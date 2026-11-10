const test = require('node:test'), assert = require('node:assert/strict');
const JR = require('../api/_job-reminders');

test('"tomorrow" is the next Brisbane calendar day, from 5pm on the day before', () => {
  // 5:00pm Brisbane on 10 Nov 2026 = 07:00 UTC
  const w = JR.tomorrowWindow(new Date('2026-11-10T07:00:00Z'));
  assert.equal(w.from, '2026-11-10T14:00:00.000Z');   // 11 Nov 00:00 Brisbane
  assert.equal(w.to, '2026-11-11T14:00:00.000Z');
});

test('reminder wording names the date, slot window and never an exact time', () => {
  const m = JR.reminderMessages({ customer_name: 'Peter Wallmer', job_no: 1013, scheduled_start: '2026-11-10T23:30:00Z' }, '1 Test St, Calamvale 4116');
  assert.match(m.sms, /Hi Peter/); assert.match(m.sms, /tomorrow/); assert.match(m.sms, /AM slot, 8am-12pm/); assert.match(m.sms, /1 Test St/);
  for (const body of [m.text, m.html]) { assert.match(body, /Wednesday 11 November 2026/); assert.match(body, /8:00am and 12:00pm/); assert.doesNotMatch(body, /9:30/); }
});

test('each job is messaged once; paused SMS falls back to email; jobs without contact details are skipped', async () => {
  const SB = require('../api/_supabase'), Sms = require('../api/_sms-outbound');
  const mail = [], sms = [], claimed = new Set();
  SB.sb = async (q, o = {}) => {
    if (q.startsWith('jobs?')) return [
      { id: 'a', job_no: 1, lead_id: null, customer_name: 'A One', phone: '0411334646', email: 'a@example.com', scheduled_start: '2026-11-10T23:30:00Z' },
      { id: 'b', job_no: 2, lead_id: null, customer_name: 'B Two', phone: '', email: '', scheduled_start: '2026-11-10T23:30:00Z' },
    ];
    if (q === 'job_reminders' && o.method === 'POST') {
      const k = o.body.job_id + o.body.scheduled_start;
      if (claimed.has(k)) throw Object.assign(new Error('dup'), { status: 409 });
      claimed.add(k); return null;
    }
    return [];
  };
  Sms.sendLeadSms = async (a) => { sms.push(a); return { status: 'submitted' }; };
  process.env.RESEND_API_KEY = 'test'; process.env.SMS_ENABLED = 'false';
  const Module = require('node:module'), load = Module._load;
  Module._load = function (r, ...rest) {
    if (r === 'resend') return { Resend: class { constructor() { this.emails = { send: async (m) => { mail.push(m); return { data: { id: 'x' } }; } }; } } };
    return load.call(this, r, ...rest);
  };
  try {
    delete require.cache[require.resolve('../api/_job-reminders')];
    const W = require('../api/_job-reminders');
    const now = new Date('2026-11-10T07:00:00Z');
    let r = await W.work({ now });
    assert.deepEqual([r.found, r.sent, r.skipped], [2, 1, 1]);
    assert.equal(mail.length, 1); assert.equal(mail[0].to, 'a@example.com'); assert.equal(sms.length, 0);
    r = await W.work({ now });                       // second run (5:30pm retry) must not message again
    assert.equal(mail.length, 1); assert.equal(r.sent, 0);
    process.env.SMS_ENABLED = 'true'; claimed.clear();
    await W.work({ now });
    assert.equal(sms.length, 1); assert.match(sms[0].message, /tomorrow/);
  } finally { Module._load = load; }
});
