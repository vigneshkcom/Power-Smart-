const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

function load(SB, file = '_jobs.js') {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api', file), 'utf8'), {
    module, require: (k) => (k === './_supabase' ? SB : k === './_payment-summary' ? load(SB, '_payment-summary.js') : require(k)), console: { error() {} }, URL, Buffer, process: { env: {} },
  }, { filename: '_jobs.js' });
  return module.exports;
}
function res() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {} };
}
function fixture(initialJob) {
  const calls = [];
  let job = initialJob ? { ...initialJob } : null;
  const SB = {
    configured: () => true,
    async sb(q, opts = {}) {
      calls.push({ q, method: opts.method || 'GET', body: opts.body });
      if (q.startsWith('electricians?id=eq.')) return [{ name: 'Jake Turner' }];
      if (q.startsWith('electricians')) return opts.method === 'POST' ? [{ id: 't1', ...opts.body }] : [];
      if (q.startsWith('jobs?id=eq.') && !opts.method) return job ? [job] : [];
      if (q.startsWith('jobs?id=eq.') && opts.method === 'PATCH') { job = { ...job, ...opts.body }; return [job]; }
      if (q === 'jobs' && opts.method === 'POST') { job = { id: 'j1', job_no: 1001, ...opts.body }; return [job]; }
      if (q.startsWith('jobs?')) return [];
      return [];
    },
  };
  return { handler: load(SB), calls };
}
const KEY = { 'x-portal-key': '2026' };

test('rejects requests without the portal key', async () => {
  const f = fixture(), r = res();
  await f.handler({ method: 'GET', headers: {}, url: '/api/pipeline?resource=jobs' }, r);
  assert.equal(r.code, 401);
});

test('GET loads electricians, jobs in range and the waiting list', async () => {
  const f = fixture(), r = res();
  await f.handler({ method: 'GET', headers: KEY, url: '/api/pipeline?resource=jobs&from=2026-10-23T00:00:00.000Z&to=2026-10-24T00:00:00.000Z' }, r);
  assert.equal(r.code, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['electricians', 'jobs', 'waiting']);
  const q = f.calls.map((c) => c.q);
  assert(q.some((x) => x.includes('scheduled_start=gte.2026-10-23T00%3A00%3A00.000Z') && x.includes('scheduled_start=lt.2026-10-24')));
  assert(q.some((x) => x.includes('or=(electrician_id.is.null,scheduled_start.is.null)')));
});

test('GET requires a date range', async () => {
  const f = fixture(), r = res();
  await f.handler({ method: 'GET', headers: KEY, url: '/api/pipeline?resource=jobs' }, r);
  assert.equal(r.code, 400);
});

test('creating a job from a lead logs a status note on the lead', async () => {
  const f = fixture(), r = res();
  await f.handler({ method: 'POST', headers: KEY, body: {
    action: 'job_create', actor: 'Mani', customer_name: 'Kath Gillespie', lead_id: 'lead1',
    electrician_id: 't1', scheduled_start: '2026-10-23T23:00:00.000Z', duration_min: 60, status: 'scheduled', work_type: 'install',
  } }, r);
  assert.equal(r.code, 200);
  assert.equal(r.body.job.job_no, 1001);
  const note = f.calls.find((c) => c.q === 'lead_comments');
  assert(note, 'lead note written');
  assert.equal(note.body.kind, 'status');
  assert.equal(note.body.author, 'Mani');
  assert.match(note.body.body, /Job J1001 created — assigned to Jake Turner/);
});

test('completing a job moves the lead to Won and logs it', async () => {
  const f = fixture({ id: 'j1', job_no: 1001, lead_id: 'lead1', electrician_id: 't1', status: 'on_site', scheduled_start: '2026-10-23T23:00:00.000Z' }), r = res();
  await f.handler({ method: 'POST', headers: KEY, body: { action: 'job_update', id: 'j1', status: 'completed', actor: 'Sunny' } }, r);
  assert.equal(r.code, 200);
  const won = f.calls.find((c) => c.q.startsWith('leads?id=eq.lead1') && c.body && c.body.stage === 'won');
  assert(won, 'lead stage set to won');
  const note = f.calls.find((c) => c.q === 'lead_comments');
  assert.match(note.body.body, /Job J1001 completed by Jake Turner/);
});

