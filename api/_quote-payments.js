const crypto = require('crypto');
const SB = require('./_supabase');
const Stripe = require('./_stripe');
const P = require('./_payments');
const Q = require('./_quote');
const Summary = require('./_payment-summary');

// Read the issued quote, rather than trusting prices or quantities in a public URL.
function quoteOptions(quote) {
  const href = (quote.body_html || '').match(/href="([^"]*\/accept\?[^"]+)"/);
  if (!href) throw new Error('This quote cannot be opened. Please contact PowerSmart.');
  const url = new URL(href[1].replace(/&amp;/g, '&'));
  const options = Q.normalise({ serviceMode: url.searchParams.get('mode'), alarmQty: url.searchParams.get('alarms'), controllerQty: url.searchParams.get('ctrl') });
  const calculation = Q.buildQuote(options);
  if (Math.round(calculation.total * 100) !== Math.round(Number(quote.quote_total) * 100)) throw new Error('The saved quote total could not be verified. Please contact PowerSmart.');
  return { ...options, calculation };
}

async function refreshPending(rows) {
  return Promise.all((rows || []).map(async payment => {
    if (payment.status !== 'sent') return payment;
    try { return await P.reconcile(payment, await Stripe.request(`/checkout/sessions/${encodeURIComponent(payment.stripe_session_id)}`)); }
    catch (error) { console.error('Quote payment status check failed:', error.message); return payment; }
  }));
}

async function quotePayments(quote, refresh = false) {
  if (!quote.lead_id || !quote.quote_ref) return [];
  const rows = await SB.sb(`payment_requests?lead_id=eq.${encodeURIComponent(quote.lead_id)}&quote_ref=eq.${encodeURIComponent(quote.quote_ref)}&select=*&order=created_at.desc&limit=200`);
  const jobs = await SB.sb(`jobs?lead_id=eq.${encodeURIComponent(quote.lead_id)}&quote_ref=eq.${encodeURIComponent(quote.quote_ref)}&${Summary.jobFilter}&select=${Summary.jobFields}&limit=1000`);
  return [...(refresh ? await refreshPending(rows) : rows || []), ...Summary.jobPayments(jobs)];
}

async function checkout(quote, lead) {
  if (!Stripe.configured()) throw new Error('Online payment is temporarily unavailable. Please call PowerSmart.');
  const { serviceMode, calculation } = quoteOptions(quote);
  const type = serviceMode === 'inspect' ? 'inspection' : 'booking_fee';
  const amount = Math.round(calculation.payableToday * 100);
  const payments = await quotePayments(quote, true);
  const paid = payments.filter(p => p.status === 'paid' && p.payment_type === type).reduce((sum, p) => sum + Number(p.amount_paid_cents || 0), 0);
  const quoteUrl = `${Q.SITE}/quote?token=${quote.id}`;
  if (paid >= amount) return { paid: true, url: quoteUrl };
  if (paid > 0) throw new Error('A partial payment is already recorded. Please call PowerSmart to arrange the remaining fee.');
  for (const payment of payments.filter(p => p.payment_type === type && p.status === 'sent')) {
    if (payment.amount_cents !== amount) throw new Error('A different payment request already exists. Please contact PowerSmart.');
    return { paid: false, url: P.checkoutUrl(payment.checkout_url) };
  }
  // Expired sessions get a new key; simultaneous/repeated submissions share one checkout.
  const attempt = payments.filter(p => p.payment_type === type).map(p => p.stripe_session_id).sort().join(',');
  const requestKey = crypto.createHash('sha256').update(`quote:${quote.lead_id}:${quote.quote_ref}:${type}:${amount}:${attempt}`).digest('hex');
  const description = `${P.TYPES[type]} for quote ${quote.quote_ref}`;
  const session = await Stripe.request('/checkout/sessions', {
    mode: 'payment', 'payment_method_types[0]': 'card', customer_email: lead.email,
    success_url: `${Q.SITE}/api/customer-link?kind=confirmation&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: quoteUrl, client_reference_id: lead.id,
    'line_items[0][price_data][currency]': 'aud', 'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][price_data][product_data][name]': `PowerSmart - ${P.TYPES[type]}`,
    'line_items[0][price_data][product_data][description]': description, 'line_items[0][quantity]': '1',
    'metadata[lead_id]': lead.id, 'metadata[quote_ref]': quote.quote_ref, 'metadata[payment_type]': type,
    'payment_intent_data[metadata][lead_id]': lead.id, 'payment_intent_data[metadata][quote_ref]': quote.quote_ref,
    'payment_intent_data[metadata][payment_type]': type,
  }, { idempotencyKey: `powersmart-quote-${requestKey}` });
  const url = P.checkoutUrl(session.url);
  await SB.sb('payment_requests?on_conflict=stripe_session_id', { method: 'POST', body: {
    lead_id: lead.id, quote_ref: quote.quote_ref, customer_email: lead.email, payment_type: type, description,
    amount_cents: amount, currency: 'aud', status: 'sent', stripe_session_id: session.id, checkout_url: url,
    request_key: requestKey, sent_at: new Date().toISOString(),
  }, prefer: 'resolution=ignore-duplicates,return=minimal' });
  await P.note(lead.id, 'System', `${P.TYPES[type]} checkout created: ${Q.fmt(amount / 100)} AUD. Quote ${quote.quote_ref}. Payment pending. Stripe checkout: ${session.id}.`);
  return { paid: false, url };
}

function renderPaidQuote(quote, payments) {
  const summaryData = Summary.summarize(quote, payments);
  const paid = summaryData.payments;
  const cents = summaryData.received_cents;
  if (!cents) return quote.body_html;
  const total = Math.round(Number(quote.quote_total) * 100), balance = Math.max(0, total - cents);
  const booking = summaryData.booking_paid_cents;
  const row = (label, amount) => `<tr><td style="padding:8px 12px;font-size:14px;color:#176646;"><strong>${label}</strong></td><td align="right" style="padding:8px 12px;font-size:14px;color:#176646;white-space:nowrap;"><strong>${Q.fmt(amount / 100)}</strong></td></tr>`;
  const summary = `<tr><td style="background:#ffffff;padding:6px 32px 12px;"><table role="presentation" width="100%" style="background:#edf8f1;border:1px solid #c5e8d0;border-radius:10px;">${booking ? row('Booking fee paid', booking) : ''}${cents > booking ? row('Other payments received', cents - booking) : ''}${row('Remaining balance', balance)}</table></td></tr>`;
  let html = quote.body_html.replace('<!-- Payment terms -->', `${summary}\n<!-- Payment terms -->`);
  const { serviceMode, calculation } = quoteOptions(quote);
  const upfrontType = serviceMode === 'inspect' ? 'inspection' : 'booking_fee';
  const upfrontPaid = paid.filter(p => p.type === upfrontType).reduce((sum, p) => sum + p.amount_cents, 0);
  if (upfrontPaid < Math.round(calculation.payableToday * 100) && balance > 0) return html;
  const terms = `<tr><td style="background:#ffffff;padding:8px 32px 4px;font-size:13px;color:#41585D;line-height:1.6;">${balance ? `The remaining balance of <strong>${Q.fmt(balance / 100)}</strong> is payable on the day of installation.` : 'Thank you. Your quote has been paid in full.'}</td></tr>`;
  html = html.replace(/<!-- Payment terms -->[\s\S]*?<!-- Included -->/, `${terms}\n<!-- Included -->`);
  return html;
}

module.exports = { quoteOptions, quotePayments, refreshPending, checkout, renderPaidQuote };
