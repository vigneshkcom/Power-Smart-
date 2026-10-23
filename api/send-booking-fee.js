// POST /api/send-booking-fee. Creates a per-lead Stripe Checkout Session and emails it.
const Stripe = require("./_stripe");
const SB = require("./_supabase");
const { Resend } = require("resend");

const PORTAL_KEY = "2026";
const FEE_CENTS = 3500;
const SITE = "https://smokealarms.powersmartco.com.au";

function clean(value, max) { return String(value == null ? "" : value).slice(0, max).trim(); }

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  if ((req.headers["x-portal-key"] || "") !== PORTAL_KEY) return res.status(401).json({ error: "Invalid portal key" });
  if (!Stripe.configured()) return res.status(500).json({ error: "Stripe is not configured" });
  if (!SB.configured()) return res.status(500).json({ error: "Pipeline storage is not configured" });
  const checkoutOnly = req.body?.action === "checkout";
  if (!checkoutOnly && !process.env.RESEND_API_KEY) return res.status(500).json({ error: "Email service is not configured" });

  const leadId = clean((req.body || {}).lead_id, 40);
  if (!leadId) return res.status(400).json({ error: "lead_id is required" });
  try {
    const rows = await SB.sb(`leads?id=eq.${encodeURIComponent(leadId)}&select=id,name,email,quote_ref&limit=1`);
    const lead = rows && rows[0];
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!checkoutOnly && !lead.email) return res.status(400).json({ error: "Add an email address before sending a booking fee" });

    const payments = await SB.sb(`payment_requests?lead_id=eq.${encodeURIComponent(lead.id)}&order=created_at.desc&select=status,stripe_session_id&limit=100`);
    if ((payments || []).some(payment => payment.status === "paid")) return res.status(409).json({ error: "This customer's booking fee has already been paid." });
    if (checkoutOnly && payments && payments[0]?.stripe_session_id) {
      const existing = await Stripe.request(`/checkout/sessions/${encodeURIComponent(payments[0].stripe_session_id)}`);
      if (existing.payment_status === "paid") return res.status(409).json({ error: "This booking fee has already been paid. Payment confirmation is updating." });
      if (existing.status === "open" && existing.url) return res.status(200).json({ ok: true, amount: 35, checkout_url: existing.url });
    }

    const session = await Stripe.request("/checkout/sessions", {
      mode: "payment",
      ...(lead.email ? { customer_email: lead.email } : {}),
      "payment_method_types[0]": "card",
      success_url: `${SITE}/payment-complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE}/payment-cancelled`,
      "line_items[0][price_data][currency]": "aud",
      "line_items[0][price_data][product_data][name]": "PowerSmart booking fee",
      "line_items[0][price_data][product_data][description]": "Booking fee including GST",
      "line_items[0][price_data][unit_amount]": String(FEE_CENTS),
      "line_items[0][quantity]": "1",
      "metadata[lead_id]": lead.id,
      "metadata[quote_ref]": lead.quote_ref || "",
      "metadata[payment_type]": "booking_fee",
      "payment_intent_data[metadata][lead_id]": lead.id,
      "payment_intent_data[metadata][payment_type]": "booking_fee",
    });

    await SB.sb("payment_requests", { method: "POST", body: {
      lead_id: lead.id, quote_ref: lead.quote_ref || null, customer_email: lead.email || "",
      amount_cents: FEE_CENTS, currency: "aud", status: "sent", stripe_session_id: session.id,
      checkout_url: session.url, sent_at: new Date().toISOString(),
    }});

    if (checkoutOnly) {
      await SB.sb("lead_comments", { method: "POST", body: { lead_id: lead.id, author: ["Mani", "Vignesh"].includes(req.body?.agent) ? req.body.agent : "System", kind: "payment", body: "Stripe checkout created for the $35.00 booking fee. Payment has not yet been confirmed." }, prefer: "return=minimal" });
      return res.status(200).json({ ok: true, amount: 35, checkout_url: session.url });
    }

    const firstName = clean(lead.name, 120).split(/\s+/)[0] || "there";
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0B1B1F"><h2>Secure your smoke alarm booking</h2><p>Hi ${firstName},</p><p>Please pay your <strong>$35.00 booking fee</strong> to secure your licensed electrician. This fee includes GST and is fully refundable if we cannot complete your installation.</p><p style="margin:28px 0"><a href="${session.url}" style="background:#43A8B6;color:#0B1B1F;padding:13px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Pay $35.00 booking fee</a></p><p>If you have any questions, reply to this email or call (07) 2141 7792.</p></div>`;
    const text = `Hi ${firstName},\n\nPlease pay your $35.00 booking fee, including GST, to secure your licensed electrician. This fee is fully refundable if we cannot complete your installation.\n\nPay securely: ${session.url}\n\nQuestions? Call (07) 2141 7792.`;
    const resend = new Resend(process.env.RESEND_API_KEY);
    const sent = await resend.emails.send({ from: process.env.RESEND_FROM_EMAIL || "PowerSmart <support@powersmartco.com.au>", to: lead.email, replyTo: process.env.RESEND_REPLY_TO || "support@powersmartco.com.au", subject: "Secure your PowerSmart booking", html, text });
    if (sent.error) throw new Error(sent.error.message || "Could not send payment email");
    await SB.sb("lead_comments", { method: "POST", body: { lead_id: lead.id, author: ["Mani", "Vignesh"].includes(req.body?.agent) ? req.body.agent : "System", kind: "payment", body: `Stripe booking fee request for $35.00 emailed to ${lead.email}.` }, prefer: "return=minimal" });
    return res.status(200).json({ ok: true, amount: 35, session_id: session.id, checkout_url: session.url });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message || "Could not send booking fee" }); }
};
