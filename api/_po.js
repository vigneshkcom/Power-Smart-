// Purchase orders for electricians (contractors): what they did in a period, priced at the contractor rates,
// plus any extra lines the office adds. Served through the jobs API (actions po_preview / po_send).
// All amounts are in cents and EXCLUDE GST. Underscore prefix => not a Vercel route.

// What the electrician is paid, ex GST. Alarms with no recorded type are paid as battery for now.
const RATES = { callout: 3000, hardwired: 1300, battery: 1000, controller: 1000 };
const TZ = "Australia/Brisbane";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(msg) { const e = new Error(msg); e.status = 400; return e; }
const dollars = (c) => (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brisbane = (d, o) => new Intl.DateTimeFormat("en-AU", { timeZone: TZ, ...o }).format(d);
const longDate = (d) => brisbane(d, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const shortDate = (d) => brisbane(d, { weekday: "short", day: "numeric", month: "short" }).replace(",", "");

function jobPay(r) {
  return RATES.callout + (r.battery + r.untyped) * RATES.battery + r.hardwired * RATES.hardwired + r.controllers * RATES.controller;
}

// Extra lines typed by the office: [{ label, qty, price }] with price in dollars (negative for a deduction).
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

// rows: the electrician's completed jobs from reportData(). Warranty visits are not paid here.
function buildPo({ tech, rows, from, to, extra, payDate }) {
  const jobs = rows.filter((r) => r.work_type !== "warranty");
  const sum = (k) => jobs.reduce((n, r) => n + (r[k] || 0), 0);
  const battery = sum("battery") + sum("untyped"), hardwired = sum("hardwired"), controllers = sum("controllers");
  const lines = [
    { label: "Call-out", qty: jobs.length, unit_cents: RATES.callout },
    { label: "Battery smoke alarm installed", qty: battery, unit_cents: RATES.battery },
    { label: "Hardwired smoke alarm installed", qty: hardwired, unit_cents: RATES.hardwired },
    { label: "Remote controller installed", qty: controllers, unit_cents: RATES.controller },
  ].filter((l) => l.qty > 0).map((l) => ({ ...l, amount_cents: l.qty * l.unit_cents }));
  const all = lines.concat(cleanExtra(extra));
  const first = new Date(from), last = new Date(Date.parse(to) - 60000);   // "to" is the start of the day after the period
  const ref = `PO-${String(tech.code || "ELEC").replace(/[^A-Za-z0-9]/g, "")}-${brisbane(first, { year: "numeric", month: "2-digit", day: "2-digit" }).split("/").reverse().join("")}`;
  return {
    ref, electrician: { id: tech.id, name: tech.name, code: tech.code || "", email: tech.email || "" },
    period: { from, to, label: `${shortDate(first)} to ${shortDate(last)} ${brisbane(last, { year: "numeric" })}` },
    pay_date: payDate, pay_date_label: payDate ? longDate(new Date(payDate + "T00:00:00+10:00")) : "",
    lines: all, jobs: jobs.map((r) => ({ completed_at: r.completed_at, job_no: r.job_no, address: r.address, battery: r.battery + r.untyped, hardwired: r.hardwired, controllers: r.controllers, amount_cents: jobPay(r) })),
    total_cents: all.reduce((n, l) => n + l.amount_cents, 0),
  };
}

function defaultIntro(po) {
  const raw = String(po.electrician.name || "").trim().split(/\s+/)[0] || "there";
  const first = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();   // names are stored in capitals
  return `Hi ${first},\n\nThis is your purchase order for the work you completed ${po.period.label}.${po.pay_date_label ? `\n\nThis will be paid on ${po.pay_date_label}.` : ""}`;
}

function renderPoEmail(po, intro) {
  const Q = require("./_quote"), esc = Q.escapeHtml, S = require("./_senders");
  const cell = "padding:7px 10px;border-bottom:1px solid #E5EEEF;";
  const head = (cols) => `<tr style="background:#F4F9FA;color:#0B1B1F;font-weight:bold;">${cols.map(([t, a]) => `<td align="${a || "left"}" style="${cell}">${t}</td>`).join("")}</tr>`;
  const para = String(intro || "").split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;color:#41585D;font-size:14px;line-height:1.6;">
<div style="font-size:18px;font-weight:bold;color:#0B1B1F;margin-bottom:2px;">Purchase order ${esc(po.ref)}</div>
<div style="font-size:12px;color:#8AA0A5;margin-bottom:14px;">${esc(po.electrician.name)} &middot; ${esc(po.period.label)}</div>
${para}
<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;margin:6px 0 14px;">
${head([["Item"], ["Qty", "right"], ["Rate", "right"], ["Amount", "right"]])}
${po.lines.map((l) => `<tr><td style="${cell}">${esc(l.label)}</td><td align="right" style="${cell}">${l.qty}</td><td align="right" style="${cell}">${dollars(l.unit_cents)}</td><td align="right" style="${cell}">${dollars(l.amount_cents)}</td></tr>`).join("")}
<tr><td colspan="3" style="padding:9px 10px;font-weight:bold;color:#0B1B1F;background:#F4F9FA;">Total (excluding GST)</td><td align="right" style="padding:9px 10px;font-weight:bold;color:#0B1B1F;background:#F4F9FA;">${dollars(po.total_cents)}</td></tr>
</table>
${po.jobs.length ? `<div style="font-weight:bold;color:#0B1B1F;margin-bottom:4px;">Jobs included</div>
<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:12px;">
${head([["Date"], ["Job"], ["Address"], ["Battery", "right"], ["Hardwired", "right"], ["Remote", "right"], ["Amount", "right"]])}
${po.jobs.map((j) => `<tr><td style="${cell}">${esc(shortDate(new Date(j.completed_at)))}</td><td style="${cell}">J${esc(j.job_no)}</td><td style="${cell}">${esc(j.address)}</td><td align="right" style="${cell}">${j.battery}</td><td align="right" style="${cell}">${j.hardwired}</td><td align="right" style="${cell}">${j.controllers}</td><td align="right" style="${cell}">${dollars(j.amount_cents)}</td></tr>`).join("")}
</table>` : ""}
<p style="font-size:12px;color:#8AA0A5;margin-top:12px;">All amounts exclude GST. Each job includes the call-out fee. Reply to this email if anything looks wrong.</p>
${S.signatureHtml("customer_service")}</div>`;
  const text = `Purchase order ${po.ref}\n${po.electrician.name} - ${po.period.label}\n\n${intro}\n\n` +
    po.lines.map((l) => `${l.label}: ${l.qty} x ${dollars(l.unit_cents)} = ${dollars(l.amount_cents)}`).join("\n") +
    `\n\nTotal (excluding GST): ${dollars(po.total_cents)}\n\nJobs included:\n` +
    po.jobs.map((j) => `${shortDate(new Date(j.completed_at))} J${j.job_no} ${j.address} - ${dollars(j.amount_cents)}`).join("\n") +
    `\n\nAll amounts exclude GST. Each job includes the call-out fee.`;
  return { html, text, subject: `Purchase order ${po.ref} - ${po.period.label}` };
}

// Shared by preview and send: look up the electrician, load their completed jobs, price them.
async function prepare(b, { sb, reportData, clean, isoOrNull }) {
  const from = isoOrNull(b.from), to = isoOrNull(b.to), id = clean(b.electrician_id, 40);
  if (!from || !to || from >= to) throw bad("Choose a valid date range");
  if (!id) throw bad("Choose an electrician");
  const payDate = clean(b.pay_date, 10);
  if (payDate && !/^\d{4}-\d{2}-\d{2}$/.test(payDate)) throw bad("Choose a valid pay date");
  const tech = (await sb(`electricians?id=eq.${encodeURIComponent(id)}&select=id,code,name,email&limit=1`))?.[0];
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
  const cc = String(process.env.NOTIFY_EMAIL || Q.SUPPORT_EMAIL).toLowerCase();
  const sender = S.resolveSender(sendAs);
  const { Resend } = require("./_transactional-mail");
  const { data, error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
    from: S.fromHeader(sender.key), to, ...(cc !== to ? { cc } : {}), replyTo: process.env.RESEND_REPLY_TO || Q.SUPPORT_EMAIL, subject, html, text });
  if (error) { const e = new Error(error.message || "Email provider rejected the request"); e.status = 502; throw e; }
  try { await require("./_maillog").logEmail({ kind: "email", sender: sender.key, agent, to_email: to, to_name: po.electrician.name, subject, body_html: html, body_text: text, provider_id: data && data.id }); } catch (_) { /* log is optional */ }
  return { ok: true, to, cc: cc !== to ? cc : null, ref: po.ref };
}

module.exports = { RATES, buildPo, cleanExtra, defaultIntro, renderPoEmail, prepare, send };
