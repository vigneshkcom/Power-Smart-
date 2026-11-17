const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), Module = require('node:module');
const OOA = require('../api/_out-of-area');

// Loads a fresh copy of a module with the given request->mock map.
// Mocks stay active until restore() so modules required lazily during a call are mocked too.
const ORIG_LOAD = Module._load;
function fresh(file, mocks) {
  Module._load = function (r, ...a) { return r in mocks ? mocks[r] : ORIG_LOAD(r, ...a); };
  delete require.cache[require.resolve(file)];
  return require(file);
}
const restore = () => { Module._load = ORIG_LOAD; };
test.afterEach(restore);
function notifier({ smsEnabled = true, prior = [], priorEmail = [], smsError = null, emailError = null } = {}) {
  const log = { sms: [], mail: [], notes: [], logged: [] };
  const mod = fresh('../api/_out-of-area', {
    './_supabase': { configured: () => true, async sb(q) { return q.startsWith('sms_messages') ? prior : q.startsWith('sent_emails') ? priorEmail : []; } },
    './_sms-outbound': {
      smsEnabled: () => smsEnabled, cleanPhone: (v) => String(v).replace(/^04/, '+614'),
      async sendLeadSms(a) { if (smsError) throw new Error(smsError); log.sms.push(a); return smsEnabled ? { status: 'submitted' } : { status: 'skipped', paused: true }; },
      async logNote(id, who, t) { log.notes.push(t); },
    },
    './_maillog': { async logEmail(r) { log.logged.push(r); return true; } },
    './_transactional-mail': { Resend: class { constructor() { this.emails = { async send(m) { if (emailError) return { error: { message: emailError } }; log.mail.push(m); return { data: { id: 'p1' } }; } }; } } },
  });
  return { mod, log };
}
const lead = { id: 'L1', name: '  Gail Butters ', phone: '0434612597', email: 'Gail@Example.com' };

