const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

function load({ welcome, process: proc }) {
  const module = { exports: {} };
  const SB = { configured: () => true, sb: async (q, o = {}) => (q === 'leads' && o.method === 'POST' ? [{ id: 'l1', stage: 'new_lead', ...o.body }] : []) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/pipeline.js'), 'utf8'), {
    module, process: proc || { env: {} }, console: { error() {} }, URL, Buffer,
    require: (k) => (k === './_supabase' ? SB : k === './_welcome-sms' ? { welcomeLead: welcome } : require(k)),
  }, { filename: 'pipeline.js' });
  return module.exports;
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {} });
const KEY = { 'x-portal-key': '2026' };
const create = (h, body) => { const r = res(); return h({ method: 'POST', headers: KEY, url: '/api/pipeline', body: { action: 'create', name: 'Kath', phone: '0411111111', email: 'k@example.com', ...body } }, r).then(() => r); };

test('adding a lead sends the welcome SMS by default and not when the SMS box is unticked', async () => {
  const calls = [];
  const h = load({ welcome: async (l) => { calls.push(l.name); return { status: 'submitted' }; } });
  let r = await create(h, {});
  assert.equal(r.body.welcome_sms.status, 'submitted');
  r = await create(h, { send_sms: false });
  assert.equal(r.body.welcome_sms.status, 'skipped');
  r = await create(h, { skip_welcome: true });
  assert.equal(r.body.welcome_sms.status, 'skipped');
  assert.equal(calls.length, 1, 'only the first lead sent an SMS');
});

test('the confirmation email is only attempted when asked for and the lead has an email address', async () => {
  const h = load({ welcome: async () => ({ status: 'skipped' }) });
  let r = await create(h, {});
  assert.equal(r.body.confirmation_email.status, 'skipped', 'not sent unless ticked');
  r = await create(h, { send_email: true, email: '' });
  assert.equal(r.body.confirmation_email.status, 'skipped', 'nothing to send to without an email address');
  r = await create(h, { send_email: true });
  assert.equal(r.body.confirmation_email.status, 'failed', 'reports a problem (email service not configured here) without failing the lead');
  assert.equal(r.code, 200);
  assert.ok(r.body.lead.id);
});
