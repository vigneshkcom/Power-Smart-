const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

// Tiny in-memory PostgREST: eq/neq/gte/lt/is.null/not.is.null filters, PATCH/POST/DELETE.
function fakeDb(tables) {
  const calls = [];
  function match(row, params) {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
      const val = row[k] == null ? null : String(row[k]);
      if (v === 'is.null' ? val !== null : v === 'not.is.null' ? val === null :
        v.startsWith('eq.') ? val !== v.slice(3) : v.startsWith('neq.') ? val === v.slice(4) :
        v.startsWith('gte.') ? !(val >= v.slice(4)) : v.startsWith('lt.') ? !(val < v.slice(3)) : false) return false;
    }
    return true;
  }
  return {
    calls, tables,
    configured: () => true,
    async sb(q, opts = {}) {
      const method = opts.method || 'GET';
      calls.push({ q, method, body: opts.body });
      const [table, query = ''] = q.split('?');
      const params = [...new URLSearchParams(query)];
      const rows = (tables[table] = tables[table] || []);
      if (method === 'POST') { const r = { id: table + rows.length, ...opts.body }; rows.push(r); return [r]; }
      const hit = rows.filter((r) => match(r, params));
      if (method === 'PATCH') { hit.forEach((r) => Object.assign(r, opts.body)); return hit.map((r) => ({ ...r })); }
      if (method === 'DELETE') { tables[table] = rows.filter((r) => !hit.includes(r)); return null; }
      return hit.map((r) => ({ ...r }));
    },
  };
}
function fakeStripe(provider = 'stripe') {
  const sessions = new Map(), calls = [];
  return {
    sessions, calls, configured: () => true,
    async request(p, form) {
      calls.push({ p, form });
      if (p === '/checkout/sessions' && form) {
        const s = { id: 'cs_' + (sessions.size + 1), url: 'https://checkout.stripe.com/c/pay/cs_' + (sessions.size + 1), status: 'open', payment_status: 'unpaid',
          amount_total: Number(form['line_items[0][price_data][unit_amount]']), currency: 'aud', metadata: { job_id: form['metadata[job_id]'] } };
        if (provider === 'revolut') Object.assign(s, { id: 'rv_order_' + (sessions.size + 1), provider: 'revolut', url: 'https://checkout.revolut.com/payment-link/example', revolut_token: 'public-order-token', revolut_mode: 'prod' });
        sessions.set(s.id, s); return s;
      }
      const m = p.match(/^\/checkout\/sessions\/([^/]+)(\/expire)?$/);
      const s = sessions.get(decodeURIComponent(m[1]));
      if (m[2]) s.status = 'expired';
      return { ...s };
    },
  };
}
const archived = [];   // jobs the electrician app asked to archive the Alarm Care Notice PDF for
function vmLoad(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api', file), 'utf8'), {
    module, require: (k) => (k in mocks ? mocks[k] : k === './_inspection' ? vmLoad('_inspection.js', mocks) : k === './_payment-summary' ? vmLoad('_payment-summary.js', mocks) : k === './_warranty' ? require('../api/_warranty') : k === './_care-notice' ? { archiveForJob: async (j) => { archived.push(j); return { status: 'skipped' }; } } : require(k)), console: { error() {} }, URL, URLSearchParams, Buffer, setTimeout, process: { env: {} },
  }, { filename: file });
  return module.exports;
}
const QUOTE_TEXT = '- Photoelectric interconnected smoke alarms - supplied & installed (5 x $79.00): $395.00\n- Smoke alarm remote controller (test / hush / locate) (1 x $35.00): $35.00';

const invoiceCalls = [], certCalls = [], afterPayCalls = [], reviewCalls = [];
function setup(provider) {
  invoiceCalls.length = 0; certCalls.length = 0; afterPayCalls.length = 0;
  const db = fakeDb({
    electricians: [
      { id: 't1', code: '1011', name: 'Jake Turner', phone: '0411 111 111', active: true },
      { id: 't2', code: '1012', name: 'Liam Brooks', active: true },
      { id: 't3', code: '1013', name: 'Former Sparky', active: false },
    ],
    jobs: [
      { id: 'j1', job_no: 1001, electrician_id: 't1', lead_id: 'lead1', email: 'kath@x.com', status: 'scheduled', work_type: 'install', customer_name: 'Kath', scheduled_start: '2026-10-23T23:00:00.000Z', pay_status: 'unpaid' },
      { id: 'j2', job_no: 1002, electrician_id: 't2', status: 'scheduled', work_type: 'install', customer_name: 'Other', scheduled_start: '2026-10-23T23:00:00.000Z', pay_status: 'unpaid' },
    ],
    sent_emails: [{ kind: 'quote', status: 'sent', lead_id: 'lead1', quote_ref: 'Q7012', quote_total: 465, body_text: QUOTE_TEXT, created_at: '2026-10-20' }],
    payment_requests: [{ lead_id: 'lead1', status: 'paid', payment_type: 'booking_fee', amount_cents: 3500, amount_paid_cents: 3500 }],
    leads: [{ id: 'lead1', stage: 'quote_accepted' }],
    lead_comments: [],
  });
  const Stripe = fakeStripe(provider);
  const jobs = vmLoad('_jobs.js', { './_supabase': db });
  const mocks = { './_dropbox': { photosForJob: async job => ({ photos: [...(job.inspection?.alarms || []).flatMap(a => [{path:a.photo},{path:a.plate}]), ...(job.alarm_units || []).map(a => ({path:a.photo}))] }) }, './_supabase': db, './_stripe': Stripe, './_jobs': jobs, './_quote': require('../api/_quote'), './_payments': { checkoutUrl: (u) => new URL(u).href }, './_after-payment': { releaseAfterPayment: async (id, o) => { afterPayCalls.push({ id, ...o }); return {}; } }, './_review-sms': { sendForCompletedJob: async (j) => { reviewCalls.push(j); return { status: 'sent' }; } }, './_certificate': { issueCertificate: async (id, o) => { certCalls.push({ id, ...o }); return { status: 'sent' }; } }, './_job-invoice': { sendJobInvoice: async (a) => { invoiceCalls.push(a); return { status: 'sent', to: a.job.email }; }, BANK: { name: 'PowerSmart Pty Ltd', bsb: '083-004', account: '270103472' } } };
  const tech = vmLoad('_tech.js', mocks);
  async function call(body, techCode = '1011') {
    let code = 200, data;
    const res = { status(c) { code = c; return this; }, json(o) { data = o; return this; }, setHeader() {} };
    await tech({ method: 'POST', headers: techCode ? { 'x-tech-code': techCode } : {}, body }, res);
    return { code, data };
  }
  return { db, Stripe, tech, mocks, call, job: (id) => db.tables.jobs.find((j) => j.id === id) };
}

