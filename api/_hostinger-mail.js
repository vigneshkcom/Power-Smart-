'use strict';
// Hostinger SMTP adapter matching the Resend emails.send() result shape.
// SMS and unrelated PowerSmart workflows are unaffected.
// Select with EMAIL_PROVIDER=hostinger only after the PowerSmart mailbox is configured.
const nodemailer = require('nodemailer');
const { randomUUID } = require('crypto');
const ADDRESS = 'support@powersmartco.com.au';
function transportConfig() {
  const user = String(process.env.HOSTINGER_SMTP_USER || '').trim().toLowerCase();
  const password = process.env.HOSTINGER_SMTP_PASSWORD;
  if (!user || !password) throw new Error('Set HOSTINGER_SMTP_USER and HOSTINGER_SMTP_PASSWORD in Vercel.');
  if (user !== ADDRESS) throw new Error('Hostinger SMTP must use the PowerSmart support mailbox, not a Goldsure or personal mailbox.');
  return { host: 'smtp.hostinger.com', port: 465, secure: true, auth: { user, pass: password },
    connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 20000 };
}
async function send(mail) {
  let transport;
  try {
    const from = String(mail.from || `PowerSmart <${ADDRESS}>`);
    const match = /<([^>]+)>\s*$/.exec(from);
    const address = (match ? match[1] : from).trim().toLowerCase();
    if (address !== ADDRESS) throw new Error('The From address must be support@powersmartco.com.au.');
    transport = nodemailer.createTransport(transportConfig());
    const result = await transport.sendMail({ from, to: mail.to, cc: mail.cc, bcc: mail.bcc,
      replyTo: mail.replyTo || ADDRESS, subject: mail.subject, html: mail.html, text: mail.text,
      attachments: mail.attachments, messageId: `<${randomUUID()}@powersmartco.com.au>` });
    if (!result.accepted || !result.accepted.length) throw new Error('SMTP did not accept the recipient.');
    return { data: { id: result.messageId }, error: null };
  } catch (error) {
    // No silent retry or Resend fallback: SMTP may have accepted a text before a timeout.
    return { data: null, error: { message: 'Hostinger SMTP failed: ' + String(error.code || error.message).slice(0,180) } };
  } finally { if (transport) transport.close(); }
}
class Resend { constructor() { this.emails = { send }; } }
module.exports = { Resend };
