const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), Module = require('node:module');
const CN = require('../api/_care-notice');
const { WORDING: W } = CN;

const ORIG_LOAD = Module._load;
function fresh(file, mocks) {
  Module._load = function (r, ...a) { return r in mocks ? mocks[r] : ORIG_LOAD(r, ...a); };
  delete require.cache[require.resolve(file)];
  return require(file);
}
test.afterEach(() => { Module._load = ORIG_LOAD; });

// ---- wording stays identical on the accept page, the PDF and the email ----
const plain = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
test('the accept page pop-up carries exactly the approved wording and version', () => {
  const html = plain(fs.readFileSync(require.resolve('../accept.html'), 'utf8').match(/<div class="notice-overlay"[\s\S]*?<p class="foot">/)[0]);
  for (const t of [W.HEADLINE, W.LEAD, W.SITUATION, W.SAFETY_LABEL, W.SAFETY, W.COMFORT_LABEL, W.COMFORT, W.LAW, W.TICK, ...W.STEPS.flatMap((s) => [s.title, s.text])]) {
    assert.ok(html.includes(t), 'accept.html is missing: ' + t);
  }
  assert.match(fs.readFileSync(require.resolve('../accept.html'), 'utf8'), new RegExp(`careNoticeVersion:"${CN.VERSION}"`));
});

// ---- PDF ----
test('the PDF is one A4 page, titled, and survives names with accents, emoji and other scripts', async () => {
  const { PDFDocument } = require('pdf-lib');
  for (const name of ['Rajendra Kumar', 'Nguyễn Thị 😀 Mai', '李小龍', "O'Brien-Smith"]) {
    const pdf = await CN.renderCareNoticePdf({ name, address: '1/22 Tëst St, Brisbane QLD 4000', ref: 'PSQ-1057', acceptedAt: '2026-11-17T05:41:00.000Z' });
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const doc = await PDFDocument.load(pdf);
    assert.equal(doc.getPageCount(), 1, name); assert.match(doc.getTitle(), /Alarm Care Notice and Acknowledgement - PSQ-1057/);
  }
});
test('the email repeats the wording with the pairing guide and the 000 safety line', () => {
  const m = CN.careNoticeEmail({ name: 'Rajendra Kumar', ref: 'PSQ-1057', acceptedAt: '2026-11-17T05:41:00.000Z' });
  assert.equal(m.subject, 'Your PowerSmart alarm care notice (PSQ-1057)');
  for (const part of [m.text, m.html.replace(/<[^>]+>/g, ' ')]) { assert.match(part, /Hi Rajendra/); assert.match(part, /call 000/); assert.match(part, /Tuesday 17 November 2026/); assert.match(part, /3:41 pm \(Brisbane time\)/); }
  assert.match(m.html, /smokealarms\.powersmartco\.com\.au\/pairing/);
});

// ---- record + send ----
function harness({ existingNote = null, priorEmail = [], emailError = null, noSb = false } = {}) {
  const calls = [], mail = [], logged = [];
  const mod = fresh('../api/_care-notice', {
    './_supabase': { async sb(q, o = {}) {
      calls.push({ q, o });
      if (q.startsWith('lead_comments?') && !o.method) return existingNote ? [existingNote] : [];
      if (q.startsWith('sent_emails')) return priorEmail;
      if (q.startsWith('leads?')) return [{ id: 'L1', name: 'Rajendra Kumar', email: 'raj@example.com', quote_ref: 'PSQ-1057', address_line1: '49 Harrison Crescent', address_suburb: 'Forest Lake', address_state: 'QLD', address_postcode: '4078' }];
      return [];
    } },
    './_maillog': { async logEmail(r) { logged.push(r); return true; } },
    './_transactional-mail': { Resend: class { constructor() { this.emails = { async send(m) { if (emailError) return { error: { message: emailError } }; mail.push(m); return { data: { id: 'p1' } }; } }; } } },
  });
  return { mod, calls, mail, logged, notes: () => calls.filter((c) => c.o.method === 'POST' && c.q === 'lead_comments').map((c) => c.o.body) };
}
const lead = { id: 'L1', name: 'Rajendra Kumar', email: 'Raj@Example.com' };

