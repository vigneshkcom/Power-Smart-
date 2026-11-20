const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const W = require('../api/_warranty');

// Mocks stay active until the test ends, so modules required lazily during a call are mocked too.
const ORIG_LOAD = Module._load;
function fresh(file, mocks) {
  Module._load = function (r, ...a) { return r in mocks ? mocks[r] : ORIG_LOAD(r, ...a); };
  delete require.cache[require.resolve(file)];
  return require(file);
}
test.afterEach(() => { Module._load = ORIG_LOAD; });

const units = [
  { id: 'a', location: 'Hallway', type: 'battery', fault: 'Beeping or chirping', outcome: 'replaced' },
  { id: 'b', location: 'Bedroom', type: 'battery', fault: 'False alarms', outcome: 'replaced' },
  { id: 'c', location: 'Lounge', type: 'hardwired', fault: 'Damaged', outcome: 'replaced' },
  { id: 'd', location: 'Kitchen', type: 'hardwired', fault: 'Other', outcome: 'fixed' },
];
const warrantyJob = { work_type: 'warranty', alarm_units: units };

test('warranty counts: each replaced alarm uses one good alarm of that type; fixed alarms use none', () => {
  assert.deepEqual(W.warrantyCounts(warrantyJob), { battery: 2, hardwired: 1, fixed: 1 });
  assert.deepEqual(W.warrantyCounts({ work_type: 'install', alarm_units: units }), { battery: 0, hardwired: 0, fixed: 0 });
  assert.equal(W.unitsSummary(units), 'Replaced 2 battery alarms (Hallway: Beeping or chirping; Bedroom: False alarms). Replaced 1 hardwired alarm (Lounge: Damaged). Fixed 1 without replacing (Kitchen: Other).');
  assert.equal(W.unitsSummary([]), 'No alarms recorded.');
});

test('customer wording: warranty visit, no charge, and the customer name is escaped', () => {
  const slot = { date: 'Thursday 19 November 2026', short: 'Thu 19 Nov', slot: 'AM', window: '8am and 12pm' };
  const b = W.bookingMessages({ name: '<b>Gail</b> Butters', jobNo: 1204, slot, address: '3 High St, Hervey Bay 4655' });
  assert.match(b.subject, /warranty visit is booked: Thu 19 Nov \(AM\)/); assert.match(b.sms, /warranty visit is booked for Thu 19 Nov, AM slot \(8am-12pm\) at 3 High St/);
  assert.match(b.sms, /no charge/); assert.match(b.text, /no charge/); assert.doesNotMatch(b.html, /<b>Gail<\/b>/);
  const r = W.bookingMessages({ name: 'Gail', slot, tomorrow: true });
  assert.match(r.subject, /^Reminder: your PowerSmart warranty visit is tomorrow/); assert.match(r.sms, /a reminder that your smoke alarm warranty visit is booked for tomorrow/);
  const c = W.completionMessages({ name: 'Gail', jobNo: 1204, units });
  assert.match(c.text, /- Hallway: replaced with a new battery smoke alarm \(beeping or chirping\)/); assert.match(c.text, /- Kitchen: checked and fixed/);
});

