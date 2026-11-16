'use strict';
const nodemailer = require('nodemailer');
const { Resend: ResendClient } = require('resend');

function getProvider() {
  return (process.env.TRANSACTIONAL_EMAIL_PROVIDER || 'brevo').trim().toLowerCase();
}
function brevoConfig() {
  const host = process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com';
  const port = Number(process.env.BREVO_SMTP_PORT || 587);
  const user = process.env.BREVO_SMTP_USER;
  const pass = process.env.BREVO_SMTP_PASSWORD;
  if (!user || !pass) throw new Error('Brevo SMTP credentials missing (BREVO_SMTP_USER / BREVO_SMTP_PASSWORD)');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BREVO_SMTP_PORT');
  return { host, port, secure: port === 465, requireTLS: port !== 465,
    auth: { user, pass }, connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 20000 };
}
async function sendBrevo(mail) {
  let transport;
  try {
    transport = nodemailer.createTransport(brevoConfig());
    const result = await transport.sendMail({
      from: mail.from, to: mail.to, cc: mail.cc, bcc: mail.bcc,
      replyTo: mail.replyTo || mail.reply_to, subject: mail.subject,
      html: mail.html, text: mail.text, attachments: mail.attachments,
    });
    if (!result.accepted || !result.accepted.length) throw new Error('Brevo did not accept any recipients');
    return { data: { id: result.messageId }, error: null };
  } catch (err) {
    const detail = String(err.response || err.message || 'Unknown SMTP error').replace(/[\r\n]+/g, ' ').slice(0, 220);
    console.error('Brevo SMTP failed:', { code: err.code || null, responseCode: err.responseCode || null, detail });
    return { data: null, error: { message: 'Brevo SMTP failed (' + (err.code || 'SMTP_ERROR') + '): ' + detail } };
  } finally {
    if (transport) transport.close();
  }
}
class Resend {
  constructor() {
    this.emails = { send: async mail => {
      if (getProvider() === 'resend') {
        if (!process.env.RESEND_API_KEY) return { data: null, error: { message: 'RESEND_API_KEY not configured' } };
        return new ResendClient(process.env.RESEND_API_KEY).emails.send(mail);
      }
      return sendBrevo(mail);
    } };
  }
}
module.exports = { Resend };
