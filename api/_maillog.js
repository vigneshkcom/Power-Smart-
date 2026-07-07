// Best-effort logging of outbound emails into Supabase (sent_emails table).
// Never throws — logging must not break sending.

const SB = require("./_supabase");

async function logEmail(row) {
  if (!SB.configured()) return;
  try {
    await SB.sb("sent_emails", {
      method: "POST",
      body: {
        kind: row.kind || "email",
        sender: row.sender || "customer_service",
        agent: row.agent || null,
        to_email: (row.to_email || "").toLowerCase(),
        to_name: row.to_name || null,
        subject: row.subject || null,
        body_html: row.body_html || null,
        body_text: row.body_text || null,
        quote_ref: row.quote_ref || null,
        quote_total: row.quote_total != null ? row.quote_total : null,
        lead_id: row.lead_id || null,
        provider_id: row.provider_id || null,
        status: row.status || "sent",
        error: row.error || null,
      },
      prefer: "return=minimal",
    });
  } catch (e) {
    console.error("sent_emails log failed:", e.message);
  }
}

module.exports = { logEmail };
