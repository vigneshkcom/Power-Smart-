const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
function run(body, existing) {
  const calls = [], sent = [], notes = [], orig = Module._load;
  Module._load = function (r, ...a) {
    if (r === './_supabase') return { configured: () => true, async sb(q, o) { calls.push({ q, o }); if (String(q).startsWith('leads?or=')) return existing ? [existing] : []; return [{ id: 'NEW', name: 'x', stage: 'new_lead' }]; } };
    if (r === './_welcome-sms') return { welcomeLead: async () => { calls.push('welcome'); return { status: 'skipped' }; } };
    if (r === './_maillog') return { logEmail: async () => true };
    if (r === './_sms-outbound') return { logNote: async (id, w, t) => { notes.push(t); } };
    if (r === 'resend') return { Resend: class { constructor() { this.emails = { send: async (m) => { sent.push(m); return { data: { id: 'x' } }; } }; } } };
    return orig(r, ...a);
  };
  process.env.RESEND_API_KEY = 'k';
  delete require.cache[require.resolve('../api/lead')];
  const handler = require('../api/lead');
  const res = { status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; }, setHeader() {} };
  return handler({ method: 'POST', body }, res).then(() => { Module._load = orig; return { res, calls, sent, notes }; });
}
test('a repeat enquiry updates the existing lead, creates none, and alerts the team', async () => {
  const { res, calls, sent, notes } = await run({ name: 'Sam', phone: '0411 222 333', email: 'Sam@Example.com', postcode: '4000' }, { id: 'L9', phone: '0411222333', email: null, postcode: null, stage: 'not_interested' });
  assert.equal(res.code, 200);
  const lookup = decodeURIComponent(calls[0].q); assert.match(lookup, /phone\.eq\.\+61411222333/); assert.match(lookup, /email\.eq\.sam@example\.com/);
  assert.equal(calls.filter(c => c.o && c.o.method === 'POST').length, 0);
  const patch = calls.find(c => c.o && c.o.method === 'PATCH'); assert.match(patch.q, /id=eq.L9/);
  assert.equal(patch.o.body.email, 'sam@example.com'); assert.equal(patch.o.body.postcode, '4000'); assert.equal(patch.o.body.stage, 'new_lead');
  assert.ok(!calls.includes('welcome')); assert.equal(sent.length, 1); assert.match(sent[0].subject, /^Repeat enquiry/); assert.match(notes[0], /Repeat website enquiry/);
});
test('a brand-new enquiry still creates a lead and sends the welcome', async () => {
  const { calls, sent } = await run({ name: 'Sam', phone: '0411222333', email: 'sam@example.com', postcode: '4000' }, null);
  assert.equal(calls.filter(c => c.o && c.o.method === 'POST').length, 1); assert.ok(calls.includes('welcome')); assert.equal(sent.length, 2);
});