test('electricians sign in with their code; unknown or inactive codes are refused', async () => {
  const t = setup();
  const me = await t.call({ action: 'me' });
  assert.equal(me.code, 200);
  assert.equal(me.data.tech.name, 'Jake Turner');
  assert.equal(me.data.tech.phone, '0411 111 111');
  assert.equal((await t.call({ action: 'me' }, '9999')).code, 401);
  assert.equal((await t.call({ action: 'me' }, '1013')).code, 401, 'deactivated electrician');
  assert.equal((await t.call({ action: 'me' }, null)).code, 401);
  t.db.tables.electricians.push({ id: 't4', code: '1011', name: 'Duplicate', active: true });
  assert.equal((await t.call({ action: 'me' })).code, 401, 'a shared code never logs in as the wrong person');
});

test("an electrician only sees and edits their own jobs", async () => {
  const t = setup();
  const list = await t.call({ action: 'jobs', from: '2026-10-23T14:00:00.000Z', to: '2026-10-24T14:00:00.000Z' });
  assert.deepEqual(list.data.jobs.map((j) => j.job_no), [1001]);
  assert.equal((await t.call({ action: 'job', id: 'j2' })).code, 404);
  assert.equal((await t.call({ action: 'save', id: 'j2', items: [] })).code, 404);
});

test('invoice starts empty; battery and hardwired alarms are separate lines', async () => {
  const t = setup();
  const d = (await t.call({ action: 'job', id: 'j1' })).data;
  assert.equal(d.items.length, 0, 'nothing is pre-populated: the electrician records what was done');
  assert.equal(d.booking_fee_cents, 3500, 'the booking fee already received is shown');
  assert.equal(d.quote.alarm_qty, 5);
  assert.equal(d.alarm_codes.join(), 'alarm_battery,alarm_hardwired');

  const saved = (await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 2, price: '1.00' }, { code: 'alarm_hardwired', qty: 3 }, { code: 'other', label: 'Extra callout', price: '95', qty: 1 }], alarm_units: [{ location: 'Hallway', type: 'battery' },{ location: 'Hallway', type: 'battery' },{ location: 'Bedroom', type: 'hardwired' },{ location: 'Bedroom', type: 'hardwired' },{ location: 'Bedroom', type: 'hardwired' }] })).data;
  assert.equal(saved.totals.total, 5 * 7900 + 9500, 'client price for catalogue items is ignored');
  assert.equal(t.job('j1').alarms_installed, 5);
  assert.equal(t.job('j1').alarm_type, null, 'mixed job');
  assert.equal(t.job('j1').invoice_items[1].label, 'Photoelectric smoke alarm (240V hardwired) – supplied & installed');
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_hardwired', qty: 2 }], alarm_units: [{ location: 'Bedroom', type: 'hardwired' },{ location: 'Bedroom', type: 'hardwired' }] });
  assert.equal(t.job('j1').alarm_type, 'hardwired');
  assert.equal((await t.call({ action: 'save', id: 'j1', items: [{ code: 'free_money', qty: 1 }] })).code, 400);
});

test('an older single "alarm" line is read as battery or hardwired', async () => {
  const t = setup();
  Object.assign(t.job('j1'), { status: 'completed', alarm_type: 'hardwired', invoice_items: [{ code: 'alarm', label: 'old', qty: 4, unit_cents: 7900, amount_cents: 31600 }] });
  const d = (await t.call({ action: 'job', id: 'j1' })).data;
  assert.equal(JSON.stringify(d.items.map((i) => [i.code, i.qty])), JSON.stringify([['alarm_hardwired', 4]]));
});

test('payment needs customer approval, then opens Stripe for the amount due', async () => {
  const t = setup();
  t.db.tables.payment_requests.push({ lead_id: 'lead1', status: 'paid', payment_type: 'inspection', description: 'Inspection', amount_cents: 12000, amount_paid_cents: 12000 });
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 3 }, { code: 'alarm_hardwired', qty: 2 }], alarm_units: [{ location: 'Hallway', type: 'battery' },{ location: 'Hallway', type: 'battery' },{ location: 'Hallway', type: 'battery' },{ location: 'Bedroom', type: 'hardwired' },{ location: 'Bedroom', type: 'hardwired' }] });
  assert.equal((await t.call({ action: 'pay', id: 'j1' })).code, 409, 'approval first');
  const approved = await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 3 }, { code: 'alarm_hardwired', qty: 2 }], alarm_units: [{ location: 'Hallway', type: 'battery' },{ location: 'Hallway', type: 'battery' },{ location: 'Hallway', type: 'battery' },{ location: 'Bedroom', type: 'hardwired' },{ location: 'Bedroom', type: 'hardwired' }], approve: true });
  assert(approved.data.job.approved_at);
  assert.equal(approved.data.totals.due, 39500 - 12000, 'prepaid inspection fee is deducted');

  const pay = await t.call({ action: 'pay', id: 'j1' });
  assert.equal(pay.code, 200);
  assert.match(pay.data.url, /^https:\/\/checkout\.stripe\.com\//);
  const form = t.Stripe.calls.find((c) => c.p === '/checkout/sessions').form;
  assert.equal(form['line_items[0][price_data][unit_amount]'], '27500');
  assert.match(form['line_items[0][price_data][product_data][description]'], /3 × battery smoke alarm, 2 × hardwired smoke alarm/);
  assert.equal(form['metadata[job_id]'], 'j1');
  assert.equal(t.job('j1').pay_status, 'pending');

  // asking again reuses the same open checkout
  assert.equal((await t.call({ action: 'pay', id: 'j1' })).data.url, pay.data.url);
  assert.equal(t.Stripe.sessions.size, 1);
  // changing the invoice resets approval
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 6 }] });
  assert.equal(t.job('j1').approved_at, null);
});

