// Sender identities for outbound email. All send from the verified
// support@ address (display name varies); replies land in support@.
// Underscore prefix => not a Vercel route.

const SUPPORT_EMAIL = "support@powersmartco.com.au";
const PHONE_DISPLAY = "(07) 2141 7792";
const PHONE_TEL = "+61721417792";
const SITE = "https://smokealarms.powersmartco.com.au";
const ABN = "41 669 943 720";
const LOGO = `${SITE}/assets/logo/power-smart-logo-full-colour.png`;

// key -> identity
const SENDERS = {
  customer_service: { key: "customer_service", label: "Customer Service", fromName: "PowerSmart",           signName: "Customer Service Team", title: "PowerSmart" },
  mani:             { key: "mani",             label: "Mani",             fromName: "Mani — PowerSmart", signName: "Mani",                  title: "PowerSmart" },
  vignesh:          { key: "vignesh",          label: "Vignesh",          fromName: "Vignesh — PowerSmart", signName: "Vignesh",             title: "PowerSmart" },
};

function resolveSender(key) {
  return SENDERS[key] || SENDERS.customer_service;
}

// "Mani — PowerSmart <support@powersmartco.com.au>"
function fromHeader(key) {
  const s = resolveSender(key);
  const addr = process.env.RESEND_FROM_ADDRESS || SUPPORT_EMAIL;
  return `${s.fromName} <${addr}>`;
}

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Branded HTML signature block for a given sender.
function signatureHtml(key) {
  const s = resolveSender(key);
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;border-top:1px solid #E5EEEF;padding-top:16px;font-family:Arial,Helvetica,sans-serif;">
    <tr>
      <td style="padding-right:16px;vertical-align:middle;border-right:2px solid #43A8B6;">
        <img src="${LOGO}" alt="Power Smart Co" width="150" style="display:block;width:150px;height:auto;">
      </td>
      <td style="padding-left:16px;vertical-align:middle;font-size:12.5px;color:#41585D;line-height:1.6;">
        <div style="font-weight:bold;color:#0B1B1F;font-size:14px;">${escapeHtml(s.signName)}</div>
        <div style="color:#2E8494;font-weight:600;">${escapeHtml(s.title)}</div>
        <div style="margin-top:6px;">
          <a href="tel:${PHONE_TEL}" style="color:#41585D;text-decoration:none;">${PHONE_DISPLAY}</a><br>
          <a href="mailto:${SUPPORT_EMAIL}" style="color:#2E8494;text-decoration:none;">${SUPPORT_EMAIL}</a><br>
          <a href="${SITE}" style="color:#2E8494;text-decoration:none;">smokealarms.powersmartco.com.au</a>
        </div>
        <div style="margin-top:6px;font-size:10.5px;color:#8AA0A5;">PowerSmart Pty Ltd &middot; ABN ${ABN}</div>
      </td>
    </tr>
  </table>`;
}

function signatureText(key) {
  const s = resolveSender(key);
  return `\n\n—\n${s.signName}\n${s.title}\n${PHONE_DISPLAY} · ${SUPPORT_EMAIL}\nsmokealarms.powersmartco.com.au\nPowerSmart Pty Ltd · ABN ${ABN}`;
}

// Full branded wrapper for a free-form message (composer emails).
function wrapMessageHtml({ senderKey, message }) {
  const bodyHtml = escapeHtml(message).replace(/\r?\n/g, "<br>");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#EAF2F3;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EAF2F3;"><tr><td align="center" style="padding:26px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;font-family:Arial,Helvetica,sans-serif;">
      <tr><td style="background:#ffffff;border-radius:14px;padding:30px 34px;">
        <div style="font-size:14px;color:#41585D;line-height:1.7;">${bodyHtml}</div>
        ${signatureHtml(senderKey)}
      </td></tr>
      <tr><td align="center" style="padding:16px 12px 4px;font-size:10.5px;color:#A5B8BC;line-height:1.6;">
        PowerSmart Pty Ltd &middot; ABN ${ABN} &middot; ${PHONE_DISPLAY} &middot; <a href="${SITE}" style="color:#A5B8BC;">smokealarms.powersmartco.com.au</a>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

module.exports = {
  SUPPORT_EMAIL, PHONE_DISPLAY, SITE, ABN, SENDERS,
  resolveSender, fromHeader, signatureHtml, signatureText, wrapMessageHtml, escapeHtml,
};
