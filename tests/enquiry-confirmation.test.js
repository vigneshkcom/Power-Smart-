const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { renderEnquiryConfirmation } = require('../api/_enquiry-confirmation');

test('confirmation email promises a call, asks three questions, and has no phone number', () => {
  const m = renderEnquiryConfirmation({ name: 'Sarah Jones' });
  for (const out of [m.html, m.text]) {
    assert.match(out, /within the next 24 hours/);
    assert.match(out, /bedrooms/i); assert.match(out, /interconnecting hallways/i); assert.match(out, /storeys/i);
    assert.match(out, /existing alarms/i);
    assert.doesNotMatch(out, /0401 991 420|tel:/);
  }
  assert.match(m.html, /Thanks Sarah,/);
  assert.match(renderEnquiryConfirmation({ name: '<b>x</b>' }).html, /Thanks &lt;b&gt;x&lt;\/b&gt;,/);
});

function run(body, { failCustomer = false } = {}) {
  const sent = [], notes = [], orig = Module._load;
  Module._load = function (r, ...a) {
    if (r === './_supabase') return { configured: () => true, async sb() { return [{ id: 'L1', name: 'Sarah', stage: 'new_lead' }]; } };
    if (r === './_welcome-sms') return { welcomeLead: async () => ({ status: 'skipped' }) };
    if (r === './_maillog') return { logEmail: async () => true };
    if (r === './_sms-outbound') return { logNote: async (id, who, text) => { notes.push(text); } };
    if (r === 'resend') return { Resend: class { constructor() { this.emails = { send: async (m) => { sent.push(m); return m.to === 'sarah@example.test' && failCustomer ? { error: { message: 'bounced' } } : { data: { id: 'x' } }; } }; } } };
    return orig(r, ...a);
  };
  process.env.RESEND_API_KEY = 'k';
  delete require.cache[require.resolve('../api/lead')];
  const handler = require('../api/lead');
  return new Promise(resolve => {
    const res = { setHeader() {}, status(n) { this.code = n; return this; }, json(b) { Module._load = orig; resolve({ code: this.code || 200, b, sent, notes }); return this; } };
    handler({ method: 'POST', body }, res);
  });
}

test('enquiry with an email sends the customer a confirmation from and replying to support@', async () => {
  const r = await run({ name: 'Sarah Jones', phone: '0400000000', email: 'sarah@example.test', postcode: '4000' });
  const c = r.sent.find(m => m.to === 'sarah@example.test');
  assert.ok(c); assert.match(c.from, /<support@powersmartco\.com\.au>$/); assert.equal(c.replyTo, 'support@powersmartco.com.au');
  assert.ok(r.sent.some(m => /New lead/.test(m.subject)));
});

test('enquiry without an email sends only the team alert', async () => {
  const r = await run({ name: 'Sarah Jones', phone: '0400000000' });
  assert.equal(r.sent.length, 1); assert.match(r.sent[0].subject, /New lead/);
});

test('a failed customer email is noted and does not stop the team alert', async () => {
  const r = await run({ name: 'Sarah Jones', phone: '0400000000', email: 'sarah@example.test' }, { failCustomer: true });
  assert.equal(r.code, 200); assert.ok(r.sent.some(m => /New lead/.test(m.subject)));
  assert.ok(r.notes.some(n => /failed: bounced/.test(n)));
});
