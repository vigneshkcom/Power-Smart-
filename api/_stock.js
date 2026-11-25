// Stock tracker, served through /api/pipeline?resource=jobs (actions stock_summary / stock_move).
// Stock on hand = what the electrician was given (stock_movements, see supabase/stock.sql)
//               - what they installed on completed jobs since their first stock entry
//               - alarms they replaced on warranty jobs (supabase/warranty-jobs.sql).
// Faulty alarms with the electrician = alarms replaced on warranty jobs - faulty alarms the office took back
//               (stock_movements with condition 'faulty').
const { sb } = require("./_supabase");

const PRODUCTS = ["hardwired", "battery", "controller"];
const KIND = { issue: 1, return: -1, adjust: 0 };   // adjust keeps the sign the user typed
const ALARMS = ["battery", "hardwired"];             // the only products that can be faulty
const BNE_MS = 10 * 3600e3;                          // Brisbane is UTC+10, no daylight saving

function bad(msg) { const e = new Error(msg); e.status = 400; return e; }

// Brisbane midnight (as an ISO instant) of the day the first stock was recorded.
function trackingStart(iso) {
  const d = new Date(Date.parse(iso) + BNE_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - BNE_MS).toISOString();
}

// installedCounts is passed in from _jobs.js to avoid a circular require.
function buildSummary(techs, moves, jobs, installedCounts) {
  const blank = () => ({ hardwired: 0, battery: 0, controller: 0 });
  const rows = new Map(techs.map((t) => [t.id, { electrician_id: t.id, code: t.code || "", name: t.name, active: t.active !== false, since: null, given: blank(), installed: blank(), warranty_used: blank(), on_hand: blank(), unclassified: 0,
    issued: blank(), returned: blank(), adjusted: blank(), faulty_collected: blank(), faulty_taken_back: blank(), faulty_held: blank() }]));
  for (const m of moves) {
    const r = rows.get(m.electrician_id); if (!r || !PRODUCTS.includes(m.product)) continue;
    if (m.condition === "faulty") r.faulty_taken_back[m.product] -= m.qty;   // stored negative: taken off the electrician
    else {
      r.given[m.product] += m.qty;
      if (m.kind === "adjust") r.adjusted[m.product] += m.qty;
      else if (m.qty > 0) r.issued[m.product] += m.qty;
      else r.returned[m.product] -= m.qty;
    }
    if (!r.since || m.created_at < r.since) r.since = m.created_at;
  }
  for (const r of rows.values()) if (r.since) r.since = trackingStart(r.since);
  for (const j of jobs) {
    const r = rows.get(j.electrician_id);
    if (!r || !r.since || (j.completed_at || "") < r.since) continue;
    const c = installedCounts(j);
    r.installed.hardwired += c.hardwired + (c.warranty_hardwired || 0); r.installed.battery += c.battery + (c.warranty_battery || 0); r.installed.controller += c.controllers;
    r.warranty_used.hardwired += c.warranty_hardwired || 0; r.warranty_used.battery += c.warranty_battery || 0;
    r.faulty_collected.hardwired += c.warranty_hardwired || 0; r.faulty_collected.battery += c.warranty_battery || 0;
    r.unclassified += c.untyped;
  }
  for (const r of rows.values()) for (const p of PRODUCTS) {
    r.on_hand[p] = r.given[p] - r.installed[p];
    r.faulty_held[p] = r.faulty_collected[p] - r.faulty_taken_back[p];
  }
  return [...rows.values()].filter((r) => r.since || r.active);
}


// Read every page: PostgREST may cap a response below the requested limit.
async function allRows(query) {
  const rows = [];
  for (;;) {
    const page = await sb(query + "&limit=500&offset=" + rows.length) || [];
    if (!page.length) return rows;
    rows.push(...page);
  }
}

