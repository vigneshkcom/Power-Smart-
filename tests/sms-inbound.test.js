const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

// Fake SMS Gate + Supabase around the real api/sms.js.
// The portal self-test (a POST to the public webhook address) is routed back into the real handler
// unless `selfTest` overrides the response, e.g. to simulate a firewall challenge.
const PORTAL_HOOK = 'https://portal.powersmartco.com.au/api/sms';
function fixture({ webhooks = [], devices = [{ id: 'dev1', lastSeen: new Date().toISOString() }], refreshStatus = 202, exportOk = true, selfTest = null } = {}) {
  const calls = [], rows = [], module = { exports: {} };
  const SB = { configured: () => true, async sb(q, opts = {}) {
    if (opts.method === 'POST') { const r = { id: 'm' + rows.length, created_at: new Date().toISOString(), ...opts.body }; rows.push(r); return [r]; }
    if (q.startsWith('sms_messages?sms_gate_id=eq.')) {
      const id = decodeURIComponent(q.split('eq.')[1].split('&')[0]);
      return rows.filter((r) => r.sms_gate_id === id && (!q.includes('direction=eq.inbound') || r.direction === 'inbound'));
    }
    return [];
  } };
  const res = () => ({ code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/sms.js'), 'utf8'), {
    module, require: (k) => (k === './_supabase' ? SB : require(path.join(__dirname, '../api', k))),
    Buffer, AbortController, setTimeout, clearTimeout, console: { error() {}, log() {} }, process: { env: { SMS_ENABLED: 'true', SMSGATE_USERNAME: 'u', SMSGATE_PASSWORD: 'p' } },
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      if (url === PORTAL_HOOK) {
        if (selfTest) return new Response(selfTest.body, { status: selfTest.status, headers: selfTest.headers || {} });
        const r = res(); await module.exports({ method: 'POST', query: {}, headers: {}, body: JSON.parse(options.body) }, r);
        return new Response(JSON.stringify(r.body), { status: r.code });
      }
      if (url.endsWith('/devices')) return new Response(JSON.stringify(devices), { status: 200 });
      if (url.endsWith('/webhooks') && !options.method) return new Response(JSON.stringify(webhooks), { status: 200 });
      if (url.endsWith('/webhooks')) return new Response('{}', { status: 201 });
      if (url.endsWith('/inbox/refresh')) return new Response(refreshStatus === 202 ? '' : '{"message":"nope"}', { status: refreshStatus });
      if (url.endsWith('/messages/inbox/export')) return new Response('{}', { status: exportOk ? 202 : 400 });
      return new Response('[]', { status: 200 });
    },
  });
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

test('Sync inbox connects replies first, then asks every phone to resend the last 7 days', async () => {
  const f = fixture(); const r = f.res();
  await f.handler({ method: 'POST', query: {}, headers: {}, body: { action: 'sync' } }, r);
  assert.equal(r.code, 200); assert.equal(r.body.webhook, 'registered');
  const exp = f.calls.find((c) => c.url.endsWith('/3rdparty/v1/inbox/refresh'));
  const days = (Date.parse(exp.body.until) - Date.parse(exp.body.since)) / 86400000;
  assert.ok(exp.body.since && exp.body.until && Math.round(days) === 7, 'SMS Gate needs a date range');
  assert.equal(exp.body.webhookDelivery, 'Individual', 'each text arrives as its own sms:received webhook');
  assert.deepEqual(exp.body.messageTypes, ['SMS']);
  assert.equal(exp.body.deviceId, undefined, 'not tied to one phone ID');
  const bad = fixture({ refreshStatus: 400 }), r2 = bad.res();
  await bad.handler({ method: 'POST', query: {}, headers: {}, body: { action: 'sync' } }, r2);
  assert.equal(r2.code, 502); assert.match(r2.body.error, /Could not request an older-texts sync/); assert.match(r2.body.error, /Replies connected: yes/);
});

test('Sync inbox falls back to the deprecated export endpoint when refresh is not available', async () => {
  const f = fixture({ refreshStatus: 404 }), r = f.res();
  await f.handler({ method: 'POST', query: {}, headers: {}, body: { action: 'sync' } }, r);
  assert.equal(r.code, 200);
  const exp = f.calls.find((c) => c.url.endsWith('/3rdparty/v1/messages/inbox/export'));
  assert.ok(exp && exp.body.since && exp.body.until);
});

test('the connection check says whether replies are connected', async () => {
  const f = fixture({ webhooks: [] }), r = f.res();
  await f.handler({ method: 'GET', query: { action: 'diagnostics' }, headers: { 'x-portal-key': '2026' } }, r);
  assert.equal(r.body.inboundConnected, false);
});

test('the webhook is registered for every phone, not one device ID', async () => {
  const f = fixture(); f.calls.length = 0;
  await f.handler({ method: 'POST', query: {}, headers: {}, body: { action: 'connect' } }, f.res());
  const post = f.calls.find((c) => c.method === 'POST' && c.url.endsWith('/webhooks'));
  assert.equal(post.body.deviceId, undefined); assert.equal(post.body.id, 'powersmart-sms-received');
});

