// Customer-facing "we got your enquiry" email. Underscore prefix => not a Vercel route.
const Q = require("./_quote");

const IMG = {
  logo: `${Q.SITE}/assets/logo/power-smart-logo-full-colour.png`,
  battery: `${Q.SITE}/assets/email/smoke-alarm-pair-angled.jpg`,
  controller: `${Q.SITE}/assets/email/remote-controller-product.jpg`,
  hardwired: `${Q.SITE}/assets/email/hardwired-smoke-alarm-wiring.jpg`,
};

const QUESTIONS = ["How many bedrooms?", "How many interconnecting hallways?", "How many storeys (levels) is the home?"];

function renderEnquiryConfirmation({ name }) {
  const first = Q.escapeHtml(String(name || "").trim().split(/\s+/)[0] || "there");
  const subject = "We've received your smoke alarm enquiry - PowerSmart";

  const tick = (text) => `
    <tr>
      <td width="22" valign="top" style="padding:5px 0;"><span style="display:inline-block;width:18px;height:18px;border-radius:50%;background:#43A8B6;color:#ffffff;font-size:11px;font-weight:bold;text-align:center;line-height:18px;">&#10003;</span></td>
      <td style="padding:5px 0 5px 10px;font-size:13px;color:#41585D;line-height:1.5;">${text}</td>
    </tr>`;
  const card = (img, alt, title, caption) => `
    <td width="33%" valign="top" style="padding:0 5px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F4F9FA;border-radius:10px;">
        <tr><td align="center" style="padding:12px 8px 4px;"><img src="${img}" alt="${alt}" width="104" style="display:block;width:104px;height:auto;border-radius:6px;"></td></tr>
        <tr><td align="center" style="padding:0 8px 3px;font-size:11.5px;font-weight:bold;color:#0B1B1F;line-height:1.3;">${title}</td></tr>
        <tr><td align="center" style="padding:0 8px 12px;font-size:10px;color:#6B8288;line-height:1.4;">${caption}</td></tr>
      </table>
    </td>`;
  const question = (n, text) => `
    <tr>
      <td width="30" valign="top" style="padding:7px 0;"><span style="display:inline-block;width:24px;height:24px;border-radius:50%;background:#0B1B1F;color:#ffffff;font-size:12px;font-weight:bold;text-align:center;line-height:24px;">${n}</span></td>
      <td style="padding:7px 0 7px 8px;font-size:15px;color:#0B1B1F;font-weight:bold;line-height:1.4;">${text}</td>
    </tr>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>We've received your enquiry - PowerSmart</title></head>
<body style="margin:0;padding:0;background-color:#EAF2F3;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">We'll call you within 24 hours. Reply with the best time to call if you'd like to choose.</div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EAF2F3;"><tr><td align="center" style="padding:26px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="620" style="width:620px;max-width:100%;font-family:Arial,Helvetica,sans-serif;">

      <tr><td style="background:#ffffff;border-radius:14px 14px 0 0;padding:26px 32px 22px;border-bottom:3px solid #43A8B6;">
        <img src="${IMG.logo}" alt="Power Smart Co" width="190" style="display:block;width:190px;height:auto;">
      </td></tr>

      <tr><td style="background:#ffffff;padding:28px 32px 6px;">
        <h1 style="margin:0 0 12px;font-size:22px;color:#0B1B1F;line-height:1.3;">Hi ${first}, thanks for your enquiry</h1>
        <p style="margin:0 0 12px;font-size:15px;color:#41585D;line-height:1.65;">We've received your details and one of our team members will give you a call <strong style="color:#0B1B1F;">within the next 24 hours</strong> to go through your smoke alarm requirements.</p>
        <p style="margin:0;font-size:15px;color:#41585D;line-height:1.65;">We know how busy things get, and you may well be at work when we ring. If there's a time that suits you better, just reply to this email with the <strong style="color:#0B1B1F;">best time to call</strong> and we'll make sure we catch you then.</p>
      </td></tr>

      <tr><td style="background:#ffffff;padding:20px 32px 6px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="background:#F4F9FA;border:1px solid #D6E8EB;border-radius:12px;padding:18px 22px;">
          <div style="font-size:11px;letter-spacing:1.5px;color:#2E8494;font-weight:bold;text-transform:uppercase;padding-bottom:6px;">To prepare your quote</div>
          <p style="margin:0 0 8px;font-size:14px;color:#41585D;line-height:1.6;">If you can include these details in your reply, we can have your quote ready when we call:</p>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${QUESTIONS.map((t, i) => question(i + 1, t)).join("")}
          </table>
          <p style="margin:10px 0 0;font-size:13px;color:#6B8288;line-height:1.5;">There's no need to tell us about any existing alarms.</p>
        </td></tr></table>
      </td></tr>

      <tr><td style="background:#ffffff;padding:22px 27px 8px;">
        <div style="font-size:11px;letter-spacing:1.5px;color:#2E8494;font-weight:bold;text-transform:uppercase;text-align:center;padding-bottom:6px;">The alarms we install</div>
        <p style="margin:0 0 12px;text-align:center;font-size:13px;color:#41585D;line-height:1.5;">All of our installations use Anka photoelectric, interconnected smoke alarms.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
          ${card(IMG.battery, "Anka battery operated interconnected smoke alarms", "Anka Battery Operated Smoke Alarm", "Bedrooms, hallways &amp; every level")}
          ${card(IMG.controller, "Smoke alarm remote controller", "Remote Controller", "Test, hush &amp; locate")}
          ${card(IMG.hardwired, "Anka 240V hardwired smoke alarm", "Anka 240V Hardwired Smoke Alarm", "Replaces existing hardwired alarms")}
        </tr></table>
      </td></tr>

      <tr><td style="background:#ffffff;padding:14px 32px 6px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          ${tick("Licensed &amp; insured electricians")}
          ${tick("Same-day compliance certificate")}
          ${tick("Photoelectric &amp; interconnected - certified to AS 3786-2014/2023")}
          ${tick("<strong>10-year manufacturer warranty</strong> on every alarm")}
        </table>
      </td></tr>

      <tr><td style="background:#ffffff;border-radius:0 0 14px 14px;padding:10px 32px 28px;font-size:14px;color:#41585D;line-height:1.6;">Kind regards,<br><strong style="color:#0B1B1F;">The PowerSmart Team</strong></td></tr>

      <tr><td align="center" style="padding:20px 12px 6px;">
        <p style="margin:0 0 4px;font-size:12px;color:#6B8288;font-weight:bold;">PowerSmart Pty Ltd &middot; ABN ${Q.ABN}</p>
        <p style="margin:0;font-size:11px;color:#8AA0A5;">${Q.SUPPORT_EMAIL} &middot; <a href="${Q.SITE}" style="color:#8AA0A5;">smokealarms.powersmartco.com.au</a></p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const text = `Hi ${String(name || "").trim().split(/\s+/)[0] || "there"}, thanks for your enquiry.

We've received your details and one of our team members will give you a call within the next 24 hours to go through your smoke alarm requirements.

We know how busy things get, and you may well be at work when we ring. If there's a time that suits you better, just reply to this email with the best time to call and we'll make sure we catch you then.

If you can include these details in your reply, we can have your quote ready when we call:
${QUESTIONS.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}

There's no need to tell us about any existing alarms.

All of our installations use Anka photoelectric, interconnected smoke alarms (battery operated or 240V hardwired), with an optional remote controller to test, hush and locate.
- Licensed & insured electricians
- Same-day compliance certificate
- Certified to AS 3786-2014/2023
- 10-year manufacturer warranty on every alarm

Kind regards,
The PowerSmart Team

PowerSmart Pty Ltd | ABN ${Q.ABN}
${Q.SITE}`;

  return { subject, html, text };
}

module.exports = { renderEnquiryConfirmation };