// Chronological ledger. Balance snapshots are per electrician and calculated
// before UI filtering, so searching or paging never resets the running balance.
function buildLedger(techs, moves, jobs, installedCounts) {
  const byId = new Map(techs.map(t => [t.electrician_id, t]));
  const blank = () => ({ hardwired: 0, battery: 0, controller: 0 });
  const entries = [];
  for (const m of moves) {
    if (!byId.has(m.electrician_id) || !PRODUCTS.includes(m.product)) continue;
    const delta = blank(), faulty_delta = blank();
    (m.condition === "faulty" ? faulty_delta : delta)[m.product] = m.qty;
    entries.push({ id: "move:" + m.id, at: m.created_at, electrician_id: m.electrician_id,
      kind: m.condition === "faulty" ? "faulty_return" : m.kind || (m.qty > 0 ? "issue" : "return"),
      product: m.product, delta, faulty_delta, note: m.note || "", by: m.created_by || "", unclassified: 0 });
  }
  for (const j of jobs) {
    const t = byId.get(j.electrician_id);
    if (!t || !t.since || (j.completed_at || "") < t.since) continue;
    const c = installedCounts(j), delta = blank(), faulty_delta = blank();
    delta.hardwired = -(c.hardwired + (c.warranty_hardwired || 0));
    delta.battery = -(c.battery + (c.warranty_battery || 0));
    delta.controller = -c.controllers;
    faulty_delta.hardwired = c.warranty_hardwired || 0;
    faulty_delta.battery = c.warranty_battery || 0;
    if (!PRODUCTS.some(p => delta[p] || faulty_delta[p]) && !c.untyped) continue;
    entries.push({ id: "job:" + j.id, at: j.completed_at, electrician_id: j.electrician_id,
      kind: j.work_type === "warranty" ? "warranty" : "job", job_id: j.id, job_no: j.job_no,
      customer: j.customer_name || "", address: [j.address,j.suburb].filter(Boolean).join(", "),
      delta, faulty_delta, unclassified: c.untyped || 0,
      note: j.work_type === "warranty" ? "Replacement stock used; faulty alarms to hand back" : "Stock used on completed job", by: "" });
  }
  entries.sort((a,b) => Date.parse(a.at)-Date.parse(b.at) || (a.id.startsWith("move:") ? 0 : 1)-(b.id.startsWith("move:") ? 0 : 1) || a.id.localeCompare(b.id));
  const balances = new Map();
  for (const e of entries) {
    const t = byId.get(e.electrician_id);
    e.electrician = t.name; e.code = t.code;
    let b = balances.get(e.electrician_id);
    if (!b) { b = { good: blank(), faulty: blank() }; balances.set(e.electrician_id,b); }
    for (const p of PRODUCTS) { b.good[p] += e.delta[p]; b.faulty[p] += e.faulty_delta[p]; }
    e.balance = { ...b.good }; e.faulty_balance = { ...b.faulty };
  }
  return entries;
}

async function load(installedCounts) {
  const [techs, moves] = await Promise.all([
    allRows("electricians?select=id,code,name,active&order=sort_order.asc,name.asc,id.asc"),
    allRows("stock_movements?select=*&order=created_at.desc,id.desc"),
  ]);
  const list = moves || [];
  let jobs = [];
  if (list.length) {
    const first = list.reduce((a, m) => (m.created_at < a ? m.created_at : a), list[0].created_at);
    jobs = await allRows(`jobs?status=eq.completed&electrician_id=not.is.null&completed_at=gte.${encodeURIComponent(trackingStart(first))}&select=id,job_no,electrician_id,completed_at,invoice_items,alarm_type,alarms,work_type,alarm_units,customer_name,address,suburb&order=completed_at.asc,id.asc`) || [];
  }
  const names = Object.fromEntries((techs || []).map((t) => [t.id, t.name]));
  // Every alarm replaced on a completed warranty job, newest first: the faulty alarm register.
  const warrantyJobs = jobs.filter(j => j.work_type === "warranty").slice().reverse();
  const faulty = [];
  for (const j of warrantyJobs) for (const u of Array.isArray(j.alarm_units) ? j.alarm_units : []) {
    if (!u || u.outcome !== "replaced") continue;
    faulty.push({ electrician_id: j.electrician_id, completed_at: j.completed_at, job_no: j.job_no, electrician: names[j.electrician_id] || "", customer: j.customer_name || "", suburb: j.suburb || "",
      location: u.location || "", type: u.type === "hardwired" ? "hardwired" : "battery", fault: u.fault || "" });
  }
  const electricians = buildSummary(techs || [], list, jobs, installedCounts);
  return {
    jobs, all: list, names, faulty, ledger: buildLedger(electricians, list, jobs, installedCounts),
    electricians,
    movements: list.slice(0, 60).map((m) => ({ id: m.id, created_at: m.created_at, electrician: names[m.electrician_id] || "", product: m.product, qty: m.qty, kind: m.kind, condition: m.condition || "good", note: m.note || "", created_by: m.created_by || "" })),
  };
}

async function summary(installedCounts) {
  const { electricians, movements, faulty, ledger } = await load(installedCounts);
  return { electricians, movements, faulty, ledger };
}

