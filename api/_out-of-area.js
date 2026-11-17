// Out-of-area handling: which postcodes we don't service, and the SMS + email telling the customer so.
// Underscore prefix => not a Vercel route. Used by /api/lead (new enquiries) and /api/pipeline (manual moves).
//
// Only Regional Queensland (4600-4899) is out of area for now. This must stay in step with the
// "Regional QLD" range in the AREA_RANGES list of tools/pipeline.html (tests/out-of-area.test.js checks it).
// A missing or unrecognised postcode is treated as in area, so nobody is told "we don't service you" by mistake.

const SB = require('./_supabase');
const Sms = require('./_sms-outbound');
const S = require('./_senders');
const Q = require('./_quote');
const { logEmail } = require('./_maillog');

const OUT_OF_AREA_RANGES = [[4600, 4899, 'Regional QLD']];
// Customers we already hold a quote or job for are never re-classified by a new enquiry's postcode.
const PROTECTED_STAGES = ['quote_sent', 'quote_accepted', 'scheduled', 'won'];

function outOfAreaName(postcode) {
  const n = parseInt(String(postcode == null ? '' : postcode).trim(), 10);
  if (!n) return '';
  const hit = OUT_OF_AREA_RANGES.find(([lo, hi]) => n >= lo && n <= hi);
  return hit ? hit[2] : '';
}
const isOutOfArea = (postcode) => Boolean(outOfAreaName(postcode));
// Same precedence as the board: the installation address postcode wins over the enquiry postcode.
const leadPostcode = (lead) => (lead && (lead.address_postcode || lead.postcode)) || '';

function outOfAreaMessages(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const sms = `Hi ${first},

Thanks for contacting PowerSmart about your smoke alarms. Unfortunately we don't currently service your area, so we're unable to help with your enquiry.

We're sorry for the inconvenience and appreciate you thinking of us.

Kind regards,
PowerSmart Team`;
  const subject = 'About your PowerSmart smoke alarm enquiry';
  const e = Q.escapeHtml(first);
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${subject}</title></head>
<body style="margin:0;padding:0;background-color:#EAF2F3;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Unfortunately we don't currently service your area.</div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EAF2F3;"><tr><td align="center" style="padding:26px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="620" style="width:620px;max-width:100%;font-family:Arial,Helvetica,sans-serif;">
      <tr><td style="background:#ffffff;border-radius:14px 14px 0 0;padding:26px 32px 22px;border-bottom:3px solid #43A8B6;">
        <img src="${Q.SITE}/assets/logo/power-smart-logo-full-colour.png" alt="Power Smart Co" width="190" style="display:block;width:190px;height:auto;">
      </td></tr>
      <tr><td style="background:#ffffff;padding:28px 32px 8px;">
        <h1 style="margin:0 0 12px;font-size:22px;color:#0B1B1F;line-height:1.3;">Hi ${e}, thanks for contacting us</h1>
        <p style="margin:0 0 12px;font-size:15px;color:#41585D;line-height:1.65;">Thanks for your enquiry about smoke alarms. Unfortunately we <strong style="color:#0B1B1F;">don't currently service your area</strong>, so we're unable to help with your enquiry.</p>
        <p style="margin:0;font-size:15px;color:#41585D;line-height:1.65;">We're sorry for the inconvenience and appreciate you thinking of us.</p>
      </td></tr>
      <tr><td style="background:#ffffff;border-radius:0 0 14px 14px;padding:18px 32px 28px;font-size:14px;color:#41585D;line-height:1.6;">Kind regards,<br><strong style="color:#0B1B1F;">The PowerSmart Team</strong></td></tr>
      <tr><td align="center" style="padding:20px 12px 6px;">
        <p style="margin:0 0 4px;font-size:12px;color:#6B8288;font-weight:bold;">PowerSmart Pty Ltd &middot; ABN ${Q.ABN}</p>
        <p style="margin:0;font-size:11px;color:#8AA0A5;">${Q.SUPPORT_EMAIL} &middot; <a href="${Q.SITE}" style="color:#8AA0A5;">smokealarms.powersmartco.com.au</a></p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  const text = `Hi ${first}, thanks for contacting us.

Thanks for your enquiry about smoke alarms. Unfortunately we don't currently service your area, so we're unable to help with your enquiry.

We're sorry for the inconvenience and appreciate you thinking of us.

Kind regards,
The PowerSmart Team

PowerSmart Pty Ltd | ABN ${Q.ABN}
${Q.SUPPORT_EMAIL}
${Q.SITE}`;
  return { sms, subject, html, text };
}

