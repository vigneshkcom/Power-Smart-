// Alarm Care Notice and Acknowledgement: what a customer is told, before they accept a quote, about what to do if an
// alarm is faulty or sounds unexpectedly. When they tick "I've read and understand..." we record it on the lead and email
// them (bcc the office) a PDF copy. Underscore prefix => not a Vercel route.
//
// The wording below is the single source for the PDF, the email and the acceptance note. The pop-up in accept.html carries
// the same text (tests/care-notice.test.js checks they match). Change the wording => bump VERSION here and in accept.html.

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const SB = require("./_supabase");
const S = require("./_senders");
const Q = require("./_quote");
const { logEmail } = require("./_maillog");

const VERSION = "v1";
const TITLE = "Alarm Care Notice and Acknowledgement";
const SUBTITLE = "How we look after your smoke alarms";
const HEADLINE = "Your alarms are backed for 10 years";
const LEAD = "Problems are uncommon, but if one ever happens, here's exactly what to do.";
const SITUATION = "If an alarm is faulty, or sounds or chirps for no obvious reason";
const PAIRING_URL = `${Q.SITE}/pairing`;
const STEPS = [
  { title: "Get in touch", text: `Call ${Q.PHONE_DISPLAY} or reply to your quote email. Tell us which alarm and what it's doing, and send a photo if you can.` },
  { title: "We post you a replacement, free", text: "If the alarm is faulty, we send a replacement at no cost, and postage is on us." },
  { title: "Swap it and pair it", text: "Swap the alarm over. For hardwired alarms our electrician has already wired the base plate, so you only change the alarm itself and never touch the wiring. Our step-by-step pairing guide shows how to connect it to your other alarms." },
];
const SAFETY_LABEL = "Safety first:";
const SAFETY = "if an alarm sounds and you can see or smell smoke, treat it as real: get everyone out and call 000. Otherwise, a sounding or chirping alarm is usually steam, dust or a low battery, and we'll help you work out which.";
const COMFORT_LABEL = "Not comfortable, or something doesn't look right?";
const COMFORT = "If the base plate looks damaged, you can see exposed wires, or you'd rather not do it yourself, leave it alone and call us. We'll arrange a licensed electrician. If the problem is with our installation work, we always fix it.";
const LAW = "This doesn't limit your rights under the Australian Consumer Law.";
const TICK = "I've read and understand what to do if an alarm is faulty or sounds unexpectedly.";
const NOTE_MARK = "Alarm Care Notice and Acknowledgement";   // start of the note saved on the customer when they accept

const WORDING = { VERSION, TITLE, SUBTITLE, HEADLINE, LEAD, SITUATION, STEPS, SAFETY_LABEL, SAFETY, COMFORT_LABEL, COMFORT, LAW, TICK };

const TZ = "Australia/Brisbane";
const enc = encodeURIComponent;
const esc = Q.escapeHtml;
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const when = (iso) => new Date(iso).toLocaleString("en-AU", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).replace(/\bam\b/, "am").replace(/\bpm\b/, "pm") + " (Brisbane time)";

// ---------- PDF ----------
// Standard PDF fonts only know Latin-1: strip accents, replace anything else (emoji, other scripts) with "?".
const safe = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?").replace(/\s+/g, " ").trim();
const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const INK = hex("#0B1B1F"), BODY = hex("#41585D"), MUTED = hex("#6B8288"), TEAL = hex("#43A8B6"), TEAL_DK = hex("#1E5F6B"), PAPER = hex("#F4F9FA"), LINE = hex("#D6E8EB"), AMBER = hex("#FDF3DC"), AMBER_LN = hex("#EBCF8A");

