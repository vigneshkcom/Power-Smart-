// Purchase orders for electricians (contractors): what they did in a week, priced at the contractor rates,
// plus any extra lines the office adds. Served through the jobs API (actions po_preview / po_pdf / po_send).
// Rates and line amounts are in cents EXCLUDING GST; the electricians are GST registered, so GST is added on top.
// Underscore prefix => not a Vercel route.

// What the electrician is paid, ex GST. Alarms with no recorded type are paid as battery for now.
const RATES = { callout: 3000, hardwired: 1300, battery: 1000, controller: 1000 };
const GST_PCT = 10;
const TZ = "Australia/Brisbane";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Who is buying: printed on every purchase order.
const COMPANY = {
  name: "PowerSmart Pty Ltd", abn: "41 669 943 720",
  address: ["36 Clearwater Rise Parade", "Truganina VIC 3029"],
  phone: "0475 184 984", email: "vignesh@powersmartco.com.au", web: "smokealarms.powersmartco.com.au",
};

function bad(msg) { const e = new Error(msg); e.status = 400; return e; }
const dollars = (c) => (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brisbane = (d, o) => new Intl.DateTimeFormat("en-AU", { timeZone: TZ, ...o }).format(d);
const longDate = (d) => brisbane(d, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const shortDate = (d) => brisbane(d, { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
const dayMonthYear = (d) => brisbane(d, { day: "numeric", month: "short", year: "numeric" });
const titleCase = (s) => String(s || "").toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());

// Brisbane calendar date of an instant, as a UTC-midnight Date (safe for day arithmetic).
function calendarDay(d) {
  const [day, month, year] = brisbane(d, { year: "numeric", month: "2-digit", day: "2-digit" }).split("/").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}
// The Sunday that ends the week holding the period's last day.
function weekEnding(to) {
  const last = calendarDay(new Date(Date.parse(to) - 60000));   // "to" is the start of the day after the period
  return new Date(last.getTime() + ((7 - last.getUTCDay()) % 7) * 864e5);
}
const utcLabel = (d, o) => new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", ...o }).format(d).replace(",", "");

function jobPay(r) {
  return RATES.callout + (r.battery + r.untyped) * RATES.battery + r.hardwired * RATES.hardwired + r.controllers * RATES.controller;
}

// Extra lines typed by the office: [{ label, qty, price }] with price in dollars ex GST (negative for a deduction).
function cleanExtra(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 20) throw bad("Too many extra lines");
  const out = [];
  for (const x of list) {
    const label = String(x && x.label || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const qty = Number(x && x.qty == null ? 1 : x && x.qty), price = Number(String(x && x.price).replace(/[$,\s]/g, ""));
    if (!label && !(x && String(x.price || "").trim())) continue;   // blank row
    if (!label) throw bad("Describe each extra line");
    if (!Number.isFinite(qty) || qty === 0 || Math.abs(qty) > 1000) throw bad(`Check the quantity on "${label}"`);
    if (!Number.isFinite(price) || Math.abs(price) > 100000) throw bad(`Check the price on "${label}"`);
    const unit_cents = Math.round(price * 100);
    out.push({ label, qty, unit_cents, amount_cents: Math.round(qty * unit_cents), extra: true });
  }
  return out;
}

// rows: the electrician's completed jobs from reportData(). Warranty visits are paid like any job: call-out plus each alarm replaced.
function buildPo({ tech, rows, from, to, extra, payDate, issued = new Date() }) {
  const jobs = rows;
  const sum = (k) => jobs.reduce((n, r) => n + (r[k] || 0), 0);
  const battery = sum("battery") + sum("untyped"), hardwired = sum("hardwired"), controllers = sum("controllers");
  const lines = [
    { label: "Call-out", qty: jobs.length, unit_cents: RATES.callout },
    { label: "Battery smoke alarm installed", qty: battery, unit_cents: RATES.battery },
    { label: "Hardwired smoke alarm installed", qty: hardwired, unit_cents: RATES.hardwired },
    { label: "Remote controller installed", qty: controllers, unit_cents: RATES.controller },
  ].filter((l) => l.qty > 0).map((l) => ({ ...l, amount_cents: l.qty * l.unit_cents }));
  const all = lines.concat(cleanExtra(extra));
  const first = new Date(from), lastDay = new Date(Date.parse(to) - 60000), ending = weekEnding(to);
  const firstName = titleCase(String(tech.name || "").trim().split(/\s+/)[0] || "Electrician");
  const endLabel = utcLabel(ending, { day: "numeric", month: "short", year: "numeric" });
  const subtotal = all.reduce((n, l) => n + l.amount_cents, 0), gst = Math.round(subtotal * GST_PCT / 100);
  return {
    ref: `PO-${String(tech.code || "ELEC").replace(/[^A-Za-z0-9]/g, "")}-${ending.toISOString().slice(0, 10).replace(/-/g, "")}`,
    title: `${firstName} PO Week ending ${endLabel}`,
    week_ending: ending.toISOString().slice(0, 10), week_ending_label: utcLabel(ending, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    electrician: { id: tech.id, name: titleCase(tech.name), first_name: firstName, code: tech.code || "", email: tech.email || "", phone: tech.phone || "", licence_no: tech.licence_no || "" },
    period: { from, to, label: `${shortDate(first)} to ${shortDate(lastDay)} ${brisbane(lastDay, { year: "numeric" })}` },
    issued: dayMonthYear(issued),
    pay_date: payDate, pay_date_label: payDate ? longDate(new Date(payDate + "T00:00:00+10:00")) : "",
    lines: all, jobs: jobs.map((r) => ({ completed_at: r.completed_at, job_no: r.job_no, address: r.address, warranty: r.work_type === "warranty", battery: r.battery + r.untyped, hardwired: r.hardwired, controllers: r.controllers, amount_cents: jobPay(r) })),
    subtotal_cents: subtotal, gst_cents: gst, total_cents: subtotal + gst,
  };
}

function defaultIntro(po) {
  return `Hi ${po.electrician.first_name},\n\nPlease find attached your purchase order for the week ending ${po.week_ending_label}: ${dollars(po.total_cents)} including GST.` +
    (po.pay_date_label ? `\n\nThis will be paid on ${po.pay_date_label}.` : "");
}

function renderPoEmail(po, intro) {
  const Q = require("./_quote"), esc = Q.escapeHtml, S = require("./_senders");
  const cell = "padding:7px 10px;border-bottom:1px solid #E5EEEF;";
  const head = (cols) => `<tr style="background:#F4F9FA;color:#0B1B1F;font-weight:bold;">${cols.map(([t, a]) => `<td align="${a || "left"}" style="${cell}">${t}</td>`).join("")}</tr>`;
  const sumRow = (label, value, strong) => `<tr><td colspan="3" align="right" style="padding:6px 10px;${strong ? "font-weight:bold;color:#0B1B1F;background:#F4F9FA;" : ""}">${label}</td><td align="right" style="padding:6px 10px;${strong ? "font-weight:bold;color:#0B1B1F;background:#F4F9FA;" : ""}">${value}</td></tr>`;
  const para = String(intro || "").split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;color:#41585D;font-size:14px;line-height:1.6;">
<div style="font-size:18px;font-weight:bold;color:#0B1B1F;margin-bottom:2px;">${esc(po.title)}</div>
<div style="font-size:12px;color:#8AA0A5;margin-bottom:14px;">${esc(po.ref)} &middot; ${esc(po.period.label)}</div>
${para}
<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;margin:6px 0 14px;">
${head([["Item"], ["Qty", "right"], ["Rate ex GST", "right"], ["Amount ex GST", "right"]])}
${po.lines.map((l) => `<tr><td style="${cell}">${esc(l.label)}</td><td align="right" style="${cell}">${l.qty}</td><td align="right" style="${cell}">${dollars(l.unit_cents)}</td><td align="right" style="${cell}">${dollars(l.amount_cents)}</td></tr>`).join("")}
${sumRow("Subtotal (ex GST)", dollars(po.subtotal_cents))}${sumRow(`GST (${GST_PCT}%)`, dollars(po.gst_cents))}${sumRow("Total (inc GST)", dollars(po.total_cents), true)}
</table>
<p style="font-size:12px;color:#8AA0A5;margin-top:12px;">Please see the attached PDF for a job-by-job breakdown. If anything doesn&#39;t look right, just reply to this email.</p>
<p style="margin:18px 0 0;color:#0B1B1F;">Regards,<br><strong>Vignesh</strong><br>Power Smart Pty Ltd</p></div>`;
  const text = `${po.title}\n${po.ref} - ${po.period.label}\n\n${intro}\n\n` +
    po.lines.map((l) => `${l.label}: ${l.qty} x ${dollars(l.unit_cents)} = ${dollars(l.amount_cents)}`).join("\n") +
    `\n\nSubtotal (ex GST): ${dollars(po.subtotal_cents)}\nGST (${GST_PCT}%): ${dollars(po.gst_cents)}\nTotal (inc GST): ${dollars(po.total_cents)}\n\nPlease see the attached PDF for a job-by-job breakdown. If anything doesn't look right, just reply to this email.\n\nRegards,\nVignesh\nPower Smart Pty Ltd`;
  return { html, text, subject: po.title };
}

const pdfName = (po) => `${po.title}.pdf`;

// Shared by preview, PDF and send: look up the electrician, load their completed jobs, price them.
async function prepare(b, { sb, reportData, clean, isoOrNull }) {
  const from = isoOrNull(b.from), to = isoOrNull(b.to), id = clean(b.electrician_id, 40);
  if (!from || !to || from >= to) throw bad("Choose a valid date range");
  if (!id) throw bad("Choose an electrician");
  const payDate = clean(b.pay_date, 10);
  if (payDate && !/^\d{4}-\d{2}-\d{2}$/.test(payDate)) throw bad("Choose a valid pay date");
  const tech = (await sb(`electricians?id=eq.${encodeURIComponent(id)}&select=*&limit=1`))?.[0];
  if (!tech) throw bad("Electrician not found");
  const data = await reportData(from, to, id);
  return buildPo({ tech, rows: data.rows.filter((r) => r.electrician_id === id), from, to, extra: b.extra, payDate });
}

async function send(po, { to, intro, sendAs, agent }) {
  const Q = require("./_quote"), S = require("./_senders");
  to = String(to || "").trim().toLowerCase();
  if (!EMAIL_RE.test(to)) throw bad("Enter a valid email address to send the purchase order to");
  if (!po.lines.length) throw bad("There is nothing to pay for in this period. Add a line first.");
  const { html, text, subject } = renderPoEmail(po, String(intro || "").trim() || defaultIntro(po));
  const pdf = await require("./_po-pdf").renderPoPdf(po);
  const cc = String(process.env.NOTIFY_EMAIL || Q.SUPPORT_EMAIL).toLowerCase();
  const sender = S.resolveSender(sendAs);
  const { Resend } = require("./_transactional-mail");
  const { data, error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
    from: S.fromHeader(sender.key), to, ...(cc !== to ? { cc } : {}), replyTo: COMPANY.email, subject, html, text,
    attachments: [{ filename: pdfName(po), content: Buffer.from(pdf) }] });
  if (error) { const e = new Error(error.message || "Email provider rejected the request"); e.status = 502; throw e; }
  try { await require("./_maillog").logEmail({ kind: "email", sender: sender.key, agent, to_email: to, to_name: po.electrician.name, subject, body_html: html, body_text: text, provider_id: data && data.id }); } catch (_) { /* log is optional */ }
  return { ok: true, to, cc: cc !== to ? cc : null, ref: po.ref, title: po.title };
}

module.exports = { RATES, GST_PCT, COMPANY, buildPo, cleanExtra, defaultIntro, renderPoEmail, pdfName, weekEnding, prepare, send, dollars };