test('only Regional QLD postcodes (4600-4899) are out of area; unknown or missing postcodes are in area', () => {
  for (const pc of ['4600', 4655, '4899', ' 4700 ']) assert.equal(OOA.isOutOfArea(pc), true, String(pc));
  for (const pc of ['4599', '4900', '4000', '4211', '2000', '', null, undefined, 'abc', '0']) assert.equal(OOA.isOutOfArea(pc), false, String(pc));
});
test('the server list agrees with the Regional QLD range the board shows, for every postcode', () => {
  const html = fs.readFileSync(require.resolve('../tools/pipeline.html'), 'utf8');
  const code = html.slice(html.indexOf('  var AREA_RANGES'), html.indexOf('  function areaChip'));
  const ctx = {}; vm.createContext(ctx); vm.runInContext(code + ';this.areaForPostcode=areaForPostcode;', ctx);
  for (let n = 0; n <= 9999; n++) assert.equal(ctx.areaForPostcode(String(n)) === 'Regional QLD', OOA.isOutOfArea(n), 'postcode ' + n);
});
test('the installation address postcode wins over the enquiry postcode', () => {
  assert.equal(OOA.leadPostcode({ postcode: '4000', address_postcode: '4655' }), '4655');
  assert.equal(OOA.leadPostcode({ postcode: '4655' }), '4655');
});
test('the approved wording uses the first name and falls back to "there"', () => {
  const m = OOA.outOfAreaMessages('  Gail Butters ');
  assert.match(m.sms, /^Hi Gail,\n\nThanks for contacting PowerSmart about your smoke alarms\. Unfortunately we don't currently service your area, so we're unable to help with your enquiry\.\n\nWe're sorry for the inconvenience and appreciate you thinking of us\.\n\nKind regards,\nPowerSmart Team$/);
  assert.match(m.html, /Hi Gail, thanks for contacting us/); assert.match(m.text, /don't currently service your area/);
  assert.match(OOA.outOfAreaMessages('').sms, /^Hi there,/);
  assert.doesNotMatch(OOA.outOfAreaMessages('<b>x</b>').html, /<b>x<\/b>/);
});
test('notify sends one SMS (stable key) and one email from Customer Service, and records both', async () => {
  const { mod, log } = notifier(), r = await mod.notifyOutOfArea(lead, { agent: 'Sam' });
  assert.equal(r.sms.status, 'submitted'); assert.equal(r.email.status, 'sent');
  assert.equal(log.sms.length, 1); assert.equal(log.sms[0].key, 'out-of-area-L1'); assert.equal(log.sms[0].author, 'Sam');
  assert.equal(log.mail.length, 1); assert.equal(log.mail[0].to, 'gail@example.com'); assert.match(log.mail[0].from, /<support@powersmartco\.com\.au>$/);
  assert.equal(log.logged.length, 1); assert.equal(log.logged[0].lead_id, 'L1'); assert.equal(log.logged[0].sender, 'customer_service');
  assert.ok(log.notes.some((t) => /Out-of-area email sent/.test(t)));
});
test('a customer is never messaged twice', async () => {
  const { mod, log } = notifier({ prior: [{ status: 'queued' }], priorEmail: [{ id: 'e1' }] }), r = await mod.notifyOutOfArea(lead);
  assert.equal(r.sms.duplicate, true); assert.equal(r.email.duplicate, true); assert.equal(log.sms.length + log.mail.length, 0);
});
test('paused SMS, no phone, no email and provider failures never throw and are noted on the lead', async () => {
  let t = notifier({ smsEnabled: false }); let r = await t.mod.notifyOutOfArea(lead);
  assert.equal(r.sms.paused, true); assert.equal(r.email.status, 'sent'); assert.ok(t.log.notes.some((n) => /paused/.test(n)));
  t = notifier(); r = await t.mod.notifyOutOfArea({ ...lead, phone: '', email: '' });
  assert.equal(r.sms.status, 'skipped'); assert.equal(r.email.status, 'skipped'); assert.ok(t.log.notes.some((n) => /no mobile/.test(n)));
  t = notifier({ smsError: 'This customer has opted out of SMS.', emailError: 'bounced' }); r = await t.mod.notifyOutOfArea(lead);
  assert.equal(r.sms.status, 'failed'); assert.equal(r.email.status, 'failed');
  assert.ok(t.log.notes.some((n) => /opted out/.test(n))); assert.ok(t.log.notes.some((n) => /bounced/.test(n)));
});
test('each channel can be switched off', async () => {
  const { mod, log } = notifier(); await mod.notifyOutOfArea(lead, { sms: false });
  assert.equal(log.sms.length, 0); assert.equal(log.mail.length, 1);
});

// ---- new enquiries (api/lead.js) ----
function enquiry(body, existing) {
  const calls = [], sent = [], out = [];
  const real = require('../api/_out-of-area');
  const handler = fresh('../api/lead', {
    './_supabase': { configured: () => true, async sb(q, o) { calls.push({ q, o }); if (String(q).startsWith('leads?or=')) return existing ? [existing] : []; return [{ id: 'NEW', name: 'Gail', phone: '0434612597', email: 'g@example.com', stage: (o && o.body && o.body.stage) || 'new_lead' }]; } },
    './_welcome-sms': { welcomeLead: async () => { calls.push('welcome'); return { status: 'submitted' }; }, repeatKind: () => true },
    './_repeat-quote': { latestSentQuote: async () => null, repeatQuoteMessages: () => ({}) },
    './_maillog': { logEmail: async () => true },
    './_sms-outbound': { logNote: async () => {} },
    './_out-of-area': { ...real, notifyOutOfArea: async (l, o) => { out.push({ l, o }); return { sms: { status: 'submitted' }, email: { status: 'sent' } }; } },
    './_transactional-mail': { Resend: class { constructor() { this.emails = { send: async (m) => { sent.push(m); return { data: { id: 'x' } }; } }; } } },
  });
  process.env.RESEND_API_KEY = 'k';
  const res = { status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; }, setHeader() {} };
  return handler({ method: 'POST', body }, res).then(() => ({ res, calls, sent, out }));
}
const person = { name: 'Gail Butters', phone: '0434612597', email: 'g@example.com' };

test('a Regional QLD enquiry is saved as Out of Area, told we do not service them, and the welcome and confirmation are not sent', async () => {
  const { res, calls, sent, out } = await enquiry({ ...person, postcode: '4655' }, null);
  assert.equal(res.code, 200);
  assert.equal(calls.find((c) => c.o && c.o.method === 'POST').o.body.stage, 'out_of_area');
  assert.equal(out.length, 1); assert.equal(out[0].l.id, 'NEW'); assert.equal(out[0].l.phone, '0434612597'); assert.equal(out[0].l.email, 'g@example.com');
  assert.ok(!calls.includes('welcome'));
  assert.equal(sent.length, 1, 'only the staff alert goes through the website path'); assert.match(sent[0].subject, /^Out of area enquiry/);
});
test('an in-area, postcode-less enquiry keeps the normal welcome and confirmation', async () => {
  for (const postcode of ['4000', '']) {
    const { calls, sent, out } = await enquiry({ ...person, postcode }, null);
    assert.equal(out.length, 0); assert.ok(calls.includes('welcome')); assert.equal(sent.length, 2);
    assert.equal(calls.find((c) => c.o && c.o.method === 'POST').o.body.stage, 'new_lead');
  }
});
test('a repeat Regional QLD enquiry moves an ordinary lead to Out of Area but never a customer with a quote or job', async () => {
  let r = await enquiry({ ...person, postcode: '4655' }, { id: 'L9', stage: 'follow_up', phone: '0434612597', email: 'g@example.com', postcode: '4000', source: 'Website' });
  assert.equal(r.calls.find((c) => c.o && c.o.method === 'PATCH').o.body.stage, 'out_of_area'); assert.equal(r.out.length, 1);
  for (const stage of ['quote_sent', 'quote_accepted', 'scheduled', 'won']) {
    r = await enquiry({ ...person, postcode: '4655' }, { id: 'L9', stage, phone: '0434612597', email: 'g@example.com', postcode: '4000', source: 'Website' });
    assert.equal(r.out.length, 0, stage); assert.notEqual(r.calls.find((c) => c.o && c.o.method === 'PATCH').o.body.stage, 'out_of_area', stage);
  }
});

// ---- manual moves and Add lead (api/pipeline.js) ----
function board(prevStage) {
  const calls = [], out = [], real = require('../api/_out-of-area');
  const h = fresh('../api/pipeline', {
    './_supabase': { configured: () => true, async sb(q, o = {}) {
      calls.push({ q, o });
      if (q === 'leads' && o.method === 'POST') return [{ id: 'N1', ...o.body }];
      if (o.method === 'PATCH') return [{ id: 'L1', name: 'Gail', phone: '0434612597', email: 'g@example.com', stage: o.body.stage }];
      return [{ id: 'L1', stage: prevStage }];
    } },
    './_welcome-sms': { welcomeLead: async () => { calls.push('welcome'); return { status: 'submitted' }; }, isRepeatCustomer: async () => false },
    './_out-of-area': { ...real, notifyOutOfArea: async (l, o) => { out.push({ l, o }); return { sms: { status: 'submitted' }, email: { status: 'sent' } }; } },
  });
  const post = (body) => { const r = { code: 200, status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; }, setHeader() {} }; return h({ method: 'POST', headers: { 'x-portal-key': '2026' }, url: '/api/pipeline', body }, r).then(() => r); };
  return { post, calls, out };
}
test('moving to Out of Area notifies the customer only when staff confirmed (notify:true) and the stage actually changes', async () => {
  let b = board('follow_up'), r = await b.post({ action: 'move', id: 'L1', stage: 'out_of_area', notify: true, agent: 'Sam' });
  assert.equal(r.body.out_of_area_notice.sms.status, 'submitted'); assert.equal(b.out.length, 1); assert.equal(b.out[0].o.agent, 'Sam'); assert.equal(b.out[0].l.id, 'L1');
  b = board('follow_up'); r = await b.post({ action: 'move', id: 'L1', stage: 'out_of_area' });
  assert.equal(b.out.length, 0); assert.equal(r.body.out_of_area_notice, undefined); assert.equal(r.body.lead.stage, 'out_of_area');
  b = board('out_of_area'); await b.post({ action: 'move', id: 'L1', stage: 'out_of_area', notify: true });
  assert.equal(b.out.length, 0, 'already out of area');
  b = board('follow_up'); await b.post({ action: 'move', id: 'L1', stage: 'won', notify: true });
  assert.equal(b.out.length, 0, 'other stages never notify');
});
test('Add lead for a Regional QLD postcode lands in Out of Area, honours the SMS and email boxes, and skips the welcome', async () => {
  let b = board(), r = await b.post({ action: 'create', name: 'Gail', phone: '0434612597', email: 'g@example.com', postcode: '4655', send_email: true, agent: 'Sunny' });
  assert.equal(b.calls.find((c) => c.o && c.o.method === 'POST').o.body.stage, 'out_of_area'); assert.equal(r.body.out_of_area, true);
  assert.deepEqual([b.out[0].o.sms, b.out[0].o.email, b.out[0].o.agent], [true, true, 'Sunny']); assert.ok(!b.calls.includes('welcome'));
  b = board(); await b.post({ action: 'create', name: 'Gail', phone: '0434612597', postcode: '4655', send_sms: false });
  assert.deepEqual([b.out[0].o.sms, b.out[0].o.email], [false, false]);
  b = board(); r = await b.post({ action: 'create', name: 'Gail', phone: '0434612597', postcode: '4000' });
  assert.equal(b.out.length, 0); assert.equal(r.body.out_of_area, undefined); assert.ok(b.calls.includes('welcome'));
  b = board(); await b.post({ action: 'create', name: 'Gail', phone: '0434612597', postcode: '4655', stage: 'follow_up' });
  assert.equal(b.out.length, 0, 'staff who pick another stage are left alone');
});
