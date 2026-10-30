// A completed job's balance has just been received (card link, Stripe webhook, or the office marking it paid):
// email the paid tax invoice, then release the compliance certificate. Each email is sent at most once.
const SB = require("./_supabase");
const Invoice = require("./_job-invoice");
const Certificate = require("./_certificate");

async function note(job, text) {
  try { await require("./_jobs").leadNote(job.lead_id, "System", text); } catch (_) { /* best effort */ }
}

async function sendPaidInvoice(jobId, agent) {
  const job = (await SB.sb(`jobs?id=eq.${encodeURIComponent(jobId)}&select=*&limit=1`))?.[0];
  if (!job || job.status !== "completed" || job.pay_status !== "paid" || job.paid_invoice_emailed_at) return { status: "skipped" };
  // Claim first so the webhook and the app can't both send it.
  const claimed = await SB.sb(`jobs?id=eq.${encodeURIComponent(job.id)}&paid_invoice_emailed_at=is.null`, { method: "PATCH", body: { paid_invoice_emailed_at: new Date().toISOString() } });
  if (!claimed || !claimed.length) return { status: "skipped" };
  const items = Array.isArray(job.invoice_items) ? job.invoice_items : [];
  const total = job.invoice_total_cents || items.reduce((n, i) => n + (i.amount_cents || 0), 0);
  const credit = Math.max(0, total - (job.amount_due_cents == null ? total : job.amount_due_cents));
  const result = await Invoice.sendJobInvoice({
    job, lead: null, items, totals: { total, due: 0 }, credits: credit ? [{ label: "Paid in advance", cents: credit }] : [],
    bookingFee: 0, paid: true, method: job.pay_method, agent,
  });
  if (result.status !== "sent") {
    await SB.sb(`jobs?id=eq.${encodeURIComponent(job.id)}`, { method: "PATCH", body: { paid_invoice_emailed_at: null } }).catch(() => {});
    await note(job, `⚠️ Paid tax invoice for J${job.job_no} not sent (${result.error || result.status}).`);
  } else await note(job, `🧾 Paid tax invoice for J${job.job_no} emailed to ${result.to}.`);
  return result;
}

async function releaseAfterPayment(jobId, { agent } = {}) {
  let invoice = { status: "skipped" };
  try { invoice = await sendPaidInvoice(jobId, agent); } catch (e) { console.error("paid invoice failed:", e.message); invoice = { status: "failed", error: e.message }; }
  const certificate = await Certificate.issueCertificate(jobId, { agent });
  return { invoice, certificate };
}

module.exports = { releaseAfterPayment, sendPaidInvoice };