test('stock: replaced alarms come out of good stock and put a faulty alarm with the electrician until it is taken back', () => {
  const { buildSummary } = require('../api/_stock');
  // The real installedCounts from api/_jobs.js (internal to that module), evaluated on its own.
  const jobsSrc = require('node:fs').readFileSync(require.resolve('../api/_jobs'), 'utf8');
  const vm = require('node:vm'), ctx = { require: (k) => (k === './_warranty' ? W : {}), module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(jobsSrc.slice(jobsSrc.indexOf('function installedCounts'), jobsSrc.indexOf('const METHOD_WORD')) + ';this.real=installedCounts;', ctx);
  const real = ctx.real;
  const install = { electrician_id: 't1', completed_at: '2026-11-12T00:00:00Z', invoice_items: [{ code: 'alarm_battery', qty: 3 }] };
  const warranty = { electrician_id: 't1', completed_at: '2026-11-13T00:00:00Z', ...warrantyJob };
  assert.deepEqual([real(warranty).battery, real(warranty).warranty_battery, real(warranty).warranty_hardwired, real(warranty).untyped], [0, 2, 1, 0]);
  assert.match(real(warranty).other[0], /^Warranty: Replaced 2 battery alarms/);
  const techs = [{ id: 't1', name: 'Dillon' }];
  const moves = [
    { electrician_id: 't1', product: 'battery', qty: 10, created_at: '2026-11-10T22:00:00Z' },
    { electrician_id: 't1', product: 'hardwired', qty: 4, created_at: '2026-11-10T22:00:00Z' },
  ];
  let d = buildSummary(techs, moves, [install, warranty], real)[0];
  assert.deepEqual([d.on_hand.battery, d.on_hand.hardwired], [10 - 3 - 2, 4 - 1]);
  assert.deepEqual([d.faulty_held.battery, d.faulty_held.hardwired], [2, 1]);
  assert.deepEqual([d.warranty_used.battery, d.warranty_used.hardwired], [2, 1]);
  // Office takes 2 faulty battery alarms back: faulty count drops, good stock is untouched.
  moves.push({ electrician_id: 't1', product: 'battery', qty: -2, kind: 'return', condition: 'faulty', created_at: '2026-11-14T00:00:00Z' });
  d = buildSummary(techs, moves, [install, warranty], real)[0];
  assert.deepEqual([d.faulty_held.battery, d.faulty_held.hardwired, d.given.battery, d.on_hand.battery], [0, 1, 10, 5]);
});

test('stock: Take back faulty is stored as a faulty return; only alarms can be faulty', async () => {
  const posted = [];
  const St = fresh('../api/_stock', { './_supabase': { sb: async (q, o) => { posted.push(o.body); return [o.body]; } } });
  const clean = (v, n) => String(v == null ? '' : v).slice(0, n).trim();
  await St.move({ electrician_id: 't1', product: 'battery', kind: 'faulty_return', qty: 3 }, 'Sam', clean);
  assert.deepEqual([posted[0].kind, posted[0].qty, posted[0].condition], ['return', -3, 'faulty']);
  await St.move({ electrician_id: 't1', product: 'battery', kind: 'return', qty: 1 }, 'Sam', clean);
  assert.equal(posted[1].condition, undefined, 'ordinary returns are unchanged');
  await assert.rejects(St.move({ electrician_id: 't1', product: 'controller', kind: 'faulty_return', qty: 1 }, 'Sam', clean), /Only battery or hardwired/);
});

// ---- electrician app (api/_tech.js) ----
function techApp(job) {
  const patches = [], notes = [], mail = [];
  const db = { configured: () => true, async sb(q, o = {}) {
    if (q.startsWith('electricians?')) return [{ id: 't1', code: '1011', name: 'Dillon' }];
    if (q.startsWith('jobs?id=eq.') && o.method === 'PATCH') { patches.push(o.body); Object.assign(job, o.body); return [{ ...job }]; }
    if (q.startsWith('jobs?id=eq.')) return [{ ...job }];
    if (q === 'lead_comments') { notes.push(o.body.body); return []; }
    return [];
  } };
  delete require.cache[require.resolve('../api/_jobs')];   // _jobs writes the lead note through this test's database
  const h = fresh('../api/_tech', {
    './_supabase': db, './_stripe': { configured: () => true },
    './_payments': { checkoutUrl: (u) => u },
    './_job-invoice': { BANK: {} },
    './_maillog': { logEmail: async () => true },
    './_transactional-mail': { Resend: class { constructor() { this.emails = { send: async (m) => { mail.push(m); return { data: { id: 'p' } }; } }; } } },
  });
  const call = (body) => { const r = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; } }; return h({ method: 'POST', headers: { 'x-tech-code': '1011' }, body: { id: 'j1', ...body } }, r).then(() => r); };
  return { call, patches, notes, mail, job };
}
const baseJob = () => ({ id: 'j1', job_no: 1204, electrician_id: 't1', status: 'scheduled', work_type: 'warranty', customer_name: 'Gail Butters', email: 'gail@example.com', lead_id: 'L1', notify_customer: true, alarm_units: [] });
const SIG = 'data:image/png;base64,iVBORw0KGgo=';

