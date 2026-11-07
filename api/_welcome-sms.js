const SB = require('./_supabase');
const Sms = require('./_sms-outbound');

function welcomeMessage(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  return `Hi ${first},

Thanks for contacting PowerSmart regarding your smoke alarms! We've received your enquiry, and our team will be in touch within the next 24 hours.

Prefer to communicate via SMS? No problem! Simply reply with:

Number of bedrooms

Number of levels (single or double-storey)

Number of hallways

If double-storey, which level the bedrooms are located on

We'll use these details to prepare and send you a quote.

Alternatively, let us know the best time to call, and we'll arrange a callback at a time that suits you.

Kind regards,
PowerSmart Team`;
}

// Runs only at lead creation. SMS failures must never reject a saved enquiry.
async function welcomeLead(lead, now = new Date()) {
  if (!lead?.id || lead.stage !== 'new_lead') return { status: 'skipped' };
  if (!Sms.smsEnabled()) return { status: 'skipped', paused: true }; // SMS paused: the enquiry confirmation email covers this
  const message = welcomeMessage(lead.name), phone = Sms.cleanPhone(lead.phone);
  try {
    if (!/^\+[1-9]\d{7,14}$/.test(phone) || (phone.startsWith('+61') && !/^\+614\d{8}$/.test(phone))) throw new Error('No valid customer mobile number.');
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const recent = await SB.sb(`sms_messages?phone_number=eq.${encodeURIComponent(phone)}&direction=eq.outbound&message=like.${encodeURIComponent(welcomeMessage('*'))}&created_at=gte.${encodeURIComponent(since)}&status=in.(sent,pending,unknown)&select=status&order=created_at.desc&limit=1`);
    if (recent?.length) {
      const confirmed = recent[0].status === 'sent';
      await Sms.logNote(lead.id, 'System', `Welcome SMS not repeated: an earlier submission to ${phone} is ${confirmed ? 'already recorded within the last 24 hours' : 'pending or uncertain'}. Message: ${message}`);
      return { status: 'skipped', duplicate: true, ...(confirmed ? {} : { error: 'An earlier welcome SMS is pending or uncertain. Check the SMS inbox.' }) };
    }
    return await Sms.sendLeadSms({ lead, message, key: `welcome-${phone}-${now.toISOString().slice(0,10)}`, author: 'System' });
  } catch (error) {
    try { await Sms.logNote(lead.id, 'System', `Welcome SMS issue: ${error.message} Message: ${message}`); } catch (_) {}
    console.error('PowerSmart welcome SMS:', error.message);
    return { status: 'failed', error: error.message };
  }
}
module.exports = { welcomeMessage, welcomeLead };
