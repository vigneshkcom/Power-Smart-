// Stripe webhook. The raw request body is required for signature verification.
const Stripe = require("./_stripe");
const SB = require("./_supabase");
const Payments = require("./_payments");

async function rawBody(req) { const parts = []; for await (const chunk of req) parts.push(chunk); return Buffer.concat(parts); }

async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).send("Method not allowed"); }
  const raw = await rawBody(req);
  if (!Stripe.verifySignature(raw.toString("utf8"), req.headers["stripe-signature"])) return res.status(400).send("Invalid Stripe signature");
  let event; try { event = JSON.parse(raw.toString("utf8")); } catch (_) { return res.status(400).send("Invalid body"); }
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.expired"].includes(event.type)) return res.status(200).json({ received: true });
  const session = event.data.object;
  // On-site job payments from the electrician app (api/_tech.js).
  if (session.metadata && session.metadata.job_id) {
    try { await require("./_tech").reconcileJobPayment(session); }
    catch (error) { console.error("Stripe webhook job payment failed:", error.message); return res.status(500).send("Could not record payment"); }
    return res.status(200).json({ received: true });
  }
  const leadId = session.metadata && session.metadata.lead_id;
  if (!leadId) return res.status(200).json({ received: true });
  try {
    const payment = await SB.sb(`payment_requests?stripe_session_id=eq.${encodeURIComponent(session.id)}&select=*&limit=1`);
    if (payment && payment[0]) await Payments.reconcile(payment[0], session, event.id);
    else if (session.metadata?.payment_type) return res.status(500).send("Payment request is not recorded yet; retry delivery");
  } catch (error) { console.error("Stripe webhook update failed:", error.message); return res.status(500).send("Could not record payment"); }
  return res.status(200).json({ received: true });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
