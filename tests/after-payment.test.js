const test = require('node:test'), assert = require('node:assert/strict');
const reg = (file, exports) => { const p = require.resolve(file); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const jobs = [], sent = [], certs = [];
reg('../api/_supabase', { configured: () => true, async sb(q, o = {}) {
  const id = /id=eq\.([^&]+)/.exec(q)[1];
  const hit = jobs.filter((j) => j.id === id && (!q.includes('paid_invoice_emailed_at=is.null') || j.paid_invoice_emailed_at == null));
  if ((o.method || 'GET') === 'PATCH') { hit.forEach((j) => Object.assign(j, o.body)); return hit.map((j) => ({ ...j })); }
  return hit.map((j) => ({ ...j }));
} });
reg('../api/_job-invoice', { sendJobInvoice: async (a) => { sent.push(a); return sent.fail ? { status: 'failed', error: 'boom' } : { status: 'sent', to: 'a@b.com' }; } });
reg('../api/_certificate', { issueCertificate: async (id) => { certs.push(id); return { status: 'sent' }; } });
reg('../api/_jobs', { leadNote: async () => {} });
const { releaseAfterPayment } = require('../api/_after-payment');
const job = (x) => ({ id: 'j1', job_no: 1008, status: 'completed', pay_status: 'paid', pay_method: 'card', invoice_total_cents: 43000, amount_due_cents: 43000, invoice_items: [{ label: 'a', qty: 1, amount_cents: 43000 }], ...x });
function reset(j) { jobs.length = 0; jobs.push(j); sent.length = 0; certs.length = 0; sent.fail = false; }

test('paying a completed pay-later job sends the paid tax invoice once, then the certificate', async () => {
  reset(job());
  await releaseAfterPayment('j1', { agent: 'Stripe' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].paid, true); assert.equal(sent[0].totals.due, 0); assert.equal(sent[0].method, 'card');
  assert.deepEqual(certs, ['j1']);
  await releaseAfterPayment('j1', { agent: 'Stripe' });
  assert.equal(sent.length, 1, 'no second tax invoice');
});

test('a job that is not completed or not paid gets no tax invoice from this path', async () => {
  reset(job({ status: 'on_site' })); await releaseAfterPayment('j1'); assert.equal(sent.length, 0);
  reset(job({ pay_status: 'later' })); await releaseAfterPayment('j1'); assert.equal(sent.length, 0);
});

test('a failed tax invoice email is retried next time and does not block the certificate', async () => {
  reset(job()); sent.fail = true;
  await releaseAfterPayment('j1');
  assert.equal(jobs[0].paid_invoice_emailed_at, null, 'claim released');
  assert.deepEqual(certs, ['j1']);
  sent.fail = false; await releaseAfterPayment('j1');
  assert.equal(sent.length, 2);
});
