// POST /api/send-email — sends a free-form branded email (with signature)
// to a customer via Resend, from one of the sender identities.
// Called from the pipeline lead card, so it requires the portal key.
//
// Body: { to, toName?, subject, message, sendAs, agent?, leadId? }
// sendAs ∈ customer_service | mani | vignesh

const S = require("./_senders");
const SB = require("./_supabase");
const { logEmail } = require("./_maillog");

function isValidEmail(v) {
  return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const portalKey = process.env.PORTAL_KEY;
  if (!portalKey) return res.status(500).json({ error: "Portal is not configured (missing PORTAL_KEY)" });
  if ((req.headers["x-portal-key"] || "") !== portalKey) return res.status(401).json({ error: "Invalid portal key" });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Email service is not configured (missing RESEND_API_KEY)" });

  const b = req.body || {};
  const to = String(b.to || "").trim();
  const toName = String(b.toName || "").slice(0, 120).trim();
  const subject = String(b.subject || "").slice(0, 200).trim();
  const message = String(b.message || "").slice(0, 20000);
  const agent = String(b.agent || "").slice(0, 120).trim();
  const leadId = String(b.leadId || "").slice(0, 40).trim();
  const sender = S.resolveSender(b.sendAs);

  if (!isValidEmail(to)) return res.status(400).json({ error: "A valid recipient email is required" });
  if (!subject) return res.status(400).json({ error: "Subject is required" });
  if (!message.trim()) return res.status(400).json({ error: "Message is required" });

  const html = S.wrapMessageHtml({ senderKey: sender.key, message });
  const text = message + S.signatureText(sender.key);

  const { Resend } = require("resend");
  const resend = new Resend(apiKey);

  async function logComment(status, err) {
    if (!leadId || !SB.configured()) return;
    try {
      const who = agent || sender.label;
      const note = status === "sent"
        ? `📧 Email sent (as ${sender.label}) by ${who} — "${subject}"`
        : `⚠️ Email FAILED (as ${sender.label}) — "${subject}"${err ? " · " + err : ""}`;
      await SB.sb("lead_comments", { method: "POST", body: { lead_id: leadId, author: who, body: note }, prefer: "return=minimal" });
      await SB.sb(`leads?id=eq.${encodeURIComponent(leadId)}`, { method: "PATCH", body: { updated_at: new Date().toISOString() }, prefer: "return=minimal" }).catch(() => {});
    } catch (e) { console.error("send-email → comment failed:", e.message); }
  }

  try {
    const { data, error } = await resend.emails.send({
      from: S.fromHeader(sender.key),
      to,
      replyTo: process.env.RESEND_REPLY_TO || S.SUPPORT_EMAIL,
      subject,
      html,
      text,
    });
    if (error) {
      await logEmail({ kind: "email", sender: sender.key, agent, to_email: to, to_name: toName, subject, body_html: html, body_text: text, lead_id: leadId || null, status: "failed", error: error.message });
      await logComment("failed", error.message);
      return res.status(502).json({ error: error.message || "Email provider rejected the request" });
    }
    await logEmail({ kind: "email", sender: sender.key, agent, to_email: to, to_name: toName, subject, body_html: html, body_text: text, lead_id: leadId || null, provider_id: data && data.id, status: "sent" });
    await logComment("sent");
    return res.status(200).json({ ok: true, id: data && data.id });
  } catch (err) {
    await logEmail({ kind: "email", sender: sender.key, agent, to_email: to, to_name: toName, subject, body_html: html, body_text: text, lead_id: leadId || null, status: "failed", error: err && err.message });
    await logComment("failed", err && err.message);
    return res.status(500).json({ error: (err && err.message) || "Unexpected error sending email" });
  }
};
