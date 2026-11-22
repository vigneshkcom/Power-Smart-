const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
test('staff checkout accepts both providers and rejects deceptive payment links', () => {
  const source = fs.readFileSync(path.join(__dirname, '../tools/pipeline.html'), 'utf8');
  const match = /function safeCheckout\(value\)\{([\s\S]*?)\n  \}/.exec(source);
  assert(match, 'Staff checkout validator exists');
  const safeCheckout = vm.runInNewContext('(function(value){' + match[1] + '})', { URL });
  assert.equal(safeCheckout('https://checkout.revolut.com/payment-link/test'), 'https://checkout.revolut.com/payment-link/test');
  assert.equal(safeCheckout('https://checkout.stripe.com/c/pay/test'), 'https://checkout.stripe.com/c/pay/test');
  assert.throws(() => safeCheckout('https://checkout.revolut.com.evil.test/pay'));
  assert.throws(() => safeCheckout('https://user:pass@checkout.revolut.com/pay'));
});

const orderId = '6516e61c-d279-a454-a837-bc52ce55ed49';
function load(file, mocks, env = {}, fetch = async () => { throw new Error('Unexpected fetch'); }) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api', file), 'utf8'), {
    module, require: name => mocks[name] || require(name),
    process: { env }, fetch, URL, URLSearchParams, AbortSignal, Buffer, Date, console,
  });
  return module.exports;
}

function fixture() {
  const attempts = [], orders = [], calls = [];
  const db = { async sb(query, options = {}) {
    const [table, qs = ''] = query.split('?');
    if (table === 'leads') return [{ name: 'Vignesh Kirubakaran', email: 'test@example.test', quote_ref: 'Q1' }];
    if (table === 'jobs') return [{ job_no: 1019, customer_name: 'Job Customer', email: 'job@example.test', quote_ref: 'Q1' }];
    assert.equal(table, 'checkout_attempts');
    const params = new URLSearchParams(qs);
    const rows = attempts.filter(row => [...params].every(([key, value]) =>
      ['select', 'limit', 'on_conflict'].includes(key) || (value === 'is.null' ? !row[key] : row[key] === value.slice(3))));
    if (options.method === 'POST') {
      if (attempts.some(row => row.request_key === options.body.request_key)) return [];
      const row = { ...options.body, order_id: null };
      attempts.push(row);
      return [{ ...row }];
    }
    if (options.method === 'PATCH') rows.forEach(row => Object.assign(row, options.body));
    if (options.method === 'DELETE') rows.forEach(row => attempts.splice(attempts.indexOf(row), 1));
    return rows.map(row => ({ ...row }));
  } };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    let data;
    if (options.method === 'POST' && url.endsWith('/orders')) {
      const body = JSON.parse(options.body);
      data = { ...body, id: orderId, token: 'public-order-token', type: 'payment', state: 'pending', outstanding_amount: body.amount,
        checkout_url: 'https://checkout.revolut.com/payment-link/example' };
      orders.push(data);
    } else if (options.method === 'PATCH') {
      const order = orders.find(row => url.endsWith('/' + row.id));
      assert(order);
      const attempt = attempts.find(row => row.order_id === order.id);
      assert(attempt, 'Save order ID before replacing the recovery reference');
      Object.assign(order, JSON.parse(options.body));
      data = order;
    } else if (url.includes('/orders?')) {
      const reference = new URL(url).searchParams.get('merchant_order_data_reference');
      data = { orders: orders.filter(order => order.merchant_order_data.reference === reference) };
    }
    else data = orders.find(row => url.endsWith('/' + row.id));
    assert(data, url);
    return { ok: true, status: 200, json: async () => data };
  };
  const api = load('_revolut.js', { './_supabase': db }, { REVOLUT_SECRET_KEY: 'test-key' }, fetch);
  const form = {
    'metadata[lead_id]': 'lead1', 'metadata[quote_ref]': 'Q1', 'metadata[payment_type]': 'booking_fee',
    'line_items[0][price_data][unit_amount]': '5000', 'line_items[0][price_data][currency]': 'aud',
    'line_items[0][price_data][product_data][name]': 'PowerSmart deposit',
    success_url: 'https://quotes.powersmartco.com.au/api/customer-link?kind=confirmation&session_id={CHECKOUT_SESSION_ID}',
    customer_email: 'test@example.test',
  };
  return { api, db, attempts, orders, calls, form };
}

