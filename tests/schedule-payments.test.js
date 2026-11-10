const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const html = fs.readFileSync(require.resolve('../tools/schedule.html'), 'utf8');

// The job window's Payments box: ledger rows, plus totals for jobs paid before the ledger existed.
function render(job) {
  const box = { innerHTML: '', style: {} };
  const ctx = { $: () => box, esc: (s) => String(s == null ? '' : s).replace(/</g, '&lt;') };
  vm.createContext(ctx);
  vm.runInContext(html.slice(html.indexOf('  function renderPayments(j'), html.indexOf('  function renderReport(j){')) + '\nthis.renderPayments = renderPayments;', ctx);
  ctx.renderPayments(job);
  return box;
}
const text = (box) => box.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('lists each payment with date, method and who, and shows received and owing', () => {
  const box = render({ status: 'completed', invoice_total_cents: 48000, pay_status: 'later', amount_due_cents: 9000, prior_paid_cents: 39000,
    payments: [{ at: '2026-11-10T03:00:00Z', amount_cents: 10000, method: 'cash', by: 'Dillon' }, { at: '2026-11-12T05:15:00Z', amount_cents: 29000, method: 'bank_transfer', by: 'Sunny' }] });
  const t = text(box);
  assert.notEqual(box.style.display, 'none');
  assert.match(t, /Invoice total \$480\.00/);
  assert.match(t, /Cash · Dillon \$100\.00/);
  assert.match(t, /Bank transfer · Sunny \$290\.00/);
  assert.match(t, /Received \$390\.00/);
  assert.match(t, /Owing \$90\.00/);
  assert.ok(t.indexOf('Cash · Dillon') < t.indexOf('Bank transfer · Sunny'), 'oldest payment first');
});

test('jobs paid before the ledger existed are rebuilt from the stored totals', () => {
  const box = render({ status: 'completed', invoice_total_cents: 7900, pay_status: 'paid', paid_cents: 7900, pay_method: 'card', paid_at: '2026-11-08T01:00:00Z' });
  const t = text(box);
  assert.match(t, /Card \$79\.00/);
  assert.match(t, /Received \$79\.00/);
  assert.match(t, /Owing \$0\.00/);
});

test('earlier money not in the ledger is shown as a separate line, and unpaid jobs show everything owing', () => {
  let t = text(render({ status: 'completed', invoice_total_cents: 20000, pay_status: 'later', amount_due_cents: 5000, prior_paid_cents: 15000, payments: [{ at: '2026-11-12T05:15:00Z', amount_cents: 5000, method: 'cash', by: 'Sam' }] }));
  assert.match(t, /Earlier payments \$100\.00/); assert.match(t, /Received \$150\.00/); assert.match(t, /Owing \$50\.00/);
  t = text(render({ status: 'completed', invoice_total_cents: 20000, pay_status: 'unpaid' }));
  assert.match(t, /No payments recorded yet/); assert.match(t, /Owing \$200\.00/);
});

test('hidden when there is nothing to show', () => {
  assert.equal(render({ status: 'scheduled' }).style.display, 'none');
});

test('a separate call-out fee is added to the invoice total and counted as paid', () => {
  const job = { status: 'completed', invoice_total_cents: 43000, pay_status: 'later', amount_due_cents: 43000 };
  const ctxBox = (qs) => { const box = { innerHTML: '', style: {} }, ctx = { $: () => box, esc: (s) => String(s) }; vm.createContext(ctx);
    vm.runInContext(html.slice(html.indexOf('  function renderPayments(j'), html.indexOf('  function renderReport(j){')) + '\nthis.renderPayments = renderPayments;', ctx); ctx.renderPayments(job, qs); return text(box); };
  const t = ctxBox({ total_cents: 46500, booking_paid_cents: 3500 });
  assert.match(t, /Installation invoice \$430\.00/); assert.match(t, /Electrician call-out fee \$35\.00/);
  assert.match(t, /Invoice total \$465\.00/); assert.match(t, /Received \$35\.00/); assert.match(t, /Owing \$430\.00/);
  assert.match(ctxBox({ total_cents: 43000, booking_paid_cents: 3500 }), /Invoice total \$430\.00/);
});
