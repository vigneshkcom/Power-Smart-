// /api/pipeline — backend for the staff sales pipeline (kanban) page.
//
// Auth: every request must carry header  x-portal-key: <PORTAL_KEY below>.
// Data: Supabase via service-role key (see api/_supabase.js). RLS blocks all
//       other access, so this function is the only door to the data.
//
// GET  → { leads:[ ...with comment counts ] }
// POST → { action:"create"|"move"|"update"|"comment"|"comments"|"delete", ... }
// ?resource=jobs → job schedule API (api/_jobs.js)
// ?resource=tech → electrician phone app API (api/_tech.js)

const { sb, configured } = require("./_supabase");
const { welcomeLead } = require('./_welcome-sms');

// Passcode staff enter to open /tools/pipeline.
const PORTAL_KEY = "2026";

const STAGES = ["new_lead", "quote_accepted", "follow_up", "quote_sent", "scheduled", "won", "not_reachable", "not_interested", "out_of_area"];

function clean(s, max) { return String(s == null ? "" : s).slice(0, max).trim(); }

module.exports = async (req, res) => {
  if (/[?&]resource=address-config(&|$)/.test(req.url || "")) return require("./_address-config")(req, res);
  if (/[?&]resource=reminders(&|$)/.test(req.url || "")) return require("./_quote-reminders").handler(req, res);
  // Job schedule shares this function (Vercel Hobby allows 12 functions); see api/_jobs.js.
  if (/[?&]resource=jobs(&|$)/.test(req.url || "")) return require("./_jobs")(req, res);
  // Electrician phone app (/tech) — own PIN auth; see api/_tech.js.
  if (/[?&]resource=tech(&|$)/.test(req.url || "")) return require("./_tech")(req, res);
  if ((req.headers["x-portal-key"] || "") !== PORTAL_KEY) {
    return res.status(401).json({ error: "Invalid portal key" });
  }
  if (!configured()) return res.status(500).json({ error: "Supabase is not configured (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" });

  try {
    if (req.method === "GET") {
      const cols = "id,created_at,updated_at,name,phone,email,postcode,address_line1,address_suburb,address_state,address_postcode,source,stage,agent,quote_ref,quote_total,payment_preference";
      // Saved board positions survive edits, notes, messages and page reloads.
      const leads = await sb(`leads?select=${cols}&order=pipeline_order_at.desc,id.desc&limit=1000`);
      const latestPayments = {};
      try {
        const payments = await sb("payment_requests?payment_type=eq.booking_fee&select=lead_id,status,amount_cents,amount_paid_cents,sent_at,paid_at&order=created_at.desc&limit=10000");
        (payments || []).forEach((payment) => {
          if (!latestPayments[payment.lead_id] || (payment.status === 'paid' && latestPayments[payment.lead_id].status !== 'paid')) latestPayments[payment.lead_id] = payment;
        });
      } catch (_) { /* payment tracking is optional until its migration is run */ }
      // Comment counts via a plain query, tallied here. (Supabase disables
      // embedded aggregate functions like lead_comments(count) by default.)
      const counts = {};
      try {
        const cmts = await sb("lead_comments?select=lead_id&limit=10000");
        (cmts || []).forEach((c) => { counts[c.lead_id] = (counts[c.lead_id] || 0) + 1; });
      } catch (_) { /* counts are cosmetic — don't fail the board over them */ }
      // Next booked visit per lead, shown on the card once a job is scheduled.
      const nextJob = {};
      try {
        const jobs = await sb("jobs?status=in.(scheduled,en_route,on_site)&scheduled_start=not.is.null&lead_id=not.is.null&select=lead_id,scheduled_start&order=scheduled_start.asc&limit=5000");
        const now = Date.now() - 12 * 3600 * 1000;
        (jobs || []).forEach((j) => {
          const t = Date.parse(j.scheduled_start);
          const cur = nextJob[j.lead_id];
          // Prefer the soonest upcoming visit; otherwise the most recent past one.
          if (!cur || (t >= now && (Date.parse(cur) < now || t < Date.parse(cur))) || (t < now && Date.parse(cur) < now && t > Date.parse(cur))) nextJob[j.lead_id] = j.scheduled_start;
        });
      } catch (_) { /* schedule info is cosmetic — don't fail the board over it */ }
      const out = (leads || []).map((l) => ({ ...l, comment_count: counts[l.id] || 0, payment: latestPayments[l.id] || null, scheduled_start: nextJob[l.id] || null }));
      return res.status(200).json({ leads: out, stages: STAGES });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const b = req.body || {};
    const action = b.action;

    if (action === "create") {
      const name = clean(b.name, 120);
      if (!name) return res.status(400).json({ error: "Name is required" });
      const stage = STAGES.includes(b.stage) ? b.stage : "new_lead";
      const rows = await sb("leads", {
        method: "POST",
        body: {
          name,
          phone: clean(b.phone, 40) || null,
          email: clean(b.email, 254).toLowerCase() || null,
          postcode: clean(b.postcode, 12) || null,
          address_line1: clean(b.address_line1, 180) || null,
          address_suburb: clean(b.address_suburb, 100) || null,
          address_state: clean(b.address_state, 20).toUpperCase() || null,
          address_postcode: clean(b.address_postcode, 12) || null,
          source: clean(b.source, 60) || "Manual",
          agent: clean(b.agent, 120) || null,
          stage,
        },
      });
      const lead = rows && rows[0];
      const welcomeSms = await welcomeLead(lead);
      return res.status(200).json({ ok: true, lead, welcome_sms: welcomeSms });
    }

    if (action === "move") {
      const id = clean(b.id, 40);
      if (!id || !STAGES.includes(b.stage)) return res.status(400).json({ error: "id and a valid stage are required" });
      const rows = await sb(`leads?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: { stage: b.stage } });
      return res.status(200).json({ ok: true, lead: rows && rows[0] });
    }

    if (action === "update") {
      const id = clean(b.id, 40);
      if (!id) return res.status(400).json({ error: "id is required" });
      const fields = {};
      if (b.name !== undefined) fields.name = clean(b.name, 120);
      if (b.phone !== undefined) fields.phone = clean(b.phone, 40) || null;
      if (b.email !== undefined) fields.email = clean(b.email, 254).toLowerCase() || null;
      if (b.postcode !== undefined) fields.postcode = clean(b.postcode, 12) || null;
      if (b.address_line1 !== undefined) fields.address_line1 = clean(b.address_line1, 180) || null;
      if (b.address_suburb !== undefined) fields.address_suburb = clean(b.address_suburb, 100) || null;
      if (b.address_state !== undefined) fields.address_state = clean(b.address_state, 20).toUpperCase() || null;
      if (b.address_postcode !== undefined) fields.address_postcode = clean(b.address_postcode, 12) || null;
      if (b.source !== undefined) fields.source = clean(b.source, 60) || null;
      if (b.agent !== undefined) fields.agent = clean(b.agent, 120) || null;
      if (!Object.keys(fields).length) return res.status(400).json({ error: "Nothing to update" });
      if (fields.name === "") return res.status(400).json({ error: "Name can't be empty" });
      const rows = await sb(`leads?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: fields });
      return res.status(200).json({ ok: true, lead: rows && rows[0] });
    }

    if (action === "comment") {
      const leadId = clean(b.lead_id, 40);
      const body = clean(b.body, 2000);
      const allowedKinds = ["note", "quote", "email", "sms", "payment", "status", "system"];
      const kind = allowedKinds.includes(b.kind) ? b.kind : "note";
      if (!leadId || !body) return res.status(400).json({ error: "lead_id and body are required" });
      const rows = await sb("lead_comments", {
        method: "POST",
        body: { lead_id: leadId, author: clean(b.author, 120) || null, kind, body },
      });
      // Keep activity dates current without changing the saved board position.
      await sb(`leads?id=eq.${encodeURIComponent(leadId)}`, { method: "PATCH", body: { updated_at: new Date().toISOString() }, prefer: "return=minimal" }).catch(() => {});
      return res.status(200).json({ ok: true, comment: rows && rows[0] });
    }

    if (action === "comments") {
      const leadId = clean(b.lead_id, 40);
      if (!leadId) return res.status(400).json({ error: "lead_id is required" });
      const rows = await sb(`lead_comments?lead_id=eq.${encodeURIComponent(leadId)}&order=created_at.desc&limit=200`);
      return res.status(200).json({ comments: rows || [] });
    }

    if (action === "emails") {
      const leadId = clean(b.lead_id, 40);
      const email = clean(b.email, 254).toLowerCase();
      if (!leadId && !email) return res.status(400).json({ error: "lead_id or email is required" });
      const cols = "id,created_at,kind,sender,agent,to_email,to_name,subject,body_html,body_text,quote_ref,quote_total,status,error";
      let q;
      if (leadId && email) q = `sent_emails?select=${cols}&or=(lead_id.eq.${leadId},to_email.eq.${encodeURIComponent(email)})&order=created_at.desc&limit=100`;
      else if (leadId)     q = `sent_emails?select=${cols}&lead_id=eq.${leadId}&order=created_at.desc&limit=100`;
      else                 q = `sent_emails?select=${cols}&to_email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=100`;
      try {
        const rows = await sb(q);
        return res.status(200).json({ emails: rows || [] });
      } catch (e) {
        // sent_emails table not created yet (emails.sql not run) — degrade gracefully
        return res.status(200).json({ emails: [], unavailable: true, note: e.message });
      }
    }

    if (action === "booking_confirmation") {
      const leadId = clean(b.lead_id, 40), jobId = clean(b.job_id, 40);
      if (!leadId && !jobId) return res.status(400).json({ error: "lead_id or job_id is required" });
      try {
        const sent = await require("./_booking-confirmation").sendBookingConfirmation({ leadId, jobId, sendAs: clean(b.send_as, 40), agent: clean(b.agent, 120), email: b.email !== false, sms: b.sms !== false });
        return res.status(200).json(sent);
      } catch (e) { return res.status(e.status || 500).json({ error: e.message || "Could not send booking confirmation" }); }
    }

    // One-time Dropbox connection from /tools/dropbox-setup: no terminal needed.
    if (action === "dropbox_connect") {
      const key = process.env.DROPBOX_APP_KEY, secret = process.env.DROPBOX_APP_SECRET;
      if (!key || !secret) return res.status(400).json({ error: "Add DROPBOX_APP_KEY and DROPBOX_APP_SECRET in Vercel first, then redeploy." });
      const code = clean(b.code, 200);
      if (!code) return res.status(200).json({ auth_url: "https://www.dropbox.com/oauth2/authorize?client_id=" + encodeURIComponent(key) + "&response_type=code&token_access_type=offline" });
      const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
        method: "POST",
        headers: { Authorization: "Basic " + Buffer.from(key + ":" + secret).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, grant_type: "authorization_code" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.refresh_token) return res.status(400).json({ error: "Dropbox did not accept that code. It works once and expires fast, so click Allow again to get a fresh one." });
      return res.status(200).json({ refresh_token: d.refresh_token });
    }

    // Job photos from Dropbox for the portal (schedule job window, pipeline lead window).
    if (action === "job_photos" || action === "photo_link") {
      const Dropbox = require("./_dropbox");
      if (!Dropbox.configured()) return res.status(200).json({ configured: false, jobs: [] });
      try {
        if (action === "photo_link") {
          const path = clean(b.path, 500);
          return res.status(200).json({ link: await Dropbox.temporaryLink(Dropbox.assertInside(Dropbox.ROOT, path)) });
        }
        const jobId = clean(b.job_id, 40), leadId = clean(b.lead_id, 40);
        if (!jobId && !leadId) return res.status(400).json({ error: "job_id or lead_id is required" });
        const cols = "id,job_no,customer_name,address,status";
        const rows = await sb(jobId ? `jobs?id=eq.${encodeURIComponent(jobId)}&select=${cols}&limit=1` : `jobs?lead_id=eq.${encodeURIComponent(leadId)}&select=${cols}&order=job_no.desc&limit=5`);
        const jobs = [];
        for (const j of rows || []) jobs.push({ job_no: j.job_no, customer_name: j.customer_name, ...(await Dropbox.photosForJob(j)) });
        return res.status(200).json({ configured: true, jobs });
      } catch (e) { return res.status(e.status || 500).json({ error: e.message || "Could not load photos" }); }
    }

    if (action === "delete") {
      const id = clean(b.id, 40);
      if (!id) return res.status(400).json({ error: "id is required" });
      await sb(`leads?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", prefer: "return=minimal" });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || "Pipeline error" });
  }
};
