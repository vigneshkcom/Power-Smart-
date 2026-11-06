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

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  if (!apiKey) return res.status(500).json({ error: "Lead service is not configured (missing RESEND_API_KEY)" });

  const b = req.body || {};
  const name = String(b.name || "").slice(0, 120).trim();
  const phone = String(b.phone || "").slice(0, 40).trim();
  const email = String(b.email || "").slice(0, 254).trim();
  const postcode = String(b.postcode || "").slice(0, 12).trim();

  if (!name || !phone) return res.status(400).json({ error: "Name and phone are required" });
  if (email && !isValidEmail(email)) return res.status(400).json({ error: "Please enter a valid email address" });

  // Blocked numbers (competitors): answer exactly like a normal success, but save and send nothing.
  if (isBlocked(phone)) {
    console.log("lead → blocked number ignored");
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

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0B1B1F;">
      <div style="background:#43A8B6;padding:16px 20px;border-radius:10px 10px 0 0;">
        <strong style="font-size:16px;color:#0B1B1F;">New website lead - call to quote</strong>
      </div>
      <div style="border:1px solid #eee;border-top:none;padding:14px 8px;border-radius:0 0 10px 10px;">
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        <p style="margin:14px 12px 4px;font-size:12px;color:#6B8288;">Submitted via the landing page &middot; ${new Date().toLocaleString("en-AU", { timeZone: "Australia/Brisbane" })} AEST</p>
        <p style="margin:8px 12px 4px;font-size:13px;">
          <a href="tel:${esc(phone)}" style="color:#2E8494;font-weight:bold;text-decoration:none;">Call ${esc(phone)}</a>
          ${email ? ` &middot; <a href="mailto:${esc(email)}" style="color:#2E8494;font-weight:bold;text-decoration:none;">Email ${esc(email)}</a>` : ""}
        </p>
      </div>
    </div>`;

  const text = `New website lead - call to quote\n\nName: ${name}\nPhone: ${phone}\nEmail: ${email || "Not provided"}\nPostcode: ${postcode || "Not provided"}\n\nSubmitted via the landing page.`;

  // Drop the enquiry into the sales pipeline (non-fatal if Supabase is down/unconfigured).
  let savedLead = null;
  if (SB.configured()) {
    try {
      const inserted = await SB.sb("leads", {
        method: "POST",
        body: { name, phone: phone || null, email: email.toLowerCase() || null, postcode: postcode || null, source: "Website", stage: "new_lead" },
      });
      savedLead = inserted && inserted[0];
    } catch (e) { console.error("lead → pipeline insert failed:", e.message); }
  }

  const welcomeSms = savedLead ? await welcomeLead(savedLead) : { status: 'skipped' };

  try {
    const { Resend } = require("resend");
    const resend = new Resend(apiKey);

    // Confirmation to the customer (only when they gave an email). Never blocks the team alert.
    if (email) {
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
      subject: `New lead: ${name}${postcode ? " (" + postcode + ")" : ""}`,
      html,
      text,
    });
    if (error) return res.status(502).json({ error: error.message || "Email provider rejected the request" });
    return res.status(200).json({ ok: true, welcome_sms: welcomeSms });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) || "Unexpected error submitting lead" });
  }
};
