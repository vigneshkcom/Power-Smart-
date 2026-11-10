const test = require('node:test');
const assert = require('node:assert/strict');
const Fee = require('../api/_callout-fee');
const { renderInvoice } = require('../api/_job-invoice');

test('customer creation date preserves the $35 price and assigns $50 to new customers', () => {
  assert.equal(Fee.centsForLead({ created_at: '2026-11-05T00:00:00Z' }), 3500);
  assert.equal(Fee.centsForLead({ created_at: '2026-11-07T00:00:00Z' }), 5000);
});

test('invoice names and deducts the paid $50 electrician call-out deposit', () => {
  const invoice = renderInvoice({ name: 'Test', jobNo: '7001', items: [{ label: 'Smoke alarms', qty: 7, amount_cents: 55300 }], total: 55300, credits: [{ label: 'Electrician call-out deposit', cents: 5000 }], due: 50300, paid: false, date: '6 November 2026' });
  assert.match(invoice.text, /Electrician call-out deposit/);
  assert.match(invoice.text, /-\$50\.00/);
  assert.match(invoice.text, /Balance owing: \$503\.00/);
  assert.match(invoice.html, /Electrician call-out deposit/);
});

test('a separately priced $50 call-out is shown as already paid without reducing the installation invoice', () => {
  const invoice = renderInvoice({ name: 'Test', jobNo: '7002', items: [{ label: 'Smoke alarms', qty: 5, amount_cents: 39500 }], total: 39500, credits: [], bookingFee: 5000, due: 39500, paid: false, date: '6 November 2026' });
  assert.match(invoice.text, /Electrician call-out fee x 1: \$50\.00/);
  assert.match(invoice.text, /Total \(incl\. GST\): \$445\.00/);
  assert.match(invoice.text, /Less paid in advance \(Electrician call-out fee \(paid when booked\)\): -\$50\.00/);
  assert.doesNotMatch(invoice.text, /received earlier/);
  assert.match(invoice.text, /Balance owing: \$395\.00/);
});

test('resent pending invoice reads as a payment reminder with card link and bank details', () => {
  const { renderInvoice } = require('../api/_job-invoice');
  const base = { name: 'Peter Wallmer', jobNo: 1005, items: [{ label: 'Alarm', qty: 1, amount_cents: 43000 }], total: 43000, credits: [], due: 43000, paid: false, date: '11 Nov 2026', invoiceUrl: 'https://x.test/invoice?token=abc' };
  const r = renderInvoice({ ...base, reminder: true });
  assert.match(r.text, /payment of \$430\.00 is still pending/); assert.match(r.text, /By card: https:\/\/x\.test\/invoice\?token=abc&pay=1/); assert.match(r.text, /BSB 083-004/);
  assert.match(r.html, /PAYMENT PENDING/);
  assert.doesNotMatch(renderInvoice(base).text, /friendly reminder/);
});

test('online invoice page shows the call-out fee as a line, a total including it, and the amount paid', () => {
  const { page } = require('../api/_invoice-page');
  const job = { id: 'x', job_no: 1005, customer_name: 'Peter', status: 'completed', pay_status: 'later', amount_due_cents: 43000, invoice_total_cents: 43000, invoice_items: [{ label: 'Alarm', qty: 1, amount_cents: 43000 }] };
  const t = page(job, false, '', 3500).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(t, /Electrician call-out fee 1 \$35\.00/); assert.match(t, /Total \(incl\. GST\) \$465\.00/); assert.match(t, /Less paid: electrician call-out fee \(paid when booked\) -\$35\.00/); assert.match(t, /Balance owing \$430\.00/);
  assert.match(page(job, false, '', 0).replace(/<[^>]+>/g, ' '), /\$430\.00/);
});
