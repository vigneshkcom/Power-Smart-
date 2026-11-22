const Revolut = require('./_revolut');
const SB = require('./_supabase');
const Payments = require('./_payments');

async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const parts = [];
  for await (const part of req) parts.push(Buffer.from(part));
  const raw = Buffer.concat(parts).toString('utf8');
  if (!Revolut.verifySignature(raw, req.headers)) return res.status(400).send('Invalid Revolut signature');
  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).send('Invalid event'); }
  if (!['ORDER_COMPLETED', 'ORDER_CANCELLED', 'ORDER_FAILED'].includes(event.event)) return res.status(204).end();
  if (!/^[a-f0-9-]{36}$/i.test(event.order_id || '')) return res.status(400).send('Invalid order');
  try {
    // Read the order again. Never trust a redirect, event amount or an
    // authorisation alone as confirmation that the customer has paid.
    const session = await Revolut.getSession('rv_' + event.order_id);
    if (session.metadata.job_id) {
      await require('./_tech').reconcileJobPayment(session);
    } else {
      const rows = await SB.sb(`payment_requests?stripe_session_id=eq.${session.id}&select=*&limit=1`);
      if (!rows?.[0]) throw new Error('Payment request is not recorded yet');
      await Payments.reconcile(rows[0], session);
    }
    return res.status(204).end();
  } catch (error) {
    if (error.unmanagedRevolutOrder) return res.status(204).end();
    console.error('Revolut payment confirmation failed:', error.message);
    return res.status(500).send('Payment confirmation will be retried');
  }
}
// Mounted through stripe-webhook.js so the shared raw-body function stays
// within the project's existing Vercel function limit.
module.exports = handler;
