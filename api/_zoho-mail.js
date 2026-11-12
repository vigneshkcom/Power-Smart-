'use strict';
const nodemailer = require('nodemailer');
const { randomUUID } = require('crypto');
const FROM = 'support@powersmartco.com.au';
function transportConfig() {
  const user = String(process.env.ZOHO_SMTP_USER || '').trim();
  const pass = process.env.ZOHO_SMTP_PASSWORD;
  if (!user || !pass) throw new Error('Set ZOHO_SMTP_USER and ZOHO_SMTP_PASSWORD in Vercel.');
  return { host: 'smtp.zeptomail.com.au', port: 465, secure: true, auth: { user, pass }, connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 20000 };
}
async function send(mail) {
  let transport;
  try {
    const from = String(mail.from || 'PowerSmart <support@powersmartco.com.au>');
    const match = /<([^>]+)>\s*$/.exec(from);
    if ((match ? match[1] : from).trim().toLowerCase() !== FROM) throw new Error('Zoho sender must be support@powersmartco.com.au.');
    transport = nodemailer.createTransport(transportConfig());
    const result = await transport.sendMail({ from, to: mail.to, cc: mail.cc, bcc: mail.bcc,
      replyTo: FROM, subject: mail.subject, html: mail.html, text: mail.text,
      attachments: mail.attachments, messageId: '<' + randomUUID() + '@powersmartco.com.au>' });
    if (!result.accepted || !result.accepted.length) throw new Error('Zoho did not accept the recipient.');
    return { data: { id: result.messageId }, error: null };
  } catch (err) {
    // Do not retry automatically: an SMTP timeout may occur after acceptance.
    return { data: null, error: { message: 'Zoho SMTP failed: ' + String(err.code || err.message).slice(0, 180) } };
  } finally { if (transport) transport.close(); }
}
class Resend { constructor() { this.emails = { send }; } }
module.exports = { Resend };
