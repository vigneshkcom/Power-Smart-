// Stripe webhook. The raw request body is required for signature verification.
const Stripe = require("./_stripe");
const SB = require("./_supabase");

async function rawBody(req) { const parts = []; for await (const chunk of req) parts.push(chunk); return Buffer.concat(parts); }

async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).send("Method not allowed"); }
  const raw = await rawBody(req);
  if (!Stripe.verifySignature(raw.toString("utf8"), req.headers["stripe-signature"])) return res.status(400).send("Invalid Stripe signature");
  let event; try { event = JSON.parse(raw.toString("utf8")); } catch (_) { return res.status(400).send("Invalid body"); }
  if (event.type !== "checkout.session.completed" || event.data.object.payment_status !== "paid") return res.status(200).json({ received: true });
  const session = event.data.object;
  const leadId = session.metadata && session.metadata.lead_id;
  if (!leadId) return res.status(200).json({ received: true });
  try {
    const payment = await SB.sb(`payment_requests?stripe_session_id=eq.${encodeURIComponent(session.id)}&select=id,lead_id,status&limit=1`);
    if (payment && payment[0] && payment[0].status !== "paid") {
      const amount = Number(session.amount_total || 0) / 100;
      await SB.sb(`payment_requests?id=eq.${encodeURIComponent(payment[0].id)}`, { method: "PATCH", body: { status: "paid", amount_paid_cents: session.amount_total, stripe_payment_intent_id: session.payment_intent || null, stripe_event_id: event.id, paid_at: new Date().toISOString() }, prefer: "return=minimal" });
      await SB.sb("lead_comments", { method: "POST", body: { lead_id: leadId, author: "Stripe", kind: "payment", body: `Booking fee paid: $${amount.toFixed(2)}.` }, prefer: "return=minimal" });
    }
  } catch (error) { console.error("Stripe webhook update failed:", error.message); return res.status(500).send("Could not record payment"); }
  return res.status(200).json({ received: true });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
