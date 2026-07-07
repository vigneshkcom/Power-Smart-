// /api/pipeline — backend for the staff sales pipeline (kanban) page.
//
// Auth: every request must carry header  x-portal-key: <PORTAL_KEY env var>.
// Data: Supabase via service-role key (see api/_supabase.js). RLS blocks all
//       other access, so this function is the only door to the data.
//
// GET  → { leads:[ ...with comment counts ] }
// POST → { action:"create"|"move"|"update"|"comment"|"comments"|"delete", ... }

const { sb, configured } = require("./_supabase");

const STAGES = ["new_lead", "follow_up", "shopping", "quote_sent", "won", "not_reachable", "out_of_area"];

function clean(s, max) { return String(s == null ? "" : s).slice(0, max).trim(); }

module.exports = async (req, res) => {
  const portalKey = process.env.PORTAL_KEY;
  if (!portalKey) return res.status(500).json({ error: "Portal is not configured (missing PORTAL_KEY)" });
  if ((req.headers["x-portal-key"] || "") !== portalKey) {
    return res.status(401).json({ error: "Invalid portal key" });
  }
  if (!configured()) return res.status(500).json({ error: "Supabase is not configured (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" });

  try {
    if (req.method === "GET") {
      const cols = "id,created_at,updated_at,name,phone,email,postcode,source,stage,agent,quote_ref,quote_total";
      const leads = await sb(`leads?select=${cols}&order=updated_at.desc&limit=1000`);
      // Comment counts via a plain query, tallied here. (Supabase disables
      // embedded aggregate functions like lead_comments(count) by default.)
      const counts = {};
      try {
        const cmts = await sb("lead_comments?select=lead_id&limit=10000");
        (cmts || []).forEach((c) => { counts[c.lead_id] = (counts[c.lead_id] || 0) + 1; });
      } catch (_) { /* counts are cosmetic — don't fail the board over them */ }
      const out = (leads || []).map((l) => ({ ...l, comment_count: counts[l.id] || 0 }));
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
          source: clean(b.source, 60) || "Manual",
          agent: clean(b.agent, 120) || null,
          stage,
        },
      });
      return res.status(200).json({ ok: true, lead: rows && rows[0] });
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
      if (!leadId || !body) return res.status(400).json({ error: "lead_id and body are required" });
      const rows = await sb("lead_comments", {
        method: "POST",
        body: { lead_id: leadId, author: clean(b.author, 120) || null, body },
      });
      // bump the card so it floats to the top of its column (trigger forces updated_at=now())
      await sb(`leads?id=eq.${encodeURIComponent(leadId)}`, { method: "PATCH", body: { updated_at: new Date().toISOString() }, prefer: "return=minimal" }).catch(() => {});
      return res.status(200).json({ ok: true, comment: rows && rows[0] });
    }

    if (action === "comments") {
      const leadId = clean(b.lead_id, 40);
      if (!leadId) return res.status(400).json({ error: "lead_id is required" });
      const rows = await sb(`lead_comments?lead_id=eq.${encodeURIComponent(leadId)}&order=created_at.asc&limit=200`);
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
