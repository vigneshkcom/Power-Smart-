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
function fakeStripe() {
  const sessions = new Map(), calls = [];
  return {
    sessions, calls, configured: () => true,
    async request(p, form) {
      calls.push({ p, form });
      if (p === '/checkout/sessions' && form) {
        const s = { id: 'cs_' + (sessions.size + 1), url: 'https://checkout.stripe.com/c/pay/cs_' + (sessions.size + 1), status: 'open', payment_status: 'unpaid',
          amount_total: Number(form['line_items[0][price_data][unit_amount]']), currency: 'aud', metadata: { job_id: form['metadata[job_id]'] } };
        sessions.set(s.id, s); return s;
      }
      const m = p.match(/^\/checkout\/sessions\/([^/]+)(\/expire)?$/);
      const s = sessions.get(decodeURIComponent(m[1]));
      if (m[2]) s.status = 'expired';
      return { ...s };
    },
  };
}
function vmLoad(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api', file), 'utf8'), {
    module, require: (k) => (k in mocks ? mocks[k] : k === './_payment-summary' ? vmLoad('_payment-summary.js', mocks) : require(k)), console: { error() {} }, URL, URLSearchParams, Buffer, setTimeout, process: { env: {} },
  }, { filename: file });
  return module.exports;
}
const QUOTE_TEXT = '- Photoelectric interconnected smoke alarms - supplied & installed (5 x $79.00): $395.00\n- Smoke alarm remote controller (test / hush / locate) (1 x $35.00): $35.00';

const invoiceCalls = [];
function setup() {
  invoiceCalls.length = 0;
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
  const Stripe = fakeStripe();
  const jobs = vmLoad('_jobs.js', { './_supabase': db });
  const mocks = { './_supabase': db, './_stripe': Stripe, './_jobs': jobs, './_quote': require('../api/_quote'), './_payments': { checkoutUrl: (u) => new URL(u).href }, './_job-invoice': { sendJobInvoice: async (a) => { invoiceCalls.push(a); return { status: 'sent', to: a.job.email }; } } };
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

test('an inspection-only job has no alarms', async () => {
  const t = setup();
  Object.assign(t.job('j1'), { work_type: 'inspection', lead_id: null, email: null });
  const d = (await t.call({ action: 'job', id: 'j1' })).data;
  assert.equal(d.items.length, 0, 'the invoice is not pre-populated');
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'inspection', qty: 1 }], approve: true });
  assert(t.job('j1').approved_at);
  assert.equal(t.job('j1').alarms_installed, 0);
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

test('completing needs a signature, and cash or bank transfer counts as paid in full', async () => {
  const t = setup();
  await t.call({ action: 'save', id: 'j1', items: [{ code: 'alarm_battery', qty: 1 }], approve: true });
  assert.equal((await t.call({ action: 'complete', id: 'j1', paid_in_full: false })).code, 400, 'name and signature are required');
  assert.equal((await t.call({ action: 'complete', id: 'j1', paid_in_full: true, signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' })).code, 409, 'paid in full needs a method');
  const done = await t.call({ action: 'complete', id: 'j1', paid_in_full: true, method: 'cash', signoff_name: 'Jake Turner', signature: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(done.code, 200);
  assert.equal(t.job('j1').pay_status, 'paid');
  assert.equal(t.job('j1').pay_method, 'cash');
  assert.equal(t.job('j1').signoff_name, 'Jake Turner');
  assert.equal(done.data.invoice.status, 'sent');
  assert.equal(invoiceCalls.at(-1).paid, true, 'cash payment sends the paid tax invoice');
  assert.equal(invoiceCalls.at(-1).method, 'cash');
});

test('alarm records are saved one by one and validated', async () => {
  const t = setup();
  const ok = await t.call({ action: 'save', id: 'j1', alarm_units: [{ id: 'a', location: 'Hallway', type: 'battery', photo: '' }] });
  assert.equal(ok.code, 200);
  assert.equal(t.job('j1').alarm_units.length, 1);
  assert.equal((await t.call({ action: 'save', id: 'j1', alarm_units: [{ location: 'Hall', type: 'solar' }] })).code, 400);
  assert.equal((await t.call({ action: 'save', id: 'j1', alarm_units: [{ location: 'Hall', type: 'battery', photo: '/etc/passwd' }] })).code, 400);
});