test('rescheduling a linked job logs the new slot; unchanged time logs nothing', async () => {
  const base = { id: 'j1', job_no: 1001, lead_id: 'lead1', electrician_id: 't1', status: 'scheduled', scheduled_start: '2026-10-23T23:00:00+00:00' };
  let f = fixture(base), r = res();
  await f.handler({ method: 'POST', headers: KEY, body: { action: 'job_update', id: 'j1', scheduled_start: '2026-10-23T23:00:00.000Z', notes: 'gate code 1234' } }, r);
  assert.equal(r.code, 200);
  assert(!f.calls.some((c) => c.q === 'lead_comments'), 'same instant is not a reschedule');

  f = fixture(base); r = res();
  await f.handler({ method: 'POST', headers: KEY, body: { action: 'job_update', id: 'j1', electrician_id: null, scheduled_start: null } }, r);
  assert.match(f.calls.find((c) => c.q === 'lead_comments').body.body, /added to the waiting list/);
});

test('validates input', async () => {
  let f = fixture(), r = res();
  await f.handler({ method: 'POST', headers: KEY, body: { action: 'job_create', customer_name: '' } }, r);
  assert.equal(r.code, 400);

  f = fixture({ id: 'j1', job_no: 1001, status: 'scheduled' }); r = res();
  await f.handler({ method: 'POST', headers: KEY, body: { action: 'job_update', id: 'j1', status: 'done' } }, r);
  assert.equal(r.code, 400);
  assert.match(r.body.error, /Invalid status/);

  f = fixture(); r = res();
  await f.handler({ method: 'POST', headers: KEY, body: { action: 'job_create', customer_name: 'A', scheduled_start: 'not a date' } }, r);
  assert.equal(r.code, 400);

  f = fixture(); r = res();
  await f.handler({ method: 'POST', headers: KEY, body: { action: 'tech_create', name: ' ' } }, r);
  assert.equal(r.code, 400);
});

test('adds an electrician', async () => {
  const f = fixture(), r = res();
  await f.handler({ method: 'POST', headers: KEY, body: { action: 'tech_create', name: 'Jake Turner', code: '1011', phone: '0400 000 000', email: 'JAKE@X.COM' } }, r);
  assert.equal(r.code, 200);
  assert.equal(r.body.electrician.email, 'jake@x.com');
});

test('the pipeline function serves job requests (keeps Vercel at 12 functions)', async () => {
  const module = { exports: {} }, seen = [];
  const fakeJobs = (req, res) => { seen.push(req.url); return res.status(200).json({ jobs: true }); };
  const SB = { configured: () => true, async sb() { return []; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/pipeline.js'), 'utf8'), {
    module, console: { error() {} }, URL, process: { env: {} },
    require: (k) => ({ './_supabase': SB, './_welcome-sms': { welcomeLead: async () => {} }, './_jobs': fakeJobs }[k] || require(k)),
  }, { filename: 'pipeline.js' });
  let r = res();
  await module.exports({ method: 'GET', headers: KEY, url: '/api/pipeline?resource=jobs&from=a&to=b' }, r);
  assert.deepEqual(r.body, { jobs: true });
  r = res();
  await module.exports({ method: 'GET', headers: KEY, url: '/api/pipeline' }, r);
  assert.equal(seen.length, 1, 'plain pipeline requests are not routed to jobs');
  const routes = fs.readdirSync(path.join(__dirname, '../api')).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
  assert(routes.length <= 12, `Vercel Hobby allows 12 functions, found ${routes.length}`);
});

test('deleting a job keeps the pipeline lead and notes the removal', async () => {
  const f = fixture({ id: 'j1', job_no: 1001, lead_id: 'lead1', electrician_id: 't1', status: 'scheduled' }), r = res();
  await f.handler({ method: 'POST', headers: KEY, body: { action: 'job_delete', id: 'j1', actor: 'Mani' } }, r);
  assert.equal(r.code, 200);
  const deletes = f.calls.filter((c) => c.method === 'DELETE');
  assert.deepEqual(deletes.map((c) => c.q), ['jobs?id=eq.j1'], 'only the job row is deleted');
  assert(!f.calls.some((c) => c.q.startsWith('leads') && c.method !== 'PATCH'), 'lead is never removed');
  assert.match(f.calls.find((c) => c.q === 'lead_comments').body.body, /Job J1001 removed from the schedule/);
});

