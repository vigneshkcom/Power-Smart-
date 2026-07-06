// POST /api/send-quote — emails a branded smoke alarm quote to the customer via Resend.
//
// Env vars (set in Vercel → Settings → Environment Variables):
//   RESEND_API_KEY      required
//   RESEND_FROM_EMAIL   optional, default "PowerSmart <support@powersmartco.com.au>"
//   RESEND_REPLY_TO     optional, default "support@powersmartco.com.au"
//
// The client sends quantities only — all pricing is computed here.

const SITE = "https://smokealarms.powersmartco.com.au";
const STRIPE_LINK = "https://book.stripe.com/14AeVc6Xk57J7QF4CXao802";
const PHONE_DISPLAY = "(07) 2141 7792";
const PHONE_TEL = "+61721417792";
const SUPPORT_EMAIL = "support@powersmartco.com.au";
const ABN = "41 669 943 720";

const PRICE_ALARM = 90;
const PRICE_CTRL = 49;
const FEE_BOOKING = 35;
const FEE_INSPECT = 131;

const IMG = {
  logo: `${SITE}/assets/logo/power-smart-logo-full-colour.png`,
  battery: `${SITE}/assets/email/smoke-alarm-pair-angled.jpg`,
  controller: `${SITE}/assets/email/remote-controller-product.jpg`,
  hardwired: `${SITE}/assets/email/hardwired-smoke-alarm-wiring.jpg`,
};

const fmt = (n) => "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function buildQuote({ serviceMode, alarmQty, controllerQty }) {
  const lines = [];
  let payableToday, balance, waiverNote = "";
  if (serviceMode === "inspect") {
    lines.push({ label: "Smoke alarm compliance inspection", qty: 1, amount: FEE_INSPECT });
    payableToday = FEE_INSPECT;
    balance = 0;
    waiverNote = "If your home needs upgrading and you proceed with us, the $131 inspection fee is waived entirely.";
  } else {
    lines.push({ label: "Photoelectric interconnected smoke alarms — supplied & installed", qty: alarmQty, unit: PRICE_ALARM, amount: alarmQty * PRICE_ALARM });
    if (controllerQty > 0) {
      lines.push({ label: "Smoke alarm remote controller", qty: controllerQty, unit: PRICE_CTRL, amount: controllerQty * PRICE_CTRL });
    }
    lines.push({ label: "Booking fee — secures your licensed electrician", qty: 1, unit: FEE_BOOKING, amount: FEE_BOOKING });
    payableToday = FEE_BOOKING;
    balance = alarmQty * PRICE_ALARM + controllerQty * PRICE_CTRL;
  }
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return { lines, total, payableToday, balance, waiverNote };
}

