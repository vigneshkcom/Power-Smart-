// Read-only quote tracker for the PowerSmart staff portal.

const { sb, configured } = require("./_supabase");

const PORTAL_KEY = "2026";
const STAGES = ["new_lead", "quote_accepted", "follow_up", "shopping", "quote_sent", "assigned", "won", "not_reachable", "out_of_area"];

function quantityFromText(text, pattern) {
  const match = String(text || "").match(pattern);
  return match ? Number(match[1]) || 0 : 0;
}

function publicStatus(email, lead, payment) {
  if (email.status === "failed") return "failed";
  if (payment && payment.status === "paid") return "paid";
  if (lead && lead.stage === "won") return "installed";
  if (lead && lead.stage === "quote_accepted") return "accepted";
  return "sent";
}

module.exports = async (req, res) => {
  if ((req.headers["x-portal-key"] || "") !== PORTAL_KEY) {
    return res.status(401).json({ error: "Invalid portal key" });
  }
  if (!configured()) return res.status(500).json({ error: "Supabase is not configured" });

  try {
    if (req.method === "POST") {
      const body = req.body || {};
      if (body.action === "update_stage") {
        const leadId = String(body.lead_id || "").slice(0, 40).trim();
        const stage = String(body.stage || "").trim();
        if (!leadId || !STAGES.includes(stage)) return res.status(400).json({ error: "A linked lead and valid pipeline status are required" });
        await sb(`leads?id=eq.${encodeURIComponent(leadId)}`, { method: "PATCH", body: { stage }, prefer: "return=minimal" });
        await sb("lead_comments", { method: "POST", body: { lead_id: leadId, author: "System", kind: "status", body: `Pipeline status changed to ${stage.replace(/_/g, " ")} from Quote Tracker.` }, prefer: "return=minimal" }).catch(() => {});
        return res.status(200).json({ ok: true, stage });
      }
      if (body.action === "delete") {
        const quoteId = String(body.quote_id || "").slice(0, 60).trim();
        if (!quoteId) return res.status(400).json({ error: "Quote id is required" });
        const rows = await sb(`sent_emails?id=eq.${encodeURIComponent(quoteId)}&kind=eq.quote&select=id,lead_id,quote_ref&limit=1`);
        const quote = rows && rows[0];
        if (!quote) return res.status(404).json({ error: "Quote not found" });
        await sb(`sent_emails?id=eq.${encodeURIComponent(quoteId)}&kind=eq.quote`, { method: "DELETE", prefer: "return=minimal" });
        if (quote.lead_id && quote.quote_ref) {
          const leads = await sb(`leads?id=eq.${encodeURIComponent(quote.lead_id)}&quote_ref=eq.${encodeURIComponent(quote.quote_ref)}&select=id&limit=1`);
          if (leads && leads[0]) await sb(`leads?id=eq.${encodeURIComponent(quote.lead_id)}`, { method: "PATCH", body: { quote_ref: null, quote_total: null }, prefer: "return=minimal" });
        }
        return res.status(200).json({ ok: true });
      }
      if (body.action === "content") {
        const quoteId = String(body.quote_id || "").slice(0, 60).trim();
        if (!quoteId) return res.status(400).json({ error: "Quote id is required" });
        const rows = await sb(`sent_emails?id=eq.${encodeURIComponent(quoteId)}&kind=eq.quote&select=body_html,body_text&limit=1`);
        if (!rows || !rows[0]) return res.status(404).json({ error: "Quote not found" });
        return res.status(200).json({ body_html: rows[0].body_html || "", body_text: rows[0].body_text || "" });
      }
      return res.status(400).json({ error: "Unknown quote action" });
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const emails = await sb("sent_emails?select=id,created_at,status,error,agent,to_email,to_name,subject,body_text,quote_ref,quote_total,lead_id,provider_id&kind=eq.quote&order=created_at.desc&limit=5000");
    const leads = await sb("leads?select=id,name,phone,email,postcode,address_line1,address_suburb,address_state,address_postcode,source,stage,quote_ref,quote_total,agent,payment_preference&limit=5000");
    const leadById = {};
    (leads || []).forEach((lead) => { leadById[lead.id] = lead; });

    const paymentByLead = {};
    try {
      const payments = await sb("payment_requests?payment_type=eq.booking_fee&select=lead_id,status,amount_cents,amount_paid_cents,sent_at,paid_at&order=created_at.desc&limit=10000");
      (payments || []).forEach((payment) => {
        if (!paymentByLead[payment.lead_id]) paymentByLead[payment.lead_id] = payment;
      });
    } catch (_) { /* payment tracking is optional until its migration is run */ }

    const quotes = (emails || []).map((email) => {
      const lead = email.lead_id ? leadById[email.lead_id] || null : null;
      const payment = lead ? paymentByLead[lead.id] || null : null;
      const text = email.body_text || "";
      const service = /compliance inspection/i.test(text) ? "Inspection" : "Installation";
      const phonePayment = Boolean(lead && lead.payment_preference === "phone" && !payment);
      const alarmQty = quantityFromText(text, /smoke alarms[^\n]*\((\d+)\s*x\s*\$/i);
      const controllerQty = quantityFromText(text, /remote controller[^\n]*\((\d+)\s*x\s*\$/i);
      return {
        id: email.id,
        created_at: email.created_at,
        ref: email.quote_ref || "",
        total: Number(email.quote_total || 0),
        customer_name: email.to_name || (lead && lead.name) || "",
        customer_email: email.to_email || (lead && lead.email) || "",
        customer_phone: (lead && lead.phone) || "",
        postcode: (lead && lead.postcode) || "",
        address_line1: (lead && lead.address_line1) || "",
        address_suburb: (lead && lead.address_suburb) || "",
        address_state: (lead && lead.address_state) || "",
        address_postcode: (lead && lead.address_postcode) || "",
        source: (lead && lead.source) || "",
        agent: email.agent || (lead && lead.agent) || "Customer Service",
        service,
        alarm_qty: alarmQty,
        controller_qty: controllerQty,
        email_status: email.status || "sent",
        status: publicStatus(email, lead, payment),
        lead_stage: (lead && lead.stage) || "",
        lead_id: (lead && lead.id) || null,
        payment_status: payment ? payment.status : phonePayment ? "phone" : "",
        payment_amount: payment ? Number((payment.status === "paid" ? payment.amount_paid_cents : payment.amount_cents) || 0) / 100 : phonePayment ? (service === "Inspection" ? 120 : 35) : 0,
        payment_date: payment ? payment.paid_at || payment.sent_at || null : null,
        subject: email.subject || "",
        body_text: text,
        error: email.error || "",
      };
    });

    return res.status(200).json({ quotes });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || "Could not load quote tracker" });
  }
};
