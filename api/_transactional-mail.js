'use strict';
// All outbound transactional emails pass through one quota-aware sender.
// Daily reservations are atomic in Supabase, including concurrent Vercel functions.
const nodemailer = require('nodemailer');
const { Resend: ResendClient } = require('resend');
const SB = require('./_supabase');

function recipients(mail) {
  const flatten = value => {
    if (!value) return [];
    if (Array.isArray(value)) return value.flatMap(flatten);
    if (typeof value === 'object') return value.address ? [value.address] : [];
    // Addresses in a single string may be separated by commas.
    return String(value).split(',').map(v => v.trim()).filter(Boolean);
  };
  return flatten(mail.to).length + flatten(mail.cc).length + flatten(mail.bcc).length;
}

async function chooseProvider(mail) {
  // Operator override is emergency-only. No auto retry after an ambiguous
  // provider failure, which could send a customer two copies.
  const override = (process.env.TRANSACTIONAL_EMAIL_PROVIDER || '').trim().toLowerCase();
  if (override === 'resend' || override === 'brevo') return override;
  if (!SB.configured()) throw new Error('Email routing requires Supabase daily usage tracking');
  const count = recipients(mail);
  if (!count) throw new Error('Email has no recipients');
  // RPC returns a JSON string such as "resend" or "brevo".
  const selected = await SB.sb('rpc/reserve_transactional_email_route', {
    method: 'POST', body: { p_recipients: count }, prefer: 'return=representation',
  });
  if (selected !== 'resend' && selected !== 'brevo') throw new Error('Invalid email route returned by Supabase');
  return selected;
}

async function sendResend(mail) {
  if (!process.env.RESEND_API_KEY) return { data: null, error: { message: 'Resend API key is not configured' } };
  return new ResendClient(process.env.RESEND_API_KEY).emails.send(mail);
}

function brevoConfig() {
  const host = process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com';
  const port = Number(process.env.BREVO_SMTP_PORT || 587);
  const user = process.env.BREVO_SMTP_USER;
  const pass = process.env.BREVO_SMTP_PASSWORD;
  if (!user || !pass) throw new Error('Brevo SMTP credentials missing');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BREVO_SMTP_PORT');
  return {
    host, port, secure: port === 465, requireTLS: port !== 465,
    auth: { user, pass }, connectionTimeout: 12000,
    greetingTimeout: 12000, socketTimeout: 20000,
  };
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

async function send(mail) {
  try {
    const provider = await chooseProvider(mail);
    console.info('Transactional email route:', provider, 'recipient count:', recipients(mail));
    return provider === 'resend' ? await sendResend(mail) : await sendBrevo(mail);
  } catch (err) {
    console.error('Transactional email routing failed:', err.message);
    return { data: null, error: { message: 'Email routing failed: ' + err.message } };
  }
}

// Compatible with existing call sites; API key argument is ignored because
// the sender uses the appropriate production environment credentials.
class Resend { constructor() { this.emails = { send }; } }
module.exports = { Resend };