async function renderCareNoticePdf({ name, address, ref, acceptedAt }) {
  const doc = await PDFDocument.create();
  doc.setTitle(`${TITLE}${ref ? " - " + ref : ""}`); doc.setAuthor("PowerSmart Pty Ltd"); doc.setSubject(SUBTITLE);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold), italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const W = 595.28, H = 841.89, M = 44, CW = W - 2 * M;
  let page = doc.addPage([W, H]), y = H - M;

  const wrap = (text, f, size, maxW) => {
    const lines = []; let line = "";
    for (const word of safe(text).split(" ")) {
      const next = line ? line + " " + word : word;
      if (line && f.widthOfTextAtSize(next, size) > maxW) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  };
  const need = (h) => { if (y - h < 62) { page = doc.addPage([W, H]); y = H - M; } };
  const text = (t, x, yy, f, size, color) => page.drawText(safe(t), { x, y: yy, font: f, size, color });
  // Plain paragraph at the current position.
  const para = (t, { f = font, size = 10, color = BODY, x = M, w = CW, lh = 14.5, gap = 8 } = {}) => {
    const lines = wrap(t, f, size, w); need(lines.length * lh);
    for (const l of lines) { y -= lh; text(l, x, y + (lh - size) / 2 + 1, f, size, color); }
    y -= gap;
  };
  // A rounded-corner-free box holding a bold label line and a paragraph.
  const box = (label, body, { fill = PAPER, border = LINE } = {}) => {
    const pad = 12, size = 10, lh = 14.5, lines = wrap(body, font, size, CW - 2 * pad), h = pad * 2 + 15 + lines.length * lh;
    need(h + 8); const top = y;
    page.drawRectangle({ x: M, y: top - h, width: CW, height: h, color: fill, borderColor: border, borderWidth: 0.8 });
    let ty = top - pad - 10; text(label, M + pad, ty, bold, size + 0.5, INK); ty -= 5;
    for (const l of lines) { ty -= lh; text(l, M + pad, ty + 3, font, size, BODY); }
    y = top - h - 9;
  };

  // Header band
  page.drawRectangle({ x: 0, y: H - 64, width: W, height: 64, color: INK });
  text("POWER SMART", M, H - 37, bold, 19, rgb(1, 1, 1)); text("Co", M + bold.widthOfTextAtSize("POWER SMART ", 19), H - 37, bold, 19, TEAL);
  text("PowerSmart Pty Ltd", M, H - 52, font, 8.5, hex("#9FB6BA"));
  if (ref) { const r = safe(`Quote ${ref}`); text(r, W - M - font.widthOfTextAtSize(r, 10), H - 39, font, 10, hex("#9FB6BA")); }
  page.drawRectangle({ x: 0, y: H - 67, width: W, height: 3, color: TEAL });
  y = H - 67 - 14;

  para(TITLE, { f: bold, size: 20, color: INK, lh: 24, gap: 2 });
  para(SUBTITLE, { size: 11, color: MUTED, gap: 10 });

  // Who and what this is for
  const details = [["Customer", name], ["Installation address", address], ["Quote reference", ref]].filter(([, v]) => v);
  const dh = 12 + details.length * 17; need(dh + 10);
  page.drawRectangle({ x: M, y: y - dh, width: CW, height: dh, color: PAPER, borderColor: LINE, borderWidth: 0.8 });
  details.forEach(([k, v], i) => { const ly = y - 20 - i * 17 + 4; text(k, M + 12, ly, font, 9, MUTED); text(v, M + 130, ly, bold, 10, INK); });
  y -= dh + 14;

  para(HEADLINE, { f: bold, size: 14, color: TEAL_DK, lh: 18, gap: 2 });
  para(LEAD, { gap: 8 });
  para(SITUATION, { f: bold, size: 11, color: INK, gap: 4 });
  STEPS.forEach((s, i) => {
    const tl = wrap(s.text, font, 10, CW - 30), h = 16 + tl.length * 14.5 + 6; need(h);
    page.drawCircle({ x: M + 9, y: y - 9, size: 9, color: hex("#E7F4F6") });
    text(String(i + 1), M + 9 - bold.widthOfTextAtSize(String(i + 1), 9.5) / 2, y - 12.3, bold, 9.5, TEAL_DK);
    text(s.title, M + 28, y - 11, bold, 10.5, INK); let ty = y - 11;
    for (const l of tl) { ty -= 14.5; text(l, M + 28, ty, font, 10, BODY); }
    y = ty - 8;
  });
  para(`Pairing guide: ${PAIRING_URL}`, { size: 9.5, color: TEAL_DK, x: M + 28, w: CW - 28, gap: 6 });
  box(SAFETY_LABEL.replace(/:$/, ""), cap(SAFETY), { fill: AMBER, border: AMBER_LN });
  box(COMFORT_LABEL, COMFORT);
  para(LAW, { f: italic, size: 9.5, color: MUTED, gap: 10 });

  // Acknowledgement
  need(130);
  para("Customer acknowledgement", { f: bold, size: 13, color: INK, lh: 17, gap: 6 });
  const ack = `On ${when(acceptedAt)}, ${name || "the customer"} confirmed on the PowerSmart quote acceptance page, by ticking the box, that: "${TICK}"`;
  const al = wrap(ack, font, 10, CW - 24), ah = 24 + al.length * 14.5 + 18 + 8; need(ah + 10);
  page.drawRectangle({ x: M, y: y - ah, width: CW, height: ah, color: rgb(1, 1, 1), borderColor: TEAL, borderWidth: 1.2 });
  let ay = y - 12; for (const l of al) { ay -= 14.5; text(l, M + 12, ay + 3, font, 10, INK); }
  text(`Notice version ${VERSION}  |  Recorded electronically by PowerSmart`, M + 12, y - ah + 12, font, 8.5, MUTED);
  y -= ah + 10;

  // Footer on every page
  doc.getPages().forEach((p, i, all) => {
    p.drawLine({ start: { x: M, y: 50 }, end: { x: W - M, y: 50 }, thickness: 0.6, color: LINE });
    const f = safe(`PowerSmart Pty Ltd  |  ABN ${Q.ABN}  |  ${Q.PHONE_DISPLAY}  |  ${Q.SUPPORT_EMAIL}`);
    p.drawText(f, { x: M, y: 36, font, size: 8.5, color: MUTED });
    if (all.length > 1) { const pg = `Page ${i + 1} of ${all.length}`; p.drawText(pg, { x: W - M - font.widthOfTextAtSize(pg, 8.5), y: 36, font, size: 8.5, color: MUTED }); }
  });
  return Buffer.from(await doc.save());
}

