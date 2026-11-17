// Warranty jobs: a customer reports a faulty smoke alarm, the office books a warranty visit (work_type "warranty"),
// the electrician checks each alarm and either replaces it from their stock or fixes it, and the faulty units
// come back with them. Underscore prefix => not a Vercel route.
//
// Each alarm the electrician checks is one entry in jobs.alarm_units (the same list installs use), with two extra
// fields: fault (what was wrong) and outcome ("replaced" = a new alarm went in and the faulty one came back,
// "fixed" = no replacement). No invoice or payment: warranty work is free.
// Customer messages only go out when the office ticked the box (jobs.notify_customer).

const Q = require("./_quote");
const esc = Q.escapeHtml;

const FAULTS = ["Beeping or chirping", "False alarms", "Not working / no power", "Not interconnecting", "Damaged", "Other"];
const OUTCOMES = ["replaced", "fixed"];
const TYPE_WORD = { battery: "battery", hardwired: "hardwired" };

const isWarranty = (job) => Boolean(job && job.work_type === "warranty");
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "there";

// Counts for stock: every replaced alarm used one good alarm of that type and brought one faulty alarm back.
function warrantyCounts(job) {
  const c = { battery: 0, hardwired: 0, fixed: 0 };
  if (!isWarranty(job)) return c;
  for (const u of Array.isArray(job.alarm_units) ? job.alarm_units : []) {
    if (!u) continue;
    if (u.outcome === "replaced") c[u.type === "hardwired" ? "hardwired" : "battery"]++;
    else c.fixed++;
  }
  return c;
}

// "Replaced 2 battery alarms (Hallway: Beeping or chirping; Bedroom: False alarms). Fixed 1 (Kitchen: Damaged)."
function unitsSummary(units) {
  const list = Array.isArray(units) ? units.filter(Boolean) : [];
  if (!list.length) return "No alarms recorded.";
  const describe = (u) => `${u.location || "Other"}${u.fault ? ": " + u.fault : ""}`;
  const parts = [];
  for (const type of ["battery", "hardwired"]) {
    const r = list.filter((u) => u.outcome === "replaced" && (u.type === "hardwired" ? "hardwired" : "battery") === type);
    if (r.length) parts.push(`Replaced ${r.length} ${TYPE_WORD[type]} alarm${r.length === 1 ? "" : "s"} (${r.map(describe).join("; ")})`);
  }
  const fixed = list.filter((u) => u.outcome !== "replaced");
  if (fixed.length) parts.push(`Fixed ${fixed.length} without replacing (${fixed.map(describe).join("; ")})`);
  return parts.join(". ") + ".";
}

