// Shared quote logic + email rendering. Underscore prefix => not a Vercel route.
// Prices are GST-inclusive (AUD). Client only ever sends quantities; money is
// always computed here so it can't be tampered with.

const SITE = "https://smokealarms.powersmartco.com.au";
const STRIPE_LINK = "https://book.stripe.com/14AeVc6Xk57J7QF4CXao802";
const PHONE_DISPLAY = "(07) 2141 7792";
const PHONE_TEL = "+61721417792";
const SUPPORT_EMAIL = "support@powersmartco.com.au";
const ABN = "41 669 943 720";
const QUOTE_VALID_DAYS = 30;

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

const fmt = (n) => "$" + Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function normalise(body) {
  const serviceMode = body.serviceMode === "inspect" ? "inspect" : "install";
  const alarmQty = Math.max(0, Math.min(50, parseInt(body.alarmQty, 10) || 0));
  const controllerQty = Math.max(0, Math.min(10, parseInt(body.controllerQty, 10) || 0));
  return { serviceMode, alarmQty, controllerQty };
}

function buildQuote({ serviceMode, alarmQty, controllerQty }) {
  const lines = [];
  let payableToday, balance, waiverNote = "";
  if (serviceMode === "inspect") {
    lines.push({ label: "Smoke alarm compliance inspection", qty: 1, unit: FEE_INSPECT, amount: FEE_INSPECT });
    payableToday = FEE_INSPECT;
    balance = 0;
    waiverNote = "If your home needs upgrading and you proceed with us, this $131 inspection fee is waived in full — you pay only the $35 booking fee plus the alarms required.";
  } else {
    lines.push({ label: "Photoelectric interconnected smoke alarms — supplied & installed", qty: alarmQty, unit: PRICE_ALARM, amount: alarmQty * PRICE_ALARM });
    if (controllerQty > 0) {
      lines.push({ label: "Smoke alarm remote controller (test / hush / locate)", qty: controllerQty, unit: PRICE_CTRL, amount: controllerQty * PRICE_CTRL });
    }
    lines.push({ label: "Booking fee — secures your licensed electrician", qty: 1, unit: FEE_BOOKING, amount: FEE_BOOKING });
    payableToday = FEE_BOOKING;
    balance = alarmQty * PRICE_ALARM + controllerQty * PRICE_CTRL;
  }
  const total = lines.reduce((s, l) => s + l.amount, 0);      // GST-inclusive
  const subtotalExGst = total / 1.1;
  const gst = total - subtotalExGst;
  return { lines, total, subtotalExGst, gst, payableToday, balance, waiverNote };
}

function makeRef(d) {
  const dt = d || new Date();
  const yy = String(dt.getFullYear()).slice(2);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  let rand = "";
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 4; i++) rand += chars[Math.floor(Math.random() * chars.length)];
  return `PS-${yy}${mm}${dd}-${rand}`;
}

function fmtDate(d) {
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
}

function acceptUrl({ ref, customerName, customerEmail, serviceMode, alarmQty, controllerQty, agentName }) {
  const p = new URLSearchParams({
    ref: ref || "",
    name: customerName || "",
    email: customerEmail || "",
    mode: serviceMode,
    alarms: String(alarmQty),
    ctrl: String(controllerQty),
    agent: agentName || "",
  });
  return `${SITE}/accept?${p.toString()}`;
}

