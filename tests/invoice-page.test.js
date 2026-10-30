const test = require('node:test'), assert = require('node:assert/strict');
const sbPath = require.resolve('../api/_supabase');
const rows = [];
require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { configured: () => true, async sb(q) { const id = /id=eq\.([^&]+)/.exec(q)[1]; return rows.filter((r) => r.id === id); } } };
const stripePath = require.resolve('../api/_stripe');
const stripeCalls = [];
require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: { configured: () => true, async request(p, form) { stripeCalls.push({ p, form }); return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }; } } };
const Invoice = require('../api/_invoice-page');
const { renderInvoice, BANK } = require('../api/_job-invoice');

const ID = '11111111-2222-3333-4444-555555555555';
const base = { id: ID, job_no: 1008, customer_name: 'Vig', address: '2 Addison St', suburb: 'Greenbank', postcode: '4124', email: 'v@x.com', status: 'completed', pay_status: 'later',
  amount_due_cents: 43000, invoice_total_cents: 43000, invoice_items: [{ label: 'Smoke alarms', qty: 5, amount_cents: 43000 }], completed_at: '2026-10-30T01:00:00Z' };
function run(query, job) {
  rows.length = 0; if (job) rows.push(job); stripeCalls.length = 0;
  const res = { code: 0, headers: {}, body: '', status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, send(b) { this.body = b; return this; }, end() { return this; } };
  return Invoice({ method: 'GET', query }, res).then(() => res);
}

test('the bank details are the PowerSmart account', () => {
  assert.deepEqual(BANK, { name: 'PowerSmart Pty Ltd', bsb: '083-004', account: '27-010-3472' });
});

test('an owing invoice shows the balance, pay by card and the bank details with the job reference', async () => {
  const r = await run({ token: ID }, { ...base });
  assert.equal(r.code, 200);
  for (const t of ['$430.00', 'Pay $430.00 by card', '083-004', '27-010-3472', 'PowerSmart Pty Ltd', 'Reference', 'J1008']) assert.ok(r.body.includes(t), t);
  assert.ok(r.body.includes(`/invoice?token=${ID}&amp;pay=1`));
});

test('a paid invoice shows no payment options', async () => {
  const r = await run({ token: ID }, { ...base, pay_status: 'paid' });
  assert.ok(r.body.includes('Paid in full') && r.body.includes('TAX INVOICE (PAID)'));
  assert.ok(!r.body.includes('083-004') && !r.body.includes('by card'));
});

test('pay=1 sends the customer to a fresh Stripe Checkout tied to the job, for the amount owing', async () => {
  const r = await run({ token: ID, pay: '1' }, { ...base });
  assert.equal(r.code, 302);
  assert.equal(r.headers.Location, 'https://checkout.stripe.com/c/pay/cs_1');
  assert.equal(stripeCalls[0].form['metadata[job_id]'], ID);
  assert.equal(stripeCalls[0].form['line_items[0][price_data][unit_amount]'], '43000');
});

test('nothing is exposed for a bad token, an unfinished job, or an already paid job asking to pay', async () => {
  assert.equal((await run({ token: 'nope' }, { ...base })).code, 404);
  assert.equal((await run({ token: ID }, { ...base, status: 'on_site' })).code, 404);
  const paid = await run({ token: ID, pay: '1' }, { ...base, pay_status: 'paid' });
  assert.equal(paid.code, 200); assert.equal(stripeCalls.length, 0);
});

test('the pending invoice email has the pay link, bank details and reference; the paid one links to the invoice', () => {
  const args = { name: 'Vig', jobNo: 1008, items: [{ label: 'Alarms', qty: 5, amount_cents: 43000 }], total: 43000, credits: [], due: 43000, address: 'x', date: 'today', invoiceUrl: `https://s/invoice?token=${ID}` };
  const owing = renderInvoice({ ...args, paid: false });
  for (const t of ['083-004', '27-010-3472', 'PowerSmart Pty Ltd', 'Reference: <strong>J1008', `${args.invoiceUrl}&pay=1`]) assert.ok(owing.html.includes(t), t);
  assert.ok(owing.text.includes('BSB 083-004') && owing.text.includes('&pay=1'));
  const paid = renderInvoice({ ...args, paid: true, due: 0 });
  assert.ok(!paid.html.includes('083-004') && paid.html.includes('view invoice'));
});
