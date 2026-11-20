const test = require('node:test'), assert = require('node:assert/strict');
const Po = require('../api/_po');

const tech = { id: 't1', code: '89128', name: 'Dillon Moritz', email: 'dillon@example.com' };
const row = (o) => Object.assign({ electrician_id: 't1', work_type: 'install', battery: 0, hardwired: 0, untyped: 0, controllers: 0, completed_at: '2026-11-11T01:00:00Z', job_no: 1005, address: '52 / 2 Diamantina St, Calamvale' }, o);
// Mon 9 Nov – Sun 15 Nov 2026, Brisbane (UTC+10): from is Sun 23:00 UTC, to is the start of Mon 16 Nov
const from = '2026-11-08T14:00:00.000Z', to = '2026-11-15T14:00:00.000Z';

test('prices jobs at the contractor rates: call-out per job, battery, hardwired and remote', () => {
  const po = Po.buildPo({ tech, from, to, payDate: '2026-11-27', rows: [row({ battery: 3, hardwired: 2, controllers: 1 }), row({ job_no: 1012, battery: 4, hardwired: 1, controllers: 1 })] });
  const by = Object.fromEntries(po.lines.map((l) => [l.label, l]));
  assert.equal(by['Call-out'].amount_cents, 2 * 3500);
  assert.equal(by['Battery smoke alarm installed'].amount_cents, 7 * 1000);
  assert.equal(by['Hardwired smoke alarm installed'].amount_cents, 3 * 1300);
  assert.equal(by['Remote controller installed'].amount_cents, 2 * 1000);
  assert.equal(po.subtotal_cents, 7000 + 7000 + 3900 + 2000);
  assert.equal(po.gst_cents, 1990);
  assert.equal(po.total_cents, 19900 + 1990);
  assert.equal(po.jobs[0].amount_cents, 3500 + 3000 + 2600 + 1000);
  assert.equal(po.jobs.reduce((n, j) => n + j.amount_cents, 0), po.subtotal_cents);
  assert.equal(po.ref, 'PO-89128-20261115');
  assert.equal(po.title, 'Dillon PO Week ending 15 Nov 2026');
  assert.equal(po.week_ending, '2026-11-15');
  assert.match(po.period.label, /Mon 9 Nov to Sun 15 Nov 2026/);
  assert.match(po.pay_date_label, /Friday 27 November 2026/);
});

test('alarms with no recorded type are paid as battery; warranty visits are paid like any job', () => {
  const po = Po.buildPo({ tech, from, to, rows: [row({ untyped: 2 }), row({ work_type: 'warranty', battery: 3, hardwired: 1 })] });
  assert.equal(po.jobs.length, 2);
  assert.equal(po.jobs[1].warranty, true);
  assert.equal(po.subtotal_cents, 3500 + 2 * 1000 + 3500 + 3 * 1000 + 1300);
});

test('extra lines add to the total, negative prices deduct, and bad input is refused', () => {
  const rows = [row({ battery: 1 })];
  const po = Po.buildPo({ tech, from, to, rows, extra: [{ label: 'Fuel allowance', qty: 2, price: '15.50' }, { label: 'Cash collected', qty: 1, price: '-100' }, { label: '', price: '' }] });
  assert.equal(po.lines.filter((l) => l.extra).length, 2);
  assert.equal(po.subtotal_cents, 3500 + 1000 + 3100 - 10000);
  assert.throws(() => Po.cleanExtra([{ label: 'x', qty: 1, price: 'abc' }]), /Check the price/);
  assert.throws(() => Po.cleanExtra([{ label: '', qty: 1, price: '5' }]), /Describe/);
});

test('the email shows the message, every line, GST and the total, signed off by Vignesh', () => {
  const po = Po.buildPo({ tech, from, to, payDate: '2026-11-27', rows: [row({ battery: 1 })] });
  const m = Po.renderPoEmail(po, Po.defaultIntro(po) + '\n\nThanks <b>mate</b>');
  assert.equal(m.subject, 'Dillon PO Week ending 15 Nov 2026');
  assert.match(m.html, /This will be paid on Friday 27 November 2026/);
  assert.match(m.html, /GST \(10%\)/);
  assert.match(m.html, /Total \(inc GST\)/);
  assert.match(m.html, /Regards,<br><strong>Vignesh<\/strong><br>Power Smart Pty Ltd/);
  assert.doesNotMatch(m.html, /support@powersmartco/);
  assert.match(m.html, /attached PDF for a job-by-job breakdown/);
  assert.doesNotMatch(m.html, /J1005/);   // jobs are listed in the PDF only
  assert.doesNotMatch(m.html, /PO-89128/);   // no title or PO number heading in the body; they are in the subject and PDF
  assert.ok(m.text.startsWith('Hi Dillon,'));
  assert.doesNotMatch(m.html, /<b>mate<\/b>/);   // typed text is escaped
  assert.match(m.text, /Total \(inc GST\): \$49\.50/);
});

test('sending needs a valid address and something to pay for', async () => {
  const po = Po.buildPo({ tech, from, to, rows: [row({ battery: 1 })] });
  await assert.rejects(Po.send(po, { to: 'not-an-email' }), /valid email/);
  await assert.rejects(Po.send(Po.buildPo({ tech, from, to, rows: [] }), { to: 'a@b.co' }), /nothing to pay/);
});

test('the week ends on the Sunday, even when the period stops mid-week', () => {
  assert.equal(Po.weekEnding('2026-11-11T14:00:00.000Z').toISOString().slice(0, 10), '2026-11-15');   // period ends Wed 11 Nov
  assert.equal(Po.weekEnding(to).toISOString().slice(0, 10), '2026-11-15');
});

test('the PDF renders with the company details and every job', async () => {
  const { PDFDocument } = require('pdf-lib');
  const rows = Array.from({ length: 30 }, (_, i) => row({ job_no: 1100 + i, battery: 2 }));
  const po = Po.buildPo({ tech, from, to, payDate: '2026-11-27', rows });
  const bytes = await require('../api/_po-pdf').renderPoPdf(po);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getTitle(), 'Dillon PO Week ending 15 Nov 2026');
  assert.ok(doc.getPageCount() >= 2, 'long weeks continue onto another page');
  assert.equal(Po.COMPANY.abn, '41 669 943 720');
  assert.match(Po.COMPANY.address.join(', '), /36 Clearwater Rise Parade, Truganina VIC 3029/);
});

test('the purchase order is copied to Vignesh only, never support@', async () => {
  const Mod = require('node:module'), orig = Mod._load, sent = [];
  Mod._load = function (req, parent, ...rest) {
    if (req === './_transactional-mail') return { Resend: class { constructor() { this.emails = { send: async (m) => { sent.push(m); return { data: { id: 'x' }, error: null }; } }; } } };
    if (req === './_maillog') return { logEmail: async () => true };
    return orig.call(this, req, parent, ...rest);
  };
  try {
    const po = Po.buildPo({ tech, from, to, rows: [row({ battery: 1 })] });
    const r = await Po.send(po, { to: 'dillon@example.com' });
    assert.equal(sent[0].cc, 'vignesh@powersmartco.com.au');
    assert.equal(sent[0].to, 'dillon@example.com');
    assert.ok(!JSON.stringify([sent[0].cc, sent[0].bcc]).includes('support@'));
    assert.equal(sent[0].attachments[0].filename, 'Dillon PO Week ending 15 Nov 2026.pdf');
    assert.equal(r.cc, 'vignesh@powersmartco.com.au');
  } finally { Mod._load = orig; }
});
