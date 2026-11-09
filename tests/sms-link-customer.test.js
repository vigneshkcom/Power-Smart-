const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

// Real api/sms.js with a small in-memory leads / quotes / comments store.
function fixture(leads) {
  const module = { exports: {} }, comments = [], writes = [], msgs = [{ id: 'm1', status: 'received', phone: '+61451898761' }, { id: 'm2', status: 'sent', phone: '+61451898761' }, { id: 'm3', status: 'optout', phone: '+61451898761' }, { id: 'm4', status: 'sent', phone: '+61411334646' }, { id: 'm5', status: null, phone: '+61411334646' }];
  const SB = { configured: () => true, async sb(q, o = {}) {
    if (q.startsWith('leads?') && !o.method) {
      if (q.includes('or=(')) { const needle = decodeURIComponent(q.split('*')[1] || '').toLowerCase(); return leads.filter((l) => (l.name + l.email + l.phone).toLowerCase().includes(needle)); }
      if (q.includes('phone=not.is.null')) return leads.filter((l) => l.phone);
      const id = /id=eq\.([^&]+)/.exec(q); if (id) return leads.filter((l) => l.id === id[1]);
    }
    if (q.startsWith('leads?id=eq.') && o.method === 'PATCH') { const id = /id=eq\.([^&]+)/.exec(q)[1]; Object.assign(leads.find((l) => l.id === id), o.body); writes.push(o.body); return []; }
    if (q === 'leads' && o.method === 'POST') { const l = { id: 'new1', ...o.body }; leads.push(l); return [l]; }
    if (q === 'lead_comments') { comments.push(o.body); return []; }
    if (q.startsWith('sent_emails?lead_id=eq.')) return q.includes('lead_id=eq.l1&') ? [{ id: '8abe9f5b-2495-4ee3-b521-0364df34db00' }] : [];
    if (q.startsWith('sms_messages?id=eq.')) { const id = /id=eq\.([^&]+)/.exec(q)[1]; const i = msgs.findIndex((m) => m.id === id); if (o.method === 'DELETE') { if (i >= 0) msgs.splice(i, 1); return []; } return i >= 0 ? [msgs[i]] : []; }
    if (q.startsWith('sms_messages?phone_number=eq.')) {
      const phone = decodeURIComponent(/phone_number=eq\.([^&]+)/.exec(q)[1]);
      const mine = msgs.filter((m) => m.phone === phone);
      if (o.method === 'DELETE') { const gone = mine.filter((m) => m.status !== 'optout' && m.status !== 'optin'); gone.forEach((m) => msgs.splice(msgs.indexOf(m), 1)); return gone; }
      return mine;
    }
    if (q.startsWith('sms_messages')) return [];
    return [];
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/sms.js'), 'utf8'), {
    module, require: (k) => (k === './_supabase' ? SB : require(path.join(__dirname, '../api', k))), Buffer, AbortController, setTimeout, clearTimeout,
    console: { error() {}, log() {} }, process: { env: { SMS_ENABLED: 'true', SMSGATE_USERNAME: 'u', SMSGATE_PASSWORD: 'p' } }, fetch: async () => new Response('[]', { status: 200 }),
  });
  const call = async (method, query, body) => { const r = { code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } }; await module.exports({ method, query: query || {}, headers: {}, body: body || {} }, r); return r; };
  return { call, comments, writes, leads, msgs };
}
const base = () => [
  { id: 'l1', name: 'Kath Gillespie', phone: '0451 898 761', email: 'kath@example.com', stage: 'quote_sent', quote_ref: '7001', quote_total: 445 },
  { id: 'l2', name: 'Peter Wallmer', phone: '+61411334646', email: null, stage: 'scheduled' },
  { id: 'l3', name: 'No Mobile', phone: null, email: 'nm@example.com', stage: 'new_lead' },
];

test('a conversation shows the customers whose mobile matches it, with the saved quote link', async () => {
  const f = fixture(base());
  const r = await f.call('GET', { action: 'conversation', phone: '+61451898761' });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.leads.map((l) => l.id), ['l1'], 'matches 0451 898 761 and +61451898761 as one number');
  assert.equal(r.body.leads[0].quote_url, 'https://quotes.powersmartco.com.au/quote?token=8abe9f5b-2495-4ee3-b521-0364df34db00');
  const none = await f.call('GET', { action: 'conversation', phone: '+61400000000' });
  assert.deepEqual(none.body.leads, []);
});

