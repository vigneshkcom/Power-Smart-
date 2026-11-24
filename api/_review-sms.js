// Google review request: one SMS after an electrician completes a job (install, inspection or service).
// The office can stop it per job with the "Send Google review SMS after the job" tick box on /tools/schedule
// (jobs.review_sms = false, see supabase/review-sms.sql). Never sent for warranty visits, to customers the office
// chose not to text, or twice for the same job (the SMS key is per job, and review_sms_sent_at is stamped).
const SB = require("./_supabase");
const Sms = require("./_sms-outbound");

const REVIEW_URL = process.env.GOOGLE_REVIEW_URL || "https://g.page/r/CTNPjpqOUVo2EBM/review";
const REPEAT_DAYS = 90;   // a returning customer is not asked again within this window
const enc = encodeURIComponent;

function reviewMessage(name) {
  const first = String(name || "").trim().split(/\s+/)[0] || "there";
  return `Hi ${first}, thanks for choosing PowerSmart! If you were happy with our service, a quick Google review would really help our small team: ${REVIEW_URL}\n\nReply STOP to opt out.`;
}

// Returns { status: "sent" | "skipped" | "failed", reason?, error? }. Never throws: completing a job must not depend on it.
async function sendForCompletedJob(job, agent = "System") {
  try {
    if (!job || job.work_type === "warranty") return { status: "skipped", reason: "Warranty visit" };
    if (job.review_sms === false) return { status: "skipped", reason: "Review SMS stopped by the office" };
    if (job.review_sms_sent_at) return { status: "skipped", reason: "Already sent" };
    if (job.notify_customer === false || job.notify_sms === false) return { status: "skipped", reason: "Office chose not to text this customer" };
    const phone = Sms.cleanPhone(job.phone);
    if (!phone) return { status: "skipped", reason: "No mobile number" };
    if (!Sms.smsEnabled()) return { status: "skipped", reason: "SMS is paused" };
    const since = new Date(Date.now() - REPEAT_DAYS * 86400000).toISOString();
    const recent = await SB.sb(`sms_messages?phone_number=eq.${enc(phone)}&direction=eq.outbound&message=like.${enc("%" + REVIEW_URL + "%")}&status=in.(sent,queued,delivered,pending,unknown)&created_at=gte.${enc(since)}&select=id&limit=1`);
    if (recent && recent.length) return { status: "skipped", reason: `Asked for a review in the last ${REPEAT_DAYS} days` };
    const r = await Sms.sendLeadSms({ lead: { id: job.lead_id || undefined, phone }, message: reviewMessage(job.customer_name), key: `review-${job.id}`, author: agent });
    if (r.status !== "submitted") return { status: "skipped", reason: r.error || r.status };
    try { await SB.sb(`jobs?id=eq.${enc(job.id)}`, { method: "PATCH", body: { review_sms_sent_at: new Date().toISOString() }, prefer: "return=minimal" }); } catch (_) { /* column added by supabase/review-sms.sql */ }
    return { status: "sent" };
  } catch (e) {
    console.error("Review SMS:", e.message);
    return { status: "failed", error: e.message };
  }
}

module.exports = { sendForCompletedJob, reviewMessage, REVIEW_URL };
