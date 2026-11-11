const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ user = 'support@powersmartco.com.au', password = 'test', error = null, accepted = ['customer@example.com'] } = {}) {
  const sent = [], configs = [];
  const module = { exports: {} };
  const nodemailer = {
    createTransport(config) {
      configs.push(config);
      return { async sendMail(mail) {
        sent.push(mail);
        if (error) throw error;
        return { accepted, messageId: '<accepted@powersmartco.com.au>' };
      }, close() {} };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/_hostinger-mail.js'), 'utf8'), {
    module,
    require: (name) => name === 'nodemailer' ? nodemailer : require(name),
    process: { env: { HOSTINGER_SMTP_USER: user, HOSTINGER_SMTP_PASSWORD: password } },
  });
  return { send: module.exports.Resend.prototype ? new module.exports.Resend().emails.send : null, sent, configs };
}

test('Hostinger uses encrypted SMTP and only the PowerSmart sender address', async () => {
  const f = fixture();
  const result = await f.send({ from: 'PowerSmart <support@powersmartco.com.au>', to: 'customer@example.com',
    replyTo: 'support@powersmartco.com.au', subject: 'Your quote', html: '<p>Hello</p>', text: 'Hello',
    attachments: [{ filename: 'certificate.pdf', content: Buffer.from('PDF') }] });
  assert.equal(result.error, null);
  assert.equal(result.data.id, '<accepted@powersmartco.com.au>');
  assert.equal(f.configs[0].host, 'smtp.hostinger.com');
  assert.equal(f.configs[0].port, 465);
  assert.equal(f.configs[0].secure, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].attachments[0].filename, 'certificate.pdf');
});

test('a Goldsure SMTP account cannot send PowerSmart emails', async () => {
  const f = fixture({ user: 'vignesh@goldsure.com.au' });
  const result = await f.send({ from: 'PowerSmart <support@powersmartco.com.au>', to: 'customer@example.com' });
  assert.match(result.error.message, /Hostinger SMTP failed/);
  assert.equal(f.sent.length, 0);
});

test('an unknown SMTP result does not trigger a Resend fallback or duplicate', async () => {
  const f = fixture({ error: Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }) });
  const result = await f.send({ from: 'PowerSmart <support@powersmartco.com.au>', to: 'customer@example.com' });
  assert.equal(result.data, null);
  assert.match(result.error.message, /ETIMEDOUT/);
  assert.equal(f.sent.length, 1);
});
