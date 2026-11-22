const test = require('node:test');
const assert = require('node:assert/strict');
const photos = require('../assets/controller-photos');

test('each invoiced controller gets a distinct photo slot while alarm quantities stay separate', () => {
  const items = [{ code: 'alarm_battery', qty: 3 }, { code: 'controller', qty: 2 }];
  const entries = photos.entries(items);
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].id, entries[1].id);
  assert.equal(items[0].qty, 3);
  assert.equal(photos.ready(items), false);
  entries[0].photoKey = 'queued-first';
  assert.equal(photos.ready(items), false);
  entries[1].photo = '/PowerSmart Jobs/J1/Controllers/second.jpg';
  assert.equal(photos.ready(items), true);
});

test('queued photos survive saving and restoring a draft, then attach to the right controller', () => {
  const items = [{ code: 'controller', qty: 2 }];
  const entries = photos.entries(items);
  entries[0].photoKey = 'queued-first'; entries[1].photoKey = 'queued-second';
  const restored = JSON.parse(JSON.stringify(items));
  assert.equal(photos.attach(restored, { unitId: entries[1].id, key: 'queued-second' }, '/PowerSmart Jobs/J1/Controllers/second.jpg'), true);
  assert.equal(restored[0].photos[1].photo, '/PowerSmart Jobs/J1/Controllers/second.jpg');
  assert.equal(restored[0].photos[1].photoKey, undefined);
  assert.equal(restored[0].photos[0].photoKey, 'queued-first');
  assert.equal(photos.attach(restored, { key: 'queued-first' }, '/PowerSmart Jobs/J1/Controllers/first.jpg'), true);
  assert.equal(photos.ready(restored), true);
});

test('increasing controller quantity retains existing photos and requires the new photo', () => {
  const items = [{ code: 'controller', qty: 1, photos: [{ id: 'existing', photo: '/PowerSmart Jobs/J1/Controllers/first.jpg' }] }];
  assert.equal(photos.ready(items), true);
  items[0].qty = 2;
  assert.equal(photos.ready(items), false);
  assert.equal(items[0].photos[0].id, 'existing');
  assert.equal(items[0].photos[0].photo, '/PowerSmart Jobs/J1/Controllers/first.jpg');
  const removed = items[0].photos[1];
  items[0].qty = 1;
  assert.equal(photos.ready(items), true);
  assert.equal(photos.attach(items, { unitId: removed.id }, '/PowerSmart Jobs/J1/Controllers/deleted.jpg'), false);
  assert.equal(items[0].photos.length, 1);
  assert.equal(photos.ready([{ code: 'alarm_battery', qty: 3 }]), true);
});
