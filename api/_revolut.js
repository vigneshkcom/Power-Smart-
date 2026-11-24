const crypto = require('node:crypto');
const SB = require('./_supabase');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REFERENCE = /^rv_([a-f0-9-]{36})$/i;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function configured() {
  return Boolean((process.env.REVOLUT_SECRET_KEY || '').trim());
}

async function request(path, body, method = body ? 'POST' : 'GET') {
  const key = (process.env.REVOLUT_SECRET_KEY || '').trim();
  if (!key) throw new Error('Revolut payments are temporarily unavailable. Please contact PowerSmart.');
  const base = process.env.REVOLUT_ENVIRONMENT === 'sandbox' ? 'https://sandbox-merchant.revolut.com' : 'https://merchant.revolut.com';
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Revolut-Api-Version': '2026-09-22' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    // Keep upstream responses and credentials out of public errors.
    const error = new Error('Revolut could not process this payment request. Please try again or contact PowerSmart.');
    error.status = 502;
    error.revolutStatus = response.status;
    throw error;
  }
  return data;
}

function checkoutUrl(value) {
  const url = new URL(value);
  const host = process.env.REVOLUT_ENVIRONMENT === 'sandbox' ? 'sandbox-checkout.revolut.com' : 'checkout.revolut.com';
  if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password) throw new Error('Invalid Revolut checkout link.');
  return url.href;
}

// Existing payment history uses stripe_session_id for both Stripe and manual
// references. rv_<order UUID> extends that shared reference without rewriting
// historical rows. The native order ID is stored separately in checkout_attempts.
function session(order) {
  if (!UUID.test(order.id || '') || !Number.isSafeInteger(order.amount) || order.amount <= 0) throw new Error('Invalid Revolut order.');
  return {
    id: 'rv_' + order.id, provider: 'revolut', mode: 'payment',
    revolut_token: order.token || null,
    revolut_mode: process.env.REVOLUT_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'prod',
    url: order.checkout_url ? checkoutUrl(order.checkout_url) : null,
    amount_total: order.amount, currency: String(order.currency || '').toLowerCase(),
    status: order.state === 'completed' ? 'complete' : ['failed', 'cancelled'].includes(order.state) ? 'expired' : 'open',
    payment_status: order.state === 'completed' && order.outstanding_amount === 0 && !order.refunded_amount ? 'paid' : 'unpaid',
    metadata: order.metadata || {}, payment_intent: null,
  };
}

async function getSession(reference) {
  const match = REFERENCE.exec(reference || '');
  if (!match || !UUID.test(match[1])) throw new Error('Invalid Revolut payment reference.');
  const order = await request('/orders/' + match[1]);
  const rows = await SB.sb(`checkout_attempts?order_id=eq.${match[1]}&select=*&limit=1`);
  let attempt = rows?.[0];
  const requestKey = order.metadata?.powersmart_request_key;
  if ((!requestKey && !attempt) || (order.type && order.type !== 'payment')) {
    const error = new Error('This order was created outside PowerSmart checkout.');
    error.unmanagedRevolutOrder = true;
    throw error;
  }
  if (!attempt && /^[a-f0-9]{64}$/.test(requestKey || '')) {
    attempt = (await SB.sb(`checkout_attempts?request_key=eq.${requestKey}&select=*&limit=1`))?.[0];
  }
  if (!attempt || (attempt.order_id && order.id !== attempt.order_id) || order.amount !== attempt.amount_cents || order.currency !== attempt.currency ||
      Object.entries(attempt.metadata).some(([key, value]) => order.metadata?.[key] !== value)) throw new Error('Revolut payment details do not match the saved checkout.');
  if (!attempt.order_id) await SB.sb(`checkout_attempts?request_key=eq.${attempt.request_key}&order_id=is.null`, { method: 'PATCH', body: { order_id: order.id }, prefer: 'return=minimal' });
  // Repair older hash-labelled orders too. Display changes must never prevent
  // a successful payment from being reconciled.
  try { await labelOrder(order); }
  catch (error) { console.error('Revolut order label update failed:', error.message); }
  return session(order);
}

async function orderDetails(metadata, email) {
  const job = metadata.job_id ? (await SB.sb(`jobs?id=eq.${encodeURIComponent(metadata.job_id)}&select=job_no,customer_name,email,quote_ref&limit=1`))?.[0] : null;
  const lead = !job && metadata.lead_id ? (await SB.sb(`leads?id=eq.${encodeURIComponent(metadata.lead_id)}&select=name,email,quote_ref&limit=1`))?.[0] : null;
  const clean = value => String(value || '').replace(/[\x00-\x1f\x7f|]/g, ' ').replace(/\s+/g, ' ').trim();
  const name = clean(job?.customer_name || lead?.name).slice(0, 120);
  const number = metadata.job_no || job?.job_no;
  const ref = clean(number ? 'J' + number : metadata.quote_ref || job?.quote_ref || lead?.quote_ref);
  const type = { booking_fee: 'Deposit', inspection: 'Inspection', installation_balance: 'Installation balance', job: 'Job payment', other: 'Payment' }[metadata.payment_type] || 'Payment';
  const reference = [ref, name, type].filter(Boolean).join(' | ');
  return { reference, customer: {
    ...(email || job?.email || lead?.email ? { email: email || job?.email || lead?.email } : {}),
    ...(name ? { full_name: name } : {}),
  } };
}

async function labelOrder(order, details) {
  if (!['pending', 'authorised', 'completed'].includes(order.state) || !/^[a-f0-9]{64}$/.test(order.merchant_order_data?.reference || '')) return;
  details ||= await orderDetails(order.metadata || {}, order.customer?.email);
  await request('/orders/' + order.id, { merchant_order_data: { reference: details.reference } }, 'PATCH');
}

