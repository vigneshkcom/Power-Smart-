const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

// Real api/sms.js with a fake SMS Gate whose message state we control, and an in-memory sms_messages table.
function fixture(states) {
  const module = { exports: {} }, msgs = [], posts = [];
  const SB = { configured: () => true, async sb(q, o = {}) {
    if (q === 'sms_messages' && o.method === 'POST') { const r = { created_at: new Date().toISOString(), ...o.body }; msgs.push(r); return [r]; }
    if (q.startsWith('sms_messages?id=eq.') && o.method === 'PATCH') { const id = /id=eq\.([^&]+)/.exec(q)[1]; Object.assign(msgs.find((m) => m.id === id), o.body); return []; }
    if (q.startsWith('sms_messages?phone_number=eq.') && q.includes('status=in.(optout,optin)')) return [];
    if (q.startsWith('sms_messages?phone_number=eq.')) {
      const select = new URLSearchParams(q.split('?')[1]).get('select');
      return msgs.map(m => !select ? { ...m } : Object.fromEntries(select.split(',').filter(k => k in m).map(k => [k, m[k]])));
    }
    if (q.startsWith('sms_messages?direction=eq.outbound')) return msgs.filter(m => m.direction === 'outbound' && ['queued','pending','unknown'].includes(m.status)).map(m => ({ ...m }));
    return [];
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/sms.js'), 'utf8'), {
    module, require: (k) => (k === './_supabase' ? SB : require(k.startsWith('.') ? path.join(__dirname, '../api', k) : k)), Buffer, AbortController, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    console: { error() {}, log() {} }, process: { env: { SMS_ENABLED: 'true', SMSGATE_USERNAME: 'u', SMSGATE_PASSWORD: 'p' } },
    fetch: async (url, opts = {}) => {
      if (url.endsWith('/messages') && opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ id: JSON.parse(opts.body).id, state: 'Pending' }), { status: 202 }); }
      const m = /\/messages\/([^/?]+)$/.exec(url);
      if (m) { const s = states.length > 1 ? states.shift() : states[0]; if (s === 'HTTP_ERROR') return new Response('{}', { status: 503 }); return new Response(JSON.stringify({ id: m[1], state: s, recipients: [{ phoneNumber: '+61451898761', state: s, error: s === 'Failed' ? 'No service' : null }] }), { status: 200 }); }
      return new Response('[]', { status: 200 });
    },
  });
  const call = async (method, query, body) => { const r = { code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } }; await module.exports({ method, query: query || {}, headers: {}, body: body || {} }, r); return r; };
  return { call, msgs, posts };
}
const send = (f) => f.call('POST', {}, { action: 'send', phone: '0451 898 761', message: 'Hi Johan, we tried calling.' });

test('a message the phone has actually sent is stored as sent, and uses the same payload as the quote and welcome texts', async () => {
  const f = fixture(['Pending', 'Sent']);
  const r = await send(f);
  assert.equal(r.code, 200); assert.equal(r.body.delivery, 'sent'); assert.equal(r.body.warning, '');
  assert.equal(typeof f.posts[0].id, 'string'); assert.equal(f.posts[0].ttl, 3600); assert.equal(f.posts[0].phoneNumbers[0], '+61451898761');
  assert.equal(f.msgs[0].status, 'sent'); assert.equal(f.msgs[0].sms_gate_id, f.posts[0].id);
});

test('a message still Pending a few seconds after sending is normal: no warning, stored as queued', async () => {
  const f = fixture(['Pending']);
  const r = await send(f);
  assert.equal(r.code, 200); assert.equal(r.body.delivery, 'queued'); assert.match(r.body.warning, /awaiting confirmation/);
  assert.equal(f.msgs[0].status, 'queued');
});

test('Processed (the phone has taken it) counts as sent', async () => {
  const f = fixture(['Processed']);
  const r = await send(f);
  assert.equal(r.body.delivery, 'sent'); assert.equal(r.body.warning, '');
  assert.equal(f.msgs[0].status, 'sent');
});

test('a failed message says so, with the reason', async () => {
  const f = fixture(['Failed']);
  const r = await send(f);
  assert.equal(r.body.delivery, 'failed'); assert.match(r.body.warning, /could not send.*No service/);
  assert.equal(f.msgs[0].status, 'failed');
});

test('opening the conversation brings stuck messages up to date, and an unreadable gateway reply changes nothing', async () => {
  const f = fixture(['Pending']);
  await send(f);                                  // stays queued
  assert.equal(f.msgs[0].status, 'queued');
  const states = ['Processed'];
  const g = fixture(states); g.msgs.push({ id: 'x1', phone_number: '+61451898761', message: 'earlier', direction: 'outbound', status: 'queued', sms_gate_id: 'x1', created_at: new Date().toISOString() });
  const r = await g.call('GET', { action: 'conversation', phone: '+61451898761' });
  assert.equal(r.body.messages[0].status, 'sent'); assert.equal(g.msgs[0].status, 'sent', 'a message wrongly shown as waiting is corrected and saved');
});

test('background reconciliation updates a delayed send without submitting a duplicate SMS', async () => {
  const f = fixture(['Processed']);
  f.msgs.push({ id: 'delayed1', direction: 'outbound', phone_number: '+61451898761', status: 'queued',
    message: 'Earlier SMS', sms_gate_id: 'gateway1', created_at: new Date().toISOString() });
  const r = await f.call('POST', {}, { action: 'refresh_outbound', offset: 0 });
  assert.equal(r.code, 200);
  assert.equal(r.body.checked, 1);
  assert.equal(r.body.updated, 1);
  assert.equal(f.msgs[0].status, 'sent');
  assert.equal(f.posts.length, 0, 'reconciliation must never send a new SMS');
});

test('unknown gateway response remains queued rather than falsely claimed sent', async () => {
  const f = fixture(['HTTP_ERROR']);
  const r = await send(f);
  assert.equal(r.body.delivery, 'queued');
  assert.equal(f.msgs[0].status, 'queued');
  assert.equal(f.posts.length, 1);
});

test('an existing sent text is not downgraded to queued by stale gateway state', async () => {
  const f = fixture(['Pending']);
  f.msgs.push({ id: 'sent1', direction: 'outbound', phone_number: '+61451898761', status: 'sent',
    message: 'Already sent', sms_gate_id: 'gate1', created_at: new Date().toISOString() });
  const r = await f.call('GET', { action: 'conversation', phone: '+61451898761' });
  assert.equal(r.body.messages[0].status, 'sent');
  assert.equal(f.msgs[0].status, 'sent');
});
