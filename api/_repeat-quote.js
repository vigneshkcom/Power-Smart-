// Existing quotation follow-up for genuine repeat enquiries.
// Internal module only: does not create another Vercel Function.
const SB = require('./_supabase');
const Q = require('./_quote');
const S = require('./_senders');

async function latestSentQuote(lead, enquiryEmail) {
  if (!lead?.id) return null;
  const fields = 'id,quote_ref,to_email,created_at';
  const byLead = await SB.sb('sent_emails?lead_id=eq.' + encodeURIComponent(lead.id) +
    '&kind=eq.quote&status=eq.sent&select=' + fields + '&order=created_at.desc&limit=1');
  if (byLead?.[0]) return byLead[0];

  // Older quotations may not be linked to a lead. Match on its ORIGINAL
  // stored email only, never an unverified new address supplied in an enquiry.
  const original = String(lead.email || '').trim().toLowerCase();
  if (!original || original !== String(enquiryEmail || '').trim().toLowerCase()) return null;
  const byEmail = await SB.sb('sent_emails?to_email=eq.' + encodeURIComponent(original) +
    '&kind=eq.quote&status=eq.sent&select=' + fields + '&order=created_at.desc&limit=1');
  return byEmail?.[0] || null;
}

function repeatQuoteMessages(name, quote) {
  const first = String(name || 'there').trim().split(/\s+/)[0] || 'there';
  const ref = String(quote.quote_ref || '').trim();
  const url = Q.QUOTE_SITE + '/quote?token=' + encodeURIComponent(quote.id);
  const sms = 'Hi ' + first + ', thanks for getting in touch with PowerSmart again. ' +
    'We have already sent you a smoke alarm quotation. You can view it here: ' + url +
    '\n\nIf you have any questions or would like to speak with someone, just reply to this SMS ' +
    'or let us know a good time to call. PowerSmart';
  const subject = 'Your existing PowerSmart smoke alarm quotation' + (ref ? ' (' + ref + ')' : '');
  const plain = 'Hi ' + first + ',\n\nThank you for contacting PowerSmart again. ' +
    'We have already sent you a quotation for your smoke alarm installation.\n\n' +
    'View your quotation here: ' + url +
    '\n\nIf you have any questions, would like to update your quotation, or prefer to speak ' +
    'with someone, simply reply to this email or let us know a good time to call. ' +
    'You can also call us on ' + Q.PHONE_DISPLAY + '.\n\nKind regards,\nPowerSmart Team';
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head>' +
    '<body style="background:#eaf2f3;margin:0;padding:26px 12px;font-family:Arial,sans-serif;color:#41585d">' +
    '<div style="max-width:600px;background:#fff;margin:auto;padding:28px 32px;border-radius:12px">' +
    '<p>Hi ' + S.escapeHtml(first) + ',</p>' +
    '<p>Thank you for contacting PowerSmart again. We have already sent you a smoke alarm quotation.</p>' +
    '<p><a href="' + S.escapeHtml(url) + '" style="display:inline-block;background:#43a8b6;color:#0b1b1f;padding:13px 20px;border-radius:8px;text-decoration:none;font-weight:bold">View your quotation</a></p>' +
    '<p>If you have any questions, would like to update your quote, or wish to speak with someone, ' +
    'reply to this email or let us know a convenient time to call. You can also call ' + Q.PHONE_DISPLAY + '.</p>' +
    S.signatureHtml('customer_service') + '</div></body></html>';
  return { url, sms, subject, html, text: plain };
}
module.exports = { latestSentQuote, repeatQuoteMessages };
