const SB = require('./_supabase');

const requestFields = 'id,lead_id,quote_ref,payment_type,description,status,amount_cents,amount_paid_cents,paid_at,sent_at,stripe_session_id';
const jobFields = 'id,job_no,lead_id,quote_ref,pay_status,paid_cents,paid_at,pay_session_id';

function jobPayments(jobs) {
  return (jobs || []).filter(j => j.pay_status === 'paid').map(j => ({
    id: `job:${j.id}`, lead_id: j.lead_id, quote_ref: j.quote_ref,
    payment_type: 'installation_balance', description: `Job J${j.job_no} payment`,
    status: 'paid', amount_paid_cents: j.paid_cents, paid_at: j.paid_at,
    stripe_session_id: j.pay_session_id, source: 'job',
  }));
}

function summarize(quote, records) {
  const total = Math.round(Number(quote.quote_total) * 100);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Quote total is unavailable.');
  const seen = new Set();
  const payments = (records || []).filter(p => {
    if (!quote.lead_id || !quote.quote_ref || p.lead_id !== quote.lead_id || p.quote_ref !== quote.quote_ref || p.status !== 'paid') return false;
    if (!Number.isSafeInteger(p.amount_paid_cents) || p.amount_paid_cents <= 0) return false;
    const key = p.stripe_session_id || p.id;
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).map(p => ({ id: p.id, type: p.payment_type, description: p.description || 'Payment', amount_cents: p.amount_paid_cents, paid_at: p.paid_at || null, source: p.source || 'payment_request' }));
  const received = payments.reduce((sum, p) => sum + p.amount_cents, 0);
  const booking = payments.filter(p => p.type === 'booking_fee').reduce((sum, p) => sum + p.amount_cents, 0);
  return {
    quote_ref: quote.quote_ref, total_cents: total, received_cents: received,
    booking_paid_cents: booking, other_paid_cents: received - booking,
    pending_cents: Math.max(0, total - received), overpaid_cents: Math.max(0, received - total),
    status: received > total ? 'overpaid' : received === total && received > 0 ? 'paid' : received > 0 ? 'part_paid' : 'unpaid',
    last_paid_at: payments.map(p => p.paid_at).filter(Boolean).sort((a,b) => new Date(b) - new Date(a))[0] || null,
    payments,
  };
}

async function read(quote) {
  if (!quote.lead_id || !quote.quote_ref) return summarize(quote, []);
  const filter = `lead_id=eq.${encodeURIComponent(quote.lead_id)}&quote_ref=eq.${encodeURIComponent(quote.quote_ref)}`;
  const [requests, jobs] = await Promise.all([
    SB.sb(`payment_requests?${filter}&select=${requestFields}&order=created_at.desc&limit=1000`),
    SB.sb(`jobs?${filter}&pay_status=eq.paid&select=${jobFields}&limit=1000`),
  ]);
  return summarize(quote, [...requests || [], ...jobPayments(jobs)]);
}

module.exports = { requestFields, jobFields, jobPayments, summarize, read };
