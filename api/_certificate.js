// Smoke alarm compliance certificate: a two-page A4 PDF (certificate + information sheet) emailed to the
// customer once the job is completed AND paid in full (paid on site, paid later and marked paid, or nothing owing).
// The design is pre-rendered to api/_cert-assets/template.pdf (scripts/build-certificate-template.js); only the customer's
// details are drawn on top with pdf-lib, so it takes milliseconds and needs no browser.
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const Q = require("./_quote");
const S = require("./_senders");
const SB = require("./_supabase");
const { logEmail } = require("./_maillog");

const { PDFDocument, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const { PNG } = require("pngjs");

const DIR = path.join(__dirname, "_cert-assets");
const esc = Q.escapeHtml;

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

let assets;
function loadAssets() {
  if (!assets) assets = {
    template: fs.readFileSync(path.join(DIR, "template.pdf")), font: fs.readFileSync(path.join(DIR, "poppins-600.ttf")),
    fields: JSON.parse(fs.readFileSync(path.join(DIR, "fields.json"), "utf8")),
  };
  return assets;
}

// The signature is dark ink on a transparent canvas; the footer is dark, so it is drawn white (colour only, keeping its shape).
function whiteSignature(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  try {
    const png = PNG.sync.read(Buffer.from(m[1], "base64"));
    for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 255; png.data[i + 1] = 255; png.data[i + 2] = 255; }
    return PNG.sync.write(png);
  } catch (_) { return null; }
}

// Widest each value may be before its type size shrinks (the column widths of the design, in px).
const MAX_W = { DATE: 219, STATE: 219, POSTCODE: 219, ADDRESS: 462, SUBURB: 219, ELEC_NAME: 202, LICENCE: 202 };
const WHITE_FIELDS = new Set(["ELEC_NAME", "LICENCE"]);   // printed on the dark footer

async function renderCertificatePdf({ job, electrician }) {
  const a = loadAssets();
  const doc = await PDFDocument.load(a.template);
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(a.font, { subset: true });
  const known = new Set(font.getCharacterSet());
  const clean = (v) => Array.from(String(v == null ? "" : v)).map((c) => (known.has(c.codePointAt(0)) ? c : "?")).join("");
  const page = doc.getPage(0), H = page.getHeight(), S = page.getWidth() / 794;
  const values = {
    DATE: dateText(job.signoff_at || job.completed_at), STATE: stateFor(job.postcode), POSTCODE: job.postcode || "",
    ADDRESS: String(job.address || "").toUpperCase(), SUBURB: String(job.suburb || "").toUpperCase(),
    ELEC_NAME: job.signoff_name || electrician.name || "", LICENCE: electrician.licence_no || "",
  };
  for (const [key, raw] of Object.entries(values)) {
    const f = a.fields[key], text = clean(raw);
    if (!f || !text) continue;
    let size = f.size * S;
    const max = (MAX_W[key] || f.w) * S;
    while (size > 7 && font.widthOfTextAtSize(text, size) > max) size -= 0.5;
    page.drawText(text, { x: f.x * S, y: H - f.baseline * S, size, font, color: WHITE_FIELDS.has(key) ? rgb(1, 1, 1) : rgb(0.039, 0.102, 0.122) });
  }
  const sig = whiteSignature(job.signoff_signature);
  if (sig) {
    const f = a.fields.SIGNATURE, img = await doc.embedPng(sig);
    const maxH = Math.min(f.h, 48) * S, maxW = f.w * S;
    const scale = Math.min(maxH / img.height, maxW / img.width);
    page.drawImage(img, { x: f.x * S, y: H - (f.y + f.h) * S + 2 * S, width: img.width * scale, height: img.height * scale });
  }
  return Buffer.from(await doc.save());
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
  } catch (e) {
    console.error("certificate failed:", e.message);
    // Never fail silently: say why on the customer's card (a missing column means supabase/certificate.sql wasn't run).
    const setup = /certificate_sent_at|licence_no|pay_receipt/.test(String(e.message));
    const reason = setup ? "Setup needed: run supabase/certificate.sql in Supabase" : e.message;
    if (job) await note(job, `⚠️ Certificate for J${job.job_no} could not be sent (${reason}). Fix that, then use Send certificate on the job.`);
    return { status: "failed", reason };
  }
}

module.exports = { renderCertificatePdf, issueCertificate, paidInFull, stateFor, dateText };