async function gatewayFor(form) {
  const jobId = form['metadata[job_id]'];
  const job = jobId ? (await SB.sb(`jobs?id=eq.${encodeURIComponent(jobId)}&select=lead_id,payment_gateway,inspection_converted_at&limit=1`))?.[0] : null;
  if (job?.inspection_converted_at || form['metadata[payment_type]'] === 'inspection') return 'revolut';
  const leadId = form['metadata[lead_id]'] || job?.lead_id;
  if (leadId) {
    const lead = (await SB.sb(`leads?id=eq.${encodeURIComponent(leadId)}&select=payment_gateway&limit=1`))?.[0];
    if (!lead) throw new Error('Customer for this checkout was not found.');
    return lead.payment_gateway || 'stripe';
  }
  return job?.payment_gateway || 'stripe';
}

async function createSession(form, options = {}) {
  const amount = Number(form['line_items[0][price_data][unit_amount]']);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid checkout amount.');
  const metadata = Object.fromEntries(Object.entries(form).flatMap(([key, value]) => {
    const match = /^metadata\[([^\]]+)\]$/.exec(key);
    return match ? [[match[1], String(value)]] : [];
  }));
  const currency = String(form['line_items[0][price_data][currency]']).toUpperCase();
  const details = await orderDetails(metadata, form.customer_email);
  const baseKey = options.idempotencyKey || hash(JSON.stringify([metadata, amount, currency, form['line_items[0][price_data][product_data][description]'] || '']));
  let key = hash(baseKey);
  for (let generation = 0; generation < 10; generation++) {
    const orderMetadata = { ...metadata, powersmart_request_key: key };
    const filter = `checkout_attempts?request_key=eq.${key}`;
    const claimed = await SB.sb('checkout_attempts?on_conflict=request_key', {
      method: 'POST', body: { request_key: key, amount_cents: amount, currency, metadata: orderMetadata },
      prefer: 'resolution=ignore-duplicates,return=representation',
    });
    const attempt = claimed?.[0] || (await SB.sb(filter + '&select=*&limit=1'))?.[0];
    if (!attempt || attempt.amount_cents !== amount || attempt.currency !== currency || Object.entries(orderMetadata).some(([k, v]) => attempt.metadata?.[k] !== v)) throw new Error('Checkout request does not match its saved amount or customer.');
    let order;
    if (attempt.order_id) {
      order = await request('/orders/' + attempt.order_id);
    } else if (claimed?.length) {
      const description = form['line_items[0][price_data][product_data][description]'] || form['line_items[0][price_data][product_data][name]'];
      const redirect = new URL(form.success_url.replace('{CHECKOUT_SESSION_ID}', ''));
      redirect.searchParams.delete('session_id');
      redirect.searchParams.delete('paid');
      redirect.searchParams.set('revolut_request', key);
      try {
        order = await request('/orders', {
          amount, currency, description, metadata: orderMetadata,
          merchant_order_data: { reference: key }, capture_mode: 'automatic',
          expire_pending_after: 'P7D', redirect_url: redirect.href,
          ...(Object.keys(details.customer).length ? { customer: details.customer } : {}),
        });
      } catch (error) {
        // A definite rejection creates no order. A timeout is ambiguous, so keep
        // the claim and recover by reference on retry instead of charging twice.
        if (error.revolutStatus >= 400 && error.revolutStatus < 500) await SB.sb(filter + '&order_id=is.null', { method: 'DELETE' });
        throw error;
      }
    } else {
      const result = await request('/orders?merchant_order_data_reference=' + key + '&limit=10');
      const matches = (result.orders || []).filter(item => item.type === 'payment');
      if (matches.length > 1) throw new Error('Please contact PowerSmart to review this payment request.');
      if (matches.length) order = await request('/orders/' + matches[0].id);
      if (!order) {
        const error = new Error('Your payment checkout is being prepared. Please try again shortly.');
        error.status = 409;
        throw error;
      }
    }
    if (order.amount !== amount || order.currency !== currency || Object.entries(orderMetadata).some(([k, v]) => order.metadata?.[k] !== v)) throw new Error('Revolut order does not match this checkout request.');
    await SB.sb(filter, { method: 'PATCH', body: { order_id: order.id }, prefer: 'return=minimal' });
    // Keep the recovery hash until the order ID is safely saved. From here on,
    // retries use that ID, so the reference can be readable without weakening
    // duplicate-payment protection after an ambiguous create response.
    await labelOrder(order, details);
    const result = session(order);
    if (result.status !== 'expired') return result;
    key = hash(baseKey + ':' + order.id);
  }
  throw new Error('Please contact PowerSmart to arrange payment.');
}

function verifySignature(raw, headers) {
  const secret = (process.env.REVOLUT_WEBHOOK_SECRET || '').trim();
  const timestamp = headers['revolut-request-timestamp'];
  const signatures = String(headers['revolut-signature'] || '').split(',');
  if (!secret || !/^\d+$/.test(timestamp || '') || Math.abs(Date.now() - Number(timestamp)) > 300000) return false;
  const expected = crypto.createHmac('sha256', secret).update(`v1.${timestamp}.${raw}`).digest();
  return signatures.some(part => {
    const match = /^v1=([a-f0-9]{64})$/i.exec(part.trim());
    return match && crypto.timingSafeEqual(expected, Buffer.from(match[1], 'hex'));
  });
}

module.exports = { configured, request, checkoutUrl, session, getSession, gatewayFor, createSession, verifySignature, REFERENCE };

