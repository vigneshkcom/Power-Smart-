const SB = require('./_supabase');
const Stripe = require('./_stripe');
const P = require('./_payments');
const Q = require('./_quote');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  let id = String(req.query.session_id || '');
  const requestKey = String(req.query.revolut_request || '');
  if (requestKey && !/^[a-f0-9]{64}$/.test(requestKey)) return res.status(404).send('Payment not found.');
  if (!requestKey && !/^cs_(live|test)_[a-zA-Z0-9]{20,200}$/.test(id) && !/^rv_[a-f0-9-]{36}$/i.test(id)) return res.status(404).send('Payment not found.');
  try {
    if (requestKey) {
      const attempt = (await SB.sb(`checkout_attempts?request_key=eq.${requestKey}&select=order_id&limit=1`))?.[0];
      if (!attempt?.order_id) return res.status(503).send('Your payment is still being confirmed. Please reopen your quote shortly.');
      id = 'rv_' + attempt.order_id;
    }
    const payments = await SB.sb(`payment_requests?stripe_session_id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    if (!payments?.[0]) return res.status(404).send('Payment not found. Please contact PowerSmart.');
    const payment = await P.reconcile(payments[0], await Stripe.request(`/checkout/sessions/${encodeURIComponent(id)}`));
    const quotes = payment.quote_ref ? await SB.sb(`sent_emails?lead_id=eq.${encodeURIComponent(payment.lead_id)}&quote_ref=eq.${encodeURIComponent(payment.quote_ref)}&kind=eq.quote&status=eq.sent&select=id&order=created_at.desc&limit=1`) : [];
    if (quotes?.[0]) {
      res.setHeader('Location', `${Q.QUOTE_SITE}/quote?token=${quotes[0].id}`);
      return res.status(303).end();
    }
    return res.status(200).send(payment.status === 'paid' ? 'Thank you. Your payment has been received by PowerSmart.' : 'Your payment is still processing. Please check your quote again shortly.');
  } catch (error) {
    console.error('Payment confirmation failed:', error.message);
    return res.status(503).send('Payment confirmation is temporarily unavailable. Please reopen your quote shortly. Do not pay again.');
  }
};
