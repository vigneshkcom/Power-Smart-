const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const html = fs.readFileSync(require.resolve('../tools/schedule.html'), 'utf8');

// The earnings panel on /tools/schedule: sales, GST, electrician pay and Stripe's cut for the jobs on the board.
const ctx = {};
vm.createContext(ctx);
vm.runInContext(html.slice(html.indexOf('// earnings:start'), html.indexOf('// earnings:end')) + '\nthis.jobEarnings = jobEarnings; this.sumEarnings = sumEarnings;', ctx);

const items = (...l) => l.map(([code, qty, unit]) => ({ code, qty, unit_cents: unit, amount_cents: qty * unit }));

test('an invoiced job: sales from the invoice, electrician paid per alarm type, Stripe 1.65% + 30c', () => {
  const e = ctx.jobEarnings({ status: 'completed', work_type: 'install', invoice_items: items(['alarm_hardwired', 2, 7900], ['alarm_battery', 1, 7900], ['controller', 1, 3500]) });
  assert.equal(e.sales, 3 * 7900 + 3500);                       // $272.00 inc GST
  assert.equal(e.gst, Math.round(27200 / 11));                  // 10% GST
  assert.equal(e.elec, 3000 + 2 * 1300 + 1000 + 1000);          // call-out + 2 hardwired + 1 battery + controller
  assert.equal(e.stripe, Math.round(27200 * 0.0165) + 30);
  assert.equal(e.profit, e.sales - e.gst - e.elec - e.stripe);
  assert.equal(e.alarms, 3); assert.equal(e.estimated, false);
});

test('a job not invoiced yet is estimated from the booked alarm count at the higher hardwired pay rate', () => {
  const e = ctx.jobEarnings({ status: 'scheduled', work_type: 'install', alarms: 4 });
  assert.equal(e.sales, 4 * 7900);
  assert.equal(e.elec, 3000 + 4 * 1300);
  assert.equal(e.estimated, true);
});

test('totals skip cancelled and warranty jobs and count estimated ones', () => {
  const t = ctx.sumEarnings([
    { status: 'completed', work_type: 'install', invoice_items: items(['alarm_battery', 2, 7900]) },
    { status: 'scheduled', work_type: 'install', alarms: 1 },
    { status: 'cancelled', work_type: 'install', alarms: 9 },
    { status: 'completed', work_type: 'warranty', alarms: 3 },
  ]);
  assert.equal(t.jobs, 2); assert.equal(t.alarms, 3); assert.equal(t.estimated, 1);
  assert.equal(t.sales, 3 * 7900);
  assert.equal(t.elec, 2 * 3000 + 2 * 1000 + 1300);
});