// ---------- email ----------
function careNoticeEmail({ name, ref, acceptedAt }) {
  const first = firstName(name), subject = `Your PowerSmart alarm care notice${ref ? ` (${ref})` : ""}`;
  const stepsText = STEPS.map((s, i) => `${i + 1}. ${s.title}: ${s.text}`).join("\n");
  const text = `Hi ${first},\n\nThanks for accepting your quote${ref ? " " + ref : ""}. Attached is a copy of the ${TITLE} you confirmed on ${when(acceptedAt)}. Please keep it for your records.\n\n${HEADLINE}. ${SITUATION}:\n\n${stepsText}\n\nPairing guide: ${PAIRING_URL}\n\n${SAFETY_LABEL} ${SAFETY}\n\n${COMFORT_LABEL} ${COMFORT}\n\n${LAW}\n\nKind regards,\nThe PowerSmart Team\n\nPowerSmart Pty Ltd | ABN ${Q.ABN}\n${Q.PHONE_DISPLAY} | ${Q.SUPPORT_EMAIL}`;
  const step = (s, i) => `<tr><td width="30" valign="top" style="padding:6px 0;"><span style="display:inline-block;width:24px;height:24px;border-radius:50%;background:#E7F4F6;color:#1E5F6B;font-size:12px;font-weight:bold;text-align:center;line-height:24px;">${i + 1}</span></td><td style="padding:6px 0 6px 8px;font-size:14px;color:#41585D;line-height:1.6;"><strong style="color:#0B1B1F;">${esc(s.title)}</strong><br>${esc(s.text)}${i === 2 ? ` <a href="${PAIRING_URL}" style="color:#1E5F6B;font-weight:bold;">Open the pairing guide</a>` : ""}</td></tr>`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#EAF2F3;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EAF2F3;"><tr><td align="center" style="padding:26px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="620" style="width:620px;max-width:100%;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="background:#ffffff;border-radius:14px 14px 0 0;padding:26px 32px 22px;border-bottom:3px solid #43A8B6;"><img src="${Q.SITE}/assets/logo/power-smart-logo-full-colour.png" alt="Power Smart Co" width="190" style="display:block;width:190px;height:auto;"></td></tr>
<tr><td style="background:#ffffff;padding:26px 32px 8px;"><h1 style="margin:0 0 12px;font-size:21px;color:#0B1B1F;line-height:1.3;">${esc(HEADLINE)}</h1>
<p style="margin:0 0 12px;font-size:14px;color:#41585D;line-height:1.65;">Hi ${esc(first)},<br><br>Thanks for accepting your quote${ref ? " " + esc(ref) : ""}. Attached is a copy of the <strong style="color:#0B1B1F;">${esc(TITLE)}</strong> you confirmed on ${esc(when(acceptedAt))}. Please keep it for your records.</p>
<p style="margin:0 0 6px;font-size:14px;color:#0B1B1F;font-weight:bold;">${esc(SITUATION)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${STEPS.map(step).join("")}</table></td></tr>
<tr><td style="background:#ffffff;padding:8px 32px 6px;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="background:#FDF3DC;border-radius:10px;padding:14px 16px;font-size:13px;color:#41585D;line-height:1.6;"><strong style="color:#0B1B1F;">${esc(SAFETY_LABEL)}</strong> ${esc(SAFETY)}</td></tr></table></td></tr>
<tr><td style="background:#ffffff;padding:8px 32px 6px;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="background:#F4F9FA;border:1px solid #D6E8EB;border-radius:10px;padding:14px 16px;font-size:13px;color:#41585D;line-height:1.6;"><strong style="color:#0B1B1F;">${esc(COMFORT_LABEL)}</strong> ${esc(COMFORT)}</td></tr></table></td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 14px 14px;padding:12px 32px 28px;font-size:12px;color:#6B8288;line-height:1.6;"><em>${esc(LAW)}</em><p style="margin:14px 0 0;font-size:14px;color:#41585D;">Kind regards,<br><strong style="color:#0B1B1F;">The PowerSmart Team</strong></p></td></tr>
<tr><td align="center" style="padding:20px 12px 6px;"><p style="margin:0 0 4px;font-size:12px;color:#6B8288;font-weight:bold;">PowerSmart Pty Ltd &middot; ABN ${Q.ABN}</p><p style="margin:0;font-size:11px;color:#8AA0A5;"><a href="tel:${Q.PHONE_TEL}" style="color:#8AA0A5;">${Q.PHONE_DISPLAY}</a> &middot; ${Q.SUPPORT_EMAIL}</p></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text };
}

