// Smoke alarm compliance certificate: a two-page A4 PDF (certificate + information sheet) emailed to the
// customer once the job is completed AND paid in full (paid on site, paid later and marked paid, or nothing owing).
// The layout lives in api/_cert-assets/page1.html + page2.html and is rendered to PDF with headless Chromium.
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const Q = require("./_quote");
const S = require("./_senders");
const SB = require("./_supabase");
const { logEmail } = require("./_maillog");

const DIR = path.join(__dirname, "_cert-assets");
const esc = Q.escapeHtml;
const asset = (name) => fs.readFileSync(path.join(DIR, name));
const dataUri = (name, mime) => `data:${mime};base64,${asset(name).toString("base64")}`;

const STATE_BY_DIGIT = { 0: "NT", 2: "NSW", 3: "VIC", 4: "QLD", 5: "SA", 6: "WA", 7: "TAS" };
function stateFor(postcode) {
  const p = String(postcode || "").trim();
  if (/^(02|26|29)/.test(p)) return "ACT";
  return STATE_BY_DIGIT[p[0]] || "QLD";
}
function dateText(iso) {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(new Date(iso || Date.now()));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.day} / ${p.month} / ${p.year}`;
}

// The signature is dark ink on a transparent canvas; the footer is dark, so it is drawn white.
function signatureHtml(dataUrl) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(dataUrl || ""))) return "";
  return `<img src="${dataUrl}" alt="Electrician signature" style="display:block;height:48px;width:auto;max-width:100%;object-fit:contain;object-position:left bottom;filter:brightness(0) invert(1)">`;
}

function fontFaces() {
  const face = (family, weight, file) => `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(${dataUri(file, "font/woff2")}) format('woff2')}`;
  return [400, 500, 600].map((w) => face("Inter", w, "inter.woff2")).join("") +
    [500, 600, 700, 800].map((w) => face("Poppins", w, `poppins-${w}.woff2`)).join("");
}

function renderCertificateHtml({ job, electrician }) {
  const logo = dataUri("logo.png", "image/png");
  const fill = (tpl, map) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in map ? map[k] : ""));
  const page1 = fill(asset("page1.html").toString("utf8"), {
    LOGO: logo, DATE: dateText(job.signoff_at || job.completed_at), STATE: esc(stateFor(job.postcode)), POSTCODE: esc(job.postcode || ""),
    ADDRESS: esc(String(job.address || "").toUpperCase()), SUBURB: esc(String(job.suburb || "").toUpperCase()),
    ELEC_NAME: esc(job.signoff_name || electrician.name || ""), LICENCE: esc(electrician.licence_no || ""), SIGNATURE: signatureHtml(job.signoff_signature),
  });
  const page2 = fill(asset("page2.html").toString("utf8"), { LOGO: logo });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Smoke Alarm Certificate of Compliance J${esc(job.job_no)}</title>
<style>${fontFaces()}
@page{size:794px 1123px;margin:0}
html,body{margin:0;padding:0}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pg{width:794px;height:1123px;overflow:hidden;page-break-after:always;break-after:page}.pg:last-child{page-break-after:auto;break-after:auto}
a{color:#8AE8E4}
</style></head><body><div class="pg">${page1}</div><div class="pg">${page2}</div></body></html>`;
}

