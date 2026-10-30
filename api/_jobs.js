// Job schedule API for /tools/schedule, served through /api/pipeline?resource=jobs
// (underscore prefix => not its own Vercel function; the plan allows 12).
//
// Auth: header x-portal-key must match the portal passcode (same as /api/pipeline).
// Data: Supabase tables `electricians` + `jobs` (see supabase/jobs.sql).
//
// GET  ?resource=jobs&from=<ISO>&to=<ISO> → { electricians, jobs (scheduled in range), waiting (unassigned) }
// POST { action: "job_create" | "job_update" | "job_delete" | "lead_quote" | "tech_create" | "tech_update" | "report", ... }
//      report: { from, to, electrician_id?, format?: "xlsx" } → completed jobs in the range (by completion date)
// The electrician phone app (/tech) has its own API in api/_tech.js and reuses the helpers exported below.

const { sb, configured } = require("./_supabase");
const PaymentSummary = require('./_payment-summary');

// Passcode staff enter to open the portal (keep in sync with api/pipeline.js).
const PORTAL_KEY = "2026";

const STATUSES = ["scheduled", "en_route", "on_site", "completed", "cancelled"];
const TYPES = ["install", "inspection", "service"];
const STATUS_LABEL = { scheduled: "Scheduled", en_route: "En route", on_site: "On site", completed: "Completed", cancelled: "Cancelled" };

function clean(s, max) { return String(s == null ? "" : s).slice(0, max).trim(); }
function bad(msg) { const e = new Error(msg); e.status = 400; return e; }
function isoOrNull(v) {
  if (v === null || v === "" || v === undefined) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) throw bad("Invalid date/time");
  return d.toISOString();
}
function intIn(v, min, max, def) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function quantityFromText(text, pattern) {
  const match = String(text || "").match(pattern);
  return match ? Number(match[1]) || 0 : 0;
}
function sameInstant(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}
function fmtWhen(iso) {
  return new Date(iso).toLocaleString("en-AU", {
    timeZone: "Australia/Brisbane", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  });
}

const TEXT_FIELDS = { customer_name: 120, phone: 40, email: 254, address: 200, suburb: 80, postcode: 12, notes: 4000, created_by: 120 };

// Sanitise the job fields present in the request body.
function pickJob(b) {
  const f = {};
  for (const [k, max] of Object.entries(TEXT_FIELDS)) {
    if (b[k] !== undefined) f[k] = clean(b[k], max) || null;
  }
  if (f.email) f.email = f.email.toLowerCase();
  if (b.lead_id !== undefined) f.lead_id = clean(b.lead_id, 40) || null;
  if (b.electrician_id !== undefined) f.electrician_id = clean(b.electrician_id, 40) || null;
  if (b.scheduled_start !== undefined) f.scheduled_start = isoOrNull(b.scheduled_start);
  if (b.duration_min !== undefined) f.duration_min = intIn(b.duration_min, 15, 720, 60);
  if (b.alarms !== undefined) f.alarms = (b.alarms === "" || b.alarms === null) ? null : intIn(b.alarms, 0, 99, null);
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) throw bad("Invalid status");
    f.status = b.status;
  }
  if (b.work_type !== undefined) {
    if (!TYPES.includes(b.work_type)) throw bad("Invalid work type");
    f.work_type = b.work_type;
  }
  return f;
}

async function techName(id) {
  if (!id) return null;
  try {
    const r = await sb(`electricians?id=eq.${encodeURIComponent(id)}&select=name&limit=1`);
    return (r && r[0] && r[0].name) || null;
  } catch (_) { return null; }
}

// Best-effort note on the linked pipeline lead — never fails the request.
async function leadNote(leadId, author, body, kind = "status") {
  if (!leadId) return;
  try {
    await sb("lead_comments", { method: "POST", body: { lead_id: leadId, author: author || "System", kind, body }, prefer: "return=minimal" });
    await sb(`leads?id=eq.${encodeURIComponent(leadId)}`, { method: "PATCH", body: { updated_at: new Date().toISOString() }, prefer: "return=minimal" });
  } catch (e) { console.error("jobs → lead note failed:", e.message); }
}

