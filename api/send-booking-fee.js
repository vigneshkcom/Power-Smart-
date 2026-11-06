// POST /api/send-booking-fee. Creates a per-lead Stripe Checkout Session and emails it.
const Stripe = require("./_stripe");
const SB = require("./_supabase");
const QP = require('./_quote-payments');
const crypto = require('crypto');
const { Resend } = require("resend");
const Fee = require('./_callout-fee');

const PORTAL_KEY = "2026";
const SITE = "https://smokealarms.powersmartco.com.au";

function clean(value, max) { return String(value == null ? "" : value).slice(0, max).trim(); }

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  if ((req.headers["x-portal-key"] || "") !== PORTAL_KEY) return res.status(401).json({ error: "Invalid portal key" });
  if (!Stripe.configured()) return res.status(500).json({ error: "Stripe is not configured" });
  if (!SB.configured()) return res.status(500).json({ error: "Pipeline storage is not configured" });
  const agent = clean(req.body?.agent, 120).replace(/^Vignesh$/i, "Sunny");
  const checkoutOnly = req.body?.action === "checkout";
  if (!checkoutOnly && !process.env.RESEND_API_KEY) return res.status(500).json({ error: "Email service is not configured" });

  const leadId = clean((req.body || {}).lead_id, 40);
  if (!leadId) return res.status(400).json({ error: "lead_id is required" });
  try {
    const rows = await SB.sb(`leads?id=eq.${encodeURIComponent(leadId)}&select=id,name,email,quote_ref,created_at&limit=1`);
    const lead = rows && rows[0];
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!checkoutOnly && !lead.email) return res.status(400).json({ error: "Add an email address before sending an electrician call-out fee" });

    const payments = await QP.refreshPending(await SB.sb(`payment_requests?lead_id=eq.${encodeURIComponent(lead.id)}&payment_type=eq.booking_fee&order=created_at.desc&select=*&limit=100`));
    if ((payments || []).some(payment => payment.status === "paid")) return res.status(409).json({ error: "This customer's electrician call-out fee has already been paid." });
    let pending = payments.find(payment => payment.status === 'sent');
    let issued = null;
    if (lead.quote_ref) {
      const quote = (await SB.sb(`sent_emails?lead_id=eq.${encodeURIComponent(lead.id)}&quote_ref=eq.${encodeURIComponent(lead.quote_ref)}&kind=eq.quote&status=eq.sent&select=body_html,quote_total&order=created_at.desc&limit=1`))?.[0];
      if (quote) issued = QP.quoteOptions(quote);
    }
    const feeCents = pending ? pending.amount_cents : issued && issued.serviceMode === 'install' ? Math.round(issued.calculation.payableToday * 100) : Fee.centsForLead(lead);
    const feeDisplay = `$${(feeCents / 100).toFixed(2)}`;
    const includedDeposit = pending ? /^Deposit toward/i.test(pending.description || '') : Boolean(issued?.calloutIncluded);
    const newDeposit = feeCents === 5000 && !includedDeposit;
    if (pending && newDeposit && !/\(upfront payment\)$/.test(pending.description || '')) {
      const oldSession = await Stripe.request(`/checkout/sessions/${encodeURIComponent(pending.stripe_session_id)}`);
      if (oldSession.payment_status === 'paid') return res.status(409).json({ error: 'This customer has already paid the deposit.' });
      if (oldSession.status === 'open') await Stripe.request(`/checkout/sessions/${encodeURIComponent(pending.stripe_session_id)}/expire`, {});
      await SB.sb(`payment_requests?id=eq.${encodeURIComponent(pending.id)}&status=eq.sent`, { method: 'PATCH', body: { status: 'expired' }, prefer: 'return=minimal' });
      pending = null;
    }
    const feeLabel = feeCents === 5000 ? 'deposit' : 'electrician call-out fee';
    const requestKey = crypto.createHash('sha256').update(`${lead.id}:${payments[0]?.stripe_session_id || 'initial'}`).digest('hex');

    const session = pending ? { id: pending.stripe_session_id, url: pending.checkout_url } : await Stripe.request("/checkout/sessions", {
      mode: "payment",
      ...(lead.email ? { customer_email: lead.email } : {}),
      "payment_method_types[0]": "card",
      success_url: `${SITE}/api/customer-link?kind=confirmation&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE}/payment-cancelled`,
      "line_items[0][price_data][currency]": "aud",
      "line_items[0][price_data][product_data][name]": feeCents === 5000 ? "PowerSmart smoke alarm deposit" : "PowerSmart electrician call-out fee",
      "line_items[0][price_data][product_data][description]": includedDeposit ? "Deposit credited against your smoke alarm quote, including GST" : newDeposit ? "Deposit covering the electrician call-out fee shown on your quote, including GST" : "Electrician call-out fee including GST",
      "line_items[0][price_data][unit_amount]": String(feeCents),
      "line_items[0][quantity]": "1",
      "metadata[lead_id]": lead.id,
      "metadata[quote_ref]": lead.quote_ref || "",
      "metadata[payment_type]": "booking_fee",
      "payment_intent_data[metadata][lead_id]": lead.id,
      "payment_intent_data[metadata][payment_type]": "booking_fee",
    }, { idempotencyKey: `powersmart-booking-${requestKey}` });

    if (!pending) await SB.sb("payment_requests?on_conflict=stripe_session_id", { method: "POST", body: {
      lead_id: lead.id, quote_ref: lead.quote_ref || null, customer_email: lead.email || "",
      payment_type: 'booking_fee', description: includedDeposit ? 'Deposit toward smoke alarm quote' : newDeposit ? 'Electrician call-out fee (upfront payment)' : 'Electrician call-out fee', request_key: requestKey,
      amount_cents: feeCents, currency: "aud", status: "sent", stripe_session_id: session.id,
      checkout_url: session.url, sent_at: new Date().toISOString(),
    }, prefer: 'resolution=ignore-duplicates,return=minimal' });

    if (checkoutOnly) {
      await SB.sb("lead_comments", { method: "POST", body: { lead_id: lead.id, author: ["Sam", "Sunny"].includes(agent) ? agent : "System", kind: "payment", body: `Stripe checkout created for the ${feeDisplay} ${feeLabel}. Payment has not yet been confirmed.` }, prefer: "return=minimal" });
      return res.status(200).json({ ok: true, amount: feeCents / 100, checkout_url: session.url });
    }

    const firstName = clean(lead.name, 120).split(/\s+/)[0] || "there";
    const explanation = includedDeposit ? 'This deposit is part of your previously issued quote total and comes off the balance payable on installation day.' : newDeposit ? 'This deposit covers the electrician call-out fee shown as an additional line on your quote; the alarm and controller balance is payable on installation day.' : 'This fee is an additional line on your quote; the alarm and controller balance is payable on installation day.';
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0B1B1F"><h2>Secure your smoke alarm appointment</h2><p>Hi ${firstName},</p><p>Please pay your <strong>${feeDisplay} ${feeLabel}</strong> to secure your licensed electrician. ${explanation} It includes GST and is fully refundable if we cannot complete your installation.</p><p style="margin:28px 0"><a href="${session.url}" style="background:#43A8B6;color:#0B1B1F;padding:13px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Pay ${feeDisplay} ${feeLabel}</a></p><p>If you have any questions, reply to this email or call 0401 991 420.</p></div>`;
    const text = `Hi ${firstName},\n\nPlease pay your ${feeDisplay} ${feeLabel}, including GST, to secure your licensed electrician. ${explanation} It is fully refundable if we cannot complete your installation.\n\nPay securely: ${session.url}\n\nQuestions? Call 0401 991 420.`;
    const resend = new Resend(process.env.RESEND_API_KEY);
    const sent = await resend.emails.send({ from: process.env.RESEND_FROM_EMAIL || "PowerSmart <support@powersmartco.com.au>", to: lead.email, replyTo: process.env.RESEND_REPLY_TO || "support@powersmartco.com.au", subject: "Secure your PowerSmart appointment", html, text });
    if (sent.error) throw new Error(sent.error.message || "Could not send payment email");
    await SB.sb("lead_comments", { method: "POST", body: { lead_id: lead.id, author: ["Sam", "Sunny"].includes(agent) ? agent : "System", kind: "payment", body: `Stripe ${feeLabel} request for ${feeDisplay} emailed to ${lead.email}.` }, prefer: "return=minimal" });
    return res.status(200).json({ ok: true, amount: feeCents / 100, session_id: session.id, checkout_url: session.url });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message || "Could not send electrician call-out fee" }); }
};
