// POST /api/lead — a website visitor requested a callback/quote.
// Emails the lead straight to PowerSmart so the team can call them.
//
// Env vars: RESEND_API_KEY (required), NOTIFY_EMAIL (optional, default support),
//           RESEND_FROM_EMAIL / RESEND_REPLY_TO (optional).

const SUPPORT_EMAIL = "support@powersmartco.com.au";
const SB = require("./_supabase");
const { welcomeLead, repeatKind } = require('./_welcome-sms');
const S = require("./_senders");
const { renderEnquiryConfirmation } = require("./_enquiry-confirmation");
const { logEmail } = require("./_maillog");
const Sms = require("./_sms-outbound");
const { isBlocked } = require("./_blocked-numbers");
const { latestSentQuote, repeatQuoteMessages } = require("./_repeat-quote");

async function parseRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Phone forms a stored lead might use for the same mobile: 04xxxxxxxx, +614xxxxxxxx, 614xxxxxxxx and the raw entry.
function phoneVariants(raw) {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  const set = new Set([digits]);
  const local = digits.replace(/^\+?61/, "0");
  if (/^0\d{9}$/.test(local)) { set.add(local); set.add("+61" + local.slice(1)); set.add("61" + local.slice(1)); }
  return [...set].filter(Boolean);
}
// Most recently updated lead with the same email or phone, if any.
async function findExistingLead({ email, phone }) {
  const conds = phoneVariants(phone).map((p) => `phone.eq.${encodeURIComponent(p)}`);
  if (email) conds.push(`email.eq.${encodeURIComponent(email.toLowerCase())}`);
  if (!conds.length) return null;
  const rows = await SB.sb(`leads?or=(${conds.join(",")})&select=id,name,phone,email,postcode,stage,source&order=updated_at.desc&limit=1`);
  return rows && rows[0] || null;
}
function isValidEmail(v) {
  return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

async function handleLead(req, res, source = "Website") {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = 'transactional-email';

  const b = req.body || {};
  const name = String(b.name || "").slice(0, 120).trim();
  const phone = String(b.phone || "").slice(0, 40).trim();
  const email = String(b.email || "").slice(0, 254).trim();
  const postcode = String(b.postcode || "").slice(0, 12).trim();

  if (!name || !phone) return res.status(400).json({ error: "Name and phone are required" });
  if (email && !isValidEmail(email)) return res.status(400).json({ error: "Please enter a valid email address" });

  // Blocked competitors (phone, email or name): answer exactly like a normal success, but save and send nothing.
  if (isBlocked({ name, phone, email })) {
    console.log("lead → blocked enquiry ignored");
    return res.status(200).json({ ok: true, welcome_sms: { status: "skipped" } });
  }

  const rows = [
    ["Name", name],
    ["Phone", phone],
    ["Email", email || "Not provided"],
    ["Postcode", postcode || "Not provided"],
  ].map(([k, v]) =>
    `<tr><td style="padding:7px 12px;color:#6B8288;font-size:13px;width:110px;">${k}</td><td style="padding:7px 12px;font-size:14px;color:#0B1B1F;"><strong>${esc(v)}</strong></td></tr>`
  ).join("");

  const leadLabel = source === "Instant Form" ? "instant form" : "website";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0B1B1F;">
      <div style="background:#43A8B6;padding:16px 20px;border-radius:10px 10px 0 0;">
        <strong style="font-size:16px;color:#0B1B1F;">New ${leadLabel} lead - call to quote</strong>
      </div>
      <div style="border:1px solid #eee;border-top:none;padding:14px 8px;border-radius:0 0 10px 10px;">
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        <p style="margin:14px 12px 4px;font-size:12px;color:#6B8288;">Submitted via ${leadLabel} &middot; ${new Date().toLocaleString("en-AU", { timeZone: "Australia/Brisbane" })} AEST</p>
        <p style="margin:8px 12px 4px;font-size:13px;">
          <a href="tel:${esc(phone)}" style="color:#2E8494;font-weight:bold;text-decoration:none;">Call ${esc(phone)}</a>
          ${email ? ` &middot; <a href="mailto:${esc(email)}" style="color:#2E8494;font-weight:bold;text-decoration:none;">Email ${esc(email)}</a>` : ""}
        </p>
      </div>
    </div>`;

  const text = `New ${leadLabel} lead - call to quote\n\nName: ${name}\nPhone: ${phone}\nEmail: ${email || "Not provided"}\nPostcode: ${postcode || "Not provided"}\n\nSubmitted via ${leadLabel}.`;

  // Drop the enquiry into the sales pipeline (non-fatal if Supabase is down/unconfigured).
  let savedLead = null, repeat = false, existingLead = null, existingQuote = null;
  if (source === "Instant Form" && !SB.configured()) return res.status(503).json({ error: "Sales pipeline is unavailable" });
  if (SB.configured()) {
    try {
      // Same phone or email already in the pipeline: update that lead instead of creating a duplicate.
      const existing = await findExistingLead({ email, phone });
      if (existing) {
        repeat = repeatKind ? repeatKind(existing.stage) : true; savedLead = existing; existingLead = existing;
        try { existingQuote = await latestSentQuote(existing, email); } catch (e) { console.error("Repeat quote lookup:", e.message); }
        if (existingQuote) repeat = "existing";
        const patch = { updated_at: new Date().toISOString() };
        if (!existing.email && email) patch.email = email.toLowerCase();
        if (!existing.phone && phone) patch.phone = phone;
        if (!existing.postcode && postcode) patch.postcode = postcode;
        if (existing.source !== source) patch.source = source;
        const reopened = ["not_interested", "not_reachable"].includes(existing.stage);
        if (reopened && !existingQuote) patch.stage = "new_lead";
        await SB.sb(`leads?id=eq.${encodeURIComponent(existing.id)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
        await Sms.logNote(existing.id, "System", `Repeat ${leadLabel} enquiry from ${name} (${phone}${email ? ", " + email : ""}${postcode ? ", " + postcode : ""}). Existing lead updated instead of creating a duplicate${reopened ? "; moved back to New Lead" : ""}.`).catch(() => {});
      } else {
      const inserted = await SB.sb("leads", {
        method: "POST",
        body: { name, phone: phone || null, email: email.toLowerCase() || null, postcode: postcode || null, source, stage: "new_lead" },
      });
      savedLead = inserted && inserted[0];
      }
    } catch (e) {
      console.error("lead → pipeline insert failed:", e.message);
      if (source === "Instant Form") return res.status(503).json({ error: "Sales pipeline could not save this lead" });
    }
  }

  let welcomeSms;
  if (existingLead && existingQuote) {
    const followup = repeatQuoteMessages(existingLead.name || name, existingQuote);
    const originalPhone = String(existingLead.phone || '').trim();
    const samePhone = Sms.cleanPhone(originalPhone) === Sms.cleanPhone(phone);
    if (samePhone && Sms.smsEnabled()) {
      try {
        welcomeSms = await Sms.sendLeadSms({ lead: existingLead, message: followup.sms,
          key: 'repeat-quote-' + existingQuote.id + '-' + new Date().toISOString().slice(0, 10),
          author: 'System' });
      } catch (err) {
        welcomeSms = { status: 'failed', error: err.message };
        await Sms.logNote(existingLead.id, 'System', 'Repeat quote SMS failed: ' + err.message).catch(() => {});
      }
    } else {
      welcomeSms = { status: 'skipped', ...(Sms.smsEnabled() ? { reason: 'Contact phone differs from existing record' } : { paused: true }) };
    }
  } else {
    welcomeSms = savedLead ? await welcomeLead(savedLead, new Date(), { repeat }) : { status: 'skipped' };
  }

  try {
    const { Resend } = require('./_transactional-mail');
    const resend = new Resend(apiKey);

    // Send the existing quotation link to the original verified recipient.
    // Never disclose a saved quote to a newly supplied email address.
    if (existingLead && existingQuote) {
      const originalEmail = String(existingLead.email || '').trim().toLowerCase();
      const quoteRecipient = String(existingQuote.to_email || '').trim().toLowerCase();
      if (originalEmail && originalEmail === quoteRecipient && (!email || email.toLowerCase() === originalEmail)) {
        try {
          const followup = repeatQuoteMessages(existingLead.name || name, existingQuote);
          const prior = await SB.sb('sent_emails?lead_id=eq.' + encodeURIComponent(existingLead.id) +
            '&kind=eq.email&status=eq.sent&subject=eq.' + encodeURIComponent(followup.subject) +
            '&created_at=gte.' + encodeURIComponent(new Date(Date.now() - 86400000).toISOString()) +
            '&select=id&limit=1');
          if (!prior?.length) {
            const { data, error: quoteError } = await resend.emails.send({
              from: S.fromHeader('customer_service'), to: originalEmail, replyTo: SUPPORT_EMAIL,
              subject: followup.subject, html: followup.html, text: followup.text,
            });
            if (quoteError) throw new Error(quoteError.message || 'Quote follow-up rejected');
            await logEmail({ kind: 'email', sender: 'customer_service', agent: 'System',
              to_email: originalEmail, to_name: existingLead.name || name, subject: followup.subject,
              body_html: followup.html, body_text: followup.text, lead_id: existingLead.id,
              provider_id: data && data.id, status: 'sent' });
            await Sms.logNote(existingLead.id, 'System', 'Existing quote link emailed following repeat enquiry.').catch(() => {});
          }
        } catch (err) {
          console.error('Existing quote follow-up failed:', err.message);
          await Sms.logNote(existingLead.id, 'System', 'Existing quote email issue: ' + err.message).catch(() => {});
        }
      } else {
        await Sms.logNote(existingLead.id, 'System', 'Existing quotation email skipped: contact address does not match saved quote recipient.').catch(() => {});
      }
    }

    // Standard response for leads without a valid saved quote.
    if (!existingQuote && email && (!repeat || welcomeSms.paused)) {
      try {
        const mail = renderEnquiryConfirmation({ name });
        const { error: custError } = await resend.emails.send({
          from: S.fromHeader("customer_service"), to: email,
          replyTo: SUPPORT_EMAIL, subject: mail.subject, html: mail.html, text: mail.text,
        });
        if (custError) throw new Error(custError.message || "Email provider rejected the request");
        await logEmail({ kind: "email", sender: "customer_service", agent: "System", to_email: email, to_name: name, subject: mail.subject, body_html: mail.html, body_text: mail.text, lead_id: savedLead && savedLead.id, status: "sent" });
        if (savedLead) await Sms.logNote(savedLead.id, "System", "Enquiry confirmation email sent to the customer.").catch(() => {});
      } catch (e) {
        console.error("lead → customer confirmation email failed:", e.message);
        if (savedLead) await Sms.logNote(savedLead.id, "System", `Enquiry confirmation email failed: ${e.message}`).catch(() => {});
      }
    }

    const { error } = await resend.emails.send({
      from: `PowerSmart Leads <${SUPPORT_EMAIL}>`,
      to: process.env.NOTIFY_EMAIL || SUPPORT_EMAIL,
      replyTo: email || (process.env.RESEND_REPLY_TO || SUPPORT_EMAIL),
      subject: `${repeat ? "Repeat enquiry" : "New lead"}: ${name}${postcode ? " (" + postcode + ")" : ""}`,
      html,
      text,
    });
    if (error) {
      console.error("lead → staff notification email failed:", error.message || "Email provider rejected the request");
      // A saved Facebook lead must never be rejected merely because the optional
      // staff notification email failed. Make.com retries the same lead otherwise.
      if (source === 'Instant Form' && savedLead?.id) {
        await Sms.logNote(savedLead.id, "System", "Staff lead notification email failed: " + (error.message || "Provider rejected email")).catch(() => {});
        return res.status(200).json({ ok: true, lead_id: savedLead.id, notification_email: "failed", welcome_sms: welcomeSms });
      }
      return res.status(502).json({ error: error.message || "Email provider rejected the request" });
    }
    return res.status(200).json({ ok: true, welcome_sms: welcomeSms, ...(source === 'Instant Form' && savedLead?.id ? { lead_id: savedLead.id } : {}) });
  } catch (err) {
    // A successfully saved lead must be acknowledged even if a customer or staff
    // notification throws unexpectedly. Otherwise Make.com retries a saved lead.
    console.error('lead → notification processing failed:', err && err.message);
    if (savedLead?.id) {
      await Sms.logNote(savedLead.id, 'System', 'Notification processing failed after the lead was saved: ' + String(err && err.message || 'Unknown error')).catch(() => {});
      return res.status(200).json({ ok: true, lead_id: savedLead.id,
        notification_email: 'failed', welcome_sms: welcomeSms });
    }
    return res.status(500).json({ error: (err && err.message) || "Unexpected error submitting lead" });
  }
}

module.exports = async (req, res) => {
  if (req.query?.make === '1' || String(req.url || '').split('?')[0] === '/api/make-lead') {
    return require('./_make-lead')(req, res, parseRawBody, handleLead);
  }
  if (req.query?.meta_webhook === '1') {
    return require('./_meta-lead-webhook')(req, res, parseRawBody, handleLead);
  }
  if (req.method !== 'POST') return handleLead(req, res);
  try {
    if (req.body == null) {
      req.body = JSON.parse((await parseRawBody(req)).toString('utf8'));
    } else if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
      req.body = JSON.parse(req.body.toString());
    }
  } catch (_) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  return handleLead(req, res);
};
module.exports.handleLead = handleLead;
module.exports.config = { api: { bodyParser: false }, maxDuration: 60 };
