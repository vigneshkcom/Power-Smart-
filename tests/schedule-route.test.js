const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require.resolve('../tools/schedule.html'), 'utf8');

// openRoute() hands the driving route to the small /tools/route popup window (the route is drawn there).
function fixture({ popupBlocked = false, jobs } = {}) {
  const opened = [], toasts = [], focused = [];
  const win = popupBlocked ? null : { focus() { focused.push(true); } };
  const context = {
    window: { open: (...a) => { opened.push(a); return win; }, screenX: 0, screenY: 0, outerWidth: 1400, outerHeight: 900 },
    state: {
      techs: [{ id: 'tech', name: 'Jake Turner' }],
      jobs: jobs || [3, 1, 2].map(n => ({ electrician_id: 'tech', status: 'scheduled', scheduled_start: `2026-11-05T0${n}:00:00Z`, address: 'Stop ' + n, job_no: n })),
    },
    mapsQuery: j => (j.address ? j.address + ', QLD, Australia' : ''),
    toast: m => toasts.push(m),
  };
  vm.createContext(context);
  vm.runInContext(html.slice(html.indexOf('  function openRoute('), html.indexOf('  /* ---------- job modal')), context);
  return { context, opened, toasts, focused };
}
const payloadOf = url => JSON.parse(decodeURIComponent(url.split('?d=')[1]));

test('route opens the popup with the electrician\'s stops in schedule order', () => {
  const f = fixture();
  f.context.openRoute('tech');
  assert.equal(f.opened.length, 1);
  const [url, name, features] = f.opened[0];
  assert.match(url, /^\/tools\/route\?d=/);
  assert.equal(name, 'ps_route');
  assert.match(features, /popup=yes,width=520,height=760/);
  const payload = payloadOf(url);
  assert.equal(payload.title, 'Driving route · Jake Turner');
  assert.deepEqual(payload.stops.map(s => s.label), ['J1', 'J2', 'J3']);
  assert.deepEqual(payload.stops.map(s => s.q), ['Stop 1, QLD, Australia', 'Stop 2, QLD, Australia', 'Stop 3, QLD, Australia']);
  assert.equal(f.focused.length, 1, 'popup is focused');
});

test('cancelled jobs, other electricians\' jobs and jobs without an address are left out', () => {
  const base = { electrician_id: 'tech', status: 'scheduled', scheduled_start: '2026-11-05T01:00:00Z' };
  const f = fixture({ jobs: [
    { ...base, address: 'Keep', job_no: 1 },
    { ...base, address: 'Cancelled', job_no: 2, status: 'cancelled' },
    { ...base, address: 'Someone else', job_no: 3, electrician_id: 'other' },
    { ...base, address: '', job_no: 4 },
  ] });
  f.context.openRoute('tech');
  assert.deepEqual(payloadOf(f.opened[0][0]).stops.map(s => s.label), ['J1']);
});

test('no stops shows a message and opens nothing', () => {
  const f = fixture({ jobs: [] });
  f.context.openRoute('tech');
  assert.equal(f.opened.length, 0);
  assert.match(f.toasts[0], /No jobs with addresses/);
});

test('a blocked popup falls back to a normal tab', () => {
  const f = fixture({ popupBlocked: true });
  f.context.openRoute('tech');
  assert.equal(f.opened.length, 2);
  assert.equal(f.opened[1][1], '_blank');
  assert.equal(f.opened[1][0], f.opened[0][0]);
});
