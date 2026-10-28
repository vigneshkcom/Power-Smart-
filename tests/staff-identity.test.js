const test = require('node:test'), assert = require('node:assert/strict');
const Staff = require('../api/_staff-identity'), Senders = require('../api/_senders');
test('new and legacy sender keys both use Sunny in outgoing email headers and signatures', () => {
  for (const key of ['sunny','vignesh']) {
    assert.equal(Senders.resolveSender(key).key,'sunny');
    assert.match(Senders.fromHeader(key), /^Sunny - PowerSmart </);
    assert.match(Senders.signatureText(key), /Sunny/);
    assert.doesNotMatch(Senders.signatureHtml(key), /Vignesh/);
  }
});
test('stored staff attribution displays Sunny while customer identity and original records are preserved', () => {
  const original = {agent:'Vignesh',author:'Vignesh',created_by:'Vignesh',sender:'vignesh',name:'Vignesh',email:'vignesh@example.test',body_text:'Prepared by Vignesh\nVignesh\nPowerSmart',body_html:'<div>Vignesh</div><a href="https://example.test/accept?agent=Vignesh&ref=1">Accept</a>'};
  const updated = Staff.record([original])[0];
  assert.equal(updated.agent,'Sunny');assert.equal(updated.author,'Sunny');assert.equal(updated.created_by,'Sunny');assert.equal(updated.sender,'sunny');
  assert.equal(updated.name,'Vignesh');assert.equal(updated.email,'vignesh@example.test');assert.equal(original.agent,'Vignesh');
  assert.doesNotMatch(updated.body_text,/Vignesh/);assert.doesNotMatch(updated.body_html,/Vignesh/);
  assert.equal(Staff.record(7011),7011);assert.equal(Staff.record(null),null);
});