function buildEmailHtml({ customerName, agentName, serviceMode, alarmQty, controllerQty }) {
  const q = buildQuote({ serviceMode, alarmQty, controllerQty });
  const name = escapeHtml(customerName || "there");
  const isInspect = serviceMode === "inspect";

  const rowsHtml = q.lines.map((l) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #E5EEEF;font-size:14px;color:#41585D;line-height:1.5;">
        ${escapeHtml(l.label)}${l.unit ? `<br><span style="font-size:12px;color:#8AA0A5;">${l.qty} &times; ${fmt(l.unit)}</span>` : ""}
      </td>
      <td align="right" style="padding:12px 0 12px 16px;border-bottom:1px solid #E5EEEF;font-size:14px;font-weight:bold;color:#0B1B1F;white-space:nowrap;">${fmt(l.amount)}</td>
    </tr>`).join("");

  const introLine = isInspect
    ? "As discussed, here is your quote for a full smoke alarm compliance inspection of your property against Queensland's 2027 legislation."
    : `As discussed, your property requires approximately <strong>${alarmQty} interconnected photoelectric smoke alarm${alarmQty === 1 ? "" : "s"}</strong> to meet Queensland's smoke alarm legislation. Your electrician will confirm the exact number and placement on the day.`;

  const ctaLabel = isInspect ? `Book my inspection — pay ${fmt(q.payableToday)}` : `Secure my booking — pay ${fmt(q.payableToday)}`;

  const productCard = (img, alt, title, caption) => `
    <td width="33%" valign="top" style="padding:0 6px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F4F9FA;border-radius:12px;">
        <tr><td align="center" style="padding:14px 10px 6px;">
          <img src="${img}" alt="${alt}" width="120" style="display:block;width:120px;height:auto;border-radius:8px;">
        </td></tr>
        <tr><td align="center" style="padding:0 10px 4px;font-size:12.5px;font-weight:bold;color:#0B1B1F;line-height:1.35;">${title}</td></tr>
        <tr><td align="center" style="padding:0 10px 14px;font-size:11px;color:#6B8288;line-height:1.45;">${caption}</td></tr>
      </table>
    </td>`;

  const tick = (text) => `
    <tr>
      <td width="22" valign="top" style="padding:5px 0;"><span style="display:inline-block;width:18px;height:18px;border-radius:50%;background:#43A8B6;color:#ffffff;font-size:12px;font-weight:bold;text-align:center;line-height:18px;">&#10003;</span></td>
      <td style="padding:5px 0 5px 10px;font-size:13.5px;color:#41585D;line-height:1.5;">${text}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your Smoke Alarm Compliance Quote — PowerSmart</title>
</head>
<body style="margin:0;padding:0;background-color:#EAF2F3;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your smoke alarm compliance quote — ${fmt(q.total)} total. Secure your licensed electrician today.</div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EAF2F3;">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;">

        <!-- Logo header -->
        <tr><td align="center" style="background:#ffffff;border-radius:14px 14px 0 0;padding:22px 24px;border-bottom:1px solid #E5EEEF;">
          <img src="${IMG.logo}" alt="Power Smart Co" width="210" style="display:block;width:210px;height:auto;">
        </td></tr>

        <!-- Title band -->
        <tr><td style="background:#0B1B1F;padding:26px 32px;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:2px;color:#7FD6E2;font-weight:bold;text-transform:uppercase;padding-bottom:6px;">QLD Smoke Alarm Legislation &middot; 1 Jan 2027</div>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:1.25;color:#ffffff;font-weight:bold;">Your Smoke Alarm<br>Compliance Quote</div>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#ffffff;padding:28px 32px 8px;font-family:Arial,Helvetica,sans-serif;">
          <p style="margin:0 0 14px;font-size:15px;color:#0B1B1F;">Hi ${name},</p>
          <p style="margin:0 0 6px;font-size:14px;color:#41585D;line-height:1.65;">${introLine}</p>
        </td></tr>

        <!-- Quote table -->
        <tr><td style="background:#ffffff;padding:10px 32px 4px;font-family:Arial,Helvetica,sans-serif;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${rowsHtml}
            <tr>
              <td style="padding:14px 0 4px;font-size:16px;font-weight:bold;color:#0B1B1F;">Total investment</td>
              <td align="right" style="padding:14px 0 4px 16px;font-size:22px;font-weight:bold;color:#2E8494;white-space:nowrap;">${fmt(q.total)}</td>
            </tr>
            <tr>
              <td colspan="2" style="padding:2px 0 14px;font-size:12.5px;color:#8AA0A5;">
                Payable today: <strong style="color:#41585D;">${fmt(q.payableToday)}</strong>${q.balance > 0 ? ` &middot; balance of <strong style="color:#41585D;">${fmt(q.balance)}</strong> payable on installation day` : ""}
              </td>
            </tr>
            ${q.waiverNote ? `<tr><td colspan="2" style="padding:0 0 14px;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="background:#FDF3DC;border-radius:10px;padding:12px 16px;font-size:12.5px;color:#6B5316;line-height:1.55;">${q.waiverNote}</td></tr></table></td></tr>` : ""}
          </table>
        </td></tr>

        <!-- CTA -->
        <tr><td align="center" style="background:#ffffff;padding:10px 32px 6px;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr><td align="center" bgcolor="#43A8B6" style="border-radius:999px;">
              <a href="${STRIPE_LINK}" target="_blank" style="display:inline-block;padding:15px 34px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#0B1B1F;text-decoration:none;">${ctaLabel} &rarr;</a>
            </td></tr>
          </table>
          <p style="margin:10px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11.5px;color:#8AA0A5;">Secure payment via Stripe &middot; fully refundable if we can't complete your ${isInspect ? "inspection" : "installation"}</p>
        </td></tr>

        <!-- Products -->
        <tr><td style="background:#ffffff;padding:24px 26px 6px;font-family:Arial,Helvetica,sans-serif;">
          <div style="font-size:12px;letter-spacing:2px;color:#2E8494;font-weight:bold;text-transform:uppercase;text-align:center;padding-bottom:12px;">What we install</div>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
            ${productCard(IMG.battery, "Battery operated interconnected smoke alarms", "Battery Operated Alarm", "Bedrooms, hallways &amp; every level — wireless interconnection, 10-yr battery")}
            ${productCard(IMG.controller, "Smoke alarm remote controller", "Remote Controller", controllerQty > 0 ? "Included in your quote — test &amp; hush from the wall" : "Optional add-on — test &amp; hush from the wall")}
            ${productCard(IMG.hardwired, "240V hardwired smoke alarm", "240V Hardwired Alarm", "Like-for-like replacement of existing hardwired alarms")}
          </tr></table>
        </td></tr>

        <!-- Included ticks -->
        <tr><td style="background:#ffffff;padding:16px 32px 22px;font-family:Arial,Helvetica,sans-serif;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F4F9FA;border-radius:12px;">
            <tr><td style="padding:16px 20px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                ${tick("Installed by <strong>licensed, insured electricians</strong>")}
                ${tick("<strong>Compliance certificate issued the same day</strong> as installation")}
                ${tick("Photoelectric &amp; interconnected — certified to AS 3786-2014/2023")}
                ${tick("<strong>10-year manufacturer warranty</strong> on every alarm")}
              </table>
            </td></tr>
          </table>
        </td></tr>

        <!-- Questions -->
        <tr><td align="center" style="background:#ffffff;border-radius:0 0 14px 14px;padding:0 32px 28px;font-family:Arial,Helvetica,sans-serif;">
          <p style="margin:0;font-size:13.5px;color:#41585D;line-height:1.7;">
            Questions, or ready to lock in a date? Reply to this email or call us on
            <a href="tel:${PHONE_TEL}" style="color:#2E8494;font-weight:bold;text-decoration:none;">${PHONE_DISPLAY}</a>.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:22px 12px 6px;font-family:Arial,Helvetica,sans-serif;" align="center">
          <p style="margin:0 0 4px;font-size:12px;color:#6B8288;font-weight:bold;">PowerSmart &middot; ${PHONE_DISPLAY} &middot; ${SUPPORT_EMAIL}</p>
          <p style="margin:0 0 4px;font-size:11px;color:#8AA0A5;">ABN ${ABN} &middot; <a href="${SITE}" style="color:#8AA0A5;">smokealarms.powersmartco.com.au</a>${agentName ? ` &middot; Quote prepared by ${escapeHtml(agentName)}` : ""}</p>
          <p style="margin:8px 0 0;font-size:10.5px;color:#A5B8BC;line-height:1.6;max-width:480px;">This quote is an estimate based on the property details discussed. Final compliance assessment is confirmed on-site by a licensed electrician. Prices in AUD.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildEmailText({ customerName, agentName, serviceMode, alarmQty, controllerQty }) {
  const q = buildQuote({ serviceMode, alarmQty, controllerQty });
  const lines = q.lines.map((l) => `- ${l.label}${l.unit ? ` (${l.qty} x ${fmt(l.unit)})` : ""}: ${fmt(l.amount)}`).join("\n");
  return `Hi ${customerName || "there"},

${serviceMode === "inspect"
    ? "Here is your quote for a full smoke alarm compliance inspection against Queensland's 2027 legislation."
    : `Your property requires approximately ${alarmQty} interconnected photoelectric smoke alarms to meet Queensland's smoke alarm legislation. Your electrician will confirm the exact number and placement on the day.`}

Quote summary:
${lines}
Total: ${fmt(q.total)}
Payable today: ${fmt(q.payableToday)}${q.balance > 0 ? ` (balance of ${fmt(q.balance)} payable on installation day)` : ""}
${q.waiverNote ? "\n" + q.waiverNote + "\n" : ""}
Secure your booking (Stripe): ${STRIPE_LINK}

Included: licensed & insured electricians, same-day compliance certificate, AS 3786-2014/2023 certified alarms, 10-year manufacturer warranty.

Questions? Reply to this email or call ${PHONE_DISPLAY}.

PowerSmart | ABN ${ABN}${agentName ? ` | Quote prepared by ${agentName}` : ""}
${SITE}`;
}

function isValidEmail(v) {
  return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Email service is not configured (missing RESEND_API_KEY)" });
  }

  const b = req.body || {};
  const customerEmail = b.customerEmail;
  const customerName = String(b.customerName || "").slice(0, 120).trim();
  const agentName = String(b.agentName || "").slice(0, 120).trim();
  const serviceMode = b.serviceMode === "inspect" ? "inspect" : "install";
  const alarmQty = Math.max(0, Math.min(50, parseInt(b.alarmQty, 10) || 0));
  const controllerQty = Math.max(0, Math.min(10, parseInt(b.controllerQty, 10) || 0));

  if (!isValidEmail(customerEmail)) {
    return res.status(400).json({ error: "A valid customer email address is required" });
  }
  if (serviceMode === "install" && alarmQty < 1) {
    return res.status(400).json({ error: "Alarm quantity must be at least 1 for an installation quote" });
  }

  const payload = { customerName, agentName, serviceMode, alarmQty, controllerQty };

  const { Resend } = require("resend");
  const resend = new Resend(apiKey);
  try {
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || `PowerSmart <${SUPPORT_EMAIL}>`,
      to: customerEmail,
      replyTo: process.env.RESEND_REPLY_TO || SUPPORT_EMAIL,
      subject: "Your Smoke Alarm Compliance Quote — PowerSmart",
      html: buildEmailHtml(payload),
      text: buildEmailText(payload),
    });
    if (error) {
      return res.status(502).json({ error: error.message || "Email provider rejected the request" });
    }
    return res.status(200).json({ ok: true, id: data && data.id });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) || "Unexpected error sending email" });
  }
}

module.exports = handler;
module.exports.buildEmailHtml = buildEmailHtml;
module.exports.buildEmailText = buildEmailText;
