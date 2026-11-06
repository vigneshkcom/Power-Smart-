// POST /api/send-quote — emails a professional smoke alarm quotation via Resend.
//
// Env vars (Vercel → Settings → Environment Variables):
//   RESEND_API_KEY      required
//   RESEND_FROM_EMAIL   optional, default "PowerSmart <support@powersmartco.com.au>"
//   RESEND_REPLY_TO     optional, default "support@powersmartco.com.au"
//   NOTIFY_EMAIL        optional, address BCC'd a copy of each quote (default support)

const Q = require("./_quote");
const SB = require("./_supabase");
const S = require("./_senders");
const { logEmail } = require("./_maillog");
const { randomUUID } = require('crypto');
const Sms = require('./_sms-outbound');
const Fee = require('./_callout-fee');
const QP = require('./_quote-payments');

// Same passcode the pipeline page and /api/send-email use.
const PORTAL_KEY = "2026";

// leadId is only honoured when the call came from the pipeline (portal key), so a
// quote sent from a lead card updates that exact lead instead of matching by email.
async function recordRevision({ leadId, agentName, ref, total, discount }) {
  if (!SB.configured() || !leadId) return;
  try {
    await SB.sb(`leads?id=eq.${encodeURIComponent(leadId)}&quote_ref=eq.${encodeURIComponent(ref)}`, { method: "PATCH", body: { quote_total: total }, prefer: "return=minimal" });
    await SB.sb("lead_comments", { method: "POST", body: { lead_id: leadId, author: agentName || "System", kind: "quote", body: `Quote ${ref} updated and re-sent${discount > 0 ? `, ${Q.fmt(discount)} discount applied` : ""}. New total ${Q.fmt(total)} incl. GST.` }, prefer: "return=minimal" });
  } catch (e) { console.error("send-quote → revision note failed:", e.message); }
}

