const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { renderPaidInvoicePdf } = require('../api/_invoice-pdf');

test('paid invoice is a real PDF including many items and credits', async () => {
  const pdf = await renderPaidInvoicePdf({
    job: { job_no: 1019, customer_name: 'Rajendra Kumar', address: '49 Harrison Crescent', suburb: 'QLD', postcode: '4000' },
    items: Array.from({ length: 70 }, (_, n) => ({ label: 'Smoke alarm installed - ' + (n + 1), qty: 1, amount_cents: 7900 })),
    total: 70 * 7900, credits: [{ label: 'Deposit', cents: 5000 }], bookingFee: 5000, method: 'card',
    billingAddress: '49 Harrison Crescent', date: '12 Nov 2026',
  });
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  const doc = await PDFDocument.load(pdf);
  assert.ok(doc.getPageCount() > 1, 'long invoices paginate instead of clipping');
});

test('paid invoice PDF supports jobs with no separate booking fee', async () => {
  const pdf = await renderPaidInvoicePdf({
    job: { job_no: 1020, customer_name: 'Test Customer', address: '10 Test St' },
    items: [{ label: 'Inspection', qty: 1, amount_cents: 13100 }],
    total: 13100, credits: [], bookingFee: 0, method: 'cash', date: '12 Nov 2026',
  });
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
});
