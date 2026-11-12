// Day-before job reminders: at 5pm Brisbane time, every customer whose job is booked for the next day
// is emailed and texted ("your install is booked for <date>, AM/PM slot"). Called by the scheduler in
// supabase/job-reminder-scheduler.sql through /api/pipeline?resource=job-reminders (Bearer worker secret).
// One reminder per job and start time (job_reminders is unique on job_id + scheduled_start), so retries and
// double runs never message a customer twice; moving the job to another day makes it eligible again.
const crypto = require("crypto");
const { randomUUID } = require("crypto");
const SB = require("./_supabase");
const Sms = require("./_sms-outbound");
const S = require("./_senders");
const Q = require("./_quote");
const { logEmail } = require("./_maillog");
const { bookingSlot } = require("./_booking-confirmation");

const TZ = "Australia/Brisbane";
const enc = encodeURIComponent;
const esc = Q.escapeHtml;
const first = (rows) => rows && rows[0];

// Brisbane is UTC+10 all year (no daylight saving), so "tomorrow" is a fixed 24h window.
function tomorrowWindow(now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const start = Date.parse(`${today}T00:00:00+10:00`) + 86400000;
  return { from: new Date(start).toISOString(), to: new Date(start + 86400000).toISOString() };
}

function reminderMessages(job, address) {
  const slot = bookingSlot(job.scheduled_start);
  const firstName = String(job.customer_name || "there").trim().split(/\s+/)[0] || "there";
  const window = slot.slot === "AM" ? "8am-12pm" : "12pm-5pm";
  const sms = `PowerSmart: Hi ${firstName}, a reminder that your smoke alarm install is booked for tomorrow, ${slot.short} (${slot.slot} slot, ${window})${address ? ` at ${address}` : ""}. Please make sure someone 18+ is home. Your electrician will text when on the way. To change, call ${Q.PHONE_DISPLAY} or reply to this SMS.`;
  const subject = `Reminder: your PowerSmart install is tomorrow, ${slot.short} (${slot.slot})`;
  const text = `Hi ${firstName},

This is a friendly reminder that your smoke alarm installation is booked in for tomorrow.

Date: ${slot.date}
Arrival: ${slot.slot} slot - your electrician will arrive between ${slot.window}
${address ? `Address: ${address}\n` : ""}
Before we arrive:
- Someone aged 18 or over needs to be home to let us in.
- Please clear access to the ceiling areas and the switchboard where you can.
- Your electrician will text you when they are on the way.
- You will get your compliance certificate the same day.

Need to change anything? Reply to this email or call ${Q.PHONE_DISPLAY} as soon as you can.

PowerSmart Pty Ltd | ABN ${Q.ABN}`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Install reminder - PowerSmart</title></head>
<body style="margin:0;padding:0;background-color:#EAF2F3;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EAF2F3;"><tr><td align="center" style="padding:26px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="620" style="width:620px;max-width:100%;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="background:#ffffff;border-radius:14px 14px 0 0;padding:26px 32px 22px;border-bottom:3px solid #43A8B6;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
    <td valign="middle"><img src="${S.LOGO || Q.SITE + "/assets/logo/power-smart-logo-full-colour.png"}" alt="Power Smart Co" width="190" style="display:block;width:190px;height:auto;"></td>
    <td valign="middle" align="right"><div style="font-size:18px;font-weight:bold;color:#0B1B1F;letter-spacing:1px;">INSTALL TOMORROW</div>${job.job_no ? `<div style="font-size:12px;color:#6B8288;padding-top:4px;">Job: <strong style="color:#41585D;">J${esc(job.job_no)}</strong></div>` : ""}</td>
  </tr></table>
</td></tr>
<tr><td style="background:#ffffff;padding:24px 32px 6px;"><p style="margin:0;font-size:14px;color:#41585D;line-height:1.65;">Hi ${esc(firstName)},<br><br>This is a friendly reminder that your smoke alarm installation is <strong>booked in for tomorrow</strong>.</p></td></tr>
<tr><td style="background:#ffffff;padding:16px 32px 4px;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F4F9FA;border-radius:12px;border-left:4px solid #43A8B6;"><tr><td style="padding:18px 22px;">
    <div style="font-size:10.5px;letter-spacing:1px;color:#8AA0A5;font-weight:bold;text-transform:uppercase;">Date &amp; arrival</div>
    <div style="font-size:22px;font-weight:bold;color:#0B1B1F;padding:4px 0 2px;">${esc(slot.date)}</div>
    <div style="font-size:15px;color:#41585D;"><strong>${slot.slot} slot</strong> &middot; your electrician will arrive between <strong>${slot.window}</strong></div>
    ${address ? `<div style="height:14px;line-height:14px;">&nbsp;</div><div style="font-size:10.5px;letter-spacing:1px;color:#8AA0A5;font-weight:bold;text-transform:uppercase;">Installation address</div><div style="font-size:14px;color:#0B1B1F;padding-top:4px;">${esc(address)}</div>` : ""}
  </td></tr></table>
</td></tr>
<tr><td style="background:#ffffff;padding:18px 32px 6px;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F4F9FA;border-radius:12px;"><tr><td style="padding:16px 20px;font-size:13px;color:#41585D;line-height:1.7;">
    <strong style="color:#0B1B1F;">Before we arrive</strong><br>
    &bull; Someone aged 18 or over needs to be home to let us in.<br>
    &bull; Please clear access to the ceiling areas and the switchboard where you can.<br>
    &bull; Your electrician will text you when they are on the way.<br>
    &bull; You will get your <strong>compliance certificate the same day</strong>.
  </td></tr></table>
</td></tr>
<tr><td style="background:#ffffff;padding:14px 32px 24px;"><p style="margin:0;font-size:13px;color:#41585D;line-height:1.65;">Need to change anything? Reply to this email or call <a href="tel:${Q.PHONE_TEL}" style="color:#398ea0;font-weight:bold;">${Q.PHONE_DISPLAY}</a> as soon as you can.</p></td></tr>
<tr><td align="center" style="background:#ffffff;border-radius:0 0 14px 14px;border-top:1px solid #E5EEEF;padding:18px 32px 24px;">
  <p style="margin:0 0 4px;font-size:12px;color:#6B8288;font-weight:bold;">PowerSmart Pty Ltd &middot; ABN ${Q.ABN}</p>
  <p style="margin:0;font-size:11px;color:#8AA0A5;">${Q.SUPPORT_EMAIL}</p>
</td></tr></table></td></tr></table></body></html>`;
  return { sms, subject, text, html, slot };
}

function jobAddress(job) {
  return [job.address, [job.suburb, job.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

// Sends one job's reminder. `claimed` is the job_reminders row this run owns.
async function sendOne(job, now) {
  const address = jobAddress(job);
  const m = reminderMessages(job, address);
  const result = { job_no: job.job_no, email: "skipped", sms: "skipped" };
  const toEmail = String(job.email || "").trim().toLowerCase();
  if (toEmail && (process.env.EMAIL_PROVIDER === 'zoho' ? (process.env.ZOHO_SMTP_USER && process.env.ZOHO_SMTP_PASSWORD) : process.env.EMAIL_PROVIDER === 'hostinger' ? (process.env.HOSTINGER_SMTP_USER && process.env.HOSTINGER_SMTP_PASSWORD) : process.env.RESEND_API_KEY)) {
    try {
      const { Resend } = require(process.env.EMAIL_PROVIDER === 'zoho' ? './_zoho-mail' : process.env.EMAIL_PROVIDER === 'hostinger' ? './_hostinger-mail' : 'resend');
      const sender = S.resolveSender("customer_service");
      const { data, error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
        from: S.fromHeader(sender.key), to: toEmail,
        replyTo: process.env.RESEND_REPLY_TO || Q.SUPPORT_EMAIL, bcc: process.env.NOTIFY_EMAIL || Q.SUPPORT_EMAIL,
        subject: m.subject, html: m.html, text: m.text,
      });
      if (error) throw new Error(error.message || "Email provider rejected the request");
      result.email = "sent";
      try { await logEmail({ id: randomUUID(), kind: "email", sender: sender.key, agent: "System", to_email: toEmail, to_name: job.customer_name, subject: m.subject, body_html: m.html, body_text: m.text, lead_id: job.lead_id || null, provider_id: data && data.id }); } catch (_) { /* log is best effort */ }
    } catch (e) { result.email = "failed"; result.error = e.message; }
  }
  if (job.phone && Sms.smsEnabled()) {
    try {
      const r = await Sms.sendLeadSms({ lead: { id: job.lead_id || undefined, phone: job.phone }, message: m.sms, key: `job-reminder-${job.id}-${job.scheduled_start}`, author: "System" });
      result.sms = r.status === "submitted" ? "sent" : r.status;
    } catch (e) { result.sms = "failed"; result.error = [result.error, e.message].filter(Boolean).join(" | "); }
  }
  if (job.lead_id && (result.email === "sent" || result.sms === "sent")) {
    try {
      await SB.sb("lead_comments", { method: "POST", body: { lead_id: job.lead_id, author: "System", kind: "email", body: `Day-before reminder sent (${[result.email === "sent" && "email", result.sms === "sent" && "SMS"].filter(Boolean).join(" and ")}) for ${m.slot.date}, ${m.slot.slot} slot.` }, prefer: "return=minimal" });
    } catch (_) { /* note is best effort */ }
  }
  return result;
}

// Finds tomorrow's booked jobs that have no reminder yet and sends them. `dryRun` only reports who would be messaged.
async function work({ now = new Date(), dryRun = false } = {}) {
  const { from, to } = tomorrowWindow(now);
  const cols = "id,job_no,lead_id,customer_name,phone,email,scheduled_start,address,suburb,postcode";
  const jobs = await SB.sb(`jobs?status=eq.scheduled&scheduled_start=gte.${enc(from)}&scheduled_start=lt.${enc(to)}&select=${cols}&order=scheduled_start.asc&limit=200`) || [];
  const out = { window: { from, to }, found: jobs.length, sent: 0, skipped: 0, failed: 0, results: [] };
  for (const job of jobs) {
    if (!job.phone && !job.email) { out.skipped++; out.results.push({ job_no: job.job_no, skipped: "No phone or email saved" }); continue; }
    if (dryRun) { out.results.push({ job_no: job.job_no, would_send: true }); continue; }
    // Claim first: the unique (job_id, scheduled_start) key means only one run can ever message this job at this time.
    try {
      await SB.sb("job_reminders", { method: "POST", body: { job_id: job.id, scheduled_start: job.scheduled_start }, prefer: "return=minimal" });
    } catch (e) {
      if (e.status === 409) { out.skipped++; continue; }           // already reminded
      throw e;
    }
    const r = await sendOne(job, now);
    const ok = r.email === "sent" || r.sms === "sent";
    ok ? out.sent++ : out.failed++;
    out.results.push(r);
    try {
      await SB.sb(`job_reminders?job_id=eq.${enc(job.id)}&scheduled_start=eq.${enc(job.scheduled_start)}`, { method: "PATCH", body: { finished_at: new Date().toISOString(), email_status: r.email, sms_status: r.sms, error: r.error || null }, prefer: "return=minimal" });
    } catch (_) { /* status row is informational */ }
  }
  return out;
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
    const action = req.body && req.body.action;
    if (action === "run") {
      const config = first(await SB.sb("job_reminder_worker?id=eq.true&select=secret,active&limit=1"));
      const supplied = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer /, ""));
      const expected = Buffer.from((config && config.secret) || "");
      if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(401).json({ error: "Invalid worker credentials" });
      if (!config.active) return res.status(200).json({ skipped: "Worker paused" });
      const result = await work();
      await SB.sb("job_reminder_worker?id=eq.true", { method: "PATCH", body: { last_run_at: new Date().toISOString(), last_result: result }, prefer: "return=minimal" });
      return res.status(200).json(result);
    }
    if (req.headers["x-portal-key"] !== "2026") return res.status(401).json({ error: "Invalid portal key" });
    if (action === "preview") return res.status(200).json(await work({ dryRun: true }));
    return res.status(400).json({ error: "Unknown action" });
  } catch (e) { console.error("Job reminders:", e.message); return res.status(503).json({ error: e.message || "Job reminders unavailable" }); }
}

module.exports = { handler, work, tomorrowWindow, reminderMessages };
