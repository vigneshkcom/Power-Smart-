const test = require('node:test'), assert = require('node:assert/strict');
const { buildSummary, trackingStart } = require('../api/_stock');
const counts = (j) => ({ hardwired: j.h || 0, battery: j.b || 0, controllers: j.c || 0, untyped: j.u || 0 });
test('on hand = given - installed since first stock day (Brisbane)', () => {
  const techs = [{ id: 't1', name: 'Dillon', code: '1' }, { id: 't2', name: 'Other' }];
  const moves = [
    { electrician_id: 't1', product: 'battery', qty: 20, created_at: '2026-11-10T22:00:00Z' },   // 8am 11 Nov Brisbane
    { electrician_id: 't1', product: 'controller', qty: 5, created_at: '2026-11-10T22:00:00Z' },
    { electrician_id: 't1', product: 'battery', qty: -2, created_at: '2026-11-12T00:00:00Z' },
  ];
  const jobs = [
    { electrician_id: 't1', completed_at: '2026-11-11T03:00:00Z', b: 4, c: 1 },
    { electrician_id: 't1', completed_at: '2026-11-10T01:00:00Z', b: 9 },                          // before tracking: ignored
    { electrician_id: 't1', completed_at: '2026-11-11T05:00:00Z', b: 1, u: 2 },
  ];
  const r = buildSummary(techs, moves, jobs, counts);
  const d = r.find((x) => x.electrician_id === 't1');
  assert.deepEqual(d.on_hand, { hardwired: 0, battery: 13, controller: 4 });
  assert.equal(d.unclassified, 2);
  assert.equal(trackingStart('2026-11-10T22:00:00Z'), '2026-11-10T14:00:00.000Z');
});
