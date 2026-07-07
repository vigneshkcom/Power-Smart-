// POST /api/accept-quote — a customer accepted their quotation.
// Emails PowerSmart a notification and returns the Stripe payment URL.
//
// Env vars: RESEND_API_KEY (required), NOTIFY_EMAIL (optional, default support),
//           RESEND_FROM_EMAIL / RESEND_REPLY_TO (optional).

const Q = require("./_quote");
const SB = require("./_supabase");

async function logAcceptance({ ref, customerName, customerEmail, payableToday }) {
  if (!SB.configured()) return;
  try {
    let lead = null;
    if (ref) {
      const byRef = await SB.sb(`leads?quote_ref=eq.${encodeURIComponent(ref)}&select=id&limit=1`);
      lead = byRef && byRef[0];
    }
    if (!lead && customerEmail) {
      const byEmail = await SB.sb(`leads?email=eq.${encodeURIComponent(customerEmail.toLowerCase())}&select=id&order=updated_at.desc&limit=1`);
      lead = byEmail && byEmail[0];
    }
    if (lead) {
      await SB.sb("lead_comments", {
        method: "POST",
        body: { lead_id: lead.id, author: "System", body: `✅ ${customerName || "Customer"} ACCEPTED quote ${ref || ""} and was sent to Stripe for the ${Q.fmt(payableToday)} fee. Confirm payment, then book them in.` },
        prefer: "return=minimal",
      });
    }
  } catch (e) { console.error("accept-quote → pipeline comment failed:", e.message); }
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
  const { serviceMode, alarmQty, controllerQty } = Q.normalise(b);
  const q = Q.buildQuote({ serviceMode, alarmQty, controllerQty });

  // Always hand back the Stripe link so the customer can pay even if the
  // notification email fails for any reason.
  const stripeUrl = Q.STRIPE_LINK;

  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    const rows = q.lines.map((l) =>
      `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;">${Q.escapeHtml(l.label)}</td><td align="center" style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;">${l.qty}</td><td align="right" style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;">${Q.fmt(l.amount)}</td></tr>`
    ).join("");

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0B1B1F;">
        <div style="background:#0B1B1F;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;">
          <strong style="font-size:16px;">✅ Quote accepted — ${Q.escapeHtml(ref || "no ref")}</strong>
        </div>
        <div style="border:1px solid #eee;border-top:none;padding:20px;border-radius:0 0 10px 10px;">
          <p style="margin:0 0 12px;font-size:14px;"><strong>${Q.escapeHtml(customerName || "A customer")}</strong> has accepted their ${serviceMode === "inspect" ? "inspection" : "installation"} quote and been sent to Stripe to pay the ${Q.fmt(q.payableToday)} ${serviceMode === "inspect" ? "inspection" : "booking"} fee.</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:14px;">
            <tr><td style="padding:4px 10px;color:#6B8288;">Customer</td><td style="padding:4px 10px;"><strong>${Q.escapeHtml(customerName || "—")}</strong></td></tr>
            <tr><td style="padding:4px 10px;color:#6B8288;">Email</td><td style="padding:4px 10px;">${Q.escapeHtml(customerEmail || "—")}</td></tr>
            <tr><td style="padding:4px 10px;color:#6B8288;">Quote ref</td><td style="padding:4px 10px;">${Q.escapeHtml(ref || "—")}</td></tr>
            ${agentName ? `<tr><td style="padding:4px 10px;color:#6B8288;">Prepared by</td><td style="padding:4px 10px;">${Q.escapeHtml(agentName)}</td></tr>` : ""}
          </table>
          <table style="width:100%;border-collapse:collapse;">${rows}
            <tr><td style="padding:8px 10px;font-weight:bold;">Total (incl. GST)</td><td></td><td align="right" style="padding:8px 10px;font-weight:bold;">${Q.fmt(q.total)}</td></tr>
          </table>
          <p style="margin:14px 0 0;font-size:12px;color:#6B8288;">Confirm payment in Stripe, then book the installation and follow up with the customer.</p>
        </div>
      </div>`;

    const text = `Quote accepted — ${ref || "no ref"}\n\n${customerName || "A customer"} accepted their ${serviceMode} quote and was sent to Stripe for the ${Q.fmt(q.payableToday)} fee.\n\nCustomer: ${customerName || "—"}\nEmail: ${customerEmail || "—"}\nRef: ${ref || "—"}\n${agentName ? "Prepared by: " + agentName + "\n" : ""}\n${q.lines.map((l) => `- ${l.label} (${l.qty}): ${Q.fmt(l.amount)}`).join("\n")}\nTotal (incl. GST): ${Q.fmt(q.total)}`;

    try {
      const { Resend } = require("resend");
      const resend = new Resend(apiKey);
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || `PowerSmart <${Q.SUPPORT_EMAIL}>`,
        to: process.env.NOTIFY_EMAIL || Q.SUPPORT_EMAIL,
        replyTo: customerEmail || (process.env.RESEND_REPLY_TO || Q.SUPPORT_EMAIL),
        subject: `✅ Quote accepted — ${customerName || "customer"} (${ref || "no ref"})`,
        html,
        text,
      });
    } catch (err) {
      // Don't block the customer's payment on our notification failing.
      console.error("accept-quote notify failed:", err && err.message);
    }
  }

  await logAcceptance({ ref, customerName, customerEmail, payableToday: q.payableToday });

  return res.status(200).json({ ok: true, stripeUrl });
};
