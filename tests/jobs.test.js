const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

function load(SB) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/_jobs.js'), 'utf8'), {
    module, require: (k) => (k === './_supabase' ? SB : require(k)), console: { error() {} }, URL, process: { env: {} },
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
  await f.handler({ method: 'POST', headers: KEY, body: { action: 'job_update', id: 'j1', status: 'completed', actor: 'Vignesh' } }, r);
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
