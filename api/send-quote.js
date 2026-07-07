// POST /api/send-quote — emails a professional smoke alarm quotation via Resend.
//
// Env vars (Vercel → Settings → Environment Variables):
//   RESEND_API_KEY      required
//   RESEND_FROM_EMAIL   optional, default "PowerSmart <support@powersmartco.com.au>"
//   RESEND_REPLY_TO     optional, default "support@powersmartco.com.au"
//   NOTIFY_EMAIL        optional, address BCC'd a copy of each quote (default support)

const Q = require("./_quote");

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

  try {
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || `PowerSmart <${Q.SUPPORT_EMAIL}>`,
      to: customerEmail,
      replyTo: process.env.RESEND_REPLY_TO || Q.SUPPORT_EMAIL,
      bcc: notify,
      subject: `Your Smoke Alarm Compliance Quotation (${ref}) — PowerSmart`,
      html: rendered.html,
      text: rendered.text,
    });
    if (error) return res.status(502).json({ error: error.message || "Email provider rejected the request" });
    return res.status(200).json({ ok: true, id: data && data.id, ref, total: rendered.quote.total });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) || "Unexpected error sending email" });
  }
};