test('electrician app: a warranty save keeps fault and outcome, never creates an invoice, and needs an outcome', async () => {
  const t = techApp(baseJob());
  let r = await t.call({ action: 'save', items: [{ code: 'alarm_battery', qty: 2 }], approve: true, alarm_units: [{ id: 'u1', location: 'Hallway', type: 'battery', fault: 'Beeping or chirping', outcome: 'replaced' }] });
  assert.equal(r.code, 200); assert.equal(r.body.warranty, true); assert.ok(r.body.faults.includes('False alarms'));
  assert.deepEqual(Object.keys(t.patches[0]), ['alarm_units']);
  assert.deepEqual(t.patches[0].alarm_units[0], { id: 'u1', location: 'Hallway', type: 'battery', photo: '', fault: 'Beeping or chirping', outcome: 'replaced' });
  r = await t.call({ action: 'save', alarm_units: [{ id: 'u2', location: 'Hallway', type: 'battery', fault: 'Other' }] });
  assert.equal(r.code, 400); assert.match(r.body.error, /Replaced or Fixed/);
  r = await t.call({ action: 'pay' });
  assert.equal(r.code, 409); assert.match(r.body.error, /free/);
});

test('electrician app: completing a warranty job charges nothing, notes the lead and emails the customer only when allowed', async () => {
  let t = techApp({ ...baseJob(), alarm_units: units });
  let r = await t.call({ action: 'complete', signoff_name: 'Dillon', signature: SIG });
  assert.equal(r.code, 200); assert.equal(r.body.warranty, true); assert.equal(r.body.email.status, 'sent');
  assert.deepEqual([t.patches[0].status, t.patches[0].pay_status, t.patches[0].amount_due_cents], ['completed', 'none', 0]);
  assert.equal(t.mail.length, 1); assert.equal(t.mail[0].to, 'gail@example.com'); assert.match(t.mail[0].subject, /warranty visit is complete/);
  assert.match(t.notes[0], /Warranty job J1204 completed .*Replaced 2 battery alarms.*Faulty alarms returned: 2 battery, 1 hardwired/);

  t = techApp({ ...baseJob(), alarm_units: units, notify_customer: false });
  r = await t.call({ action: 'complete', signoff_name: 'Dillon', signature: SIG });
  assert.equal(r.code, 200); assert.equal(r.body.email.status, 'skipped'); assert.equal(t.mail.length, 0, 'office chose not to message the customer');

  t = techApp({ ...baseJob(), alarm_units: units, notify_email: false, notify_sms: true });
  r = await t.call({ action: 'complete', signoff_name: 'Dillon', signature: SIG });
  assert.equal(r.body.email.status, 'skipped'); assert.equal(t.mail.length, 0, 'SMS only: no completion email');

  t = techApp(baseJob());
  r = await t.call({ action: 'complete', signoff_name: 'Dillon', signature: SIG });
  assert.equal(r.code, 409); assert.match(r.body.error, /alarms you checked/);
});

// ---- day-before reminders ----
function reminders(jobs, { missingColumn = false } = {}) {
  const sent = [], sms = [], queries = [];
  const R = fresh('../api/_job-reminders', {
    './_supabase': { async sb(q, o = {}) {
      queries.push(q);
      if (q.startsWith('jobs?')) { if (missingColumn && q.includes('notify_customer')) throw new Error('column jobs.notify_customer does not exist'); return jobs; }
      return [];
    } },
    './_sms-outbound': { smsEnabled: () => true, sendLeadSms: async (a) => { sms.push(a.message); return { status: 'submitted' }; } },
    './_maillog': { logEmail: async () => true },
    './_transactional-mail': { Resend: class { constructor() { this.emails = { send: async (m) => { sent.push(m); return { data: { id: 'x' } }; } }; } } },
  });
  return { R, sent, sms, queries };
}
const tomorrow = (now) => new Date(Date.parse(require('../api/_job-reminders').tomorrowWindow(now).from) + 9 * 3600e3).toISOString();

