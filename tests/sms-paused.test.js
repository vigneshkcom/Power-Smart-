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
  const fs = require('node:fs'), path = require('node:path'), found = [];
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'archive'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (!['sms-paused.test.js', 'enquiry-confirmation.test.js'].includes(entry.name)
        && /\.(?:js|html|md)$/.test(entry.name)
        && /0401(?: |&nbsp;)?991(?: |&nbsp;)?420|61401991420/.test(fs.readFileSync(file, 'utf8'))) found.push(file);
    }
  }
  scan(path.join(__dirname, '..'));
  assert.deepEqual(found, []);
});
