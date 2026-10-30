// Booking confirmation email for a scheduled lead (pipeline action "booking_confirmation").
// Customers are only given an AM (8am-12pm) or PM (12pm-5pm) arrival slot, never an exact time.
const Q = require("./_quote");
const SB = require("./_supabase");
const S = require("./_senders");
const { logEmail } = require("./_maillog");
const { randomUUID } = require("crypto");

const TZ = "Australia/Brisbane";
const esc = Q.escapeHtml;
const fmt = Q.fmt;

function bookingSlot(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const hour = Number(new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hour: "numeric", hour12: false }).format(d)) % 24;
  const isAm = hour < 12;
  const date = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
  const short = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(d).replace(",", "");
  return { date, short, slot: isAm ? "AM" : "PM", window: isAm ? "8:00am and 12:00pm" : "12:00pm and 5:00pm" };
}

function renderBookingEmail({ name, jobNo, quoteRef, quoteTotal, feePaid, address, slot, quoteUrl }) {
  const first = String(name || "there").trim().split(/\s+/)[0] || "there";
  const balance = quoteTotal != null ? Math.max(0, quoteTotal - (feePaid || 0)) : null;
  const row = (label, value, color) => `<tr><td colspan="2" style="padding:4px 12px;color:${color || "#41585D"};">${label}</td><td align="right" style="padding:4px 12px;color:${color || "#41585D"};">${value}</td></tr>`;
  const quoteBlock = quoteTotal != null ? `
<tr><td style="background:#ffffff;padding:20px 32px 4px;">
  <div style="font-size:15px;font-weight:bold;color:#0B1B1F;padding-bottom:8px;">Your quote${quoteRef ? ` (${esc(quoteRef)})` : ""}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-size:13px;">
    ${row("Total (incl. GST)", fmt(quoteTotal), "#0B1B1F")}
    ${feePaid ? row("Booking fee paid", "-" + fmt(feePaid), "#32925d") : ""}
    <tr><td colspan="2" style="padding:10px 12px;font-weight:bold;color:#0B1B1F;background:#F4F9FA;border-radius:8px 0 0 8px;">Balance due on the day</td><td align="right" style="padding:10px 12px;font-weight:bold;color:#0B1B1F;background:#F4F9FA;border-radius:0 8px 8px 0;">${fmt(balance)}</td></tr>
  </table>
  ${quoteUrl ? `<p style="margin:10px 0 0;font-size:12px;"><a href="${esc(quoteUrl)}" style="color:#398ea0;">View your full quote</a></p>` : ""}
</td></tr>` : "";
  const balanceLine = balance != null ? `<br>&bull; The balance of <strong>${fmt(balance)}</strong> is payable on the day, after installation.` : "";

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Booking confirmed - PowerSmart</title></head>
<body style="margin:0;padding:0;background-color:#EAF2F3;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your smoke alarm installation is booked for ${esc(slot.date)} (${slot.slot} slot).</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EAF2F3;"><tr><td align="center" style="padding:26px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="620" style="width:620px;max-width:100%;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="background:#ffffff;border-radius:14px 14px 0 0;padding:26px 32px 22px;border-bottom:3px solid #43A8B6;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
    <td valign="middle"><img src="${S.LOGO || Q.SITE + "/assets/logo/power-smart-logo-full-colour.png"}" alt="Power Smart Co" width="190" style="display:block;width:190px;height:auto;"></td>
    <td valign="middle" align="right"><div style="font-size:18px;font-weight:bold;color:#0B1B1F;letter-spacing:1px;">BOOKING CONFIRMED</div>${jobNo || quoteRef ? `<div style="font-size:12px;color:#6B8288;padding-top:4px;">${jobNo ? `Job: <strong style="color:#41585D;">J${esc(jobNo)}</strong>` : ""}${jobNo && quoteRef ? " &middot; " : ""}${quoteRef ? `Quote: <strong style="color:#41585D;">${esc(quoteRef)}</strong>` : ""}</div>` : ""}</td>
  </tr></table>
</td></tr>
<tr><td style="background:#ffffff;padding:24px 32px 6px;"><p style="margin:0;font-size:14px;color:#41585D;line-height:1.65;">Hi ${esc(first)},<br><br>Thanks for booking with PowerSmart. Your smoke alarm installation is <strong>booked in</strong>. Here are the details.</p></td></tr>
<tr><td style="background:#ffffff;padding:16px 32px 4px;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F4F9FA;border-radius:12px;border-left:4px solid #43A8B6;"><tr><td style="padding:18px 22px;">
    <div style="font-size:10.5px;letter-spacing:1px;color:#8AA0A5;font-weight:bold;text-transform:uppercase;">Date &amp; arrival</div>
    <div style="font-size:22px;font-weight:bold;color:#0B1B1F;padding:4px 0 2px;">${esc(slot.date)}</div>
    <div style="font-size:15px;color:#41585D;"><strong>${slot.slot} slot</strong> &middot; your electrician will arrive between <strong>${slot.window}</strong></div>
    ${address ? `<div style="height:14px;line-height:14px;">&nbsp;</div>
    <div style="font-size:10.5px;letter-spacing:1px;color:#8AA0A5;font-weight:bold;text-transform:uppercase;">Installation address</div>
    <div style="font-size:14px;color:#0B1B1F;padding-top:4px;">${esc(address)}</div>` : ""}
  </td></tr></table>
</td></tr>
${quoteBlock}
<tr><td style="background:#ffffff;padding:18px 32px 6px;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F4F9FA;border-radius:12px;"><tr><td style="padding:16px 20px;font-size:13px;color:#41585D;line-height:1.7;">
    <strong style="color:#0B1B1F;">Before we arrive</strong><br>
    &bull; Someone aged 18 or over needs to be home to let us in.<br>
    &bull; Please clear access to the ceiling areas and the switchboard where you can.<br>
    &bull; Your electrician will text you when they are on the way, so you will know your arrival time on the day.<br>
    &bull; You will get your <strong>compliance certificate the same day</strong>.${balanceLine}
  </td></tr></table>
</td></tr>
<tr><td style="background:#ffffff;padding:14px 32px 24px;"><p style="margin:0;font-size:13px;color:#41585D;line-height:1.65;">Need to change the day or slot? Reply to this email or call <a href="tel:${Q.PHONE_TEL}" style="color:#398ea0;font-weight:bold;">${Q.PHONE_DISPLAY}</a> at least 24 hours before and we will move you.</p></td></tr>
<tr><td align="center" style="background:#ffffff;border-radius:0 0 14px 14px;border-top:1px solid #E5EEEF;padding:18px 32px 24px;">
  <p style="margin:0 0 4px;font-size:12px;color:#6B8288;font-weight:bold;">PowerSmart Pty Ltd &middot; ABN ${Q.ABN}</p>
  <p style="margin:0;font-size:11px;color:#8AA0A5;">${Q.PHONE_DISPLAY} &middot; ${Q.SUPPORT_EMAIL}</p>
</td></tr>
</table></td></tr></table></body></html>`;

  const text = `BOOKING CONFIRMED - PowerSmart

Hi ${first},

Your smoke alarm installation is booked in.

Date: ${slot.date}
Arrival: ${slot.slot} slot - your electrician will arrive between ${slot.window}
${address ? `Address: ${address}\n` : ""}${quoteTotal != null ? `\nQuote${quoteRef ? " " + quoteRef : ""} total (incl. GST): ${fmt(quoteTotal)}\n${feePaid ? `Booking fee paid: -${fmt(feePaid)}\n` : ""}Balance due on the day: ${fmt(balance)}\n${quoteUrl ? `View your quote: ${quoteUrl}\n` : ""}` : ""}
Before we arrive:
- Someone aged 18 or over needs to be home to let us in.
- Please clear access to the ceiling areas and the switchboard where you can.
- Your electrician will text you when they are on the way.
- You will get your compliance certificate the same day.

Need to change the day or slot? Reply to this email or call ${Q.PHONE_DISPLAY} at least 24 hours before.

PowerSmart Pty Ltd | ABN ${Q.ABN}`;
  return { html, text };
}

// Sends the confirmation for the lead's next booked visit. Throws errors with .status for the API layer.
async function sendBookingConfirmation({ leadId, sendAs, agent }) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw fail(500, "Email service is not configured (missing RESEND_API_KEY)");
  const id = encodeURIComponent(leadId);
  const lead = (await SB.sb(`leads?id=eq.${id}&select=id,name,email,address_line1,address_suburb,address_state,address_postcode,quote_ref,quote_total&limit=1`))?.[0];
  if (!lead) throw fail(404, "Lead not found");
  if (!lead.email) throw fail(400, "Add an email address before sending a booking confirmation");
  const jobs = await SB.sb(`jobs?lead_id=eq.${id}&status=in.(scheduled,en_route,on_site)&scheduled_start=not.is.null&select=job_no,scheduled_start,address,suburb,postcode&order=scheduled_start.asc&limit=20`);
  const cutoff = Date.now() - 12 * 3600 * 1000;
  const job = (jobs || []).find((j) => Date.parse(j.scheduled_start) >= cutoff) || (jobs || [])[jobs.length - 1];
  if (!job) throw fail(400, "No scheduled job found for this customer. Schedule the job first.");
  const slot = bookingSlot(job.scheduled_start);
  if (!slot) throw fail(400, "The scheduled job has an invalid date");

  const address = lead.address_line1 && lead.address_suburb
    ? [lead.address_line1, [lead.address_suburb, lead.address_state, lead.address_postcode].filter(Boolean).join(" ")].join(", ")
    : [job.address, [job.suburb, job.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");

  let feePaid = 0, quoteUrl = "";
  try {
    const pay = await SB.sb(`payment_requests?lead_id=eq.${id}&payment_type=eq.booking_fee&status=eq.paid&select=amount_paid_cents&order=created_at.desc&limit=1`);
    feePaid = pay?.[0]?.amount_paid_cents ? pay[0].amount_paid_cents / 100 : 0;
  } catch (_) { /* payment tracking is optional */ }
  try {
    const ref = lead.quote_ref ? `&quote_ref=eq.${encodeURIComponent(lead.quote_ref)}` : "";
    const q = await SB.sb(`sent_emails?kind=eq.quote&status=eq.sent&lead_id=eq.${id}${ref}&select=id&order=created_at.desc&limit=1`);
    if (q?.[0]) quoteUrl = `${Q.SITE}/quote?token=${q[0].id}`;
  } catch (_) { /* link is optional */ }

  const sender = S.resolveSender(sendAs);
  const { html, text } = renderBookingEmail({
    name: lead.name, jobNo: job.job_no, quoteRef: lead.quote_ref,
    quoteTotal: lead.quote_total != null ? Number(lead.quote_total) : null, feePaid, address, slot, quoteUrl,
  });
  const subject = `Your PowerSmart booking is confirmed: ${slot.short} (${slot.slot})`;
  const { Resend } = require("resend");
  const { data, error } = await new Resend(apiKey).emails.send({
    from: S.fromHeader(sender.key), to: lead.email,
    replyTo: process.env.RESEND_REPLY_TO || Q.SUPPORT_EMAIL, bcc: process.env.NOTIFY_EMAIL || Q.SUPPORT_EMAIL,
    subject, html, text,
  });
  if (error) throw fail(502, error.message || "Email provider rejected the request");
  await logEmail({ id: randomUUID(), kind: "email", sender: sender.key, agent, to_email: lead.email, to_name: lead.name, subject, body_html: html, body_text: text, lead_id: lead.id, provider_id: data && data.id });
  try {
    await SB.sb("lead_comments", { method: "POST", body: { lead_id: lead.id, author: agent || "System", kind: "email", body: `Booking confirmation emailed to ${lead.email}: ${slot.date}, ${slot.slot} slot.` }, prefer: "return=minimal" });
  } catch (e) { console.error("booking confirmation note failed:", e.message); }
  return { ok: true, to: lead.email, date: slot.date, slot: slot.slot };
}

module.exports = { bookingSlot, renderBookingEmail, sendBookingConfirmation };
