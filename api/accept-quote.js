// POST /api/accept-quote: a customer accepted their quotation.
// Emails PowerSmart a notification and either returns the Stripe payment URL
// or records that the customer requested a call to arrange payment.
//
// Env vars: RESEND_API_KEY (required), NOTIFY_EMAIL (optional, default support),
//           RESEND_FROM_EMAIL / RESEND_REPLY_TO (optional).

const Q = require("./_quote");
const SB = require("./_supabase");

async function logAcceptance({ ref, customerName, customerEmail, payableToday, paymentMethod, address }) {
  if (!SB.configured()) throw new Error("The customer record service is not configured");
  let lead = null;
  if (ref) {
    const byRef = await SB.sb(`leads?quote_ref=eq.${encodeURIComponent(ref)}&select=id&limit=1`);
    lead = byRef && byRef[0];
  }
  if (!lead && customerEmail) {
    const byEmail = await SB.sb(`leads?email=eq.${encodeURIComponent(customerEmail.toLowerCase())}&select=id&order=updated_at.desc&limit=1`);
    lead = byEmail && byEmail[0];
  }
  if (!lead) throw new Error("We could not find this quote. Please call (07) 2141 7792.");
  await SB.sb(`leads?id=eq.${encodeURIComponent(lead.id)}`, {
    method: "PATCH",
    body: {
      stage: "quote_accepted",
      payment_preference: paymentMethod,
      address_line1: address.line1,
      address_suburb: address.suburb,
      address_state: address.state,
      address_postcode: address.postcode,
      postcode: address.postcode,
    },
    prefer: "return=minimal",
  });
  try {
      await SB.sb("lead_comments", {
        method: "POST",
        body: { lead_id: lead.id, author: "System", body: paymentMethod === "phone"
          ? `${customerName || "Customer"} accepted quote ${ref || ""} for ${address.full} and requested a call to arrange the ${Q.fmt(payableToday)} fee. Call the customer, arrange payment, then book them in.`
          : `${customerName || "Customer"} accepted quote ${ref || ""} for ${address.full} and was sent to Stripe for the ${Q.fmt(payableToday)} fee. Confirm payment, then book them in.` },
        prefer: "return=minimal",
      });
  } catch (e) { console.error("accept-quote pipeline comment failed:", e.message); }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const b = req.body || {};
  const ref = String(b.ref || "").slice(0, 40).trim();
  const customerName = String(b.customerName || "").slice(0, 120).trim();
  const customerEmail = String(b.customerEmail || "").slice(0, 254).trim();
  const agentName = String(b.agentName || "").slice(0, 120).trim();
  const paymentMethod = b.paymentMethod === "phone" ? "phone" : "stripe";
  const address = {
    line1: String(b.addressLine1 || "").slice(0, 180).trim(),
    suburb: String(b.addressSuburb || "").slice(0, 100).trim(),
    state: String(b.addressState || "").slice(0, 20).trim().toUpperCase(),
    postcode: String(b.addressPostcode || "").slice(0, 12).trim(),
  };
  if (!address.line1 || !address.suburb || !address.state || !address.postcode) {
    return res.status(400).json({ error: "Please enter the complete installation address" });
  }
  address.full = `${address.line1}, ${address.suburb} ${address.state} ${address.postcode}`;
  const { serviceMode, alarmQty, controllerQty } = Q.normalise(b);
  const q = Q.buildQuote({ serviceMode, alarmQty, controllerQty });

  // Always hand back the Stripe link so the customer can pay even if the
  // notification email fails for any reason.
  const stripeUrl = Q.STRIPE_LINK;

  try {
    await logAcceptance({ ref, customerName, customerEmail, payableToday: q.payableToday, paymentMethod, address });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not save the accepted quote" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    const rows = q.lines.map((l) =>
      `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;">${Q.escapeHtml(l.label)}</td><td align="center" style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;">${l.qty}</td><td align="right" style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;">${Q.fmt(l.amount)}</td></tr>`
    ).join("");

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0B1B1F;">
        <div style="background:#0B1B1F;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;">
          <strong style="font-size:16px;">Quote accepted - ${Q.escapeHtml(ref || "no ref")}</strong>
        </div>
        <div style="border:1px solid #eee;border-top:none;padding:20px;border-radius:0 0 10px 10px;">
          <p style="margin:0 0 12px;font-size:14px;"><strong>${Q.escapeHtml(customerName || "A customer")}</strong> has accepted their ${serviceMode === "inspect" ? "inspection" : "installation"} quote${paymentMethod === "phone" ? ` and requested a call to arrange the ${Q.fmt(q.payableToday)} ${serviceMode === "inspect" ? "inspection" : "booking"} fee.` : ` and been sent to Stripe to pay the ${Q.fmt(q.payableToday)} ${serviceMode === "inspect" ? "inspection" : "booking"} fee.`}</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:14px;">
            <tr><td style="padding:4px 10px;color:#6B8288;">Customer</td><td style="padding:4px 10px;"><strong>${Q.escapeHtml(customerName || "Not provided")}</strong></td></tr>
            <tr><td style="padding:4px 10px;color:#6B8288;">Email</td><td style="padding:4px 10px;">${Q.escapeHtml(customerEmail || "Not provided")}</td></tr>
            <tr><td style="padding:4px 10px;color:#6B8288;">Installation address</td><td style="padding:4px 10px;"><strong>${Q.escapeHtml(address.full)}</strong></td></tr>
            <tr><td style="padding:4px 10px;color:#6B8288;">Quote ref</td><td style="padding:4px 10px;">${Q.escapeHtml(ref || "Not provided")}</td></tr>
            ${agentName ? `<tr><td style="padding:4px 10px;color:#6B8288;">Prepared by</td><td style="padding:4px 10px;">${Q.escapeHtml(agentName)}</td></tr>` : ""}
          </table>
          <table style="width:100%;border-collapse:collapse;">${rows}
            <tr><td style="padding:8px 10px;font-weight:bold;">Total (incl. GST)</td><td></td><td align="right" style="padding:8px 10px;font-weight:bold;">${Q.fmt(q.total)}</td></tr>
          </table>
          <p style="margin:14px 0 0;font-size:12px;color:#6B8288;">${paymentMethod === "phone" ? "Call the customer to arrange payment, then book the installation." : "Confirm payment in Stripe, then book the installation and follow up with the customer."}</p>
        </div>
      </div>`;

    const paymentText = paymentMethod === "phone"
      ? `requested a call to arrange the ${Q.fmt(q.payableToday)} fee`
      : `was sent to Stripe for the ${Q.fmt(q.payableToday)} fee`;
    const text = `Quote accepted - ${ref || "no ref"}\n\n${customerName || "A customer"} accepted their ${serviceMode} quote and ${paymentText}.\n\nCustomer: ${customerName || "Not provided"}\nEmail: ${customerEmail || "Not provided"}\nInstallation address: ${address.full}\nRef: ${ref || "Not provided"}\nPayment method: ${paymentMethod === "phone" ? "Call requested" : "Stripe"}\n${agentName ? "Prepared by: " + agentName + "\n" : ""}\n${q.lines.map((l) => `- ${l.label} (${l.qty}): ${Q.fmt(l.amount)}`).join("\n")}\nTotal (incl. GST): ${Q.fmt(q.total)}`;

    try {
      const { Resend } = require("resend");
      const resend = new Resend(apiKey);
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || `PowerSmart <${Q.SUPPORT_EMAIL}>`,
        to: process.env.NOTIFY_EMAIL || Q.SUPPORT_EMAIL,
        replyTo: customerEmail || (process.env.RESEND_REPLY_TO || Q.SUPPORT_EMAIL),
        subject: `${paymentMethod === "phone" ? "Quote accepted, call requested" : "Quote accepted"} - ${customerName || "customer"} (${ref || "no ref"})`,
        html,
        text,
      });
    } catch (err) {
      // Don't block the customer's payment on our notification failing.
      console.error("accept-quote notify failed:", err && err.message);
    }
  }

  return res.status(200).json({ ok: true, paymentMethod, stripeUrl: paymentMethod === "stripe" ? stripeUrl : null });
};
