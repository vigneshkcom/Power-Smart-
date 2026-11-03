// Stock tracker, served through /api/pipeline?resource=jobs (actions stock_summary / stock_move).
// Stock on hand = what the electrician was given (stock_movements, see supabase/stock.sql)
//               - what they installed on completed jobs since their first stock entry.
const { sb } = require("./_supabase");

const PRODUCTS = ["hardwired", "battery", "controller"];
const KIND = { issue: 1, return: -1, adjust: 0 };   // adjust keeps the sign the user typed
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
  const rows = new Map(techs.map((t) => [t.id, { electrician_id: t.id, code: t.code || "", name: t.name, active: t.active !== false, since: null, given: blank(), installed: blank(), on_hand: blank(), unclassified: 0 }]));
  for (const m of moves) {
    const r = rows.get(m.electrician_id); if (!r || !PRODUCTS.includes(m.product)) continue;
    r.given[m.product] += m.qty;
    if (!r.since || m.created_at < r.since) r.since = m.created_at;
  }
  for (const r of rows.values()) if (r.since) r.since = trackingStart(r.since);
  for (const j of jobs) {
    const r = rows.get(j.electrician_id);
    if (!r || !r.since || (j.completed_at || "") < r.since) continue;
    const c = installedCounts(j);
    r.installed.hardwired += c.hardwired; r.installed.battery += c.battery; r.installed.controller += c.controllers;
    r.unclassified += c.untyped;
  }
  for (const r of rows.values()) for (const p of PRODUCTS) r.on_hand[p] = r.given[p] - r.installed[p];
  return [...rows.values()].filter((r) => r.since || r.active);
}

async function summary(installedCounts) {
  const [techs, moves] = await Promise.all([
    sb("electricians?select=id,code,name,active&order=sort_order.asc,name.asc"),
    sb("stock_movements?select=*&order=created_at.desc&limit=5000"),
  ]);
  const list = moves || [];
  let jobs = [];
  if (list.length) {
    const first = list.reduce((a, m) => (m.created_at < a ? m.created_at : a), list[0].created_at);
    jobs = await sb(`jobs?status=eq.completed&electrician_id=not.is.null&completed_at=gte.${encodeURIComponent(trackingStart(first))}&select=id,job_no,electrician_id,completed_at,invoice_items,alarm_type,alarms&limit=5000`) || [];
  }
  const names = Object.fromEntries((techs || []).map((t) => [t.id, t.name]));
  return {
    electricians: buildSummary(techs || [], list, jobs, installedCounts),
    movements: list.slice(0, 60).map((m) => ({ id: m.id, created_at: m.created_at, electrician: names[m.electrician_id] || "", product: m.product, qty: m.qty, kind: m.kind, note: m.note || "", created_by: m.created_by || "" })),
  };
}

async function move(b, actor, clean) {
  const electrician_id = clean(b.electrician_id, 40), product = clean(b.product, 20), kind = clean(b.kind, 10) || "issue";
  if (!electrician_id) throw bad("Choose an electrician");
  if (!PRODUCTS.includes(product)) throw bad("Choose a product");
  if (!(kind in KIND)) throw bad("Choose Give, Take back or Correction");
  let qty = parseInt(b.qty, 10);
  if (!qty || isNaN(qty)) throw bad("Enter a quantity");
  qty = kind === "adjust" ? qty : Math.abs(qty) * KIND[kind];
  if (Math.abs(qty) > 100000) throw bad("Quantity is too large");
  const rows = await sb("stock_movements", { method: "POST", body: { electrician_id, product, qty, kind, note: clean(b.note, 300) || null, created_by: actor } });
  return rows && rows[0];
}

module.exports = { summary, move, buildSummary, trackingStart, PRODUCTS };
