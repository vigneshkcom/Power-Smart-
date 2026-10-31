const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

// Fake SMS Gate + Supabase around the real api/sms.js.
function fixture({ webhooks = [], exportOk = true } = {}) {
  const calls = [], rows = [], module = { exports: {} };
  const SB = { configured: () => true, async sb(q, opts = {}) {
    if (opts.method === 'POST') { const r = { id: 'm' + rows.length, created_at: new Date().toISOString(), ...opts.body }; rows.push(r); return [r]; }
    if (q.startsWith('sms_messages?sms_gate_id=eq.')) return rows.filter((r) => r.sms_gate_id === decodeURIComponent(q.split('eq.')[1].split('&')[0]));
    return [];
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/sms.js'), 'utf8'), {
    module, require: (k) => (k === './_supabase' ? SB : require(path.join(__dirname, '../api', k))),
    Buffer, AbortController, setTimeout, clearTimeout, console: { error() {} }, process: { env: { SMSGATE_USERNAME: 'u', SMSGATE_PASSWORD: 'p' } },
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/webhooks') && !options.method) return new Response(JSON.stringify(webhooks), { status: 200 });
      if (url.endsWith('/webhooks')) return new Response('{}', { status: 201 });
      if (url.endsWith('/inbox/export')) return new Response('{}', { status: exportOk ? 202 : 400 });
      return new Response('[]', { status: 200 });
    },
  });
  const res = () => ({ code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } });
  return { handler: module.exports, res, calls, rows };
}

test('a customer reply from SMS Gate is stored as inbound, once, and STOP is an opt-out', async () => {
  const f = fixture(); let r = f.res();
  const hook = (id, message) => ({ method: 'POST', query: {}, headers: {}, body: { event: 'sms:received', payload: { messageId: id, message, phoneNumber: '+61451898761' } } });
  await f.handler(hook('g1', 'Yes please book me in'), r);
  assert.equal(r.code, 200); assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].direction, 'inbound'); assert.equal(f.rows[0].status, 'received'); assert.equal(f.rows[0].phone_number, '+61451898761');
  await f.handler(hook('g1', 'Yes please book me in'), f.res()); assert.equal(f.rows.length, 1, 'the same message is not stored twice');
  await f.handler(hook('g2', 'stop'), f.res()); assert.equal(f.rows[1].status, 'optout');
});

test('connect registers the sms:received webhook pointing at the portal when it is missing', async () => {
  const f = fixture(); const r = f.res();
  await f.handler({ method: 'POST', query: {}, headers: {}, body: { action: 'connect' } }, r);
  assert.equal(r.body.webhook, 'registered');
  const post = f.calls.find((c) => c.method === 'POST' && c.url.endsWith('/webhooks'));
  assert.equal(post.body.event, 'sms:received'); assert.equal(post.body.url, 'https://portal.powersmartco.com.au/api/sms');
});

test('connect does nothing when the webhook is already there, and replaces one pointing elsewhere', async () => {
  let f = fixture({ webhooks: [{ id: 'x', event: 'sms:received', url: 'https://portal.powersmartco.com.au/api/sms' }] }), r = f.res();
  await f.handler({ method: 'POST', query: {}, headers: {}, body: { action: 'connect' } }, r);
  assert.equal(r.body.webhook, 'already'); assert.equal(f.calls.filter((c) => c.method === 'POST').length, 0);
  f = fixture({ webhooks: [{ id: 'old', event: 'sms:received', url: 'https://old.example/api/sms' }] }); r = f.res();
  await f.handler({ method: 'POST', query: {}, headers: {}, body: { action: 'connect' } }, r);
  assert.equal(r.body.webhook, 'registered');
});

test('Sync inbox connects replies first, then asks the phone to resend the last 7 days', async () => {
  const f = fixture(); const r = f.res();
  await f.handler({ method: 'POST', query: {}, headers: {}, body: { action: 'sync' } }, r);
  assert.equal(r.code, 200); assert.equal(r.body.webhook, 'registered');
  const exp = f.calls.find((c) => c.url.endsWith('/3rdparty/v1/messages/inbox/export'));
  const days = (Date.parse(exp.body.until) - Date.parse(exp.body.since)) / 86400000;
  assert.ok(exp.body.since && exp.body.until && Math.round(days) === 7, 'SMS Gate needs a date range');
  const bad = fixture({ exportOk: false }), r2 = bad.res();
  await bad.handler({ method: 'POST', query: {}, headers: {}, body: { action: 'sync' } }, r2);
  assert.equal(r2.code, 502); assert.match(r2.body.error, /Could not request an inbox sync/);
});

test('the connection check says whether replies are connected', async () => {
  const f = fixture({ webhooks: [] }), r = f.res();
  await f.handler({ method: 'GET', query: { action: 'diagnostics' }, headers: { 'x-portal-key': '2026' } }, r);
  assert.equal(r.body.inboundConnected, false);
});
