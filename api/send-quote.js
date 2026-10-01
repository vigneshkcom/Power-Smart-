// POST /api/send-quote — emails a professional smoke alarm quotation via Resend.
//
// Env vars (Vercel → Settings → Environment Variables):
//   RESEND_API_KEY      required
//   RESEND_FROM_EMAIL   optional, default "PowerSmart <support@powersmartco.com.au>"
//   RESEND_REPLY_TO     optional, default "support@powersmartco.com.au"
//   NOTIFY_EMAIL        optional, address BCC'd a copy of each quote (default support)

const Q = require("./_quote");
const SB = require("./_supabase");
const S = require("./_senders");
const { logEmail } = require("./_maillog");

// Same passcode the pipeline page and /api/send-email use.
const PORTAL_KEY = "2026";

// leadId is only honoured when the call came from the pipeline (portal key), so a
// quote sent from a lead card updates that exact lead instead of matching by email.
async function recordInPipeline({ customerName, customerEmail, agentName, ref, total, leadId: hintId }) {
  if (!SB.configured()) return null;
  try {
    const patch = { stage: "quote_sent", quote_ref: ref, quote_total: total, agent: agentName || null };
    let leadId = null;
    if (hintId) {
      const byId = await SB.sb(`leads?id=eq.${encodeURIComponent(hintId)}&select=id,email&limit=1`);
      if (byId && byId[0]) {
        leadId = byId[0].id;
        if (!byId[0].email) patch.email = customerEmail.toLowerCase();   // remember the address we just used
      }
    }
    if (!leadId) {
      const found = await SB.sb(`leads?email=eq.${encodeURIComponent(customerEmail.toLowerCase())}&select=id&order=updated_at.desc&limit=1`);
      if (found && found[0]) leadId = found[0].id;
    }
    if (leadId) {
      await SB.sb(`leads?id=eq.${encodeURIComponent(leadId)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
    } else {
      const rows = await SB.sb("leads", {
        method: "POST",
        body: { name: customerName || customerEmail, email: customerEmail.toLowerCase(), source: "Phone quote", stage: "quote_sent", quote_ref: ref, quote_total: total, agent: agentName || null },
      });
      leadId = rows && rows[0] && rows[0].id;
    }
    if (leadId) {
      await SB.sb("lead_comments", {
        method: "POST",
        body: { lead_id: leadId, author: agentName || "System", body: `📧 Quote ${ref} emailed — total ${Q.fmt(total)} incl. GST.` },
        prefer: "return=minimal",
      });
    }
    return leadId || null;
  } catch (e) { console.error("send-quote → pipeline update failed:", e.message); return null; }
}

function isValidEmail(v) {
  return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Email service is not configured (missing RESEND_API_KEY)" });

  const b = req.body || {};
  const customerEmail = b.customerEmail;
  const customerName = String(b.customerName || "").slice(0, 120).trim();
  const agentName = String(b.agentName || "").slice(0, 120).trim();
  const sender = S.resolveSender(b.sendAs);
  const fromPipeline = (req.headers["x-portal-key"] || "") === PORTAL_KEY;
  const hintLeadId = fromPipeline && /^[\w-]{1,40}$/.test(String(b.leadId || "")) ? String(b.leadId) : "";
  const { serviceMode, alarmQty, controllerQty } = Q.normalise(b);

  if (!isValidEmail(customerEmail)) return res.status(400).json({ error: "A valid customer email address is required" });
  if (serviceMode === "install" && alarmQty < 1) return res.status(400).json({ error: "Alarm quantity must be at least 1 for an installation quote" });

  const now = new Date();
  const validUntilDate = new Date(now.getTime() + Q.QUOTE_VALID_DAYS * 864e5);
  const ref = Q.makeRef(now);

  const rendered = Q.renderQuoteEmail({
    customerName, agentName, customerEmail, serviceMode, alarmQty, controllerQty,
    ref, issueDate: Q.fmtDate(now), validUntil: Q.fmtDate(validUntilDate),
  });

  const { Resend } = require("resend");
  const resend = new Resend(apiKey);
  const notify = process.env.NOTIFY_EMAIL || Q.SUPPORT_EMAIL;

  const subject = `Your Smoke Alarm Compliance Quotation (${ref}) — PowerSmart`;

  try {
    const { data, error } = await resend.emails.send({
      from: S.fromHeader(sender.key),
      to: customerEmail,
      replyTo: process.env.RESEND_REPLY_TO || Q.SUPPORT_EMAIL,
      bcc: notify,
      subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (error) {
      await logEmail({ kind: "quote", sender: sender.key, agent: agentName, to_email: customerEmail, to_name: customerName, subject, body_html: rendered.html, body_text: rendered.text, quote_ref: ref, quote_total: rendered.quote.total, status: "failed", error: error.message });
      return res.status(502).json({ error: error.message || "Email provider rejected the request" });
    }
    const leadId = await recordInPipeline({ customerName, customerEmail, agentName, ref, total: rendered.quote.total, leadId: hintLeadId });
    await logEmail({ kind: "quote", sender: sender.key, agent: agentName, to_email: customerEmail, to_name: customerName, subject, body_html: rendered.html, body_text: rendered.text, quote_ref: ref, quote_total: rendered.quote.total, lead_id: leadId, provider_id: data && data.id, status: "sent" });
    return res.status(200).json({ ok: true, id: data && data.id, ref, total: rendered.quote.total });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) || "Unexpected error sending email" });
  }
};
