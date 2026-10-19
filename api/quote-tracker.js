// Read-only quote tracker for the PowerSmart staff portal.

const { sb, configured } = require("./_supabase");

const PORTAL_KEY = "2026";

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
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!configured()) return res.status(500).json({ error: "Supabase is not configured" });

  try {
    const emails = await sb("sent_emails?select=id,created_at,status,error,agent,to_email,to_name,subject,body_text,quote_ref,quote_total,lead_id,provider_id&kind=eq.quote&order=created_at.desc&limit=5000");
    const leads = await sb("leads?select=id,name,phone,email,postcode,source,stage,quote_ref,quote_total,agent&limit=5000");
    const leadById = {};
    (leads || []).forEach((lead) => { leadById[lead.id] = lead; });

    const paymentByLead = {};
    try {
      const payments = await sb("payment_requests?select=lead_id,status,amount_cents,amount_paid_cents,sent_at,paid_at&order=created_at.desc&limit=10000");
      (payments || []).forEach((payment) => {
        if (!paymentByLead[payment.lead_id]) paymentByLead[payment.lead_id] = payment;
      });
    } catch (_) { /* payment tracking is optional until its migration is run */ }

    const quotes = (emails || []).map((email) => {
      const lead = email.lead_id ? leadById[email.lead_id] || null : null;
      const payment = lead ? paymentByLead[lead.id] || null : null;
      const text = email.body_text || "";
      const service = /compliance inspection/i.test(text) ? "Inspection" : "Installation";
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
        source: (lead && lead.source) || "",
        agent: email.agent || (lead && lead.agent) || "Customer Service",
        service,
        alarm_qty: alarmQty,
        controller_qty: controllerQty,
        email_status: email.status || "sent",
        status: publicStatus(email, lead, payment),
        lead_stage: (lead && lead.stage) || "",
        lead_id: (lead && lead.id) || null,
        payment_status: payment ? payment.status : "",
        payment_amount: payment ? Number((payment.status === "paid" ? payment.amount_paid_cents : payment.amount_cents) || 0) / 100 : 0,
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
