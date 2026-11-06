const test = require('node:test'), assert = require('node:assert/strict');
const Sms = require('../api/_sms-outbound');
test('SMS is paused by default and sendLeadSms never reaches the gateway', async () => {
  delete process.env.SMS_ENABLED;
  assert.equal(Sms.smsEnabled(), false);
  const real = global.fetch; let hit = 0; global.fetch = async () => { hit++; throw new Error('should not be called'); };
  try {
    const r = await Sms.sendLeadSms({ lead: { id: 'l1', phone: '0411111111' }, message: 'hi', key: 'k' });
    assert.equal(r.status, 'skipped'); assert.equal(r.paused, true); assert.equal(hit, 0);
  } finally { global.fetch = real; }
});
test('SMS_ENABLED=true switches SMS back on', () => {
  process.env.SMS_ENABLED = 'true'; try { assert.equal(Sms.smsEnabled(), true); } finally { delete process.env.SMS_ENABLED; }
});
test('the business phone number is gone from the codebase', () => {
  const { execSync } = require('node:child_process');
  const out = execSync(`grep -rIlE "0401 ?991 ?420|61401991420|0401&nbsp;991" . --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=archive --exclude=sms-paused.test.js --exclude=enquiry-confirmation.test.js || true`, { cwd: require('path').join(__dirname, '..') }).toString().trim();
  assert.equal(out, '');
});