async function sendOutOfAreaSms(lead, msg, agent) {
  const note = (t) => Sms.logNote(lead.id, agent, t).catch(() => {});
  if (!String(lead.phone || '').trim()) { await note('Out-of-area SMS not sent: no mobile number on file.'); return { status: 'skipped', reason: 'no phone' }; }
  try {
    if (Sms.smsEnabled()) {
      // Already sent (or in flight) to this number: never text the same customer twice.
      const phone = Sms.cleanPhone(lead.phone);
      const prior = await SB.sb(`sms_messages?phone_number=eq.${encodeURIComponent(phone)}&direction=eq.outbound&message=eq.${encodeURIComponent(msg.sms)}&status=neq.failed&select=status&limit=1`);
      if (prior && prior.length) return { status: 'skipped', duplicate: true };
    }
    const result = await Sms.sendLeadSms({ lead, message: msg.sms, key: `out-of-area-${lead.id}`, author: agent });
    if (result && result.paused) await note('Out-of-area SMS not sent: SMS sending is paused.');
    return result;
  } catch (err) {
    await note(`Out-of-area SMS not sent: ${err.message}`);
    return { status: 'failed', error: err.message };
  }
}

async function sendOutOfAreaEmail(lead, msg, agent) {
  const note = (t) => Sms.logNote(lead.id, agent, t).catch(() => {});
  const to = String(lead.email || '').trim().toLowerCase();
  if (!to) return { status: 'skipped', reason: 'no email' };
  try {
    try {
      const prior = await SB.sb(`sent_emails?lead_id=eq.${encodeURIComponent(lead.id)}&subject=eq.${encodeURIComponent(msg.subject)}&status=eq.sent&select=id&limit=1`);
      if (prior && prior.length) return { status: 'skipped', duplicate: true };
    } catch (_) { /* email log unavailable: carry on */ }
    const { Resend } = require('./_transactional-mail'); // lazy, like the other senders: keeps mail libraries out of module load
    const { data, error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: S.fromHeader('customer_service'), to, replyTo: Q.SUPPORT_EMAIL,
      subject: msg.subject, html: msg.html, text: msg.text,
    });
    if (error) throw new Error(error.message || 'Email provider rejected the request');
    await logEmail({ kind: 'email', sender: 'customer_service', agent, to_email: to, to_name: lead.name, subject: msg.subject,
      body_html: msg.html, body_text: msg.text, lead_id: lead.id, provider_id: data && data.id, status: 'sent' });
    await note(`Out-of-area email sent to ${to}.`);
    return { status: 'sent' };
  } catch (err) {
    await note(`Out-of-area email not sent: ${err.message}`);
    return { status: 'failed', error: err.message };
  }
}

// Texts and emails the customer that we don't service their area. Never throws: failures are logged on the lead.
// lead: { id, name, phone, email }.  opts: { agent, sms:false, email:false }
async function notifyOutOfArea(lead, opts = {}) {
  const result = { sms: { status: 'skipped' }, email: { status: 'skipped' } };
  if (!lead || !lead.id) return result;
  const agent = opts.agent || 'System', msg = outOfAreaMessages(lead.name);
  if (opts.sms !== false) result.sms = await sendOutOfAreaSms(lead, msg, agent);
  if (opts.email !== false) result.email = await sendOutOfAreaEmail(lead, msg, agent);
  return result;
}

module.exports = { OUT_OF_AREA_RANGES, PROTECTED_STAGES, outOfAreaName, isOutOfArea, leadPostcode, outOfAreaMessages, notifyOutOfArea };