async function renderCertificatePdf(data) {
  const puppeteer = require("puppeteer-core");
  const chromium = (await import("@sparticuz/chromium")).default;   // ESM-only package
  const browser = await puppeteer.launch({
    args: process.env.CHROME_PATH ? [...chromium.args, "--no-sandbox"] : chromium.args, headless: "shell",
    executablePath: process.env.CHROME_PATH || (await chromium.executablePath()),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(renderCertificateHtml(data), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    return Buffer.from(await page.pdf({ width: "794px", height: "1123px", printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } }));
  } finally { await browser.close().catch(() => {}); }
}

function paidInFull(job) { return job.status === "completed" && (job.pay_status === "paid" || job.pay_status === "none"); }

async function note(job, text) {
  try { await require("./_jobs").leadNote(job.lead_id, "Certificate", text); } catch (_) { /* best effort */ }
}

// Sends the certificate once. Never throws: { status: 'sent' | 'skipped' | 'failed', reason?, to? }.
// Safe to call from every place a job can become paid: the first caller claims certificate_sent_at.
async function issueCertificate(jobId, { agent, force } = {}) {
  let job;
  try {
    job = (await SB.sb(`jobs?id=eq.${encodeURIComponent(jobId)}&select=*&limit=1`))?.[0];
    if (!job) return { status: "skipped", reason: "Job not found." };
    if (!paidInFull(job)) return { status: "skipped", reason: "The job is not completed and paid in full yet." };
    if (job.certificate_sent_at && !force) return { status: "skipped", reason: "Certificate already sent." };
    const to = String(job.email || "").trim().toLowerCase() ||
      String((job.lead_id && (await SB.sb(`leads?id=eq.${encodeURIComponent(job.lead_id)}&select=email&limit=1`).catch(() => []))?.[0]?.email) || "").trim().toLowerCase();
    if (!to) { await note(job, `⚠️ Certificate for J${job.job_no} not sent: no customer email saved.`); return { status: "failed", reason: "No customer email saved." }; }
    if (!process.env.RESEND_API_KEY) return { status: "failed", reason: "Email service is not configured." };
    const electrician = (job.electrician_id && (await SB.sb(`electricians?id=eq.${encodeURIComponent(job.electrician_id)}&select=name,licence_no&limit=1`))?.[0]) || {};
    if (!electrician.licence_no) {
      await note(job, `⚠️ Certificate for J${job.job_no} not sent: add ${electrician.name || "the electrician"}'s licence number in Schedule → Electricians, then use Send certificate.`);
      return { status: "failed", reason: "The electrician has no licence number saved." };
    }
    if (!/^data:image\/png;base64,/.test(String(job.signoff_signature || ""))) return { status: "failed", reason: "The job has no electrician signature." };

    // Claim first so two simultaneous triggers (webhook + app) can't both email.
    const claimed = await SB.sb(`jobs?id=eq.${encodeURIComponent(job.id)}${force ? "" : "&certificate_sent_at=is.null"}`, { method: "PATCH", body: { certificate_sent_at: new Date().toISOString() } });
    if (!claimed || !claimed.length) return { status: "skipped", reason: "Certificate already sent." };
    try {
      const pdf = await renderCertificatePdf({ job, electrician });
      const first = String(job.customer_name || "there").trim().split(/\s+/)[0] || "there";
      const address = [job.address, [job.suburb, job.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      const subject = `Your PowerSmart smoke alarm compliance certificate (J${job.job_no})`;
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#0B1B1F;line-height:1.6"><p>Hi ${esc(first)},</p><p>Thanks for choosing PowerSmart and for your payment. Your smoke alarm <strong>Certificate of Compliance</strong>${address ? ` for ${esc(address)}` : ""} is attached as a PDF. Please keep it for your records, and give a copy to your property manager or insurer if they ask.</p><p>The second page covers how to look after your alarms.</p><p>If you have any questions, reply to this email or call <a href="tel:${Q.PHONE_TEL}">${Q.PHONE_DISPLAY}</a>.</p><p>PowerSmart</p></div>`;
      const text = `Hi ${first},\n\nThanks for choosing PowerSmart and for your payment. Your smoke alarm Certificate of Compliance${address ? " for " + address : ""} is attached as a PDF. Please keep it for your records, and give a copy to your property manager or insurer if they ask.\n\nThe second page covers how to look after your alarms.\n\nQuestions? Reply to this email or call ${Q.PHONE_DISPLAY}.\n\nPowerSmart`;
      const { Resend } = require("resend");
      const { data, error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
        from: S.fromHeader("customer_service"), to, replyTo: process.env.RESEND_REPLY_TO || Q.SUPPORT_EMAIL,
        bcc: process.env.NOTIFY_EMAIL || Q.SUPPORT_EMAIL, subject, html, text,
        attachments: [{ filename: `PowerSmart-Smoke-Alarm-Certificate-J${job.job_no}.pdf`, content: pdf }],
      });
      if (error) throw new Error(error.message || "Email provider rejected the request");
      await logEmail({ id: randomUUID(), kind: "email", sender: "customer_service", agent, to_email: to, to_name: job.customer_name, subject, body_html: html, body_text: text, lead_id: job.lead_id || null, provider_id: data && data.id });
      await note(job, `📄 Compliance certificate for J${job.job_no} emailed to ${to}.`);
      return { status: "sent", to };
    } catch (e) {
      await SB.sb(`jobs?id=eq.${encodeURIComponent(job.id)}`, { method: "PATCH", body: { certificate_sent_at: null } }).catch(() => {});
      await note(job, `⚠️ Certificate for J${job.job_no} could not be sent (${e.message}). Use Send certificate on the job to retry.`);
      return { status: "failed", reason: e.message };
    }
  } catch (e) { console.error("certificate failed:", e.message); return { status: "failed", reason: e.message }; }
}

module.exports = { renderCertificateHtml, renderCertificatePdf, issueCertificate, paidInFull, stateFor, dateText };