test('Revolut checkout creates a fixed AUD order and keeps its secret on the server', async () => {
  const f = fixture();
  const checkout = await f.api.createSession(f.form, { idempotencyKey: 'quote1' });
  assert.equal(checkout.id, 'rv_' + orderId);
  assert.equal(checkout.payment_status, 'unpaid');
  assert.equal(checkout.revolut_token, 'public-order-token');
  assert.equal(checkout.revolut_mode, 'prod');
  const body = JSON.parse(f.calls[0].options.body);
  assert.equal(body.amount, 5000);
  assert.equal(body.currency, 'AUD');
  assert.equal(body.capture_mode, 'automatic');
  assert.equal(body.metadata.lead_id, 'lead1');
  assert.equal(body.customer.full_name, 'Vignesh Kirubakaran');
  assert.equal(f.orders[0].merchant_order_data.reference, 'Q1 | Vignesh Kirubakaran | Deposit');
  assert.match(body.redirect_url, /revolut_request=[a-f0-9]{64}/);
  assert.doesNotMatch(JSON.stringify(checkout), /test-key/);
});

test('simultaneous checkout requests create at most one Revolut order and retries reuse it', async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    f.api.createSession(f.form, { idempotencyKey: 'same' }),
    f.api.createSession(f.form, { idempotencyKey: 'same' }),
  ]);
  assert(results.some(result => result.status === 'fulfilled'));
  assert.equal(f.orders.length, 1);
  const retry = await f.api.createSession(f.form, { idempotencyKey: 'same' });
  assert.equal(retry.id, 'rv_' + orderId);
  assert.equal(f.orders.length, 1);
});

test('a lost database save recovers the existing order by reference without another create', async () => {
  const f = fixture();
  const sb = f.db.sb;
  let failSave = true;
  f.db.sb = async (query, options = {}) => {
    if (failSave && options.method === 'PATCH') { failSave = false; throw new Error('Save failed'); }
    return sb(query, options);
  };
  await assert.rejects(f.api.createSession(f.form, { idempotencyKey: 'recover' }), /Save failed/);
  assert.match(f.orders[0].merchant_order_data.reference, /^[a-f0-9]{64}$/);
  const checkout = await f.api.createSession(f.form, { idempotencyKey: 'recover' });
  assert.equal(checkout.id, 'rv_' + orderId);
  assert.equal(f.orders.length, 1);
  assert.equal(f.attempts[0].order_id, orderId);
  assert.equal(f.orders[0].merchant_order_data.reference, 'Q1 | Vignesh Kirubakaran | Deposit');
});

test('electrician checkout shows the job number and customer name without an email', async () => {
  const f = fixture();
  delete f.form.customer_email;
  delete f.form['metadata[lead_id]'];
  f.form['metadata[job_id]'] = 'job1';
  f.form['metadata[job_no]'] = '1019';
  f.form['metadata[payment_type]'] = 'job';
  await f.api.createSession(f.form);
  assert.equal(f.orders[0].merchant_order_data.reference, 'J1019 | Job Customer | Job payment');
  assert.equal(f.orders[0].customer.full_name, 'Job Customer');
});

test('completed legacy orders get a readable reference without changing payment data', async () => {
  const f = fixture();
  await f.api.createSession(f.form);
  const order = f.orders[0];
  order.merchant_order_data.reference = f.attempts[0].request_key;
  order.state = 'completed';
  order.outstanding_amount = 0;
  const before = JSON.stringify({ amount: order.amount, metadata: order.metadata, customer: order.customer });
  const result = await f.api.getSession('rv_' + orderId);
  assert.equal(result.payment_status, 'paid');
  assert.equal(order.merchant_order_data.reference, 'Q1 | Vignesh Kirubakaran | Deposit');
  assert.equal(JSON.stringify({ amount: order.amount, metadata: order.metadata, customer: order.customer }), before);
});

test('a failed display update does not prevent completed payment reconciliation', async () => {
  const f = fixture();
  await f.api.createSession(f.form);
  const order = f.orders[0];
  order.merchant_order_data.reference = f.attempts[0].request_key;
  order.state = 'completed';
  order.outstanding_amount = 0;
  const sb = f.db.sb;
  f.db.sb = (query, options) => {
    if (query.startsWith('leads?')) throw new Error('Customer lookup unavailable');
    return sb(query, options);
  };
  assert.equal((await f.api.getSession('rv_' + orderId)).payment_status, 'paid');
});

test('a webhook arriving before the order ID is saved repairs its checkout mapping', async () => {
  const f = fixture();
  await f.api.createSession(f.form);
  f.attempts[0].order_id = null;
  const checkout = await f.api.getSession('rv_' + orderId);
  assert.equal(checkout.id, 'rv_' + orderId);
  assert.equal(f.attempts[0].order_id, orderId);
});

test('unrelated Revolut dashboard orders are identified for webhook acknowledgement', async () => {
  const f = fixture();
  f.orders.push({ id: orderId, type: 'payment', amount: 5000, currency: 'AUD', metadata: {} });
  await assert.rejects(f.api.getSession('rv_' + orderId), error => error.unmanagedRevolutOrder === true);
});