// Latest successfully sent quote for a lead (falls back to the customer's email).
// Quantities are read from the saved quote text, same as api/quote-tracker.js.
async function latestQuote(leadId, email, ref) {
  const cols = "id,lead_id,quote_ref,quote_total,body_text,created_at";
  const reference = ref ? `&quote_ref=eq.${encodeURIComponent(ref)}` : '';
  try {
    let rows = leadId ? await sb(`sent_emails?kind=eq.quote&status=eq.sent&lead_id=eq.${encodeURIComponent(leadId)}${reference}&select=${cols}&order=created_at.desc&limit=1`) : [];
    if (!(rows && rows[0]) && email) rows = await sb(`sent_emails?kind=eq.quote&status=eq.sent&to_email=eq.${encodeURIComponent(email)}${reference}&select=${cols}&order=created_at.desc&limit=1`);
    const q = rows && rows[0];
    if (!q) return null;
    const text = q.body_text || "";
    return {
      id: q.id, lead_id: q.lead_id || null,
      ref: q.quote_ref || "",
      total: Number(q.quote_total || 0),
      service: /compliance inspection/i.test(text) ? "inspection" : "install",
      alarm_qty: quantityFromText(text, /smoke alarms[^\n]*\((\d+)\s*x\s*\$/i),
      controller_qty: quantityFromText(text, /remote controller[^\n]*\((\d+)\s*x\s*\$/i),
      sent_at: q.created_at,
    };
  } catch (_) { return null; }   // no quote log yet — the dispatcher can type the count
}

// An electrician's code is also their sign-in for the phone app, so codes must be unique.
async function codeTaken(code, exceptId) {
  if (!code) return false;
  const rows = await sb(`electricians?code=eq.${encodeURIComponent(code)}&select=id`);
  return (rows || []).some((r) => r.id !== exceptId);
}

/* ---------- completed-jobs report (who installed what — for paying electricians) ---------- */

// What went in on a job, from the electrician's invoice lines. Older saves used one
// "alarm" line + alarm_type; jobs completed in the office without an invoice only
// have the booked alarm count (type not recorded).
function installedCounts(job) {
  const c = { battery: 0, hardwired: 0, untyped: 0, controllers: 0, inspections: 0, other: [] };
  const items = Array.isArray(job.invoice_items) ? job.invoice_items : [];
  for (const i of items) {
    const qty = Number(i.qty) || 0;
    if (i.code === "alarm_battery" || (i.code === "alarm" && job.alarm_type !== "hardwired")) c.battery += qty;
    else if (i.code === "alarm_hardwired" || i.code === "alarm") c.hardwired += qty;
    else if (i.code === "controller") c.controllers += qty;
    else if (i.code === "inspection") c.inspections += qty;
    else c.other.push(`${qty} × ${i.label || "item"}`);
  }
  if (!items.length && job.alarms) c.untyped = job.alarms;
  return c;
}

const PAY_LABEL = { paid: "Paid by card", later: "To collect", none: "Nothing to pay", pending: "Card payment started", unpaid: "Not paid" };

async function reportData(from, to, techId) {
  const f = encodeURIComponent(from), t = encodeURIComponent(to);
  const range = `or=(and(completed_at.gte.${f},completed_at.lt.${t}),and(completed_at.is.null,scheduled_start.gte.${f},scheduled_start.lt.${t}))`;
  const [jobs, techs] = await Promise.all([
    sb(`jobs?status=eq.completed&${range}${techId ? `&electrician_id=eq.${encodeURIComponent(techId)}` : ""}&select=*&order=completed_at.asc.nullsfirst,scheduled_start.asc&limit=5000`),
    sb("electricians?select=id,code,name&order=sort_order.asc,name.asc"),
  ]);
  const techById = Object.fromEntries((techs || []).map((x) => [x.id, x]));
  const rows = (jobs || []).map((j) => {
    const c = installedCounts(j), tech = techById[j.electrician_id] || {};
    const invoice = j.invoice_total_cents != null ? j.invoice_total_cents / 100 : null;
    return {
      id: j.id, job_no: j.job_no, completed_at: j.completed_at || j.scheduled_start,
      electrician_id: j.electrician_id || null, electrician: tech.name || "Unassigned", electrician_code: tech.code || "",
      customer: j.customer_name || "", address: [j.address, j.suburb, j.postcode].filter(Boolean).join(", "), work_type: j.work_type,
      battery: c.battery, hardwired: c.hardwired, untyped: c.untyped, alarms: c.battery + c.hardwired + c.untyped,
      controllers: c.controllers, inspections: c.inspections, other: c.other.join(", "),
      invoice, payment: PAY_LABEL[j.pay_status] || "",
      paid: j.pay_status === "paid" ? (j.paid_cents || 0) / 100 : 0,
      to_collect: j.pay_status === "later" ? (j.amount_due_cents || 0) / 100 : 0,
      notes: j.tech_notes || "",
    };
  });
  const by = {};
  for (const r of rows) {
    const k = r.electrician_id || "none";
    const s = by[k] || (by[k] = { electrician: r.electrician, electrician_code: r.electrician_code, jobs: 0, battery: 0, hardwired: 0, untyped: 0, alarms: 0, controllers: 0, inspections: 0, invoice: 0, paid: 0, to_collect: 0 });
    s.jobs += 1;
    for (const f2 of ["battery", "hardwired", "untyped", "alarms", "controllers", "inspections", "paid", "to_collect"]) s[f2] += r[f2];
    s.invoice += r.invoice || 0;
  }
  const summary = Object.values(by).sort((a, b) => a.electrician.localeCompare(b.electrician));
  const totals = summary.reduce((acc, s) => { for (const k of Object.keys(acc)) acc[k] += s[k]; return acc; },
    { jobs: 0, battery: 0, hardwired: 0, untyped: 0, alarms: 0, controllers: 0, inspections: 0, invoice: 0, paid: 0, to_collect: 0 });
  return { from, to, rows, summary, totals };
}

function xText(v) { const s = String(v == null ? "" : v); return /^[=+\-@]/.test(s) ? `'${s}` : s; }   // no spreadsheet formulas from data

async function reportWorkbook(data, label) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "PowerSmart"; wb.created = new Date();
  const money = '"$"#,##0.00';
  function title(sheet, text, cols) {
    sheet.mergeCells(1, 1, 1, cols);
    sheet.getCell("A1").value = text;
    sheet.getCell("A1").font = { size: 16, bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B1B1F" } };
    sheet.getRow(1).height = 28;
    sheet.mergeCells(2, 1, 2, cols);
    sheet.getCell("A2").value = label;
    sheet.getCell("A2").font = { size: 10, italic: true, color: { argb: "FF41585D" } };
  }

  const sCols = [["Electrician", 24], ["Code", 9], ["Jobs", 8], ["Battery alarms", 15], ["Hardwired alarms", 17], ["Alarms (type not recorded)", 24],
    ["Total alarms", 13], ["Remote controllers", 18], ["Inspections", 12], ["Invoiced", 13], ["Paid by card", 14], ["To collect", 13]];
  const sum = wb.addWorksheet("Summary by electrician", { views: [{ state: "frozen", ySplit: 4 }] });
  title(sum, "PowerSmart – completed jobs by electrician", sCols.length);
  sum.columns = sCols.map(([, width]) => ({ width }));
  const sRow = (s, name) => [xText(name || s.electrician), xText(s.electrician_code || ""), s.jobs, s.battery, s.hardwired, s.untyped, s.alarms, s.controllers, s.inspections, s.invoice, s.paid, s.to_collect];
  const sRows = data.summary.length ? data.summary.map((s) => sRow(s)) : [sRow({ ...data.totals, electrician_code: "" }, "No completed jobs")];
  sum.addTable({
    name: "ElectricianSummary", ref: "A4", headerRow: true, totalsRow: true, style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: sCols.map(([name], i) => (i === 0 ? { name, totalsRowLabel: "Total", filterButton: false }
      : i === 1 ? { name, totalsRowFunction: "none", filterButton: false }
      : { name, totalsRowFunction: "sum", filterButton: false })),
    rows: sRows,
  });
  [10, 11, 12].forEach((c) => { sum.getColumn(c).numFmt = money; });

  const jCols = [["Completed", 18], ["Job", 9], ["Electrician", 22], ["Code", 9], ["Customer", 24], ["Address", 40], ["Work type", 11],
    ["Battery alarms", 15], ["Hardwired alarms", 17], ["Alarms (type not recorded)", 24], ["Total alarms", 13], ["Remote controllers", 18],
    ["Inspections", 12], ["Other items", 30], ["Invoice", 12], ["Payment", 16], ["Paid by card", 14], ["To collect", 13], ["Electrician notes", 40]];
  const js = wb.addWorksheet("Jobs", { views: [{ state: "frozen", ySplit: 4 }] });
  title(js, "PowerSmart – completed jobs", jCols.length);
  js.columns = jCols.map(([, width]) => ({ width }));
  js.addTable({
    name: "CompletedJobs", ref: "A4", headerRow: true, style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: jCols.map(([name]) => ({ name, filterButton: true })),
    rows: data.rows.length ? data.rows.map((r) => [new Date(r.completed_at), "J" + r.job_no, xText(r.electrician), xText(r.electrician_code), xText(r.customer), xText(r.address), xText(r.work_type),
      r.battery, r.hardwired, r.untyped, r.alarms, r.controllers, r.inspections, xText(r.other), r.invoice, r.payment, r.paid, r.to_collect, xText(r.notes)])
      : [[null, "", "No completed jobs in this period", "", "", "", "", 0, 0, 0, 0, 0, 0, "", null, "", 0, 0, ""]],
  });
  js.getColumn(1).numFmt = "ddd dd/mm/yyyy";
  [15, 17, 18].forEach((c) => { js.getColumn(c).numFmt = money; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function scheduleText(job, tech) {
  if (job.electrician_id && job.scheduled_start) return `assigned to ${tech || "an electrician"} for ${fmtWhen(job.scheduled_start)}`;
  return "added to the waiting list";
}

module.exports = async (req, res) => {
  if ((req.headers["x-portal-key"] || "") !== PORTAL_KEY) {
    return res.status(401).json({ error: "Invalid portal key" });
  }
  if (!configured()) return res.status(500).json({ error: "Supabase is not configured (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" });

  try {
    if (req.method === "GET") {
      const u = new URL(req.url || "/", "http://local");
      const from = isoOrNull(u.searchParams.get("from"));
      const to = isoOrNull(u.searchParams.get("to"));
      if (!from || !to) return res.status(400).json({ error: "from and to are required" });

      const [electricians, jobs, waiting] = await Promise.all([
        sb("electricians?select=*&order=sort_order.asc,name.asc"),
        sb(`jobs?select=*&electrician_id=not.is.null&scheduled_start=gte.${encodeURIComponent(from)}&scheduled_start=lt.${encodeURIComponent(to)}&order=scheduled_start.asc&limit=2000`),
        sb("jobs?select=*&or=(electrician_id.is.null,scheduled_start.is.null)&status=not.in.(completed,cancelled)&order=created_at.desc&limit=300"),
      ]);
      return res.status(200).json({ electricians: electricians || [], jobs: jobs || [], waiting: waiting || [] });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const b = req.body || {};
    const actor = clean(b.actor, 120) || "Office";

    if (b.action === "job_create") {
      const f = pickJob(b);
      if (!f.customer_name) return res.status(400).json({ error: "Customer name is required" });
      f.created_by = actor;
      const quote = f.lead_id ? await latestQuote(f.lead_id, f.email) : null;
      f.quote_ref = quote && quote.lead_id === f.lead_id ? quote.ref : null;
      const rows = await sb("jobs", { method: "POST", body: f });
      const job = rows && rows[0];
      if (job && job.lead_id) {
        const tech = await techName(job.electrician_id);
        await leadNote(job.lead_id, actor, `🛠 Job J${job.job_no} created — ${scheduleText(job, tech)}.`);
      }
      return res.status(200).json({ ok: true, job });
    }

    if (b.action === "job_update") {
      const id = clean(b.id, 40);
      if (!id) return res.status(400).json({ error: "id is required" });
      const prevRows = await sb(`jobs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
      const prev = prevRows && prevRows[0];
      if (!prev) return res.status(404).json({ error: "Job not found" });

      const f = pickJob(b);
      delete f.created_by;
      if (f.lead_id !== undefined && f.lead_id !== prev.lead_id) {
        if (prev.pay_status === 'paid' || prev.pay_session_id) throw bad('A job with a card payment cannot be moved to another customer.');
        const quote = f.lead_id ? await latestQuote(f.lead_id, f.email || prev.email) : null;
        f.quote_ref = quote && quote.lead_id === f.lead_id ? quote.ref : null;
      }
      if ("customer_name" in f && !f.customer_name) return res.status(400).json({ error: "Customer name can't be empty" });
      if (!Object.keys(f).length) return res.status(400).json({ error: "Nothing to update" });
      // completion date drives the weekly report
      if (f.status === "completed" && prev.status !== "completed") f.completed_at = new Date().toISOString();
      else if (f.status && f.status !== "completed" && prev.status === "completed") f.completed_at = null;

      const rows = await sb(`jobs?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: f });
      const job = rows && rows[0];

      if (job && job.lead_id) {
        const tech = await techName(job.electrician_id);
        if (f.status === "completed" && prev.status !== "completed") {
          try {
            await sb(`leads?id=eq.${encodeURIComponent(job.lead_id)}`, { method: "PATCH", body: { stage: "won" }, prefer: "return=minimal" });
          } catch (e) { console.error("jobs → lead stage update failed:", e.message); }
          await leadNote(job.lead_id, actor, `✅ Job J${job.job_no} completed${tech ? " by " + tech : ""}.`);
        } else if (f.status && f.status !== prev.status) {
          await leadNote(job.lead_id, actor, `🛠 Job J${job.job_no} status: ${STATUS_LABEL[f.status]}.`);
        } else if ((f.electrician_id !== undefined && f.electrician_id !== prev.electrician_id) ||
                   (f.scheduled_start !== undefined && !sameInstant(f.scheduled_start, prev.scheduled_start))) {
          await leadNote(job.lead_id, actor, `🛠 Job J${job.job_no} ${scheduleText(job, tech)}.`);
        }
      }
      return res.status(200).json({ ok: true, job });
    }

    // Back to Assigned: wipe the electrician's work (alarms, invoice, notes, sign-off) so another electrician can
    // start fresh. Payments received and Dropbox photos are kept.
    if (b.action === "job_revert") {
      const id = clean(b.id, 40);
      if (!id) return res.status(400).json({ error: "id is required" });
      const prevRows = await sb(`jobs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
      const prev = prevRows && prevRows[0];
      if (!prev) return res.status(404).json({ error: "Job not found" });
      const f = {
        status: "scheduled", completed_at: null, tech_notes: null,
        invoice_items: null, invoice_total_cents: null, amount_due_cents: null, alarms_installed: null, alarm_type: null, alarm_units: null,
        approved_at: null, signoff_name: null, signoff_signature: null, signoff_at: null, invoice_emailed_at: null, certificate_sent_at: null,
      };
      if (prev.pay_status !== "paid" && prev.pay_status !== "pending") f.pay_status = "unpaid";
      const rows = await sb(`jobs?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: f });
      const job = rows && rows[0];
      if (job && job.lead_id) {
        if (prev.status === "completed") {
          try {
            const others = await sb(`jobs?lead_id=eq.${encodeURIComponent(job.lead_id)}&status=eq.completed&id=neq.${encodeURIComponent(id)}&select=id&limit=1`);
            if (!others || !others.length) await sb(`leads?id=eq.${encodeURIComponent(job.lead_id)}&stage=eq.won`, { method: "PATCH", body: { stage: "scheduled" }, prefer: "return=minimal" });
          } catch (e) { console.error("jobs → lead stage revert failed:", e.message); }
        }
        await leadNote(job.lead_id, actor, `↩ Job J${job.job_no} reverted to Assigned — electrician's work cleared; payments and photos kept.`);
      }
      return res.status(200).json({ ok: true, job });
    }

    // Office records the balance of a completed job (pay-later invoice) as received. Full payment releases the certificate.
    if (b.action === "job_mark_paid") {
      const id = clean(b.id, 40);
      const method = String(b.method || "");
      if (!["bank_transfer", "cash", "card"].includes(method)) return res.status(400).json({ error: "Choose how the payment was received" });
      const prev = (await sb(`jobs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`))?.[0];
      if (!prev) return res.status(404).json({ error: "Job not found" });
      if (prev.status !== "completed" || prev.pay_status !== "later") return res.status(409).json({ error: "Only a completed job with an invoice owing can be marked paid." });
      const rows = await sb(`jobs?id=eq.${encodeURIComponent(id)}&pay_status=eq.later`, { method: "PATCH", body: { pay_status: "paid", pay_method: method, paid_cents: prev.amount_due_cents || 0, paid_at: new Date().toISOString() } });
      const job = rows && rows[0];
      if (!job) return res.status(409).json({ error: "This job was already updated. Refresh and check." });
      await leadNote(job.lead_id, actor, `💵 Job J${job.job_no} balance of $${((prev.amount_due_cents || 0) / 100).toFixed(2)} received (${method.replace("_", " ")}) and marked paid.`, "payment");
      const { invoice, certificate } = await require("./_after-payment").releaseAfterPayment(job.id, { agent: actor });
      return res.status(200).json({ ok: true, job, invoice, certificate });
    }

    // (Re)send the compliance certificate PDF for a completed, fully paid job.
    if (b.action === "certificate_send") {
      const id = clean(b.id, 40);
      if (!id) return res.status(400).json({ error: "id is required" });
      const certificate = await require("./_certificate").issueCertificate(id, { agent: actor, force: b.force === true });
      if (certificate.status === "failed") return res.status(502).json({ error: certificate.reason || "Certificate could not be sent", certificate });
      return res.status(200).json({ ok: true, certificate });
    }

    if (b.action === "report") {
      const from = isoOrNull(b.from), to = isoOrNull(b.to);
      if (!from || !to || from >= to) return res.status(400).json({ error: "Choose a valid date range" });
      const data = await reportData(from, to, clean(b.electrician_id, 40));
      if (b.format !== "xlsx") return res.status(200).json(data);
      const label = clean(b.label, 120) || `${fmtWhen(from)} – ${fmtWhen(to)}`;
      const file = await reportWorkbook(data, `Completed ${label} · exported ${new Date().toLocaleString("en-AU", { timeZone: "Australia/Brisbane" })}`);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="powersmart-jobs-${from.slice(0, 10)}.xlsx"`);
      return res.status(200).send(file);
    }

    // Latest sent quote for a lead → alarm/controller counts for the job card.
    if (b.action === "lead_quote") {
      let leadId = clean(b.lead_id, 40), email = clean(b.email, 254).toLowerCase(), ref = '';
      if (b.job_id) {
        const rows = await sb(`jobs?id=eq.${encodeURIComponent(clean(b.job_id, 40))}&select=lead_id,email,quote_ref&limit=1`);
        if (!rows?.[0]) return res.status(404).json({ error: 'Job not found' });
        leadId = rows[0].lead_id; email = rows[0].email; ref = rows[0].quote_ref;
      }
      if (!leadId && !email) return res.status(400).json({ error: "lead_id or email is required" });
      const quote = await latestQuote(leadId, email, ref);
      let payment = null, payment_error = null;
      if (quote) {
        try { payment = await PaymentSummary.read({ lead_id: quote.lead_id, quote_ref: quote.ref, quote_total: quote.total }); }
        catch (error) { console.error('Job payment summary failed:', error.message); payment_error = 'Payment details could not be loaded. Please refresh before relying on the balance.'; }
      }
      return res.status(200).json({ quote, payment, payment_error });
    }

    // Removes the job from the schedule only — the linked pipeline lead is kept (just noted).
    if (b.action === "job_delete") {
      const id = clean(b.id, 40);
      if (!id) return res.status(400).json({ error: "id is required" });
      const prevRows = await sb(`jobs?id=eq.${encodeURIComponent(id)}&select=job_no,lead_id&limit=1`);
      const prev = prevRows && prevRows[0];
      await sb(`jobs?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", prefer: "return=minimal" });
      if (prev && prev.lead_id) await leadNote(prev.lead_id, actor, `🗑 Job J${prev.job_no} removed from the schedule.`);
      return res.status(200).json({ ok: true });
    }

    if (b.action === "tech_create" || b.action === "tech_update") {
      const f = {};
      if (b.name !== undefined) f.name = clean(b.name, 120);
      if (b.code !== undefined) f.code = clean(b.code, 20) || null;
      if (b.phone !== undefined) f.phone = clean(b.phone, 40) || null;
      if (b.email !== undefined) f.email = clean(b.email, 254).toLowerCase() || null;
      if (b.licence_no !== undefined) f.licence_no = clean(b.licence_no, 40) || null;
      if (b.active !== undefined) f.active = Boolean(b.active);
      if (b.sort_order !== undefined) f.sort_order = intIn(b.sort_order, 0, 9999, 0);
      if (f.code && await codeTaken(f.code, b.action === "tech_update" ? clean(b.id, 40) : null)) {
        return res.status(400).json({ error: `Code ${f.code} is already used by another electrician` });
      }

      if (b.action === "tech_create") {
        if (!f.name) return res.status(400).json({ error: "Electrician name is required" });
        const rows = await sb("electricians", { method: "POST", body: f });
        return res.status(200).json({ ok: true, electrician: rows && rows[0] });
      }
      const id = clean(b.id, 40);
      if (!id) return res.status(400).json({ error: "id is required" });
      if ("name" in f && !f.name) return res.status(400).json({ error: "Name can't be empty" });
      if (!Object.keys(f).length) return res.status(400).json({ error: "Nothing to update" });
      const rows = await sb(`electricians?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: f });
      return res.status(200).json({ ok: true, electrician: rows && rows[0] });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || "Jobs error" });
  }
};

// Shared with api/_tech.js (electrician app).
Object.assign(module.exports, { STATUS_LABEL, clean, intIn, fmtWhen, techName, leadNote, latestQuote });