test('connecting a number saves it on the customer and notes it, and warns before replacing a different number', async () => {
  const f = fixture(base());
  let r = await f.call('POST', {}, { action: 'link_lead', lead_id: 'l3', phone: '0412 345 678' });
  assert.equal(r.code, 200);
  assert.equal(f.leads.find((l) => l.id === 'l3').phone, '+61412345678');
  assert.match(f.comments.at(-1).body, /connected from the SMS inbox/);
  r = await f.call('POST', {}, { action: 'link_lead', lead_id: 'l2', phone: '+61412345679' });
  assert.equal(r.code, 409); assert.equal(r.body.code, 'phone_differs');
  assert.equal(f.leads.find((l) => l.id === 'l2').phone, '+61411334646', 'not replaced without confirmation');
  r = await f.call('POST', {}, { action: 'link_lead', lead_id: 'l2', phone: '+61412345679', replace: true });
  assert.equal(r.code, 200); assert.equal(f.leads.find((l) => l.id === 'l2').phone, '+61412345679');
  assert.equal((await f.call('POST', {}, { action: 'link_lead', lead_id: 'nope', phone: '+61412345679' })).code, 404);
  assert.equal((await f.call('POST', {}, { action: 'link_lead', lead_id: 'l3', phone: '123' })).code, 400);
});

test('a customer can be created from a number, and customers can be searched', async () => {
  const f = fixture(base());
  let r = await f.call('POST', {}, { action: 'create_lead', phone: '0422 000 111', name: 'New Person', email: 'NEW@Example.com' });
  assert.equal(r.code, 200);
  const made = f.leads.find((l) => l.name === 'New Person');
  assert.deepEqual([made.phone, made.email, made.source, made.stage], ['+61422000111', 'new@example.com', 'SMS', 'new_lead']);
  assert.equal((await f.call('POST', {}, { action: 'create_lead', phone: '0422 000 111', name: '' })).code, 400);
  assert.equal((await f.call('POST', {}, { action: 'create_lead', phone: '0422 000 111', name: 'X', email: 'bad' })).code, 400);
  r = await f.call('GET', { action: 'lead_search', q: 'wallmer' });
  assert.deepEqual(r.body.leads.map((l) => l.id), ['l2']);
  assert.equal(JSON.stringify((await f.call('GET', { action: 'lead_search', q: 'a' })).body.leads), '[]', 'needs 2+ characters');
});

test('a message can be deleted, but a STOP/START consent message cannot', async () => {
  const f = fixture(base());
  let r = await f.call('POST', {}, { action: 'delete_message', id: 'm2' });
  assert.equal(r.code, 200); assert.equal(f.msgs.length, 4); assert.equal(f.msgs.some((m) => m.id === 'm2'), false);
  r = await f.call('POST', {}, { action: 'delete_message', id: 'm3' });
  assert.equal(r.code, 409); assert.match(r.body.error, /STOP \/ START/); assert.equal(f.msgs.length, 4, 'the opt-out record is kept');
  assert.equal((await f.call('POST', {}, { action: 'delete_message', id: 'nope' })).code, 404);
  assert.equal((await f.call('POST', {}, { action: 'delete_message', id: '' })).code, 400);
});

test('deleting whole conversations removes every message for those numbers but keeps STOP/START records', async () => {
  const f = fixture(base());
  let r = await f.call('POST', {}, { action: 'delete_conversations', phones: ['0411 334 646'] });
  assert.equal(r.code, 200); assert.equal(r.body.deleted, 2, 'including a message with no status'); assert.equal(r.body.kept_consent_records, 0);
  assert.equal(f.msgs.filter((m) => m.phone === '+61411334646').length, 0);
  r = await f.call('POST', {}, { action: 'delete_conversations', phones: ['+61451898761', '+61451898761'] });
  assert.equal(r.body.conversations, 1, 'the same number twice counts once');
  assert.equal(r.body.deleted, 2); assert.equal(r.body.kept_consent_records, 1);
  assert.deepEqual(f.msgs.map((m) => m.id), ['m3'], 'only the opt-out record is left');
  assert.equal((await f.call('POST', {}, { action: 'delete_conversations', phones: [] })).code, 400);
  assert.equal((await f.call('POST', {}, { action: 'delete_conversations', phones: ['abc'] })).code, 400);
});