const LABEL = { hardwired: "Hardwired smoke alarm", battery: "Battery smoke alarm", controller: "Controller" };
const xText = (v) => { const t = String(v == null ? "" : v); return /^[=+\-@]/.test(t) ? `'${t}` : t; };
const bneDate = (iso) => new Date(iso).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", weekday: "short", day: "numeric", month: "short", year: "numeric" });

// Excel: what each electrician was given, installed, and should still have.
async function workbook(data, installedCounts, techId) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook(); wb.creator = "PowerSmart"; wb.created = new Date();
  const techs = data.electricians.filter((t) => t.since && (!techId || t.electrician_id === techId));
  const ids = new Set(techs.map((t) => t.electrician_id));
  const stamp = "Exported " + new Date().toLocaleString("en-AU", { timeZone: "Australia/Brisbane" });
  const banner = (sheet, text, cols) => {
    sheet.mergeCells(1, 1, 1, cols); const c = sheet.getCell("A1"); c.value = text;
    c.font = { size: 16, bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B1B1F" } }; sheet.getRow(1).height = 28;
    sheet.mergeCells(2, 1, 2, cols); sheet.getCell("A2").value = stamp; sheet.getCell("A2").font = { size: 10, italic: true, color: { argb: "FF41585D" } };
  };
  const sCols = [["Electrician", 24], ["Code", 9], ["Counting installs from", 22]];
  PRODUCTS.forEach((p) => ["given", "returned", "corrections", "installed", "warranty used", "remaining"].forEach((k) => sCols.push([`${LABEL[p]} ${k}`, 20])));
  sCols.push(["Alarms of unknown type (not counted)", 30]);
  ALARMS.forEach((p) => sCols.push([`Faulty ${p} alarms with electrician`, 22]));
  const s1 = wb.addWorksheet("Stock summary", { views: [{ state: "frozen", ySplit: 4 }] });
  banner(s1, "PowerSmart - stock by electrician", sCols.length);
  s1.columns = sCols.map(([, width]) => ({ width }));
  s1.addTable({ name: "StockSummary", ref: "A4", headerRow: true, style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: sCols.map(([name]) => ({ name, filterButton: false })),
    rows: techs.length ? techs.map((t) => [xText(t.name), xText(t.code), bneDate(t.since), ...PRODUCTS.flatMap((p) => [t.issued[p], t.returned[p], t.adjusted[p], t.installed[p] - t.warranty_used[p], t.warranty_used[p], t.on_hand[p]]), t.unclassified, ...ALARMS.map((p) => t.faulty_held[p])])
      : [["No stock recorded yet", "", "", ...PRODUCTS.flatMap(() => [0, 0, 0, 0, 0, 0]), 0, 0, 0]] });

  const jCols = [["Completed", 18], ["Job", 9], ["Electrician", 22], ["Customer", 24], ["Address", 40], ["Hardwired alarms", 17], ["Battery alarms", 15], ["Controllers", 13], ["Type not recorded", 18]];
  const s2 = wb.addWorksheet("Installed", { views: [{ state: "frozen", ySplit: 4 }] });
  banner(s2, "PowerSmart - what was installed", jCols.length);
  s2.columns = jCols.map(([, width]) => ({ width }));
  const rows = data.jobs.filter((j) => ids.has(j.electrician_id) && (j.completed_at || "") >= data.electricians.find((t) => t.electrician_id === j.electrician_id).since).map((j) => {
    const c = installedCounts(j);
    return [bneDate(j.completed_at), "J" + j.job_no, xText(data.names[j.electrician_id]), xText(j.customer_name), xText([j.address, j.suburb].filter(Boolean).join(", ")), c.hardwired + (c.warranty_hardwired || 0), c.battery + (c.warranty_battery || 0), c.controllers, c.untyped];
  });
  s2.addTable({ name: "InstalledJobs", ref: "A4", headerRow: true, style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: jCols.map(([name]) => ({ name, filterButton: true })), rows: rows.length ? rows : [["", "", "No installs yet", "", "", 0, 0, 0, 0]] });

  const mCols = [["When", 22], ["Electrician", 22], ["Product", 24], ["Qty", 8], ["Type", 12], ["Note", 40], ["By", 16]];
  const s3 = wb.addWorksheet("Stock entries", { views: [{ state: "frozen", ySplit: 4 }] });
  banner(s3, "PowerSmart - stock given and taken back", mCols.length);
  s3.columns = mCols.map(([, width]) => ({ width }));
  const mv = data.all.filter((m) => !techId || m.electrician_id === techId).map((m) => [new Date(m.created_at).toLocaleString("en-AU", { timeZone: "Australia/Brisbane" }), xText(data.names[m.electrician_id]), LABEL[m.product] || m.product, m.qty, m.kind, xText(m.note), xText(m.created_by)]);
  s3.addTable({ name: "StockEntries", ref: "A4", headerRow: true, style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: mCols.map(([name]) => ({ name, filterButton: true })), rows: mv.length ? mv : [["", "", "No entries", 0, "", "", ""]] });
  const fCols = [["Completed", 18], ["Job", 9], ["Electrician", 22], ["Customer", 24], ["Suburb", 18], ["Location", 16], ["Type", 12], ["Fault", 26]];
  const s4 = wb.addWorksheet("Faulty alarms", { views: [{ state: "frozen", ySplit: 4 }] });
  banner(s4, "PowerSmart - faulty alarms replaced under warranty", fCols.length);
  s4.columns = fCols.map(([, width]) => ({ width }));
  const fr = (data.faulty || []).filter((f) => !techId || f.electrician === data.names[techId])
    .map((f) => [bneDate(f.completed_at), "J" + f.job_no, xText(f.electrician), xText(f.customer), xText(f.suburb), xText(f.location), f.type, xText(f.fault)]);
  s4.addTable({ name: "FaultyAlarms", ref: "A4", headerRow: true, style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: fCols.map(([name]) => ({ name, filterButton: true })), rows: fr.length ? fr : [["", "", "No faulty alarms yet", "", "", "", "", ""]] });

  const lCols = [["When",23],["Electrician",24],["Action",18],["Job",10],["Customer",26],["Address",40],
    ["Hardwired change",18],["Battery change",18],["Controller change",18],["Hardwired remaining",22],["Battery remaining",22],["Controllers remaining",22],
    ["Faulty hardwired change",24],["Faulty battery change",24],["Faulty hardwired held",24],["Faulty battery held",24],["Unclassified alarms",20],["Note",50],["By",20]];
  const s5 = wb.addWorksheet("Full stock history", { views: [{ state: "frozen", ySplit: 4 }] });
  banner(s5, "PowerSmart - complete stock movement history", lCols.length);
  s5.columns = lCols.map(([,width]) => ({width}));
  const actions = {issue:"Given",return:"Returned",adjust:"Correction",job:"Used on job",warranty:"Warranty replacement",faulty_return:"Faulty returned"};
  const lr = (data.ledger || []).filter(e => !techId || e.electrician_id === techId).map(e => [
    new Date(e.at).toLocaleString("en-AU",{timeZone:"Australia/Brisbane"}),xText(e.electrician),actions[e.kind] || e.kind,e.job_no ? "J"+e.job_no : "",
    xText(e.customer),xText(e.address),...PRODUCTS.map(p=>e.delta[p]),...PRODUCTS.map(p=>e.balance[p]),
    e.faulty_delta.hardwired,e.faulty_delta.battery,e.faulty_balance.hardwired,e.faulty_balance.battery,e.unclassified,xText(e.note),xText(e.by)]);
  s5.addTable({name:"FullStockHistory",ref:"A4",headerRow:true,style:{theme:"TableStyleMedium2",showRowStripes:true},
    columns:lCols.map(([name])=>({name,filterButton:true})),rows:lr.length ? lr : [["No stock history",...Array(lCols.length-1).fill("")]]});

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Email one electrician their stock count, CC'd to the office.
async function sendCount(data, techId, { sendAs, agent }) {
  const t = data.electricians.find((x) => x.electrician_id === techId);
  if (!t || !t.since) throw bad("No stock has been recorded for this electrician yet");
  const tech = (await sb(`electricians?id=eq.${encodeURIComponent(techId)}&select=name,email&limit=1`))?.[0];
  const to = String(tech && tech.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw bad(`${t.name} has no email saved. Add one under Electricians first.`);
  if (!process.env.RESEND_API_KEY) { const e = new Error("Email service is not configured (missing RESEND_API_KEY)"); e.status = 500; throw e; }
  const Q = require("./_quote"), S = require("./_senders"), esc = Q.escapeHtml;
  const first = String(t.name).trim().split(/\s+/)[0];
  const cc = String(process.env.NOTIFY_EMAIL || Q.SUPPORT_EMAIL).toLowerCase();
  const date = new Date().toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const cell = "padding:8px 12px;border-bottom:1px solid #E5EEEF;";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;color:#41585D;font-size:14px;line-height:1.6;">
<p>Hi ${esc(first)},</p><p>Here is your PowerSmart stock count as of ${esc(date)}. Please check it against what is in your van and let us know if anything is out.</p>
<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;"><tr style="background:#F4F9FA;color:#0B1B1F;font-weight:bold;"><td style="${cell}">Product</td><td align="right" style="${cell}">Given</td><td align="right" style="${cell}">Installed</td><td align="right" style="${cell}">You should have</td></tr>
${PRODUCTS.map((p) => `<tr><td style="${cell}">${LABEL[p]}</td><td align="right" style="${cell}">${t.given[p]}</td><td align="right" style="${cell}">${t.installed[p]}</td><td align="right" style="${cell}font-weight:bold;color:#0B1B1F;">${t.on_hand[p]}</td></tr>`).join("")}</table>
${ALARMS.some((p) => t.faulty_held[p] > 0) ? `<p><strong style="color:#0B1B1F;">Faulty alarms to hand back to the office:</strong> ${ALARMS.map((p) => `${t.faulty_held[p]} ${p}`).join(", ")}.</p>` : ""}
${t.unclassified ? `<p style="font-size:12px;">Note: ${t.unclassified} alarm${t.unclassified === 1 ? "" : "s"} on completed jobs had no type recorded and are not counted above.</p>` : ""}</div>`;
  const text = `Hi ${first},\n\nYour PowerSmart stock count as of ${date}:\n\n${PRODUCTS.map((p) => `${LABEL[p]}: given ${t.given[p]}, installed ${t.installed[p]}, you should have ${t.on_hand[p]}`).join("\n")}\n${ALARMS.some((p) => t.faulty_held[p] > 0) ? `\nFaulty alarms to hand back to the office: ${ALARMS.map((p) => `${t.faulty_held[p]} ${p}`).join(", ")}.\n` : ""}${t.unclassified ? `\nNote: ${t.unclassified} alarm(s) had no type recorded and are not counted.\n` : ""}\nPlease check this against what is in your van.`;
  const subject = `Your PowerSmart stock count - ${new Date().toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short" })}`;
  const sender = S.resolveSender(sendAs);
  const { Resend } = require("resend");
  const { data: sent, error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
    from: S.fromHeader(sender.key), to, ...(cc !== to ? { cc } : {}), replyTo: process.env.RESEND_REPLY_TO || Q.SUPPORT_EMAIL, subject, html, text });
  if (error) { const e = new Error(error.message || "Email provider rejected the request"); e.status = 502; throw e; }
  try { await require("./_maillog").logEmail({ kind: "email", sender: sender.key, agent, to_email: to, to_name: t.name, subject, body_html: html, body_text: text, provider_id: sent && sent.id }); } catch (_) { /* log is optional */ }
  return { ok: true, to, cc };
}

// kind "faulty_return": the office took faulty alarms back from the electrician (stored as a return of faulty stock).
async function move(b, actor, clean) {
  const electrician_id = clean(b.electrician_id, 40), product = clean(b.product, 20);
  let kind = clean(b.kind, 20) || "issue";
  const faulty = kind === "faulty_return";
  if (faulty) kind = "return";
  if (!electrician_id) throw bad("Choose an electrician");
  if (!PRODUCTS.includes(product)) throw bad("Choose a product");
  if (faulty && !ALARMS.includes(product)) throw bad("Only battery or hardwired alarms can be faulty");
  if (!(kind in KIND)) throw bad("Choose Give, Take back, Take back faulty or Correction");
  let qty = parseInt(b.qty, 10);
  if (!qty || isNaN(qty)) throw bad("Enter a quantity");
  qty = kind === "adjust" ? qty : Math.abs(qty) * KIND[kind];
  if (Math.abs(qty) > 100000) throw bad("Quantity is too large");
  const body = { electrician_id, product, qty, kind, note: clean(b.note, 300) || null, created_by: actor };
  if (faulty) body.condition = "faulty";
  try {
    const rows = await sb("stock_movements", { method: "POST", body });
    return rows && rows[0];
  } catch (e) {
    if (faulty && /condition/.test(String(e.message))) throw bad("Setup needed for faulty alarms: run supabase/warranty-jobs.sql in Supabase, then try again.");
    throw e;
  }
}

module.exports = { summary, load, workbook, sendCount, move, buildSummary, trackingStart, PRODUCTS, buildLedger, allRows };