test('electrician Revolut checkout returns a card-only token and reuses an existing pending order', async () => {
  const t = setup('revolut');
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_hardwired', qty: 3 }], approve: true });
  const pay = await t.call({ action: 'pay', id: 'j1' });
  assert.equal(pay.code, 200);
  assert.equal(pay.data.provider, 'revolut');
  assert.equal(pay.data.token, 'public-order-token');
  assert.equal(pay.data.mode, 'prod');
  assert.equal(pay.data.amount_cents, 23700);
  assert.equal(pay.data.customer.name, 'Kath');
  assert.equal(pay.data.customer.email, 'kath@x.com');
  assert.equal(pay.data.url, undefined, 'Never send the wallet-selection URL to the electrician app');
  assert.equal(t.job('j1').pay_status, 'pending');
  assert.equal(t.job('j1').revolut_token, undefined, 'Public token is not persisted on the job');
  const again = await t.call({ action: 'pay', id: 'j1' });
  assert.equal(again.data.token, pay.data.token);
  assert.equal(t.Stripe.sessions.size, 1, 'Do not create another order when reopening the card form');
  assert.equal((await t.call({ action: 'pay_check', id: 'j1' })).data.paid, false);
  const session = t.Stripe.sessions.get(t.job('j1').pay_session_id);
  session.status = 'complete'; session.payment_status = 'paid';
  assert.equal((await t.call({ action: 'pay_check', id: 'j1' })).data.paid, true);
  assert.equal(t.job('j1').paid_cents, 23700);
});

test('another electrician cannot obtain the card token and mismatched or missing tokens never fall back to hosted checkout', async () => {
  const t = setup('revolut');
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_hardwired', qty: 3 }], approve: true });
  const denied = await t.call({ action: 'pay', id: 'j1' }, '1012');
  assert.equal(denied.code, 404);
  assert.equal(t.Stripe.sessions.size, 0);
  await t.call({ action: 'pay', id: 'j1' });
  const session = t.Stripe.sessions.get(t.job('j1').pay_session_id);
  session.metadata.job_id = 'j2';
  const mismatch = await t.call({ action: 'pay', id: 'j1' });
  assert.equal(mismatch.code, 502);
  assert.equal(mismatch.data.token, undefined);
  assert.equal(mismatch.data.url, undefined);
  session.metadata.job_id = 'j1'; session.revolut_token = null;
  const missing = await t.call({ action: 'pay', id: 'j1' });
  assert.equal(missing.code, 502);
  assert.equal(missing.data.url, undefined);
});

test('card payment uses explicit billing details before installation details on new and existing orders', async () => {
  const t = setup('revolut');
  Object.assign(t.job('j1'), { address: '1 Installation Street', suburb: 'Brisbane', postcode: '4000' });
  Object.assign(t.db.tables.leads[0], { billing_line1: '4 Billing Road', billing_suburb: 'Doonside', billing_state: 'NSW', billing_postcode: '2767' });
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_hardwired', qty: 3 }], approve: true });
  const first = await t.call({ action: 'pay', id: 'j1' });
  assert.equal(JSON.stringify(first.data.customer.billingAddress), JSON.stringify({ countryCode: 'AU', streetLine1: '4 Billing Road', city: 'Doonside', postcode: '2767', region: 'NSW' }));
  const again = await t.call({ action: 'pay', id: 'j1' });
  assert.equal(again.data.customer.billingAddress.postcode, '2767');
  assert.equal(t.Stripe.sessions.size, 1);
});

test('card payment uses the saved job address when there is no separate billing address', async () => {
  const t = setup('revolut');
  Object.assign(t.job('j1'), { address: '1 Installation Street', suburb: 'Brisbane', postcode: '4000' });
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_hardwired', qty: 3 }], approve: true });
  const result = await t.call({ action: 'pay', id: 'j1' });
  assert.equal(result.data.customer.billingAddress.postcode, '4000');
  assert.equal(result.data.customer.billingAddress.streetLine1, '1 Installation Street');
});

test('partial billing details never receive an invented or unrelated postcode', async () => {
  const t = setup('revolut');
  Object.assign(t.job('j1'), { address: '1 Installation Street', suburb: 'Brisbane', postcode: '4000' });
  Object.assign(t.db.tables.leads[0], { billing_line1: '4 Billing Road', billing_suburb: 'Doonside', billing_state: 'NSW' });
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_hardwired', qty: 3 }], approve: true });
  const result = await t.call({ action: 'pay', id: 'j1' });
  assert.equal(result.code, 200);
  assert.equal(result.data.customer.billingAddress, undefined);
});

