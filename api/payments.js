const crypto = require('crypto');
const Stripe = require('./_stripe');
const SB = require('./_supabase');
const P = require('./_payments');
const Sms = require('./_sms-outbound');
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const fields = 'id,lead_id,quote_ref,payment_type,description,amount_cents,amount_paid_cents,currency,status,stripe_session_id,checkout_url,created_at,paid_at,request_key';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers['x-portal-key'] !== '2026') return res.status(401).json({ error: 'Invalid portal key' });
  if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  if (!Stripe.configured() || !SB.configured()) return res.status(503).json({ error: 'Payment services are not configured' });
  const b = req.body || {}, leadId = clean(req.method === 'GET' ? req.query.lead_id : b.lead_id, 40);
  if (!leadId) return res.status(400).json({ error: 'Choose a customer first.' });
  try {
    if (req.method === 'GET') {
      const payments = await SB.sb(`payment_requests?lead_id=eq.${encodeURIComponent(leadId)}&select=${fields}&order=created_at.desc&limit=200`);
      return res.status(200).json({ payments: payments || [] });
    }
    if (['refresh','send_sms','preview_sms'].includes(b.action)) {
      const rows = await SB.sb(`payment_requests?id=eq.${encodeURIComponent(clean(b.payment_id, 40))}&lead_id=eq.${encodeURIComponent(leadId)}&select=${fields}&limit=1`);
      if (!rows?.[0]) return res.status(404).json({ error: 'Payment request not found.' });
      const payment = rows[0], session = await Stripe.request(`/checkout/sessions/${encodeURIComponent(payment.stripe_session_id)}`);
      const updated = await P.reconcile(payment, session);
      if(b.action === 'send_sms' || b.action === 'preview_sms') {
        if(updated.status !== 'sent' || session.status !== 'open' || !session.url)return res.status(409).json({error:updated.status === 'paid' ? 'This payment has already been paid. No SMS was sent.' : 'This payment link has expired. Create a new request before sending SMS.'});
        const leads = await SB.sb(`leads?id=eq.${encodeURIComponent(leadId)}&select=id,name,phone&limit=1`),lead=leads?.[0];
        if(!lead)return res.status(404).json({error:'Customer not found.'});
        const first=String(lead.name || 'there').trim().split(/\s+/)[0],type=(P.TYPES[payment.payment_type] || 'payment').toLowerCase();
        const message=`Hi ${first}, please pay your PowerSmart ${type} of $${(payment.amount_cents/100).toFixed(2)} AUD. ${payment.description}. Pay securely here: https://smokealarms.powersmartco.com.au/pay?token=${payment.id} Thank you, PowerSmart.`;
        const phone=Sms.cleanPhone(lead.phone);
        if(!/^\+[1-9]\d{7,14}$/.test(phone) || (phone.startsWith('+61') && !/^\+614\d{8}$/.test(phone)))return res.status(400).json({error:'Add a valid customer mobile number before sending SMS.'});
        if(b.action === 'preview_sms')return res.status(200).json({phone,message,payment:updated});
        if(b.expected_phone !== phone || b.expected_message !== message)return res.status(409).json({error:'The customer or payment details changed. Preview the SMS again before sending.'});
        const sms=await Sms.sendLeadSms({lead,message,key:`payment-${payment.id}`,author:['Mani','Vignesh'].includes(b.agent) ? b.agent : 'Team'});
        return res.status(200).json({ok:true,sms,payment:updated});
      }
      return res.status(200).json({ payment: updated, checkout_url: session.status === 'open' && session.url ? P.checkoutUrl(session.url) : null });
    }
    if (b.action !== 'create') return res.status(400).json({ error: 'Unknown payment action.' });
    let amount;
    try { amount = P.amountCents(b.amount); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (!Object.hasOwn(P.TYPES, b.payment_type)) return res.status(400).json({ error: 'Choose a valid payment type.' });
    const description = clean(b.description, 250), token = clean(b.request_key, 80);
    if (!description) return res.status(400).json({ error: 'Enter a payment description.' });
    if (!/^[\w-]{16,80}$/.test(token)) return res.status(400).json({ error: 'Invalid payment request. Close and reopen the payment window.' });
    const requestKey = crypto.createHash('sha256').update(JSON.stringify([leadId, token, b.payment_type, amount, description])).digest('hex');
    const prior = await SB.sb(`payment_requests?request_key=eq.${requestKey}&select=${fields}&limit=1`);
    if (prior?.[0]) {
      const payment = await P.reconcile(prior[0], await Stripe.request(`/checkout/sessions/${encodeURIComponent(prior[0].stripe_session_id)}`));
      if (payment.status !== 'sent') return res.status(409).json({ error: `This request is ${payment.status}. Review payment history before creating another payment.` });
      await P.note(leadId, ['Mani', 'Vignesh'].includes(b.agent) ? b.agent : 'Team', `${P.TYPES[payment.payment_type]} checkout created: $${(payment.amount_cents / 100).toFixed(2)} AUD. ${payment.description}. Payment pending. Stripe checkout: ${payment.stripe_session_id}.`);
      return res.status(200).json({ payment, checkout_url: P.checkoutUrl(payment.checkout_url) });
    }
    const leads = await SB.sb(`leads?id=eq.${encodeURIComponent(leadId)}&select=id,name,email,quote_ref&limit=1`), lead = leads?.[0];
    if (!lead) return res.status(404).json({ error: 'Customer not found.' });
    if (b.payment_type === 'booking_fee') {
      const paid = await SB.sb(`payment_requests?lead_id=eq.${encodeURIComponent(leadId)}&payment_type=eq.booking_fee&status=eq.paid&select=id&limit=1`);
      if (paid?.length) return res.status(409).json({ error: 'This customer already has a paid booking fee. Choose another payment type.' });
    }
    const pending = await SB.sb(`payment_requests?lead_id=eq.${encodeURIComponent(leadId)}&payment_type=eq.${encodeURIComponent(b.payment_type)}&status=eq.sent${b.payment_type === 'booking_fee' ? '' : `&amount_cents=eq.${amount}&description=eq.${encodeURIComponent(description)}`}&select=${fields}&order=created_at.desc&limit=10`);
    for (const payment of pending || []) {
      const existing = await Stripe.request(`/checkout/sessions/${encodeURIComponent(payment.stripe_session_id)}`);
      const updated = await P.reconcile(payment, existing);
      if (updated.status === 'paid' && b.payment_type === 'booking_fee') return res.status(409).json({ error: 'This booking fee has already been paid. Choose another payment type.' });
      if (existing.status === 'open' && existing.url) {
        if (payment.amount_cents !== amount || payment.description !== description) return res.status(409).json({ error: 'A booking fee request already exists. Use its link in payment history.' });
        await P.note(leadId, ['Mani', 'Vignesh'].includes(b.agent) ? b.agent : 'Team', `${P.TYPES[payment.payment_type]} checkout created: $${(payment.amount_cents / 100).toFixed(2)} AUD. ${payment.description}. Payment pending. Stripe checkout: ${payment.stripe_session_id}.`);
        return res.status(200).json({ payment: updated, checkout_url: P.checkoutUrl(existing.url) });
      }
    }
    const session = await Stripe.request('/checkout/sessions', {
      mode: 'payment', 'payment_method_types[0]': 'card', ...(lead.email ? { customer_email: lead.email } : {}),
      success_url: 'https://smokealarms.powersmartco.com.au/payment-complete?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://smokealarms.powersmartco.com.au/payment-cancelled', client_reference_id: leadId,
      'line_items[0][price_data][currency]': 'aud', 'line_items[0][price_data][unit_amount]': String(amount),
      'line_items[0][price_data][product_data][name]': `PowerSmart - ${P.TYPES[b.payment_type]}`,
      'line_items[0][price_data][product_data][description]': description, 'line_items[0][quantity]': '1',
      'metadata[lead_id]': leadId, 'metadata[quote_ref]': lead.quote_ref || '', 'metadata[payment_type]': b.payment_type,
      'metadata[description]': description, 'payment_intent_data[metadata][lead_id]': leadId,
      'payment_intent_data[metadata][payment_type]': b.payment_type, 'payment_intent_data[metadata][quote_ref]': lead.quote_ref || '',
    }, { idempotencyKey: `powersmart-payment-${requestKey}` });
    const url = P.checkoutUrl(session.url);
    const rows = await SB.sb('payment_requests?on_conflict=stripe_session_id', { method: 'POST', body: {
      lead_id: leadId, quote_ref: lead.quote_ref || null, customer_email: lead.email || '', payment_type: b.payment_type, description,
      amount_cents: amount, currency: 'aud', status: 'sent', stripe_session_id: session.id, checkout_url: url,
      request_key: requestKey, sent_at: new Date().toISOString(),
    }, prefer: 'resolution=ignore-duplicates,return=representation' });
    const payment = rows?.[0] || (await SB.sb(`payment_requests?stripe_session_id=eq.${encodeURIComponent(session.id)}&select=${fields}&limit=1`))?.[0];
    if (!payment) throw new Error('Could not save the payment request. Please retry.');
    await P.note(leadId, ['Mani', 'Vignesh'].includes(b.agent) ? b.agent : 'Team', `${P.TYPES[b.payment_type]} checkout created: $${(amount / 100).toFixed(2)} AUD. ${description}. Payment pending. Stripe checkout: ${session.id}.`);
    return res.status(200).json({ payment, checkout_url: url });
  } catch (error) {
    console.error('PowerSmart payment request failed:', error.message);
    return res.status(error.status || 500).json({ error: error.message || 'Could not process payment request.' });
  }
};