test('reminders: warranty jobs get warranty wording, and nothing goes to a customer the office chose not to message', async () => {
  const now = new Date('2026-11-17T07:00:00Z'), at = tomorrow(now);
  const jobs = [
    { id: 'a', job_no: 1, customer_name: 'Gail', email: 'g@example.com', phone: '0434612597', scheduled_start: at, work_type: 'warranty', notify_customer: true },
    { id: 'b', job_no: 2, customer_name: 'Tom', email: 't@example.com', phone: '0411111111', scheduled_start: at, work_type: 'warranty', notify_customer: false },
    { id: 'c', job_no: 3, customer_name: 'Ann', email: 'a@example.com', scheduled_start: at, work_type: 'install', notify_customer: true },
  ];
  const { R, sent, sms } = reminders(jobs);
  const out = await R.work({ now });
  assert.equal(out.sent, 2); assert.equal(out.skipped, 1);
  assert.match(sent[0].subject, /warranty visit is tomorrow/); assert.match(sms[0], /warranty visit/);
  assert.match(sent[1].subject, /install is tomorrow/);
  assert.ok(!sent.some((m) => m.to === 't@example.com'));
});

test('reminders: a warranty job sends only the channels the office ticked', async () => {
  const now = new Date('2026-11-17T07:00:00Z'), at = tomorrow(now);
  const jobs = [
    { id: 'a', job_no: 1, customer_name: 'Gail', email: 'g@example.com', phone: '0434612597', scheduled_start: at, work_type: 'warranty', notify_customer: true, notify_email: false, notify_sms: true },
    { id: 'b', job_no: 2, customer_name: 'Tom', email: 't@example.com', phone: '0411111111', scheduled_start: at, work_type: 'warranty', notify_customer: true, notify_email: true, notify_sms: false },
    { id: 'c', job_no: 3, customer_name: 'Ann', email: '', phone: '0422222222', scheduled_start: at, work_type: 'warranty', notify_customer: true, notify_email: true, notify_sms: false },
  ];
  const { R, sent, sms } = reminders(jobs);
  const out = await R.work({ now });
  assert.equal(out.sent, 2); assert.equal(out.skipped, 1, 'email ticked but no email saved, SMS not ticked');
  assert.deepEqual(sent.map((m) => m.to), ['t@example.com']); assert.equal(sms.length, 1); assert.match(sms[0], /^PowerSmart: Hi Gail/);
});

test('reminders still work before warranty-jobs.sql is run', async () => {
  const now = new Date('2026-11-17T07:00:00Z');
  const { R, sent, queries } = reminders([{ id: 'c', job_no: 3, customer_name: 'Ann', email: 'a@example.com', scheduled_start: tomorrow(now), work_type: 'install' }], { missingColumn: true });
  const out = await R.work({ now });
  assert.equal(out.sent, 1); assert.equal(sent.length, 1); assert.ok(queries.filter((q) => q.startsWith('jobs?')).length === 2);
});

// ---- booking confirmation ----
test('booking confirmation for a warranty job uses the warranty wording and notes the lead', async () => {
  const mail = [], sms = [], notes = [];
  const at = '2026-11-18T23:00:00Z';
  const B = fresh('../api/_booking-confirmation', {
    './_supabase': { async sb(q, o = {}) {
      if (q.startsWith('jobs?')) return [{ id: 'j1', job_no: 1204, lead_id: 'L1', customer_name: 'Gail Butters', phone: '0434612597', email: 'g@example.com', scheduled_start: at, address: '3 High St', suburb: 'Hervey Bay', postcode: '4655', work_type: 'warranty' }];
      if (q === 'lead_comments') { notes.push(o.body.body); return []; }
      return [];
    } },
    './_sms-outbound': { smsEnabled: () => true, sendLeadSms: async (a) => { sms.push(a.message); return { status: 'submitted' }; } },
    './_maillog': { logEmail: async () => true },
    './_job-invoice': { billingAddressFor: async () => '' },
    './_transactional-mail': { Resend: class { constructor() { this.emails = { send: async (m) => { mail.push(m); return { data: { id: 'x' } }; } }; } } },
  });
  const r = await B.sendBookingConfirmation({ jobId: 'j1', agent: 'Sam' });
  assert.equal(r.email.status, 'sent');
  assert.match(mail[0].subject, /warranty visit is booked/); assert.doesNotMatch(mail[0].text, /Balance|quote/i);
  assert.match(sms[0], /warranty visit is booked/); assert.match(notes[0], /^Warranty visit confirmation sent by email and SMS/);
});

test('report: warranty replacements count toward the alarms the electrician is paid for', async () => {
  const src = require('node:fs').readFileSync(require.resolve('../api/_jobs'), 'utf8');
  assert.match(src, /battery: c\.battery \+ c\.warranty_battery, hardwired: c\.hardwired \+ c\.warranty_hardwired/);
});