// ---------- record + send ----------
const parseAccepted = (body) => { const m = /\[accepted_at=([^\]]+)\]/.exec(body || ""); return m && !isNaN(Date.parse(m[1])) ? m[1] : null; };
const noteLike = (ref) => `${enc(`*${NOTE_MARK}*accepted for quote ${ref}*`)}`;

// Saves "customer ticked the notice" on the lead once per quote; returns the time of the first acceptance.
async function recordAcceptance({ lead, ref, now = new Date() }) {
  const found = await SB.sb(`lead_comments?lead_id=eq.${enc(lead.id)}&kind=eq.status&body=like.${noteLike(ref)}&select=body,created_at&order=created_at.asc&limit=1`);
  if (found && found[0]) return { acceptedAt: parseAccepted(found[0].body) || found[0].created_at, existing: true };
  const acceptedAt = now.toISOString();
  await SB.sb("lead_comments", { method: "POST", prefer: "return=minimal", body: { lead_id: lead.id, author: "System", kind: "status",
    body: `${NOTE_MARK} (${VERSION}) accepted for quote ${ref} at ${when(acceptedAt)}. The customer ticked: "${TICK}" [accepted_at=${acceptedAt}]` } });
  return { acceptedAt, existing: false };
}

// Emails the customer the PDF copy (bcc the office). Never throws. force = resend even if it was already sent.
async function sendCareNotice({ lead, name, ref, address, acceptedAt, agent = "System", force = false }) {
  const note = (t) => SB.sb("lead_comments", { method: "POST", prefer: "return=minimal", body: { lead_id: lead.id, author: agent, kind: "email", body: t } }).catch(() => {});
  const to = String(lead.email || "").trim().toLowerCase();
  if (!to) { await note("Alarm Care Notice PDF not sent: no email address on file."); return { status: "skipped", reason: "No email address on file." }; }
  const mail = careNoticeEmail({ name, ref, acceptedAt });
  try {
    if (!force) {
      try {
        const prior = await SB.sb(`sent_emails?lead_id=eq.${enc(lead.id)}&subject=eq.${enc(mail.subject)}&status=eq.sent&select=id,created_at&order=created_at.desc&limit=1`);
        if (prior && prior.length) {
          // Say so on the customer, so a repeat acceptance isn't a silent no-show.
          await note(`${NOTE_MARK} PDF not sent again: a copy was already emailed to ${to}${prior[0].created_at ? " on " + when(prior[0].created_at) : ""}. Use Resend care notice to send another.`);
          return { status: "skipped", duplicate: true, to };
        }
      } catch (_) { /* email log unavailable: carry on */ }
    }
    const pdf = await renderCareNoticePdf({ name, address, ref, acceptedAt });
    const filename = `PowerSmart-Alarm-Care-Acknowledgement${ref ? "-" + String(ref).replace(/[^A-Za-z0-9_-]/g, "") : ""}.pdf`;
    const { Resend } = require("./_transactional-mail");
    const { data, error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: S.fromHeader("customer_service"), to, replyTo: Q.SUPPORT_EMAIL, bcc: Q.SUPPORT_EMAIL,
      subject: mail.subject, html: mail.html, text: mail.text, attachments: [{ filename, content: pdf }],
    });
    if (error) throw new Error(error.message || "Email provider rejected the request");
    await logEmail({ kind: "email", sender: "customer_service", agent, to_email: to, to_name: name, subject: mail.subject, body_html: mail.html, body_text: mail.text, lead_id: lead.id, provider_id: data && data.id, status: "sent" });
    await note(`${NOTE_MARK} PDF ${force ? "re-sent" : "sent"} to ${to} (copy to ${Q.SUPPORT_EMAIL}).`);
    return { status: "sent", to };
  } catch (e) {
    await note(`${NOTE_MARK} PDF NOT sent to ${to}: ${e.message}. Use Resend care notice on the customer card.`);
    return { status: "failed", error: e.message, to };
  }
}