test('accepting records the tick once and emails the customer a PDF with support on bcc', async () => {
  const h = harness(), r = await h.mod.acceptAndSend({ lead, name: 'Rajendra Kumar', ref: 'PSQ-1057', address: '49 Harrison Crescent, Forest Lake QLD 4078' });
  assert.equal(r.status, 'sent');
  const [record, sent] = h.notes();
  assert.match(record.body, /^Alarm Care Notice and Acknowledgement \(v2\) accepted for quote PSQ-1057 at /); assert.match(record.body, /\[accepted_at=\d{4}-/); assert.equal(record.kind, 'status');
  assert.equal(h.mail.length, 1); assert.equal(h.mail[0].to, 'raj@example.com'); assert.equal(h.mail[0].bcc, 'support@powersmartco.com.au');
  assert.match(h.mail[0].from, /<support@powersmartco\.com\.au>$/); assert.equal(h.mail[0].attachments[0].filename, 'PowerSmart-Alarm-Care-Acknowledgement-PSQ-1057.pdf');
  assert.equal(h.mail[0].attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  assert.equal(h.logged.length, 1); assert.equal(h.logged[0].lead_id, 'L1'); assert.match(sent.body, /PDF sent to raj@example\.com \(copy to support@powersmartco\.com\.au\)/);
});
test('a second acceptance of the same quote keeps the first time and never emails twice', async () => {
  const first = new Date('2026-11-17T05:41:00.000Z').toISOString();
  const h = harness({ existingNote: { body: `x [accepted_at=${first}]`, created_at: '2026-11-17T05:41:01Z' }, priorEmail: [{ id: 'e1', created_at: first }] });
  const r = await h.mod.acceptAndSend({ lead, name: 'Raj', ref: 'PSQ-1057', address: 'x' });
  assert.equal(r.acceptedAt, first); assert.equal(r.duplicate, true); assert.equal(h.mail.length, 0);
  assert.equal(h.notes().length, 1, 'one note explaining why nothing was sent'); assert.match(h.notes()[0].body, /PDF not sent again: a copy was already emailed to raj@example\.com on Tuesday 17 November 2026.*Use Resend care notice/);
});
test('no email address or a failing mail provider never throws: the tick stays recorded and staff are told', async () => {
  let h = harness(); let r = await h.mod.acceptAndSend({ lead: { ...lead, email: '' }, name: 'Raj', ref: 'PSQ-1', address: 'x' });
  assert.equal(r.status, 'skipped'); assert.ok(h.notes().some((n) => /no email address on file/.test(n.body)) && h.notes().some((n) => /accepted for quote/.test(n.body)));
  h = harness({ emailError: 'bounced' }); r = await h.mod.acceptAndSend({ lead, name: 'Raj', ref: 'PSQ-1', address: 'x' });
  assert.equal(r.status, 'failed'); assert.ok(h.notes().some((n) => /NOT sent.*bounced.*Resend care notice/.test(n.body)));
});
test('a slow email never holds the customer up for longer than the limit', async () => {
  const mod = fresh('../api/_care-notice', {
    './_supabase': { sb: async () => [] }, './_maillog': { logEmail: async () => true },
    './_transactional-mail': { Resend: class { constructor() { this.emails = { send: () => new Promise((r) => setTimeout(() => r({ data: {} }), 1500)) }; } } },
  });
  const t = Date.now(), r = await mod.acceptAndSend({ lead, name: 'Raj', ref: 'PSQ-1', address: 'x', limitMs: 100 });
  assert.equal(r.status, 'pending'); assert.ok(Date.now() - t < 1000);
});
test('staff resend uses the original quote and acceptance time and sends even if it was sent before', async () => {
  const at = '2026-11-17T05:41:00.000Z';
  const h = harness({ existingNote: { body: `Alarm Care Notice and Acknowledgement (v1) accepted for quote PSQ-1057 at Tuesday... [accepted_at=${at}]`, created_at: at }, priorEmail: [{ id: 'e1' }] });
  const r = await h.mod.resendForLead('L1', 'Sam');
  assert.equal(r.status, 'sent'); assert.equal(h.mail.length, 1); assert.equal(h.mail[0].subject, 'Your PowerSmart alarm care notice (PSQ-1057)'); assert.match(h.mail[0].text, /3:41 pm/);
  assert.ok(h.notes().some((n) => /PDF re-sent to raj@example\.com/.test(n.body) && n.author === 'Sam'));
  const none = harness(); await assert.rejects(none.mod.resendForLead('L1', 'Sam'), /hasn't accepted/);
});

// ---- the accept API enforces the tick ----
test('accept-quote refuses an acceptance without the tick or with out-of-date wording, before touching anything', async () => {
  const touched = [];
  const handler = fresh('../api/accept-quote', {
    './_supabase': { configured: () => true, sb: async (q) => { touched.push(q); return []; } },
    './_quote-payments': {}, './_care-notice': { VERSION: 'v1', acceptAndSend: async () => ({}) },
  });
  const call = (body) => { const r = { code: 200, status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; }, setHeader() {} }; return handler({ method: 'POST', body: { ref: 'PSQ-1', customerEmail: 'a@b.co', customerName: 'A', addressLine1: '1 St', addressSuburb: 'X', addressState: 'QLD', addressPostcode: '4000', ...body } }, r).then(() => r); };
  let r = await call({}); assert.equal(r.code, 400); assert.match(r.body.error, /tick the box/);
  r = await call({ careNoticeAccepted: 'true', careNoticeVersion: 'v1' }); assert.equal(r.code, 400);
  r = await call({ careNoticeAccepted: true, careNoticeVersion: 'v0' }); assert.equal(r.code, 400); assert.match(r.body.error, /out of date/);
  assert.equal(touched.length, 0);
});

// ---- archive to the job's Dropbox Documents folder when a job is completed ----
function archiveHarness({ notes = [], lead = { name: 'Rajendra Kumar', address_line1: '99 Changed St', address_suburb: 'Forest Lake', address_state: 'QLD', address_postcode: '4078' }, saveResult = { status: 'saved' } } = {}) {
  const saved = [], posted = [], queries = [];
  const mod = fresh('../api/_care-notice', {
    './_supabase': { async sb(q, o = {}) {
      queries.push(q);
      if (o.method === 'POST') { posted.push(o.body); return []; }
      if (q.startsWith('lead_comments?')) return notes;
      if (q.startsWith('leads?')) return [lead];
      return [];
    } },
    './_maillog': { logEmail: async () => true },
    './_job-documents': { async saveCustomerDocuments(job, attachments) { saved.push({ job, attachments }); return saveResult; } },
  });
  return { mod, saved, posted, queries };
}
const acceptedNote = { created_at: '2026-11-17T05:41:02Z', body: 'Alarm Care Notice and Acknowledgement (v1) accepted for quote PSQ-1057 at Tuesday. The customer ticked: "x" [accepted_at=2026-11-17T05:41:00.000Z] [name=Rajendra Kumar] [address=49 Harrison Crescent, Forest Lake QLD 4078]' };
const job = { id: 'j1', job_no: 1061, lead_id: 'L1', quote_ref: 'PSQ-1057', work_type: 'install', customer_name: 'Rajendra Kumar', address: '49 Harrison Crescent', suburb: 'Forest Lake', postcode: '4078' };

test('completing a job files the rebuilt PDF in the job Documents folder, using what the customer accepted', async () => {
  const h = harness2(), r = await h.mod.archiveForJob(job);
  assert.equal(r.status, 'saved'); assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].attachments.length, 1); assert.equal(h.saved[0].attachments[0].filename, 'PowerSmart-Alarm-Care-Acknowledgement-J1061.pdf');
  assert.equal(h.saved[0].attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  assert.match(decodeURIComponent(h.queries[0]), /accepted for quote PSQ-1057/);
  assert.ok(h.posted.some((n) => /PDF saved to the Dropbox Documents folder for J1061/.test(n.body)));
  function harness2() { return archiveHarness({ notes: [acceptedNote] }); }
});
test('the archived PDF uses the name, address and time recorded at acceptance, with sensible fallbacks for older notes', async () => {
  const { PDFDocument } = require('pdf-lib');
  const f = CN.archiveFields({ ...job, address: 'Edited later 1 Other Rd', customer_name: 'Renamed Person' }, acceptedNote, { name: 'Lead Name' });
  assert.deepEqual(f, { name: 'Rajendra Kumar', ref: 'PSQ-1057', address: '49 Harrison Crescent, Forest Lake QLD 4078', acceptedAt: '2026-11-17T05:41:00.000Z', version: 'v1' });
  const old = { created_at: '2026-11-18T01:00:00Z', body: 'Alarm Care Notice and Acknowledgement (v1) accepted for quote PSQ-9 at x [accepted_at=2026-11-18T01:00:00.000Z]' };
  const g = CN.archiveFields({ ...job, quote_ref: 'PSQ-9' }, old, { address_line1: '5 Lead St', address_suburb: 'X', address_state: 'QLD', address_postcode: '4000' });
  assert.deepEqual([g.name, g.ref, g.address], ['Rajendra Kumar', 'PSQ-9', '49 Harrison Crescent, Forest Lake 4078'], 'older note: job details are used');
  assert.equal(CN.archiveFields({ job_no: 1 }, { created_at: '2026-11-18T01:00:00Z', body: 'x' }, { name: 'L', address_line1: '5 Lead St', address_suburb: 'X', address_state: 'QLD', address_postcode: '4000' }).address, '5 Lead St, X QLD 4000');
  const h = archiveHarness({ notes: [acceptedNote] }); await h.mod.archiveForJob(job);
  assert.equal((await PDFDocument.load(h.saved[0].attachments[0].content)).getPageCount(), 1);
});
test('no care notice is filed for jobs whose customer never accepted it, warranty visits, or jobs with no customer', async () => {
  let h = archiveHarness({ notes: [] }); let r = await h.mod.archiveForJob(job); assert.equal(r.status, 'skipped'); assert.equal(h.saved.length, 0);
  h = archiveHarness({ notes: [acceptedNote] }); r = await h.mod.archiveForJob({ ...job, work_type: 'warranty' }); assert.equal(r.status, 'skipped'); assert.equal(h.saved.length, 0);
  r = await h.mod.archiveForJob({ ...job, lead_id: null }); assert.equal(r.status, 'skipped'); assert.equal(h.saved.length, 0);
});
test('a quote reference that does not match falls back to the latest acceptance, and Dropbox failures never throw', async () => {
  const h = archiveHarness({ notes: [acceptedNote], saveResult: { status: 'failed', error: 'Dropbox is not configured' } });
  const r = await h.mod.archiveForJob({ ...job, quote_ref: 'OLD-1' });
  assert.equal(r.status, 'failed'); assert.equal(h.saved.length, 1); assert.equal(h.posted.length, 0, 'no success note when it failed (Dropbox helper notes the failure)');
  const boom = fresh('../api/_care-notice', { './_supabase': { sb: async () => { throw new Error('db down'); } }, './_maillog': { logEmail: async () => true } });
  assert.equal((await boom.archiveForJob(job)).status, 'failed');
});

// ---- wording versions: customers who ticked v1 keep seeing exactly what they ticked ----
test('the current wording says "would have already wired", and v1 acceptances keep the original wording in their PDF and email', async () => {
  assert.equal(CN.VERSION, 'v2');
  assert.match(CN.stepsFor('v2')[2].text, /our electrician would have already wired the base plate, so you only change the alarm itself/);
  assert.match(CN.stepsFor('v1')[2].text, /our electrician has already wired the base plate, so you only change the alarm itself/);
  assert.equal(CN.stepsFor('v1')[0].text, CN.stepsFor('v2')[0].text, 'only step 3 differs');
  const a = { acceptedAt: '2026-11-17T05:41:00.000Z', name: 'Raj', ref: 'PSQ-1' };
  assert.match(CN.careNoticeEmail({ ...a, version: 'v1' }).text, /electrician has already wired/);
  assert.match(CN.careNoticeEmail(a).text, /electrician would have already wired/);
  const { PDFDocument } = require('pdf-lib');
  for (const version of ['v1', 'v2']) assert.equal((await PDFDocument.load(await CN.renderCareNoticePdf({ ...a, address: 'x', version }))).getPageCount(), 1);
  // a staff resend and the job archive both use the version recorded when the customer ticked
  const h = harness({ existingNote: { body: 'Alarm Care Notice and Acknowledgement (v1) accepted for quote PSQ-1057 at x [accepted_at=2026-11-17T05:41:00.000Z]', created_at: '2026-11-17T05:41:00Z' } });
  await h.mod.resendForLead('L1', 'Sam'); assert.match(h.mail[0].text, /electrician has already wired/);
  const h2 = harness({ existingNote: { body: 'Alarm Care Notice and Acknowledgement (v2) accepted for quote PSQ-1057 at x [accepted_at=2026-11-17T05:41:00.000Z]', created_at: '2026-11-17T05:41:00Z' } });
  await h2.mod.resendForLead('L1', 'Sam'); assert.match(h2.mail[0].text, /electrician would have already wired/);
});
test('the recorded acceptance note carries the current version', async () => {
  const h = harness(); await h.mod.acceptAndSend({ lead, name: 'Raj', ref: 'PSQ-1', address: 'x' });
  assert.match(h.notes()[0].body, /^Alarm Care Notice and Acknowledgement \(v2\) accepted for quote PSQ-1 at /);
});
