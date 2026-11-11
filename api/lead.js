// POST /api/lead — a website visitor requested a callback/quote.
// Emails the lead straight to PowerSmart so the team can call them.
//
// Env vars: RESEND_API_KEY (required), NOTIFY_EMAIL (optional, default support),
//           RESEND_FROM_EMAIL / RESEND_REPLY_TO (optional).

const SUPPORT_EMAIL = "support@powersmartco.com.au";
const SB = require("./_supabase");
const { welcomeLead } = require('./_welcome-sms');
const S = require("./_senders");
const { renderEnquiryConfirmation } = require("./_enquiry-confirmation");
const { logEmail } = require("./_maillog");
const Sms = require("./_sms-outbound");
const { isBlocked } = require("./_blocked-numbers");

async function parseRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Phone forms a stored lead might use for the same mobile: 04xxxxxxxx, +614xxxxxxxx, 614xxxxxxxx and the raw entry.
function phoneVariants(raw) {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  const set = new Set([digits]);
  const local = digits.replace(/^\+?61/, "0");
  if (/^0\d{9}$/.test(local)) { set.add(local); set.add("+61" + local.slice(1)); set.add("61" + local.slice(1)); }
  return [...set].filter(Boolean);
}
// Most recently updated lead with the same email or phone, if any.
async function findExistingLead({ email, phone }) {
  const conds = phoneVariants(phone).map((p) => `phone.eq.${encodeURIComponent(p)}`);
  if (email) conds.push(`email.eq.${encodeURIComponent(email.toLowerCase())}`);
  if (!conds.length) return null;
  const rows = await SB.sb(`leads?or=(${conds.join(",")})&select=id,name,phone,email,postcode,stage,source&order=updated_at.desc&limit=1`);
  return rows && rows[0] || null;
}
function isValidEmail(v) {
  return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

async function handleLead(req, res, source = "Website") {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Lead service is not configured (missing RESEND_API_KEY)" });

  const b = req.body || {};
  const name = String(b.name || "").slice(0, 120).trim();
  const phone = String(b.phone || "").slice(0, 40).trim();
  const email = String(b.email || "").slice(0, 254).trim();
  const postcode = String(b.postcode || "").slice(0, 12).trim();

  if (!name || !phone) return res.status(400).json({ error: "Name and phone are required" });
  if (email && !isValidEmail(email)) return res.status(400).json({ error: "Please enter a valid email address" });

  // Blocked competitors (phone, email or name): answer exactly like a normal success, but save and send nothing.
  if (isBlocked({ name, phone, email })) {
    console.log("lead → blocked enquiry ignored");
    return res.status(200).json({ ok: true, welcome_sms: { status: "skipped" } });
  }

  const rows = [
    ["Name", name],
    ["Phone", phone],
    ["Email", email || "Not provided"],
    ["Postcode", postcode || "Not provided"],
  ].map(([k, v]) =>
    `<tr><td style="padding:7px 12px;color:#6B8288;font-size:13px;width:110px;">${k}</td><td style="padding:7px 12px;font-size:14px;color:#0B1B1F;"><strong>${esc(v)}</strong></td></tr>`
  ).join("");

  const leadLabel = source === "Instant Form" ? "instant form" : "website";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0B1B1F;">
      <div style="background:#43A8B6;padding:16px 20px;border-radius:10px 10px 0 0;">
        <strong style="font-size:16px;color:#0B1B1F;">New ${leadLabel} lead - call to quote</strong>
      </div>
      <div style="border:1px solid #eee;border-top:none;padding:14px 8px;border-radius:0 0 10px 10px;">
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        <p style="margin:14px 12px 4px;font-size:12px;color:#6B8288;">Submitted via ${leadLabel} &middot; ${new Date().toLocaleString("en-AU", { timeZone: "Australia/Brisbane" })} AEST</p>
        <p style="margin:8px 12px 4px;font-size:13px;">
          <a href="tel:${esc(phone)}" style="color:#2E8494;font-weight:bold;text-decoration:none;">Call ${esc(phone)}</a>
          ${email ? ` &middot; <a href="mailto:${esc(email)}" style="color:#2E8494;font-weight:bold;text-decoration:none;">Email ${esc(email)}</a>` : ""}
        </p>
      </div>
    </div>`;

  const text = `New ${leadLabel} lead - call to quote\n\nName: ${name}\nPhone: ${phone}\nEmail: ${email || "Not provided"}\nPostcode: ${postcode || "Not provided"}\n\nSubmitted via ${leadLabel}.`;

  // Drop the enquiry into the sales pipeline (non-fatal if Supabase is down/unconfigured).
  let savedLead = null, repeat = false;
  if (source === "Instant Form" && !SB.configured()) return res.status(503).json({ error: "Sales pipeline is unavailable" });
  if (SB.configured()) {
    try {
      // Same phone or email already in the pipeline: update that lead instead of creating a duplicate.
      const existing = await findExistingLead({ email, phone });
      if (existing) {
        repeat = true; savedLead = existing;
        const patch = { updated_at: new Date().toISOString() };
        if (!existing.email && email) patch.email = email.toLowerCase();
        if (!existing.phone && phone) patch.phone = phone;
        if (!existing.postcode && postcode) patch.postcode = postcode;
        if (existing.source !== source) patch.source = source;
        const reopened = ["not_interested", "not_reachable"].includes(existing.stage);
        if (reopened) patch.stage = "new_lead";
        await SB.sb(`leads?id=eq.${encodeURIComponent(existing.id)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
        await Sms.logNote(existing.id, "System", `Repeat ${leadLabel} enquiry from ${name} (${phone}${email ? ", " + email : ""}${postcode ? ", " + postcode : ""}). Existing lead updated instead of creating a duplicate${reopened ? "; moved back to New Lead" : ""}.`).catch(() => {});
      } else {
      const inserted = await SB.sb("leads", {
        method: "POST",
        body: { name, phone: phone || null, email: email.toLowerCase() || null, postcode: postcode || null, source, stage: "new_lead" },
      });
      savedLead = inserted && inserted[0];
      }
    } catch (e) {
      console.error("lead → pipeline insert failed:", e.message);
      if (source === "Instant Form") return res.status(503).json({ error: "Sales pipeline could not save this lead" });
    }
  }

  const welcomeSms = savedLead ? await welcomeLead(savedLead, new Date(), { repeat }) : { status: 'skipped' };

  try {
    const { Resend } = require("resend");
    const resend = new Resend(apiKey);

    // Confirmation to the customer (only when they gave an email). Never blocks the team alert.
    // A repeat enquiry gets the SMS above instead; the email goes out only if SMS is paused.
    if (email && (!repeat || welcomeSms.paused)) {
      try {
        const mail = renderEnquiryConfirmation({ name });
        const { error: custError } = await resend.emails.send({
          from: S.fromHeader("customer_service"), to: email,
          replyTo: SUPPORT_EMAIL, subject: mail.subject, html: mail.html, text: mail.text,
        });
        if (custError) throw new Error(custError.message || "Email provider rejected the request");
        await logEmail({ kind: "email", sender: "customer_service", agent: "System", to_email: email, to_name: name, subject: mail.subject, body_html: mail.html, body_text: mail.text, lead_id: savedLead && savedLead.id, status: "sent" });
        if (savedLead) await Sms.logNote(savedLead.id, "System", "Enquiry confirmation email sent to the customer.").catch(() => {});
      } catch (e) {
        console.error("lead → customer confirmation email failed:", e.message);
        if (savedLead) await Sms.logNote(savedLead.id, "System", `Enquiry confirmation email failed: ${e.message}`).catch(() => {});
      }
    }

    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || `PowerSmart Leads <${SUPPORT_EMAIL}>`,
      to: process.env.NOTIFY_EMAIL || SUPPORT_EMAIL,
      replyTo: email || (process.env.RESEND_REPLY_TO || SUPPORT_EMAIL),
      subject: `${repeat ? "Repeat enquiry" : "New lead"}: ${name}${postcode ? " (" + postcode + ")" : ""}`,
      html,
      text,
    });
    if (error) return res.status(502).json({ error: error.message || "Email provider rejected the request" });
    return res.status(200).json({ ok: true, welcome_sms: welcomeSms });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) || "Unexpected error submitting lead" });
  }
}

module.exports = async (req, res) => {
  if (req.query?.meta_webhook === '1') {
    return require('./_meta-lead-webhook')(req, res, parseRawBody, handleLead);
  }
  if (req.method !== 'POST') return handleLead(req, res);
  try {
    req.body = JSON.parse((await parseRawBody(req)).toString('utf8'));
  } catch (_) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  return handleLead(req, res);
};
module.exports.handleLead = handleLead;
module.exports.config = { api: { bodyParser: false }, maxDuration: 60 };
