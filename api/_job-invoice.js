// Invoice email sent when an electrician completes a job (api/_tech.js).
// Paid in full -> "Tax invoice (paid)". Not paid in full -> "Invoice - amount owing".
const Q = require("./_quote");
const S = require("./_senders");
const SB = require("./_supabase");
const { logEmail } = require("./_maillog");
const { randomUUID } = require("crypto");

const esc = Q.escapeHtml, fmt = (cents) => Q.fmt(cents / 100);
const METHOD = { card: "card", bank_transfer: "bank transfer", cash: "cash" };

function renderInvoice({ name, jobNo, items, total, credits, due, paid, method, address, date }) {
  const first = String(name || "there").trim().split(/\s+/)[0] || "there";
  const rows = (items || []).map((i) => `<tr><td style="padding:8px 12px;border-bottom:1px solid #E5EEEF;">${esc(i.label)}</td><td align="center" style="padding:8px;border-bottom:1px solid #E5EEEF;">${i.qty}</td><td align="right" style="padding:8px 12px;border-bottom:1px solid #E5EEEF;">${fmt(i.amount_cents)}</td></tr>`).join("");
  const creditRows = (credits || []).map((c) => `<tr><td colspan="2" style="padding:4px 12px;color:#32925d;">Less paid in advance: ${esc(c.label)}</td><td align="right" style="padding:4px 12px;color:#32925d;">-${fmt(c.cents)}</td></tr>`).join("");
  const gst = Math.round(total / 11);
  const title = paid ? "TAX INVOICE (PAID)" : "INVOICE";
  const lead = paid
    ? `Thanks for choosing PowerSmart. Your smoke alarm installation is complete and your invoice is below${method ? ` (paid by ${METHOD[method] || method})` : ""}.`
    : `Thanks for choosing PowerSmart. Your smoke alarm installation is complete. There is a balance of <strong>${fmt(due)}</strong> still to pay; your invoice is below.`;
  const footerNote = paid
    ? "Your compliance certificate will be sent to you separately."
    : `Please arrange payment of ${fmt(due)} by calling <a href="tel:${Q.PHONE_TEL}" style="color:#398ea0;font-weight:bold;">${Q.PHONE_DISPLAY}</a> or replying to this email. Your compliance certificate will be sent once this invoice is paid.`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Invoice J${esc(jobNo)} - PowerSmart</title></head>
<body style="margin:0;padding:0;background-color:#EAF2F3;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EAF2F3;"><tr><td align="center" style="padding:26px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="620" style="width:620px;max-width:100%;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="background:#ffffff;border-radius:14px 14px 0 0;padding:26px 32px 22px;border-bottom:3px solid #43A8B6;"><table role="presentation" width="100%"><tr>
  <td valign="middle"><img src="${Q.SITE}/assets/logo/power-smart-logo-full-colour.png" alt="Power Smart Co" width="190" style="display:block;width:190px;height:auto;"></td>
  <td valign="middle" align="right"><div style="font-size:18px;font-weight:bold;color:#0B1B1F;letter-spacing:1px;">${title}</div><div style="font-size:12px;color:#6B8288;padding-top:4px;">Invoice: <strong style="color:#41585D;">J${esc(jobNo)}</strong> &middot; ${esc(date)}</div></td>
</tr></table></td></tr>
<tr><td style="background:#ffffff;padding:22px 32px 4px;"><p style="margin:0;font-size:14px;color:#41585D;line-height:1.65;">Hi ${esc(first)},<br><br>${lead}</p>${address ? `<p style="margin:10px 0 0;font-size:12px;color:#6B8288;">Property: ${esc(address)}</p>` : ""}</td></tr>
<tr><td style="background:#ffffff;padding:16px 32px 4px;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-size:13px;color:#41585D;">
  <tr><td style="padding:0 12px 8px;font-size:10.5px;letter-spacing:1px;color:#8AA0A5;font-weight:bold;text-transform:uppercase;">Description</td><td align="center" style="padding:0 8px 8px;font-size:10.5px;letter-spacing:1px;color:#8AA0A5;font-weight:bold;text-transform:uppercase;">Qty</td><td align="right" style="padding:0 12px 8px;font-size:10.5px;letter-spacing:1px;color:#8AA0A5;font-weight:bold;text-transform:uppercase;">Amount</td></tr>
  ${rows}
  <tr><td colspan="2" style="padding:10px 12px 4px;font-weight:bold;color:#0B1B1F;">Total (incl. GST)</td><td align="right" style="padding:10px 12px 4px;font-weight:bold;color:#0B1B1F;">${fmt(total)}</td></tr>
  <tr><td colspan="2" style="padding:0 12px;font-size:12px;color:#8AA0A5;">Includes GST of ${fmt(gst)}</td><td></td></tr>
  ${creditRows}
  <tr><td colspan="2" style="padding:10px 12px;font-weight:bold;color:#0B1B1F;background:#F4F9FA;border-radius:8px 0 0 8px;">Balance owing</td><td align="right" style="padding:10px 12px;font-weight:bold;color:${paid ? "#32925d" : "#B3261E"};background:#F4F9FA;border-radius:0 8px 8px 0;">${paid ? "$0.00 (paid in full)" : fmt(due)}</td></tr>
</table></td></tr>
<tr><td style="background:#ffffff;padding:18px 32px 24px;"><p style="margin:0;font-size:13px;color:#41585D;line-height:1.65;">${footerNote}</p></td></tr>
<tr><td align="center" style="background:#ffffff;border-radius:0 0 14px 14px;border-top:1px solid #E5EEEF;padding:18px 32px 24px;"><p style="margin:0 0 4px;font-size:12px;color:#6B8288;font-weight:bold;">PowerSmart Pty Ltd &middot; ABN ${Q.ABN}</p><p style="margin:0;font-size:11px;color:#8AA0A5;">${Q.PHONE_DISPLAY} &middot; ${Q.SUPPORT_EMAIL}</p></td></tr>
</table></td></tr></table></body></html>`;
  const text = `${title} - PowerSmart
Invoice J${jobNo} - ${date}

Hi ${first},

${lead.replace(/<[^>]+>/g, "")}

${(items || []).map((i) => `- ${i.label} x ${i.qty}: ${fmt(i.amount_cents)}`).join("\n")}

Total (incl. GST): ${fmt(total)} (GST ${fmt(gst)})
${(credits || []).map((c) => `Less paid in advance (${c.label}): -${fmt(c.cents)}`).join("\n")}${credits && credits.length ? "\n" : ""}${paid ? "Balance: $0.00 (paid)" : "Balance owing: " + fmt(due)}

${footerNote.replace(/<[^>]+>/g, "")}

PowerSmart Pty Ltd | ABN ${Q.ABN}`;
  return { html, text };
}

// Emails the invoice. Never throws: returns { status: 'sent' | 'skipped' | 'failed', ... }.
async function sendJobInvoice({ job, lead, items, totals, credits, paid, method, agent }) {
  const to = String(job.email || (lead && lead.email) || "").trim().toLowerCase();
  if (!to) return { status: "skipped", error: "No customer email saved." };
  if (!process.env.RESEND_API_KEY) return { status: "failed", error: "Email service is not configured." };
  const address = [job.address, [job.suburb, job.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const date = Q.fmtDate(new Date());
  const { html, text } = renderInvoice({ name: job.customer_name, jobNo: job.job_no, items, total: totals.total, credits, due: totals.due, paid, method, address, date });
  const subject = paid ? `Your PowerSmart tax invoice J${job.job_no} (paid)` : `Your PowerSmart invoice J${job.job_no}: ${fmt(totals.due)} owing`;
  try {
    const { Resend } = require("resend");
    const { data, error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: S.fromHeader("customer_service"), to, replyTo: process.env.RESEND_REPLY_TO || Q.SUPPORT_EMAIL,
      bcc: process.env.NOTIFY_EMAIL || Q.SUPPORT_EMAIL, subject, html, text,
    });
    if (error) throw new Error(error.message || "Email provider rejected the request");
    await logEmail({ id: randomUUID(), kind: "email", sender: "customer_service", agent, to_email: to, to_name: job.customer_name, subject, body_html: html, body_text: text, lead_id: job.lead_id || null, provider_id: data && data.id });
    return { status: "sent", to };
  } catch (e) { return { status: "failed", error: e.message }; }
}

module.exports = { renderInvoice, sendJobInvoice };