test('only a completed, fully captured, unrefunded order counts as paid', async () => {
  const f = fixture();
  await f.api.createSession(f.form);
  const order = f.orders[0];
  order.state = 'authorised';
  assert.equal((await f.api.getSession('rv_' + orderId)).payment_status, 'unpaid');
  order.state = 'completed';
  order.outstanding_amount = 0;
  assert.equal((await f.api.getSession('rv_' + orderId)).payment_status, 'paid');
  order.refunded_amount = 100;
  assert.equal((await f.api.getSession('rv_' + orderId)).payment_status, 'unpaid');
});

test('order amount, currency and customer metadata must match the saved checkout', async () => {
  const f = fixture();
  await f.api.createSession(f.form);
  const order = f.orders[0];
  order.amount = 1;
  await assert.rejects(f.api.getSession('rv_' + orderId), /do not match/);
  order.amount = 5000;
  order.metadata.lead_id = 'other';
  f.attempts[0].metadata = { ...f.attempts[0].metadata, lead_id: 'lead1' };
  await assert.rejects(f.api.getSession('rv_' + orderId), /do not match/);
});

test('an existing customer stays on Stripe even when their new job defaults to Revolut', async () => {
  let gateway = 'stripe';
  const api = load('_revolut.js', { './_supabase': { async sb(query) {
    return query.startsWith('jobs') ? [{ lead_id: 'old-lead', payment_gateway: 'revolut' }] : [{ payment_gateway: gateway }];
  } } });
  assert.equal(await api.gatewayFor({ 'metadata[job_id]': 'job1' }), 'stripe');
  gateway = 'revolut';
  assert.equal(await api.gatewayFor({ 'metadata[job_id]': 'job1' }), 'revolut');
});

test('webhook verification rejects tampering, missing signatures and expired timestamps', () => {
  const api = load('_revolut.js', { './_supabase': {} }, { REVOLUT_WEBHOOK_SECRET: 'secret' });
  const raw = JSON.stringify({ event: 'ORDER_COMPLETED', order_id: orderId });
  const timestamp = String(Date.now());
  const signature = 'v1=' + crypto.createHmac('sha256', 'secret').update(`v1.${timestamp}.${raw}`).digest('hex');
  const headers = { 'revolut-request-timestamp': timestamp, 'revolut-signature': signature };
  assert.equal(api.verifySignature(raw, headers), true);
  assert.equal(api.verifySignature(raw + ' ', headers), false);
  assert.equal(api.verifySignature(raw, { ...headers, 'revolut-request-timestamp': '1' }), false);
  assert.equal(api.verifySignature(raw, {}), false);
});

test('checkout links reject lookalike hosts and embedded credentials', () => {
  const api = fixture().api;
  assert.throws(() => api.checkoutUrl('https://checkout.revolut.com.evil.test/pay'), /Invalid/);
  assert.throws(() => api.checkoutUrl('https://user:pass@checkout.revolut.com/pay'), /Invalid/);
});

test('legacy Stripe sessions keep using Stripe after the Revolut cutover', async () => {
  const calls = [];
  const gateway = load('_stripe.js', {}, { REVOLUT_SECRET_KEY: 'revolut', STRIPE_SECRET_KEY: 'stripe' }, async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ id: 'cs_live_old' }) };
  });
  await gateway.request('/checkout/sessions/cs_live_old');
  assert.equal(calls[0], 'https://api.stripe.com/v1/checkout/sessions/cs_live_old');
});

test('Revolut webhook reads the verified order, records payment, and retries missing records', async () => {
  const f = fixture();
  await f.api.createSession(f.form);
  f.orders[0].state = 'completed';
  f.orders[0].outstanding_amount = 0;
  let hasPayment = true, recorded = 0;
  const handler = load('_revolut-webhook.js', {
    './_revolut': { ...f.api, verifySignature: () => true },
    './_supabase': { sb: async () => hasPayment ? [{ id: 'request1' }] : [] },
    './_payments': { reconcile: async (payment, session) => {
      assert.equal(payment.id, 'request1');
      assert.equal(session.payment_status, 'paid');
      recorded++;
    } },
  });
  const invoke = async event => {
    const req = Readable.from([Buffer.from(JSON.stringify({ event, order_id: orderId }))]);
    req.method = 'POST';
    req.headers = {};
    let status;
    await handler(req, { status(value) { status = value; return this; }, send() {}, end() {} });
    return status;
  };
  assert.equal(await invoke('ORDER_AUTHORISED'), 204);
  assert.equal(recorded, 0);
  assert.equal(await invoke('ORDER_COMPLETED'), 204);
  assert.equal(recorded, 1);
  hasPayment = false;
  assert.equal(await invoke('ORDER_COMPLETED'), 500);
});