test('lead_quote reads alarm and controller counts from the latest sent quote', async () => {
  const text = [
    'Based on the details discussed, your property requires approximately 5 interconnected photoelectric smoke alarms to meet Queensland legislation.',
    '- Photoelectric interconnected smoke alarms - supplied & installed (5 x $79.00): $395.00',
    '- Smoke alarm remote controller (test / hush / locate) (1 x $35.00): $35.00',
  ].join('\n');
  const queries = [];
  const SB = { configured: () => true, async sb(q) {
    queries.push(q);
    if (q.includes('lead_id=eq.lead1')) return [];                       // quote was logged before it was linked
    if (q.includes('to_email=eq.kath%40x.com')) return [{ quote_ref: 'Q7012', quote_total: 430, body_text: text, created_at: '2026-10-20T00:00:00Z' }];
    return [];
  } };
  const h = load(SB), r = res();
  await h({ method: 'POST', headers: KEY, body: { action: 'lead_quote', lead_id: 'lead1', email: 'Kath@X.com' } }, r);
  assert.equal(r.code, 200);
  assert.deepEqual({ ref: r.body.quote.ref, alarms: r.body.quote.alarm_qty, ctrl: r.body.quote.controller_qty, service: r.body.quote.service },
    { ref: 'Q7012', alarms: 5, ctrl: 1, service: 'install' });
  assert(queries[0].includes('kind=eq.quote') && queries[0].includes('status=eq.sent'), 'only successfully sent quotes count');
});

test('lead_quote recognises inspections and returns null when no quote exists', async () => {
  let SB = { configured: () => true, async sb() { return [{ quote_ref: 'Q7013', body_text: '- Smoke alarm compliance inspection (1 x $120.00): $120.00' }]; } };
  let r = res();
  await load(SB)({ method: 'POST', headers: KEY, body: { action: 'lead_quote', lead_id: 'lead2' } }, r);
  assert.equal(r.body.quote.service, 'inspection');
  assert.equal(r.body.quote.alarm_qty, 0);

  SB = { configured: () => true, async sb() { return []; } };
  r = res();
  await load(SB)({ method: 'POST', headers: KEY, body: { action: 'lead_quote', lead_id: 'lead3' } }, r);
  assert.equal(r.code, 200);
  assert.equal(r.body.quote, null);
});