test('remote controller photos persist with invoice items and block approval, payment and completion while missing', async () => {
  const t = setup();
  const items = [{ code: 'alarm_hardwired', qty: 3 }, { code: 'controller', qty: 2, photos: [{ id: 'c1', photo: '' }, { id: 'c2', photo: '' }] }];
  const draft = await t.call({ action: 'save', id: 'j1', items });
  assert.equal(draft.code, 200);
  assert.equal(t.job('j1').alarms_installed, 3, 'Controllers do not count as smoke alarms');
  assert.equal(t.job('j1').invoice_total_cents, 30700, 'Each controller keeps its existing $35 price');
  const approve = await t.call({ action: 'save', id: 'j1', items, approve: true });
  assert.equal(approve.code, 409);
  assert.match(approve.data.error, /photo of each remote controller/);
  t.job('j1').approved_at = new Date().toISOString();
  assert.equal((await t.call({ action: 'pay', id: 'j1' })).code, 409, 'Existing approvals cannot bypass photo requirement');
  assert.equal(t.Stripe.sessions.size, 0);
  const done = await t.call({ action: 'complete', id: 'j1', method: 'bank_transfer', signoff_name: 'Jake', signature: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(done.code, 409);
  assert.equal(invoiceCalls.length, 0);
  items[1].photos[0].photo = '/PowerSmart Jobs/J1001 - Kath/Controllers/first.jpg';
  items[1].photos[1].photo = '/PowerSmart Jobs/J1001 - Kath/Controllers/second.jpg';
  const saved = await t.call({ action: 'save', id: 'j1', items, approve: true });
  assert.equal(saved.code, 200);
  assert.equal(saved.data.items.find(item => item.code === 'controller').photos.length, 2);
  assert.equal((await t.call({ action: 'job', id: 'j1' })).data.items.find(item => item.code === 'controller').photos[1].photo, items[1].photos[1].photo);
  assert.equal((await t.call({ action: 'pay', id: 'j1' })).data.amount_cents, 30700);
});

test('older phones do not erase synchronised controller photos and invalid photo paths cannot be saved', async () => {
  const t = setup();
  const path = '/PowerSmart Jobs/J1001 - Kath/Controllers/first.jpg';
  const items = [{ code: 'controller', qty: 1, photos: [{ id: 'c1', photo: path, photoKey: 'do-not-save-local-key' }] }];
  assert.equal((await t.call({ action: 'save', id: 'j1', items })).code, 200);
  assert.equal(t.job('j1').invoice_items[0].photos[0].photoKey, undefined);
  assert.equal((await t.call({ action: 'save', id: 'j1', items: [{ code: 'controller', qty: 1 }] })).code, 200);
  assert.equal(t.job('j1').invoice_items[0].photos[0].photo, path);
  const bad = await t.call({ action: 'save', id: 'j1', items: [{ code: 'controller', qty: 1, photos: [{ id: 'c1', photo: '/etc/passwd' }] }] });
  assert.equal(bad.code, 400);
  assert.equal(t.job('j1').invoice_items[0].photos[0].photo, path);
  const denied = await t.call({ action: 'save', id: 'j1', items }, '1012');
  assert.equal(denied.code, 404);
});

test('controller photo corrections can be saved after card payment without changing the paid invoice', async () => {
  const t = setup();
  const items = [{ code: 'controller', qty: 1, photos: [{ id: 'c1', photo: '/PowerSmart Jobs/J1001 - Kath/Controllers/first.jpg' }] }];
  await t.call({ action: 'save', id: 'j1', items, approve: true });
  await t.call({ action: 'pay', id: 'j1' });
  const session = t.Stripe.sessions.get(t.job('j1').pay_session_id);
  session.status = 'complete'; session.payment_status = 'paid';
  await t.call({ action: 'pay_check', id: 'j1' });
  items[0].photos[0].photo = '/PowerSmart Jobs/J1001 - Kath/Controllers/retaken.jpg';
  assert.equal((await t.call({ action: 'save', id: 'j1', items })).code, 200);
  assert.equal(t.job('j1').invoice_items[0].photos[0].photo, items[0].photos[0].photo);
  assert.equal(t.job('j1').paid_cents, 3500);
  assert.equal((await t.call({ action: 'save', id: 'j1', items: [{ ...items[0], qty: 2 }] })).code, 409);
});

test('a paid checkout marks the job paid once, and completing moves the lead to Won', async () => {
  const t = setup();
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_hardwired', qty: 3 }], approve: true });
  await t.call({ action: 'pay', id: 'j1' });
  assert.equal((await t.call({ action: 'complete', id: 'j1', paid_in_full: true, method: 'card', signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' })).code, 409, 'cannot complete as paid before Stripe confirms');

  const s = t.Stripe.sessions.get(t.job('j1').pay_session_id);
  s.payment_status = 'paid'; s.status = 'complete';
  assert.equal((await t.call({ action: 'pay_check', id: 'j1' })).data.paid, true);
  await t.call({ action: 'pay_check', id: 'j1' });
  assert.equal(t.job('j1').paid_cents, 23700);
  assert.equal(t.db.tables.lead_comments.filter((c) => c.kind === 'payment').length, 1);

  const done = await t.call({ action: 'complete', id: 'j1', paid_in_full: true, method: 'card', signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(done.code, 200);
  assert.equal(t.job('j1').status, 'completed');
  assert.equal(t.job('j1').pay_status, 'paid');
  assert.equal(t.db.tables.leads[0].stage, 'won');
  assert.match(t.db.tables.lead_comments.at(-1).body, /J1001 completed and signed off by Jake Turner\. Invoice \$237\.00: 3 × hardwired smoke alarm\. Paid in full by card/);
  assert.equal((await t.call({ action: 'save', id: 'j1', items: [] })).code, 409, 'completed jobs are locked');
});

test('the customer can pay later; the lead note records alarms installed and notes', async () => {
  const t = setup();
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 1 }] });
  assert.equal((await t.call({ action: 'complete', id: 'j1', paid_in_full: false, signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' })).code, 409, 'customer approval required');
  await t.call({ action: 'save', id: 'j1', notes: 'Customer to pay by bank transfer', items: [{ code: 'alarm_battery', qty: 1 }], approve: true });
  assert.equal((await t.call({ action: 'complete', id: 'j1', paid_in_full: false, signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' })).code, 200);
  assert.equal(t.job('j1').pay_status, 'later');
  assert.equal(invoiceCalls.at(-1).paid, false, 'a pending invoice is sent when not paid in full');
  assert.match(t.db.tables.lead_comments.at(-1).body, /1 × battery smoke alarm\. Not paid in full: \$79\.00 owing.*Notes: Customer to pay by bank transfer/);
});

test('completing a job files the customer\'s Alarm Care Notice PDF with the job documents, once per completion and with the completed job', async () => {
  const t = setup(); archived.length = 0;
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 1 }], approve: true });
  assert.equal(archived.length, 0, 'not before the job is completed');
  assert.equal((await t.call({ action: 'complete', id: 'j1', paid_in_full: false, signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' })).code, 200);
  assert.equal(archived.length, 1); assert.equal(archived[0].id, 'j1'); assert.equal(archived[0].status, 'completed'); assert.ok(archived[0].job_no);
});

test('a completed job can be reopened, changed and completed again', async () => {
  const t = setup();
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 2 }], approve: true });
  await t.call({ action: 'complete', id: 'j1', paid_in_full: false, signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(t.job('j1').status, 'completed');
  const r = await t.call({ action: 'reopen', id: 'j1' });
  assert.equal(r.code, 200);
  assert.equal(t.job('j1').status, 'on_site');
  assert.equal(t.job('j1').completed_at, null);
  assert.equal(t.job('j1').pay_status, 'unpaid', 'can now take a card payment');
  assert.match(t.db.tables.lead_comments.at(-1).body, /J1001 reopened for changes by Jake Turner/);
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 2 }, { code: 'alarm_hardwired', qty: 1 }], approve: true });
  assert.equal((await t.call({ action: 'complete', id: 'j1', paid_in_full: false, signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' })).code, 200);
  assert.equal(t.job('j1').invoice_total_cents, 23700);
  assert.equal((await t.call({ action: 'reopen', id: 'j2' })).code, 404, "can't reopen someone else's job");
});

test('a reopened card-paid job keeps its invoice locked', async () => {
  const t = setup();
  Object.assign(t.job('j1'), { status: 'completed', pay_status: 'paid', paid_cents: 7900, approved_at: '2026-10-23T01:00:00Z',
    invoice_items: [{ code: 'alarm_battery', label: 'x', qty: 1, unit_cents: 7900, amount_cents: 7900 }] });
  await t.call({ action: 'reopen', id: 'j1' });
  assert.equal(t.job('j1').pay_status, 'paid');
  assert.equal((await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 3 }] })).code, 409);
  assert.equal((await t.call({ action: 'save', id: 'j1', notes: 'Fixed typo' })).code, 200);
  assert.equal((await t.call({ action: 'complete', id: 'j1', paid_in_full: true, method: 'card', signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' })).code, 200);
});

test('inspection jobs require the upfront payment and use a fixed $120 invoice without installed alarms', async () => {
  const t = inspectionSetup();
  const d = (await t.call({ action: 'job', id: 'j1' })).data;
  assert.equal(d.inspection_only, true);
  assert.equal(d.totals.total, 12000);
  assert.equal(d.totals.due, 0);
  assert.equal(d.booking_fee_cents, 0);
  assert.equal((await t.call({action:'pay',id:'j1'})).code,409);
  assert.equal(t.job('j1').alarms_installed || 0,0);
});

test('Stripe webhook records job payments from the electrician app', async () => {
  const t = setup();
  const webhook = vmLoad('stripe-webhook.js', {
    './_stripe': { verifySignature: () => true }, './_supabase': t.db, './_payments': {}, './_tech': t.tech,
  });
  let status;
  const session = { id: 'cs_9', payment_status: 'paid', amount_total: 7900, metadata: { job_id: 'j1', payment_type: 'job' } };
  const req = { method: 'POST', headers: { 'stripe-signature': 'ok' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: session } })); } };
  await webhook(req, { status(n) { status = n; return this; }, json() { return this; }, send() { return this; }, setHeader() {} });
  assert.equal(status, 200);
  assert.equal(t.job('j1').pay_status, 'paid');
  assert.equal(t.job('j1').paid_cents, 7900);
});

test('electrician codes must be unique', async () => {
  const t = setup();
  const jobs = t.mocks['./_jobs'];
  let body, code;
  const res = { status(c) { code = c; return this; }, json(o) { body = o; return this; }, setHeader() {} };
  await jobs({ method: 'POST', headers: { 'x-portal-key': '2026' }, body: { action: 'tech_create', name: 'New Sparky', code: '1011' } }, res);
  assert.equal(code, 400);
  assert.match(body.error, /1011 is already used/);
  await jobs({ method: 'POST', headers: { 'x-portal-key': '2026' }, body: { action: 'tech_update', id: 't1', code: '1011', name: 'Jake T' } }, res);
  assert.equal(code, 200, 'keeping your own code is fine');
  await jobs({ method: 'POST', headers: { 'x-portal-key': '2026' }, body: { action: 'tech_update', id: 't2', code: '1011' } }, res);
  assert.equal(code, 400);
});

test('completing needs a signature, and cash with a receipt photo counts as paid in full', async () => {
  const t = setup();
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 1 }], approve: true });
  assert.equal((await t.call({ action: 'complete', id: 'j1', paid_in_full: false })).code, 400, 'name and signature are required');
  assert.equal((await t.call({ action: 'complete', id: 'j1', paid_in_full: true, signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' })).code, 409, 'paid in full needs a method');
  const cashArgs = { action: 'complete', id: 'j1', paid_in_full: true, method: 'cash', signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' };
  assert.equal((await t.call(cashArgs)).code, 409, 'cash needs a receipt photo');
  assert.equal((await t.call({ action: 'save', id: 'j1', pay_receipt: '../etc/passwd' })).code, 400, 'receipt path must be inside the job photos');
  assert.equal((await t.call({ action: 'save', id: 'j1', pay_receipt: '/PowerSmart Jobs/J1001 - Kath/Receipts/receipts-1.jpg' })).code, 200);
  assert.equal((await t.call({ ...cashArgs, method: 'bank_transfer' })).code, 409, 'bank transfers are confirmed by the office, not on site');
  const done = await t.call(cashArgs);
  assert.equal(done.code, 200);
  assert.equal(t.job('j1').pay_status, 'paid');
  assert.equal(t.job('j1').pay_method, 'cash');
  assert.equal(t.job('j1').signoff_name, 'Jake Turner');
  assert.equal(done.data.invoice.status, 'sent');
  assert.equal(invoiceCalls.at(-1).paid, true, 'cash payment sends the paid tax invoice');
  assert.equal(invoiceCalls.at(-1).method, 'cash');
  const ledger = t.job('j1').payments || [];
  assert.equal(ledger.length, 1, 'the cash taken on site is added to the payment ledger');
  assert.deepEqual([ledger[0].method, ledger[0].amount_cents, ledger[0].by], ['cash', t.job('j1').paid_cents, 'Jake Turner']);
});

test('part payment in cash is taken off the invoice and the balance goes on a pending invoice', async () => {
  const t = setup();
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 1 }], approve: true });
  const total = t.job('j1').invoice_items.reduce((n, i) => n + i.amount_cents, 0);
  const args = { action: 'complete', id: 'j1', paid_in_full: false, method: 'cash', cash_cents: 2000, signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' };
  assert.equal((await t.call(args)).code, 409, 'cash collected needs a receipt photo');
  assert.equal((await t.call({ action: 'save', id: 'j1', pay_receipt: '/PowerSmart Jobs/J1001 - Kath/Receipts/receipts-1.jpg' })).code, 200);
  assert.equal((await t.call({ ...args, cash_cents: total })).code, 400, 'cash equal to the amount due is paid in full, not a part payment');
  const done = await t.call(args);
  assert.equal(done.code, 200);
  const j = t.job('j1');
  assert.equal(j.pay_status, 'later');
  assert.equal(j.amount_due_cents, total - 2000);
  assert.equal(j.prior_paid_cents, 2000);
  assert.equal(j.prior_pay_method, 'cash');
  assert.equal(invoiceCalls.at(-1).paid, false, 'a pending invoice is sent');
  assert.equal(invoiceCalls.at(-1).totals.due, total - 2000);
  assert.equal(JSON.stringify((t.job('j1').payments || []).map((p) => [p.method, p.amount_cents])), JSON.stringify([['cash', 2000]]), 'part cash is in the ledger too');
});

test('bank transfer sends a pending invoice and holds the compliance certificate until payment', async () => {
  const t = setup();
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 1 }], approve: true });
  const detail = await t.call({ action: 'job', id: 'j1' });
  assert.equal(detail.data.bank.bsb.length > 0, true, 'bank details are returned for the app to show');
  const done = await t.call({ action: 'complete', id: 'j1', paid_in_full: false, method: 'bank_transfer', signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(done.code, 200);
  assert.equal(t.job('j1').pay_status, 'later');
  assert.equal(invoiceCalls.at(-1).paid, false);
  assert.equal(done.data.certificate.status, 'skipped', 'no certificate until the payment is received');
});

test('alarm records are saved one by one and validated', async () => {
  const t = setup();
  const ok = await t.call({ action: 'save', id: 'j1', alarm_units: [{ id: 'a', location: 'Hallway', type: 'battery', photo: '' }] });
  assert.equal(ok.code, 200);
  assert.equal(t.job('j1').alarm_units.length, 1);
  assert.equal((await t.call({ action: 'save', id: 'j1', alarm_units: [{ location: 'Hall', type: 'solar' }] })).code, 400);
  assert.equal((await t.call({ action: 'save', id: 'j1', alarm_units: [{ location: 'Hall', type: 'battery', photo: '/etc/passwd' }] })).code, 400);
});

test('the compliance certificate is only released when the job is paid in full', async () => {
  const t = setup();
  const sig = 'data:image/png;base64,iVBORw0KGgo=';
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_hardwired', qty: 3 }], approve: true });
  const later = await t.call({ action: 'complete', id: 'j1', paid_in_full: false, signoff_name: 'Jake Turner', signature: sig });
  assert.equal(later.code, 200);
  assert.equal(t.job('j1').pay_status, 'later');
  assert.equal(certCalls.length, 0, 'invoice still owing: no certificate');

  const paid = setup();
  await paid.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_hardwired', qty: 3 }], approve: true, pay_receipt: '/PowerSmart Jobs/J1001 - Kath/Receipts/receipts-1.jpg' });
  assert.equal((await paid.call({ action: 'complete', id: 'j1', paid_in_full: true, method: 'cash', signoff_name: 'Jake Turner', signature: sig })).code, 200);
  assert.equal(certCalls.length, 1, 'paid in full on site: certificate released');
  assert.equal(certCalls[0].id, 'j1');
});

test('a card payment after sign-off releases the paid invoice and certificate; a card payment before sign-off does not', async () => {
  const t = setup();
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_hardwired', qty: 3 }], approve: true });
  await t.call({ action: 'pay', id: 'j1' });
  const s = t.Stripe.sessions.get(t.job('j1').pay_session_id); s.payment_status = 'paid'; s.status = 'complete';
  await t.call({ action: 'pay_check', id: 'j1' });
  assert.equal(afterPayCalls.length, 1, 'webhook/app hook runs on payment (it skips jobs that are not completed yet)');
  assert.equal(afterPayCalls[0].id, 'j1');
});

test('a job reverted to assigned can be redone: money already received counts against the new invoice', async () => {
  const t = setup();
  Object.assign(t.job('j1'), { pay_status: 'unpaid', prior_paid_cents: 15800, prior_pay_method: 'cash', prior_paid_by: 't1' });
  const saved = await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_hardwired', qty: 2 }], alarm_units: [{ id: 'u1', location: 'Hall', type: 'hardwired' }, { id: 'u2', location: 'Study', type: 'hardwired' }], approve: true });
  assert.equal(saved.code, 200, 'the invoice is editable again');
  assert.equal(saved.data.totals.total, 15800);
  assert.equal(saved.data.totals.due, 0, 'the earlier cash covers it');
  assert.equal(JSON.stringify(saved.data.credits.map((c) => c.label)), JSON.stringify(['Paid earlier (cash)']));
  const more = await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_hardwired', qty: 3 }], alarm_units: [{ id: 'u1', location: 'Hall', type: 'hardwired' }, { id: 'u2', location: 'Study', type: 'hardwired' }, { id: 'u3', location: 'Bedroom', type: 'hardwired' }], approve: true });
  assert.equal(more.data.totals.due, 7900, 'only the extra alarm is still owing');
});

test('a reset job still marked paid is healed when the electrician opens it: payment becomes a credit and alarms can be added', async () => {
  const t = setup();
  Object.assign(t.job('j1'), { status: 'scheduled', pay_status: 'paid', pay_method: 'cash', paid_cents: 15800, pay_receipt: '/PowerSmart Jobs/J1001 - Kath/Receipts/r.jpg', invoice_items: null, alarm_units: null });
  const opened = await t.call({ action: 'job', id: 'j1' });
  assert.equal(opened.code, 200);
  assert.equal(t.job('j1').pay_status, 'unpaid');
  assert.equal(t.job('j1').prior_paid_cents, 15800);
  assert.equal(opened.data.job.pay_status, 'unpaid', 'the app is no longer locked');
  assert.equal(opened.data.credits.length, 1);
});


test('linked quote discount survives fitting, approval, and card pricing without deducting the separate booking fee twice', async () => {
  const t = setup();
  const job = t.job('j1');
  job.quote_ref = 'Q7012';
  const quote = t.db.tables.sent_emails[0];
  quote.body_text += '\n- Discount (1 x -$50.00): -$50.00';
  const items = [{ code: 'alarm_battery', qty: 4 }, { code: 'alarm_hardwired', qty: 2 }, { code: 'controller', qty: 1, photos: [{ id: 'c1', photo: '/PowerSmart Jobs/J1001 - Kath/Controllers/controller.jpg' }] }];
  const detail = await t.call({ action: 'job', id: job.id });
  assert.equal(detail.data.quote_discount_cents, 5000);
  assert.equal(detail.data.items.length, 0);
  const stale = await t.call({ action: 'save', id: job.id, items, approve: true, quote_discount_cents: 0 });
  assert.equal(stale.code, 409);
  const units = Array.from({ length: 6 }, (_, i) => ({ type: i < 4 ? 'battery' : 'hardwired' }));
  const approved = await t.call({ action: 'save', id: job.id, items: [...items, { code: 'quote_discount', qty: 99 }], alarm_units: units, approve: true, quote_discount_cents: 5000 });
  assert.equal(approved.code, 200);
  assert.equal(approved.data.totals.due, 45900);
  assert.equal(approved.data.booking_fee_cents, 3500);
  assert.equal(job.invoice_items.filter(i => i.code === 'quote_discount').length, 1);
  assert.equal(job.invoice_items.find(i => i.code === 'quote_discount').amount_cents, -5000);
  assert.equal((await t.call({ action: 'pay', id: job.id })).data.amount_cents, 45900);

  quote.body_text = quote.body_text.replaceAll('-$50.00', '-$60.00');
  assert.equal((await t.call({ action: 'pay', id: job.id })).code, 409);
  const revised = await t.call({ action: 'job', id: job.id });
  assert.equal(revised.data.job.approved_at, null);
  assert.equal(revised.data.totals.due, 44900);
});


function inspectionSetup(provider) {
  const t=setup(provider);
  Object.assign(t.job('j1'),{work_type:'inspection',quote_ref:'QI1',inspection_payment_id:'p-inspection'});
  t.db.tables.payment_requests.push({id:'p-inspection',lead_id:'lead1',quote_ref:'QI1',status:'paid',payment_type:'inspection',amount_cents:12000,amount_paid_cents:12000});
  return t;
}
function inspectionRecord(compliant=true,decision='') {
  return {alarms:[{id:'e1',type:'battery',location:'Bedroom 1',expiry:'2034-01-01',photo:'/PowerSmart Jobs/J1001/Before/alarm.jpg',plate:'/PowerSmart Jobs/J1001/Before/plate.jpg'}],
    checks:{coverage:compliant?'pass':'fail',photoelectric:'pass',age_expiry:'pass',functionality:'pass',interconnection:'pass'},
    findings:'Inspected existing alarms',compliant,reason:compliant?'':'Bedroom coverage missing',decision,customer_name:decision==='accepted'?'Test Customer':''};
}
const inspectionSignature='data:image/png;base64,AAAA';
test('compliant inspection retains $120, completes with zero owing and releases certificate once',async()=>{
  const t=inspectionSetup();
  assert.equal((await t.call({action:'inspection_save',id:'j1',inspection:inspectionRecord()})).code,200);
  const result=await t.call({action:'complete',id:'j1',signoff_name:'Jake',signature:inspectionSignature,inspection_confirmed:true});
  assert.equal(result.code,200);
  assert.equal(result.data.job.compliance_outcome,'compliant');
  assert.equal(result.data.job.amount_due_cents,0);
  assert.equal(result.data.job.invoice_total_cents,12000);
  assert.equal(certCalls.length,1);
  assert.equal(invoiceCalls[0].totals.due,0);
  assert.equal(invoiceCalls[0].credits[0].cents,12000);
  assert.equal((await t.call({action:'complete',id:'j1',signoff_name:'Jake',signature:inspectionSignature,inspection_confirmed:true})).code,409);
  assert.equal(invoiceCalls.length,1);
  assert.equal(certCalls.length,1);
});
test('declined upgrade completes non-compliant inspection without issuing a certificate',async()=>{
  const t=inspectionSetup();
  await t.call({action:'inspection_save',id:'j1',inspection:inspectionRecord(false,'declined')});
  const r=await t.call({action:'complete',id:'j1',signoff_name:'Jake',signature:inspectionSignature,inspection_confirmed:true});
  assert.equal(r.code,200);
  assert.equal(r.data.job.compliance_outcome,'declined');
  assert.equal(r.data.job.invoice_total_cents,12000);
  assert.equal(r.data.job.amount_due_cents,0);
  assert.equal(certCalls.length,0);
  assert.match(r.data.certificate.reason,/Non-compliant/);
  assert.equal(invoiceCalls.length,1);
});
test('accepted inspection converts in place, charges 6 x $79 + $50 less $120 = $404, then uses normal installation payment and signoff',async()=>{
  const t=inspectionSetup('revolut'), count=t.db.tables.jobs.length;
  await t.call({action:'inspection_save',id:'j1',inspection:inspectionRecord(false,'accepted')});
  let r=await t.call({action:'inspection_convert',id:'j1',inspection:inspectionRecord(false,'accepted')});
  assert.equal(r.code,200,JSON.stringify(r.data));
  assert.equal(t.db.tables.jobs.length,count);
  assert.equal(t.job('j1').work_type,'install');
  assert.equal(t.job('j1').compliance_outcome,'converted');
  assert.equal((await t.call({action:'inspection_convert',id:'j1',inspection:inspectionRecord(false,'accepted')})).code,409);
  const units=Array.from({length:6},(_,i)=>({id:'u'+i,type:i<4?'battery':'hardwired',location:'Bedroom '+i,photo:'/PowerSmart Jobs/J1001/Alarms/'+i+'.jpg'}));
  r=await t.call({action:'save',id:'j1',alarm_units:units,items:[{code:'alarm_battery',qty:4},{code:'alarm_hardwired',qty:2},{code:'inspection',qty:1}],approve:true});
  assert.equal(r.code,200,JSON.stringify(r.data));
  assert.equal(r.data.totals.total,52400);
  assert.equal(r.data.totals.credit,12000);
  assert.equal(r.data.totals.due,40400);
  assert.equal(r.data.items.some(i=>i.code==='inspection'),false);
  const pay=await t.call({action:'pay',id:'j1'});
  assert.equal(pay.code,200,JSON.stringify(pay.data));
  assert.equal(pay.data.amount_cents,40400);
  const session=t.Stripe.sessions.get(t.job('j1').pay_session_id);
  session.payment_status='paid';session.status='complete';
  await t.tech.reconcileJobPayment(session);
  const blocked=await t.call({action:'complete',id:'j1',signoff_name:'Jake',signature:inspectionSignature});
  assert.equal(blocked.code,409);
  r=await t.call({action:'complete',id:'j1',signoff_name:'Jake',signature:inspectionSignature,installation_compliant:true,customer_approved:true});
  assert.equal(r.code,200,JSON.stringify(r.data));
  assert.equal(r.data.job.compliance_outcome,'installed');
  assert.equal(r.data.job.paid_cents,40400);
  assert.equal(certCalls.length,1);
  assert.equal(invoiceCalls[0].totals.total,52400);
  assert.equal(invoiceCalls[0].bookingFee,0);
  assert.equal(t.db.tables.jobs.length,count);
});
test('inspection completion rejects missing checks, photos, non-compliance reason, decision or signoff',async()=>{
  for(const mutate of [
    d=>delete d.checks.coverage,d=>d.alarms[0].plate='',d=>{d.compliant=false;d.reason='';d.decision='declined';},d=>{d.compliant=false;d.reason='Coverage';d.decision='';}
  ]){
    const t=inspectionSetup(),d=inspectionRecord();mutate(d);
    await t.call({action:'inspection_save',id:'j1',inspection:d});
    assert.equal((await t.call({action:'complete',id:'j1',signoff_name:'Jake',signature:inspectionSignature,inspection_confirmed:true})).code,409);
    assert.equal(certCalls.length,0);
  }
});
test('inspection credit cannot use another quote, an unpaid payment or an already allocated payment',async()=>{
  for(const mutate of [
    t=>t.db.tables.payment_requests.find(p=>p.id==='p-inspection').status='sent',
    t=>t.db.tables.payment_requests.find(p=>p.id==='p-inspection').quote_ref='OTHER',
    t=>t.db.tables.jobs.push({id:'used',inspection_payment_id:'p-inspection'})
  ]){
    const t=inspectionSetup();mutate(t);
    assert.equal((await t.call({action:'inspection_convert',id:'j1',inspection:inspectionRecord(false,'accepted')})).code,409);
    assert.equal(t.Stripe.calls.length,0);
  }
});


test('completing a job asks for the Google review once, with the completed job', async () => {
  const t = setup(), before = reviewCalls.length;
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 1 }], approve: true });
  const r = await t.call({ action: 'complete', id: 'j1', paid_in_full: false, signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(r.code, 200);
  assert.equal(r.data.review.status, 'sent');
  assert.equal(reviewCalls.length, before + 1);
  assert.equal(reviewCalls.at(-1).status, 'completed');
});