function shell(title, badge, jobNo, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background-color:#EAF2F3;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EAF2F3;"><tr><td align="center" style="padding:26px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="620" style="width:620px;max-width:100%;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="background:#ffffff;border-radius:14px 14px 0 0;padding:26px 32px 22px;border-bottom:3px solid #43A8B6;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
    <td valign="middle"><img src="${Q.SITE}/assets/logo/power-smart-logo-full-colour.png" alt="Power Smart Co" width="190" style="display:block;width:190px;height:auto;"></td>
    <td valign="middle" align="right"><div style="font-size:16px;font-weight:bold;color:#0B1B1F;letter-spacing:1px;">${esc(badge)}</div>${jobNo ? `<div style="font-size:12px;color:#6B8288;padding-top:4px;">Job: J${esc(jobNo)}</div>` : ""}</td>
  </tr></table>
</td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 14px 14px;padding:24px 32px 28px;font-size:14px;color:#41585D;line-height:1.65;">${bodyHtml}
<p style="margin:18px 0 0;">Kind regards,<br><strong style="color:#0B1B1F;">The PowerSmart Team</strong></p></td></tr>
<tr><td align="center" style="padding:20px 12px 6px;">
  <p style="margin:0 0 4px;font-size:12px;color:#6B8288;font-weight:bold;">PowerSmart Pty Ltd &middot; ABN ${Q.ABN}</p>
  <p style="margin:0;font-size:11px;color:#8AA0A5;"><a href="tel:${Q.PHONE_TEL}" style="color:#8AA0A5;">${Q.PHONE_DISPLAY}</a> &middot; ${Q.SUPPORT_EMAIL}</p>
</td></tr></table></td></tr></table></body></html>`;
}
const footerText = () => `\n\nKind regards,\nThe PowerSmart Team\n\nPowerSmart Pty Ltd | ABN ${Q.ABN}\n${Q.PHONE_DISPLAY} | ${Q.SUPPORT_EMAIL}`;
const windowText = (slot) => (slot.slot === "AM" ? "8am-12pm" : "12pm-5pm");

// Booking confirmation for a warranty visit (sent only when the office ticks the box).
function bookingMessages({ name, jobNo, slot, address, note, tomorrow = false }) {
  const first = firstName(name);
  const when = tomorrow ? `tomorrow, ${slot.short}` : slot.short;
  const subject = tomorrow ? `Reminder: your PowerSmart warranty visit is tomorrow, ${slot.short} (${slot.slot})`
    : `Your PowerSmart warranty visit is booked: ${slot.short} (${slot.slot})`;
  const sms = `PowerSmart: Hi ${first}, ${tomorrow ? "a reminder that " : ""}your smoke alarm warranty visit is booked for ${when}, ${slot.slot} slot (${windowText(slot)})${address ? ` at ${address}` : ""}. There is no charge for this visit. Please make sure someone 18+ is home. Questions? Call ${Q.PHONE_DISPLAY}.`;
  const lines = [`Date: ${slot.date}`, `Arrival: ${slot.slot} slot - your electrician will arrive between ${slot.window}`, address ? `Address: ${address}` : ""].filter(Boolean);
  const intro = tomorrow ? "This is a friendly reminder that your smoke alarm warranty visit is booked in for tomorrow."
    : "Thanks for letting us know about your smoke alarm. We've booked an electrician to come and check it under warranty.";
  const text = `Hi ${first},\n\n${intro}\n\n${lines.join("\n")}\n\nThere is no charge for this warranty visit. Your electrician will check the alarm and replace it if it's faulty.\nSomeone aged 18 or over needs to be home to let us in.${note ? `\n\n${note}` : ""}\n\nNeed to change anything? Reply to this email or call ${Q.PHONE_DISPLAY}.` + footerText();
  const html = shell(subject, tomorrow ? "VISIT TOMORROW" : "WARRANTY VISIT", jobNo,
    `<p style="margin:0 0 14px;">Hi ${esc(first)},<br><br>${esc(intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F4F9FA;border:1px solid #D6E8EB;border-radius:12px;"><tr><td style="padding:16px 20px;font-size:14px;color:#0B1B1F;line-height:1.8;">${lines.map(esc).join("<br>")}</td></tr></table>
<p style="margin:14px 0 0;">There is <strong style="color:#0B1B1F;">no charge</strong> for this warranty visit. Your electrician will check the alarm and replace it if it's faulty. Someone aged 18 or over needs to be home to let us in.</p>
${note ? `<p style="margin:14px 0 0;">${esc(note)}</p>` : ""}
<p style="margin:14px 0 0;">Need to change anything? Reply to this email or call ${Q.PHONE_DISPLAY}.</p>`);
  return { subject, sms, text, html };
}

// Sent to the customer after the warranty visit (only when the office ticked the box).
function completionMessages({ name, jobNo, units }) {
  const first = firstName(name);
  const list = (Array.isArray(units) ? units : []).filter(Boolean);
  const rows = list.map((u) => `${u.location || "Other"}: ${u.outcome === "replaced" ? `replaced with a new ${TYPE_WORD[u.type] || "battery"} smoke alarm` : "checked and fixed"}${u.fault ? ` (${u.fault.toLowerCase()})` : ""}`);
  const subject = "Your PowerSmart warranty visit is complete";
  const text = `Hi ${first},\n\nYour smoke alarm warranty visit is complete. Here's what our electrician did:\n\n${rows.map((r) => "- " + r).join("\n")}\n\nThere is no charge for this visit. If you have any more trouble, reply to this email or call ${Q.PHONE_DISPLAY}.` + footerText();
  const html = shell(subject, "WARRANTY COMPLETE", jobNo,
    `<p style="margin:0 0 14px;">Hi ${esc(first)},<br><br>Your smoke alarm warranty visit is complete. Here's what our electrician did:</p>
<ul style="margin:0 0 0 18px;padding:0;color:#0B1B1F;">${rows.map((r) => `<li style="margin:0 0 6px;">${esc(r)}</li>`).join("")}</ul>
<p style="margin:14px 0 0;">There is <strong style="color:#0B1B1F;">no charge</strong> for this visit. If you have any more trouble, reply to this email or call ${Q.PHONE_DISPLAY}.</p>`);
  return { subject, text, html };
}

module.exports = { FAULTS, OUTCOMES, isWarranty, warrantyCounts, unitsSummary, bookingMessages, completionMessages };