async function recordInPipeline({ customerName, customerEmail, customerPhone, agentName, ref, total, leadId: hintId }) {
  if (!SB.configured()) return null;
  try {
    const patch = { stage: "quote_sent", quote_ref: ref, quote_total: total, agent: agentName || null };
    let leadId = null;
    if (hintId) {
      const byId = await SB.sb(`leads?id=eq.${encodeURIComponent(hintId)}&select=id,email,phone&limit=1`);
      if (byId && byId[0]) {
        leadId = byId[0].id;
        if (!byId[0].email) patch.email = customerEmail.toLowerCase();   // remember the address we just used
        if (!byId[0].phone && customerPhone) patch.phone = customerPhone;
      }
    }
    if (!leadId) {
      const found = await SB.sb(`leads?email=eq.${encodeURIComponent(customerEmail.toLowerCase())}&select=id,phone&order=updated_at.desc&limit=1`);
      if (found && found[0]) { leadId = found[0].id; if (!found[0].phone && customerPhone) patch.phone = customerPhone; }
    }
    if (leadId) {
      await SB.sb(`leads?id=eq.${encodeURIComponent(leadId)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
    } else {
      const rows = await SB.sb("leads", {
        method: "POST",
        body: { name: customerName || customerEmail, email: customerEmail.toLowerCase(), ...(customerPhone ? {phone:customerPhone} : {}), source: "Phone quote", stage: "quote_sent", quote_ref: ref, quote_total: total, agent: agentName || null },
      });
      leadId = rows && rows[0] && rows[0].id;
    }
    if (leadId) {
      await SB.sb("lead_comments", {
        method: "POST",
        body: { lead_id: leadId, author: agentName || "System", kind: "quote", body: `Quote ${ref} emailed. Total ${Q.fmt(total)} incl. GST.` },
        prefer: "return=minimal",
      });
    }
    return leadId || null;
  } catch (e) { console.error("send-quote → pipeline update failed:", e.message); return null; }
}

async function nextQuoteReference() {
  if (!SB.configured()) {
    const error = new Error("Quote numbering is not configured");
    error.status = 500;
    throw error;
  }
  const number = await SB.sb("rpc/next_quote_reference", { method: "POST", body: {} });
  if (!Number.isInteger(number) || number < 7000) {
    const error = new Error("Quote numbering returned an invalid reference");
    error.status = 500;
    throw error;
  }
  return String(number);
}

function isValidEmail(v) {
  return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

async function resendQuote(req, res, leadId, agentName, apiKey) {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(leadId)) return res.status(400).json({ error: "Invalid customer" });
  try {
    const lead = (await SB.sb(`leads?id=eq.${leadId}&select=id,name,phone,email,quote_ref&limit=1`))?.[0];
    if (!lead) return res.status(404).json({ error: "Customer not found" });
    if (!lead.quote_ref) return res.status(400).json({ error: "This customer has no quote to resend" });
    const q = (await SB.sb(`sent_emails?lead_id=eq.${leadId}&kind=eq.quote&status=eq.sent&quote_ref=eq.${encodeURIComponent(lead.quote_ref)}&select=id,lead_id,sender,quote_ref,subject,body_html,body_text,to_email,to_name&order=created_at.desc&limit=1`))?.[0];
    if (!q) return res.status(404).json({ error: "The original quote email was not found" });
    const to = isValidEmail(lead.email) ? lead.email : q.to_email;
    if (!isValidEmail(to)) return res.status(400).json({ error: "Add a valid customer email address first" });
    const sender = S.resolveSender("customer_service");   // quotes always come from the PowerSmart team, never a named person
    const quoteUrl = `${Q.QUOTE_SITE}/quote?token=${q.id}`;
    const subject = `Reminder: ${q.subject || `Your PowerSmart quotation (${q.quote_ref})`}`;
    // Older saved quote emails can contain an acceptance link on the former host.
    const replaceLegacyQuoteLinks = value => String(value || '').replace(/https:\/\/smokealarms\.powersmartco\.com\.au\/(accept|quote)(?=[?"\s<])/g, `${Q.QUOTE_SITE}/$1`);
    const { Resend } = require("resend");
    const { data, error } = await new Resend(apiKey).emails.send({
      from: S.fromHeader(sender.key), to: to, replyTo: process.env.RESEND_REPLY_TO || Q.SUPPORT_EMAIL,
      subject, html: replaceLegacyQuoteLinks(q.body_html), text: replaceLegacyQuoteLinks(q.body_text),
    });
    if (error) return res.status(502).json({ error: error.message || "Email provider rejected the request" });
    let sms = { status: "skipped", error: "No mobile number saved." };
    if (lead.phone) {
      try {
        const first = String(lead.name || "there").trim().split(/\s+/)[0];
        const message = `Hi ${first}, here is your PowerSmart smoke alarm quote ${q.quote_ref} again. We've also re-emailed it, so please check your spam or junk folder just in case. View your quote here: ${quoteUrl} Call 0401 991 420 with any questions.`;
        sms = await Sms.sendLeadSms({ lead, message, key: `quote-${q.id}-resend-${Date.now()}`, author: agentName });
      } catch (e) { sms = { status: "failed", error: e.message }; }
    }
    try { await SB.sb("lead_comments", { method: "POST", body: { lead_id: lead.id, author: agentName || "System", kind: "quote", body: `Quote ${q.quote_ref} re-sent by email${sms.status === "submitted" ? " and SMS" : " (SMS not sent: " + (sms.error || sms.status) + ")"}.` }, prefer: "return=minimal" }); } catch (_) {}
    return res.status(200).json({ ok: true, id: data && data.id, ref: q.quote_ref, sms });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) || "Could not resend the quote" });
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Email service is not configured (missing RESEND_API_KEY)" });

  const b = req.body || {};
  const customerEmail = b.customerEmail;
  const customerName = String(b.customerName || "").slice(0, 120).trim();
  const agentName = String(b.agentName || "").slice(0, 120).trim().replace(/^Vignesh$/i, "Sunny");
  const sender = S.resolveSender("customer_service");   // quotes always come from the PowerSmart team, never a named person
  const fromPipeline = (req.headers["x-portal-key"] || "") === PORTAL_KEY;
  const customerPhone = fromPipeline ? Sms.cleanPhone(b.customerPhone) : '';
  let hintLeadId = fromPipeline && /^[\w-]{1,40}$/.test(String(b.leadId || "")) ? String(b.leadId) : "";
  // Discounts and revisions can only be applied from the staff portal.
  const { serviceMode, alarmQty, controllerQty, discount } = Q.normalise(fromPipeline ? b : { ...b, discount: 0 });
  const reviseId = fromPipeline && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(String(b.reviseQuoteId || "")) ? String(b.reviseQuoteId) : "";

  // Resend: staff re-send the SAME quote (same ref, total and online link) by email + SMS. Nothing about the quote changes.
  if (fromPipeline && b.resendLeadId) return resendQuote(req, res, String(b.resendLeadId), agentName, apiKey);

  if (!isValidEmail(customerEmail)) return res.status(400).json({ error: "A valid customer email address is required" });
  if (customerPhone && !/^\+[1-9]\d{7,14}$/.test(customerPhone)) return res.status(400).json({error:'Enter a valid customer mobile number.'});
  if (serviceMode === "install" && alarmQty < 1) return res.status(400).json({ error: "Alarm quantity must be at least 1 for an installation quote" });

  const now = new Date();
  const validUntilDate = new Date(now.getTime() + Q.QUOTE_VALID_DAYS * 864e5);
  let ref, existing = null;
  try {
    if (reviseId) {
      // Revising: keep the same quote (number, row and online link) and update it in place.
      existing = (await SB.sb(`sent_emails?id=eq.${reviseId}&kind=eq.quote&status=eq.sent&select=id,lead_id,quote_ref,quote_total,body_html&limit=1`))?.[0];
      if (!existing || !existing.quote_ref) return res.status(404).json({ error: "The quote to update was not found" });
      ref = existing.quote_ref;
    } else {
      ref = await nextQuoteReference();
    }
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || "Could not allocate a quote number" });
  }

  if (existing && existing.lead_id) hintLeadId = existing.lead_id;

  let calloutFee = Fee.CURRENT_CENTS / 100;
  let calloutIncluded = false;
  try {
    if (existing) {
      const saved = QP.quoteOptions(existing);
      calloutFee = saved.calloutFee;
      calloutIncluded = saved.calloutIncluded;
    } else {
      const byId = hintLeadId ? (await SB.sb(`leads?id=eq.${encodeURIComponent(hintLeadId)}&select=id,created_at&limit=1`))?.[0] : null;
      const byEmail = byId ? null : (await SB.sb(`leads?email=eq.${encodeURIComponent(customerEmail.toLowerCase())}&select=id,created_at&order=updated_at.desc&limit=1`))?.[0];
      if (byId || byEmail) calloutFee = Fee.centsForLead(byId || byEmail) / 100;
    }
  } catch (error) { return res.status(500).json({ error: `Could not verify the customer's call-out fee: ${error.message}` }); }

  // Show the property address on the quote when the lead has one saved.
  let address = "";
  if (hintLeadId && SB.configured()) {
    try {
      const l = (await SB.sb(`leads?id=eq.${encodeURIComponent(hintLeadId)}&select=address_line1,address_suburb,address_state,address_postcode&limit=1`))?.[0];
      if (l && l.address_line1) address = [l.address_line1, [l.address_suburb, l.address_state, l.address_postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    } catch (_) { /* address is optional */ }
  }

  const rendered = Q.renderQuoteEmail({
    address, customerName, agentName, customerEmail, serviceMode, alarmQty, controllerQty, discount, calloutFee, calloutIncluded, revised: Boolean(existing),
    ref, issueDate: Q.fmtDate(now), validUntil: Q.fmtDate(validUntilDate),
  });

  const { Resend } = require("resend");
  const resend = new Resend(apiKey);
  const notify = process.env.NOTIFY_EMAIL || Q.SUPPORT_EMAIL;

  const subject = `Your ${existing ? "Updated " : ""}Smoke Alarm Compliance Quotation (${ref}) - PowerSmart`;

  try {
    const { data, error } = await resend.emails.send({
      from: S.fromHeader(sender.key),
      to: customerEmail,
      replyTo: process.env.RESEND_REPLY_TO || Q.SUPPORT_EMAIL,
      bcc: notify,
      subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (error) {
      if (!existing) await logEmail({ kind: "quote", sender: sender.key, agent: agentName, to_email: customerEmail, to_name: customerName, subject, body_html: rendered.html, body_text: rendered.text, quote_ref: ref, quote_total: rendered.quote.total, status: "failed", error: error.message });
      return res.status(502).json({ error: error.message || "Email provider rejected the request" });
    }
    let leadId, emailId, saved;
    if (existing) {
      emailId = existing.id; leadId = existing.lead_id || null;
      try {
        await SB.sb(`sent_emails?id=eq.${emailId}&kind=eq.quote`, { method: "PATCH", body: { subject, body_html: rendered.html, body_text: rendered.text, quote_total: rendered.quote.total, provider_id: data && data.id, agent: agentName || null }, prefer: "return=minimal" });
        saved = true;
      } catch (e) { console.error("send-quote → quote update failed:", e.message); saved = false; }
      await recordRevision({ leadId, agentName, ref, total: rendered.quote.total, discount: rendered.quote.discount });
    } else {
      leadId = await recordInPipeline({ customerName, customerEmail, customerPhone, agentName, ref, total: rendered.quote.total, leadId: hintLeadId });
      emailId = randomUUID();
      saved = await logEmail({ id:emailId, kind: "quote", sender: sender.key, agent: agentName, to_email: customerEmail, to_name: customerName, subject, body_html: rendered.html, body_text: rendered.text, quote_ref: ref, quote_total: rendered.quote.total, lead_id: leadId, provider_id: data && data.id, status: "sent" });
    }
    const quoteUrl = `${Q.QUOTE_SITE}/quote?token=${emailId}`;
    let sms = {status:'skipped',error:'SMS requires staff portal access.'};
    if (fromPipeline) {
      try {
        if(!saved)throw new Error('Quote email was sent, but its online copy could not be saved. No SMS link was sent.');
        if(!leadId)throw new Error('Quote email was sent, but the customer record could not be saved.');
        const leads = await SB.sb(`leads?id=eq.${encodeURIComponent(leadId)}&select=id,name,phone&limit=1`),lead=leads?.[0];
        const first=String(lead?.name || customerName || 'there').trim().split(/\s+/)[0];
        const message=`Hi ${first}, your ${existing ? 'updated ' : ''}PowerSmart smoke alarm quote ${ref} is ready. We've also emailed it to you, so please check your spam or junk folder just in case. View your quote here: ${quoteUrl} Call 0401 991 420 with any questions.`;
        sms=await Sms.sendLeadSms({lead,message,key:existing ? `quote-${emailId}-rev-${Date.now()}` : `quote-${emailId}`,author:agentName});
      } catch(e) {
        sms={status:'failed',error:e.message};
        try {await Sms.logNote(leadId,agentName,`Quote ${ref} SMS issue: ${e.message}`);} catch(_) {}
      }
    }
    return res.status(200).json({ ok: true, id: data && data.id, ref, total: rendered.quote.total, quote_url:saved ? quoteUrl : null, sms });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) || "Unexpected error sending email" });
  }
};