/* ---------- Customer-facing quote email ---------- */
function renderQuoteEmail(opts) {
  const { customerName, agentName, ref, issueDate, validUntil } = opts;
  const q = buildQuote(opts);
  const name = escapeHtml(customerName || "there");
  const isInspect = opts.serviceMode === "inspect";
  const accept = acceptUrl(opts);

  const rowsHtml = q.lines.map((l, i) => `
    <tr>
      <td style="padding:13px 12px;border-bottom:1px solid #E5EEEF;font-size:13.5px;color:#41585D;line-height:1.5;${i === 0 ? "border-top:2px solid #0B1B1F;" : ""}">${escapeHtml(l.label)}</td>
      <td align="center" style="padding:13px 8px;border-bottom:1px solid #E5EEEF;font-size:13.5px;color:#41585D;${i === 0 ? "border-top:2px solid #0B1B1F;" : ""}">${l.qty}</td>
      <td align="right" style="padding:13px 8px;border-bottom:1px solid #E5EEEF;font-size:13.5px;color:#41585D;white-space:nowrap;${i === 0 ? "border-top:2px solid #0B1B1F;" : ""}">${fmt(l.unit)}</td>
      <td align="right" style="padding:13px 12px 13px 8px;border-bottom:1px solid #E5EEEF;font-size:13.5px;font-weight:bold;color:#0B1B1F;white-space:nowrap;${i === 0 ? "border-top:2px solid #0B1B1F;" : ""}">${fmt(l.amount)}</td>
    </tr>`).join("");

  const introLine = isInspect
    ? "Thank you for the opportunity to quote. Please find your quotation for a full smoke alarm compliance inspection of your property against Queensland's 2027 legislation below."
    : `Thank you for the opportunity to quote. Based on the details discussed, your property requires approximately <strong>${q.lines[0].qty} interconnected photoelectric smoke alarm${q.lines[0].qty === 1 ? "" : "s"}</strong> to meet Queensland's smoke alarm legislation. The exact number and placement is confirmed on-site by your licensed electrician.`;

  const totalsRow = (label, value, opt) => `
    <tr>
      <td style="padding:${opt && opt.pad ? opt.pad : "5px 12px"};font-size:${opt && opt.big ? "16px" : "13px"};color:${opt && opt.big ? "#0B1B1F" : "#6B8288"};font-weight:${opt && opt.big ? "bold" : "normal"};${opt && opt.top ? "border-top:2px solid #0B1B1F;" : ""}">${label}</td>
      <td align="right" style="padding:${opt && opt.pad ? opt.pad : "5px 12px"};font-size:${opt && opt.big ? "20px" : "13px"};color:${opt && opt.big ? "#2E8494" : "#41585D"};font-weight:bold;white-space:nowrap;${opt && opt.top ? "border-top:2px solid #0B1B1F;" : ""}">${value}</td>
    </tr>`;

  const tick = (text) => `
    <tr>
      <td width="22" valign="top" style="padding:5px 0;"><span style="display:inline-block;width:18px;height:18px;border-radius:50%;background:#43A8B6;color:#ffffff;font-size:11px;font-weight:bold;text-align:center;line-height:18px;">&#10003;</span></td>
      <td style="padding:5px 0 5px 10px;font-size:13px;color:#41585D;line-height:1.5;">${text}</td>
    </tr>`;

  const productCard = (img, alt, title, caption) => `
    <td width="33%" valign="top" style="padding:0 5px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F4F9FA;border-radius:10px;">
        <tr><td align="center" style="padding:12px 8px 4px;"><img src="${img}" alt="${alt}" width="104" style="display:block;width:104px;height:auto;border-radius:6px;"></td></tr>
        <tr><td align="center" style="padding:0 8px 3px;font-size:11.5px;font-weight:bold;color:#0B1B1F;line-height:1.3;">${title}</td></tr>
        <tr><td align="center" style="padding:0 8px 12px;font-size:10px;color:#6B8288;line-height:1.4;">${caption}</td></tr>
      </table>
    </td>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Quotation ${escapeHtml(ref)} — PowerSmart</title></head>
<body style="margin:0;padding:0;background-color:#EAF2F3;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your smoke alarm compliance quotation ${escapeHtml(ref)} — ${fmt(q.total)} incl. GST. Valid until ${escapeHtml(validUntil)}.</div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EAF2F3;"><tr><td align="center" style="padding:26px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="620" style="width:620px;max-width:100%;font-family:Arial,Helvetica,sans-serif;">

      <!-- Header: logo + quotation meta -->
      <tr><td style="background:#ffffff;border-radius:14px 14px 0 0;padding:26px 32px 22px;border-bottom:3px solid #43A8B6;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
          <td valign="middle"><img src="${IMG.logo}" alt="Power Smart Co" width="190" style="display:block;width:190px;height:auto;"></td>
          <td valign="middle" align="right">
            <div style="font-size:20px;font-weight:bold;color:#0B1B1F;letter-spacing:1px;">QUOTATION</div>
            <div style="font-size:12px;color:#6B8288;padding-top:4px;">Ref: <strong style="color:#41585D;">${escapeHtml(ref)}</strong></div>
          </td>
        </tr></table>
      </td></tr>

      <!-- Meta band -->
      <tr><td style="background:#F4F9FA;padding:14px 32px;border-bottom:1px solid #E5EEEF;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
          <td style="font-size:12px;color:#6B8288;">PREPARED FOR<br><strong style="font-size:14px;color:#0B1B1F;">${name}</strong></td>
          <td align="right" style="font-size:12px;color:#6B8288;line-height:1.7;">Issued: <strong style="color:#41585D;">${escapeHtml(issueDate)}</strong><br>Valid until: <strong style="color:#41585D;">${escapeHtml(validUntil)}</strong></td>
        </tr></table>
      </td></tr>

      <!-- Intro -->
      <tr><td style="background:#ffffff;padding:24px 32px 6px;"><p style="margin:0;font-size:14px;color:#41585D;line-height:1.65;">${introLine}</p></td></tr>

      <!-- Line items -->
      <tr><td style="background:#ffffff;padding:18px 32px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td style="padding:0 12px 8px;font-size:10.5px;letter-spacing:1px;color:#8AA0A5;font-weight:bold;text-transform:uppercase;">Description</td>
            <td align="center" style="padding:0 8px 8px;font-size:10.5px;letter-spacing:1px;color:#8AA0A5;font-weight:bold;text-transform:uppercase;">Qty</td>
            <td align="right" style="padding:0 8px 8px;font-size:10.5px;letter-spacing:1px;color:#8AA0A5;font-weight:bold;text-transform:uppercase;">Unit</td>
            <td align="right" style="padding:0 12px 8px;font-size:10.5px;letter-spacing:1px;color:#8AA0A5;font-weight:bold;text-transform:uppercase;">Amount</td>
          </tr>
          ${rowsHtml}
        </table>
      </td></tr>

      <!-- Totals -->
      <tr><td style="background:#ffffff;padding:6px 32px 4px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td>
          <table role="presentation" cellpadding="0" cellspacing="0" align="right" width="290" style="width:290px;">
            ${totalsRow("Subtotal (excl. GST)", fmt(q.subtotalExGst))}
            ${totalsRow("GST (10%)", fmt(q.gst))}
            ${totalsRow("Total (incl. GST)", fmt(q.total), { big: true, top: true, pad: "12px 12px" })}
          </table>
        </td></tr></table>
      </td></tr>

      <!-- Payment terms -->
      <tr><td style="background:#ffffff;padding:8px 32px 4px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="background:#F4F9FA;border-radius:10px;padding:14px 18px;font-size:12.5px;color:#41585D;line-height:1.6;">
          <strong style="color:#0B1B1F;">Payment terms:</strong> ${fmt(q.payableToday)} payable today to secure your licensed electrician${q.balance > 0 ? `, with the balance of <strong>${fmt(q.balance)}</strong> payable on the day of installation` : ""}. The booking fee is fully refundable if we can't complete your ${isInspect ? "inspection" : "installation"}.
          ${q.waiverNote ? `<br><br>${q.waiverNote}` : ""}
        </td></tr></table>
      </td></tr>

      <!-- Accept CTA -->
      <tr><td align="center" style="background:#ffffff;padding:22px 32px 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#43A8B6" style="border-radius:999px;">
          <a href="${accept}" target="_blank" style="display:inline-block;padding:16px 40px;font-size:16px;font-weight:bold;color:#0B1B1F;text-decoration:none;">Accept this quote &rarr;</a>
        </td></tr></table>
        <p style="margin:12px 0 0;font-size:12px;color:#8AA0A5;line-height:1.6;">Accepting takes you to secure payment of your ${fmt(q.payableToday)} ${isInspect ? "inspection" : "booking"} fee.<br>Prefer to talk first? Call <a href="tel:${PHONE_TEL}" style="color:#2E8494;font-weight:bold;text-decoration:none;">${PHONE_DISPLAY}</a> or just reply to this email.</p>
      </td></tr>

      <!-- Included -->
      <tr><td style="background:#ffffff;padding:18px 32px 6px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F4F9FA;border-radius:12px;"><tr><td style="padding:16px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${tick("Installed by <strong>licensed, insured electricians</strong>")}
            ${tick("<strong>Compliance certificate issued the same day</strong> as installation")}
            ${tick("Photoelectric &amp; interconnected — certified to AS 3786-2014/2023")}
            ${tick("<strong>10-year manufacturer warranty</strong> on every alarm")}
          </table>
        </td></tr></table>
      </td></tr>

      <!-- Products -->
      <tr><td style="background:#ffffff;border-radius:0 0 0 0;padding:20px 27px 8px;">
        <div style="font-size:11px;letter-spacing:1.5px;color:#2E8494;font-weight:bold;text-transform:uppercase;text-align:center;padding-bottom:12px;">What we install</div>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
          ${productCard(IMG.battery, "Battery operated interconnected smoke alarms", "Battery Operated Alarm", "Bedrooms, hallways &amp; every level")}
          ${productCard(IMG.controller, "Smoke alarm remote controller", "Remote Controller", opts.controllerQty > 0 ? "Included in your quote" : "Optional add-on")}
          ${productCard(IMG.hardwired, "240V hardwired smoke alarm", "240V Hardwired Alarm", "Replaces existing hardwired alarms")}
        </tr></table>
      </td></tr>

      <tr><td style="background:#ffffff;border-radius:0 0 14px 14px;padding:8px 32px 26px;"></td></tr>

      <!-- Footer -->
      <tr><td align="center" style="padding:20px 12px 6px;">
        <p style="margin:0 0 4px;font-size:12px;color:#6B8288;font-weight:bold;">PowerSmart Pty Ltd &middot; ABN ${ABN}</p>
        <p style="margin:0;font-size:11px;color:#8AA0A5;">${PHONE_DISPLAY} &middot; ${SUPPORT_EMAIL} &middot; <a href="${SITE}" style="color:#8AA0A5;">smokealarms.powersmartco.com.au</a>${agentName ? ` &middot; Prepared by ${escapeHtml(agentName)}` : ""}</p>
        <p style="margin:8px 0 0;font-size:10px;color:#A5B8BC;line-height:1.6;max-width:500px;">This quotation is an estimate based on the property details discussed and is valid until ${escapeHtml(validUntil)}. Final compliance requirements are confirmed on-site by a licensed electrician. All prices in AUD and inclusive of GST.</p>
      </td></tr>

    </table>
  </td></tr></table>
</body></html>`;

  const text = `QUOTATION ${ref} — PowerSmart
Prepared for: ${customerName || "you"}
Issued: ${issueDate} | Valid until: ${validUntil}

${introLine.replace(/<[^>]+>/g, "")}

${q.lines.map((l) => `- ${l.label} (${l.qty} x ${fmt(l.unit)}): ${fmt(l.amount)}`).join("\n")}

Subtotal (excl. GST): ${fmt(q.subtotalExGst)}
GST (10%): ${fmt(q.gst)}
Total (incl. GST): ${fmt(q.total)}

Payment terms: ${fmt(q.payableToday)} today to secure your electrician${q.balance > 0 ? `, balance of ${fmt(q.balance)} on installation day` : ""}.
${q.waiverNote ? q.waiverNote + "\n" : ""}
Accept this quote: ${accept}

Included: licensed & insured electricians, same-day compliance certificate, AS 3786-2014/2023 certified alarms, 10-year manufacturer warranty.

Questions? Reply to this email or call ${PHONE_DISPLAY}.
PowerSmart Pty Ltd | ABN ${ABN}${agentName ? ` | Prepared by ${agentName}` : ""}
${SITE}`;

  return { html, text, quote: q };
}

module.exports = {
  SITE, STRIPE_LINK, PHONE_DISPLAY, PHONE_TEL, SUPPORT_EMAIL, ABN, QUOTE_VALID_DAYS,
  fmt, escapeHtml, normalise, buildQuote, makeRef, fmtDate, acceptUrl, renderQuoteEmail,
};