// What /api/accept-quote calls after saving the acceptance. Never throws, and never holds the customer up for more than
// `limitMs` (they may be about to pay): the tick is recorded first; if the email is slow, staff can use Resend care notice.
async function acceptAndSend({ lead, name, ref, address, agent, limitMs = 6000 }) {
  let timer;
  const work = (async () => {
    const { acceptedAt } = await recordAcceptance({ lead, ref });
    return { acceptedAt, ...(await sendCareNotice({ lead, name: name || lead.name, ref, address, acceptedAt, agent })) };
  })().catch((e) => { console.error("care notice failed:", e.message); return { status: "failed", error: e.message }; });
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: "pending", reason: "Still sending." }), limitMs); });
  try { return await Promise.race([work, slow]); } finally { clearTimeout(timer); }
}

// Staff "Resend care notice": the original acceptance time and quote come from the note saved at acceptance.
async function resendForLead(leadId, agent) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const lead = (await SB.sb(`leads?id=eq.${enc(leadId)}&select=id,name,email,quote_ref,address_line1,address_suburb,address_state,address_postcode&limit=1`))?.[0];
  if (!lead) throw fail(404, "Customer not found");
  const found = (await SB.sb(`lead_comments?lead_id=eq.${enc(lead.id)}&kind=eq.status&body=like.${enc(`*${NOTE_MARK}*accepted for quote*`)}&select=body,created_at&order=created_at.desc&limit=1`))?.[0];
  if (!found) throw fail(404, "This customer hasn't accepted the Alarm Care Notice yet.");
  const ref = (/accepted for quote (.+?) at /.exec(found.body) || [])[1] || lead.quote_ref || "";
  const address = lead.address_line1 ? `${lead.address_line1}, ${[lead.address_suburb, lead.address_state, lead.address_postcode].filter(Boolean).join(" ")}` : "";
  const result = await sendCareNotice({ lead, name: lead.name, ref, address, acceptedAt: parseAccepted(found.body) || found.created_at, agent, force: true });
  if (result.status !== "sent") throw fail(502, result.error || result.reason || "The care notice could not be sent");
  return result;
}

module.exports = { WORDING, VERSION, TICK, NOTE_MARK, PAIRING_URL, renderCareNoticePdf, careNoticeEmail, recordAcceptance, sendCareNotice, acceptAndSend, resendForLead, parseAccepted };
