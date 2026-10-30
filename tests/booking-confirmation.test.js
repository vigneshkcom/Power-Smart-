const test = require('node:test'), assert = require('node:assert/strict');
const { bookingSlot, renderBookingEmail } = require('../api/_booking-confirmation');
test('visits are grouped into AM (before 12pm) and PM Brisbane slots', () => {
  assert.equal(bookingSlot('2026-11-03T22:00:00Z').slot, 'AM');   // 8:00am Brisbane
  assert.equal(bookingSlot('2026-11-04T01:30:00Z').slot, 'AM');   // 11:30am
  assert.equal(bookingSlot('2026-11-04T02:00:00Z').slot, 'PM');   // 12:00pm
  assert.equal(bookingSlot('2026-11-04T06:00:00Z').slot, 'PM');   // 4:00pm
  assert.equal(bookingSlot('nonsense'), null);
});
test('confirmation shows the slot window, balance and never an exact time', () => {
  const slot = bookingSlot('2026-11-03T23:30:00Z');
  const { html, text } = renderBookingEmail({ name: 'Peter Wallmer', quoteRef: '7013', quoteTotal: 465, feePaid: 35, address: '1 Test St', slot });
  for (const body of [html, text]) {
    assert.match(body, /Wednesday 4 November 2026/);
    assert.match(body, /8:00am and 12:00pm/);
    assert.match(body, /\$430\.00/);
    assert.doesNotMatch(body, /9:30/);
  }
});

test('sending respects the channel choice and works for a job with no lead', async () => {
  const SB = require('../api/_supabase'), Sms = require('../api/_sms-outbound');
  const calls = { sms: [], mail: [], queries: [] };
  const real = { sb: SB.sb, send: Sms.sendLeadSms };
  SB.sb = async (q) => {
    calls.queries.push(q);
    if (q.startsWith('jobs?id=eq.')) return [{ id: 'j1', job_no: 1013, lead_id: null, customer_name: 'Peter Wallmer', phone: '0411334646', email: 'p@example.com', scheduled_start: '2026-11-03T23:30:00Z', address: '1 Test St', suburb: 'Calamvale', postcode: '4116' }];
    return [];
  };
  Sms.sendLeadSms = async (a) => { calls.sms.push(a); return { status: 'submitted', phone: a.lead.phone }; };
  process.env.RESEND_API_KEY = 'test';
  const Module = require('node:module'), load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'resend') return { Resend: class { constructor() { this.emails = { send: async (m) => { calls.mail.push(m); return { data: { id: 'x' } }; } }; } } };
    return load.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../api/_booking-confirmation')];
    const { sendBookingConfirmation } = require('../api/_booking-confirmation');
    let r = await sendBookingConfirmation({ jobId: 'j1', email: false, sms: true });
    assert.equal(r.sms.status, 'submitted'); assert.equal(calls.mail.length, 0); assert.match(calls.sms[0].message, /AM slot \(8am-12pm\).*0401 991 420/);
    r = await sendBookingConfirmation({ jobId: 'j1', email: true, sms: false });
    assert.equal(r.email.status, 'sent'); assert.equal(calls.mail.length, 1); assert.equal(calls.sms.length, 1);
    await assert.rejects(() => sendBookingConfirmation({ jobId: 'j1', email: false, sms: false }), /Choose email, SMS or both/);
  } finally { Module._load = load; SB.sb = real.sb; Sms.sendLeadSms = real.send; }
});