test('report totals what each electrician installed and builds an Excel file', async () => {
  const jobs = [
    { id: 'a', job_no: 1001, status: 'completed', electrician_id: 't1', completed_at: '2026-10-20T01:00:00Z', customer_name: 'A', pay_status: 'paid', paid_cents: 47400, invoice_total_cents: 47400,
      invoice_items: [{ code: 'alarm_battery', qty: 4, label: 'b' }, { code: 'alarm_hardwired', qty: 2, label: 'h' }] },
    { id: 'b', job_no: 1002, status: 'completed', electrician_id: 't1', completed_at: '2026-10-21T01:00:00Z', customer_name: 'B', pay_status: 'later', amount_due_cents: 15300, invoice_total_cents: 15300,
      invoice_items: [{ code: 'alarm', qty: 1, label: 'old' }, { code: 'controller', qty: 1 }, { code: 'other', qty: 1, label: 'Extra callout' }], alarm_type: 'hardwired' },
    { id: 'c', job_no: 1003, status: 'completed', electrician_id: 't2', completed_at: null, scheduled_start: '2026-10-22T01:00:00Z', customer_name: '=cmd', alarms: 3 },
    { id: 'd', job_no: 1004, status: 'completed', electrician_id: 't2', completed_at: '2026-10-21T02:00:00Z', customer_name: 'D', pay_status: 'paid', pay_method: 'cash', paid_cents: 20000, pay_receipt: '/PowerSmart Jobs/J1004/Receipts/r.jpg', invoice_total_cents: 20000, invoice_items: [] },
    { id: 'e', job_no: 1005, status: 'completed', electrician_id: 't2', completed_at: '2026-10-21T03:00:00Z', customer_name: 'E', pay_status: 'paid', pay_method: 'cash', paid_cents: 5000, invoice_total_cents: 5000, invoice_items: [] },
    { id: 'f', job_no: 1006, status: 'completed', electrician_id: 't2', completed_at: '2026-10-21T04:00:00Z', customer_name: 'F', pay_status: 'paid', pay_method: 'bank_transfer', paid_cents: 7000, invoice_total_cents: 7000, invoice_items: [] },
  ];
  const queries = [];
  const SB = { configured: () => true, async sb(q) {
    queries.push(q);
    if (q.startsWith('jobs?')) return jobs;
    if (q.startsWith('electricians?')) return [{ id: 't1', code: '1011', name: 'Jake Turner' }, { id: 't2', code: '1012', name: 'Liam Brooks' }];
    return [];
  } };
  const h = load(SB);
  let r = res();
  await h({ method: 'POST', headers: KEY, body: { action: 'report', from: '2026-10-18T14:00:00.000Z', to: '2026-10-25T14:00:00.000Z' } }, r);
  assert.equal(r.code, 200);
  assert(queries[0].includes('status=eq.completed') && queries[0].includes('completed_at.gte.2026-10-18T14%3A00%3A00.000Z'), 'filtered by completion date');
  const jake = r.body.summary.find((s) => s.electrician === 'Jake Turner');
  assert.equal(JSON.stringify([jake.jobs, jake.battery, jake.hardwired, jake.alarms, jake.controllers, jake.invoice, jake.paid_card, jake.to_collect]),
    JSON.stringify([2, 4, 3, 7, 1, 627, 474, 153]));
  const liam = r.body.summary.find((s) => s.electrician === 'Liam Brooks');
  assert.equal(liam.paid_cash, 200, 'cash the electrician collected (with receipt) is deducted from pay');
  assert.equal(liam.paid_other, 120, 'office-recorded cash and bank transfers went to the company');
  assert.equal(liam.paid_card, 0);
  assert.equal(r.body.rows.find((x) => x.job_no === 1004).payment, 'Paid by cash');
  assert.equal(liam.untyped, 3, 'office-completed job without an invoice still counts booked alarms');
  assert.equal(r.body.totals.alarms, 10);
  assert.equal(r.body.rows[1].other, '1 × Extra callout');

  let sent = null, headers = {};
  r = { code: 200, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, setHeader(k, v) { headers[k] = v; }, send(b) { sent = b; return this; } };
  await h({ method: 'POST', headers: KEY, body: { action: 'report', from: '2026-10-18T14:00:00.000Z', to: '2026-10-25T14:00:00.000Z', format: 'xlsx', label: 'Mon 19 Oct – Sun 25 Oct' } }, r);
  assert.equal(r.code, 200);
  assert.match(headers['Content-Type'], /spreadsheetml/);
  const ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook();
  await wb.xlsx.load(sent);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary by electrician', 'Jobs']);
  const sumSheet = wb.getWorksheet('Summary by electrician');
  assert.equal(sumSheet.getCell('A5').value, 'Jake Turner');
  assert.equal(sumSheet.getCell('G5').value, 7);
  assert.equal(sumSheet.getCell('A7').value, 'Total');
  assert.match(sumSheet.getCell('G7').value.formula, /SUBTOTAL\(109/);
  assert.equal(wb.getWorksheet('Jobs').getCell('E7').value, "'=cmd", 'spreadsheet formulas are neutralised');
});

test('report needs a valid range', async () => {
  const f = fixture(), r = res();
  await f.handler({ method: 'POST', headers: KEY, body: { action: 'report', from: '2026-10-25', to: '2026-10-18' } }, r);
  assert.equal(r.code, 400);
});

test('marking a job completed in the office stamps the completion date', async () => {
  const f = fixture({ id: 'j1', job_no: 1001, status: 'on_site' }), r = res();
  await f.handler({ method: 'POST', headers: KEY, body: { action: 'job_update', id: 'j1', status: 'completed' } }, r);
  assert(f.calls.find((c) => c.method === 'PATCH' && c.q.startsWith('jobs?')).body.completed_at);
});
