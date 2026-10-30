const test = require('node:test'), assert = require('node:assert/strict');
const { bookingSlot, renderBookingEmail } = require('../api/_booking-confirmation');
test('visits are grouped into AM (before 12pm) and PM Brisbane slots', () => {
  assert.equal(bookingSlot('2026-11-03T22:00:00Z').slot, 'AM');   // 8:00am Brisbane
  assert.equal(bookingSlot('2026-11-04T01:30:00Z').slot, 'AM');   // 11:30am
  assert.equal(bookingSlot('2026-11-04T02:00:00Z').slot, 'PM');   // 12:00pm
  assert.equal(bookingSlot('2026-11-04T06:00:00Z').slot, 'PM');   // 4:00pm
  assert.equal(bookingSlot('nonsense'), null);
});
test('confirmation shows the slot window, balance and never an exact time', () => {
  const slot = bookingSlot('2026-11-03T23:30:00Z');
  const { html, text } = renderBookingEmail({ name: 'Peter Wallmer', quoteRef: '7013', quoteTotal: 465, feePaid: 35, address: '1 Test St', slot });
  for (const body of [html, text]) {
    assert.match(body, /Wednesday 4 November 2026/);
    assert.match(body, /8:00am and 12:00pm/);
    assert.match(body, /\$430\.00/);
    assert.doesNotMatch(body, /9:30/);
  }
});
