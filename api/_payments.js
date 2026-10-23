const SB = require('./_supabase');

const TYPES = { booking_fee: 'Booking fee', inspection: 'Inspection', installation_balance: 'Installation balance', other: 'Pending balance' };
function amountCents(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) throw new Error('Enter a valid AUD amount with no more than two decimal places.');
  const [dollars, cents = ''] = text.split('.');
  const amount = Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
  if (amount < 50 || amount > 99999999) throw new Error('Enter an amount between $0.50 and $999,999.99.');
  return amount;
}
function checkoutUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') throw new Error('Stripe returned an invalid checkout link.');
  return url.href;
}
async function note(leadId, author, body) {
  // Checking the exact body also repairs a note if an earlier write failed.
  const found = await SB.sb(`lead_comments?lead_id=eq.${encodeURIComponent(leadId)}&kind=eq.payment&body=eq.${encodeURIComponent(body)}&select=id&limit=1`);
  if (!found || !found.length) await SB.sb('lead_comments', { method: 'POST', body: { lead_id: leadId, author, kind: 'payment', body }, prefer: 'return=minimal' });
}
async function reconcile(payment, session, eventId) {
  if (session.id !== payment.stripe_session_id || session.metadata?.lead_id !== payment.lead_id || session.currency !== payment.currency || session.amount_total !== payment.amount_cents) {
    throw new Error('Stripe payment details do not match the customer payment request.');
  }
  if (session.payment_status === 'paid') {
    const paidAt = payment.paid_at || new Date().toISOString();
    if (payment.status !== 'paid') await SB.sb(`payment_requests?id=eq.${encodeURIComponent(payment.id)}&status=neq.paid`, { method: 'PATCH', body: {
      status: 'paid', amount_paid_cents: session.amount_total, stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
      ...(eventId ? { stripe_event_id: eventId } : {}), paid_at: paidAt,
    }, prefer: 'return=minimal' });
    await note(payment.lead_id, 'Stripe', `${TYPES[payment.payment_type] || 'Payment'} paid: $${(session.amount_total / 100).toFixed(2)} AUD. ${payment.description || 'Booking fee'}. Stripe checkout: ${session.id}.`);
    return { ...payment, status: 'paid', amount_paid_cents: session.amount_total, paid_at: paidAt };
  }
  if (session.status === 'expired' && payment.status !== 'paid') {
    await SB.sb(`payment_requests?id=eq.${encodeURIComponent(payment.id)}&status=neq.paid`, { method: 'PATCH', body: { status: 'expired' }, prefer: 'return=minimal' });
    return { ...payment, status: 'expired' };
  }
  return payment;
}
module.exports = { TYPES, amountCents, checkoutUrl, note, reconcile };