test('a portal webhook tied to an old phone registration does not count as connected, and connect replaces it', async () => {
  const stale = [{ id: 'powersmart-sms-received', deviceId: 'gone', event: 'sms:received', url: PORTAL_HOOK }];
  let f = fixture({ webhooks: stale, devices: [{ id: 'dev2' }] }), r = f.res();
  await f.handler({ method: 'GET', query: { action: 'diagnostics' }, headers: { 'x-portal-key': '2026' } }, r);
  assert.equal(r.body.inboundConnected, false); assert.equal(r.body.staleWebhook, true);
  f = fixture({ webhooks: stale, devices: [{ id: 'dev2' }] }); r = f.res();
  await f.handler({ method: 'POST', query: {}, headers: {}, body: { action: 'connect' } }, r);
  assert.equal(r.body.webhook, 'registered');
  // Bound to the phone that is registered now: genuinely connected.
  f = fixture({ webhooks: [{ ...stale[0], deviceId: 'dev2' }], devices: [{ id: 'dev2' }] }); r = f.res();
  await f.handler({ method: 'GET', query: { action: 'diagnostics' }, headers: { 'x-portal-key': '2026' } }, r);
  assert.equal(r.body.inboundConnected, true); assert.equal(r.body.staleWebhook, false);
});

test('the reply is filed under the sender, not the deprecated phoneNumber or the gateway number', async () => {
  const f = fixture(), r = f.res();
  await f.handler({ method: 'POST', query: {}, headers: {}, body: { event: 'sms:received', payload: { messageId: 'h1', message: 'Tuesday works', sender: '0451898761', recipient: '+61400000000', phoneNumber: '0451898761' } } }, r);
  assert.equal(r.code, 200); assert.equal(f.rows[0].phone_number, '+61451898761');
});

test('a webhook body that arrives as a raw JSON string is still stored', async () => {
  const f = fixture(), r = f.res();
  await f.handler({ method: 'POST', query: {}, headers: {}, body: JSON.stringify({ event: 'sms:received', payload: { messageId: 's1', message: 'Hi', sender: '+61451898761' } }) }, r);
  assert.equal(r.code, 200); assert.equal(f.rows.length, 1);
});

test('pings and other phone events are acknowledged without storing anything', async () => {
  const f = fixture();
  for (const event of ['system:ping', 'app:started', 'sms:delivered']) {
    const r = f.res();
    await f.handler({ method: 'POST', query: {}, headers: {}, body: { event, payload: {} } }, r);
    assert.equal(r.code, 200); assert.equal(r.body.receiver, 'powersmart-sms');
  }
  assert.equal(f.rows.length, 0);
});

test('an inbound ID equal to an outbound gateway ID is not mistaken for a duplicate', async () => {
  const f = fixture();
  f.rows.push({ id: 'o1', phone_number: '+61451898761', direction: 'outbound', sms_gate_id: 'abc' });
  const r = f.res();
  await f.handler({ method: 'POST', query: {}, headers: {}, body: { event: 'sms:received', payload: { messageId: 'abc', message: 'Yes', sender: '+61451898761' } } }, r);
  assert.equal(r.body.duplicate, undefined); assert.equal(f.rows.length, 2);
});

test('the connection check proves the public webhook address accepts the phone\'s posts', async () => {
  let f = fixture({ webhooks: [{ id: 'x', event: 'sms:received', url: PORTAL_HOOK }] }), r = f.res();
  await f.handler({ method: 'GET', query: { action: 'diagnostics' }, headers: { 'x-portal-key': '2026' } }, r);
  assert.equal(r.body.selfTest.ok, true); assert.equal(r.body.inboundConnected, true);
  assert.equal(f.rows.length, 0, 'the self-test stores nothing');
  f = fixture({ selfTest: { status: 403, body: '<html>Vercel Security Checkpoint</html>' } }); r = f.res();
  await f.handler({ method: 'GET', query: { action: 'diagnostics' }, headers: { 'x-portal-key': '2026' } }, r);
  assert.equal(r.body.selfTest.ok, false); assert.match(r.body.selfTest.detail, /blocked/);
  f = fixture({ selfTest: { status: 308, body: '', headers: { location: 'https://www.example.com/api/sms' } } }); r = f.res();
  await f.handler({ method: 'GET', query: { action: 'diagnostics' }, headers: { 'x-portal-key': '2026' } }, r);
  assert.equal(r.body.selfTest.ok, false); assert.match(r.body.selfTest.detail, /redirects to https:\/\/www\.example\.com/);
  f = fixture({ selfTest: { status: 200, body: '<html>Staff hub</html>' } }); r = f.res();
  await f.handler({ method: 'GET', query: { action: 'diagnostics' }, headers: { 'x-portal-key': '2026' } }, r);
  assert.equal(r.body.selfTest.ok, false); assert.match(r.body.selfTest.detail, /something other than the SMS portal/);
});
