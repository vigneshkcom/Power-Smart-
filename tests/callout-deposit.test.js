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
  assert.match(invoice.text, /Electrician call-out fee of \$50\.00 received earlier/);
  assert.match(invoice.text, /Balance owing: \$395\.00/);
});
