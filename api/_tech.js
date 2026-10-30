// Electrician phone app API for /tech, served through /api/pipeline?resource=tech
// (underscore prefix => not its own Vercel function; the plan allows 12).
//
// Auth: electricians sign in with their electrician code (e.g. 1011, set by the
// office in /tools/schedule → Electricians). Every request carries x-tech-code and
// only ever sees that electrician's own jobs.
//
// POST { action: "me" | "jobs" | "job" | "status" | "save" | "pay" | "pay_check" | "complete" | "reopen", ... }
// On site the electrician records how many battery and hardwired alarms were installed,
// adjusts the invoice, gets the customer's okay, takes a card payment and completes the job.
//
// Money is always computed here from the price list in api/_quote.js — the app
// only sends item codes and quantities (plus a price for "other" items).

const { sb, configured } = require("./_supabase");
const Stripe = require("./_stripe");
const { checkoutUrl } = require("./_payments");
const { PRICE_ALARM, PRICE_CTRL, FEE_INSPECT } = require("./_quote");
const J = require("./_jobs");

const PORTAL = "https://portal.powersmartco.com.au";

// What the electrician records on site: how many alarms of each kind went in
// (a job can be a mix). Each kind is its own invoice line.
const ALARM_CODES = ["alarm_battery", "alarm_hardwired"];

const CATALOGUE = {
  alarm_battery: { label: "Photoelectric smoke alarm (10-year battery) – supplied & installed", short: "battery smoke alarm", cents: PRICE_ALARM * 100 },
  alarm_hardwired: { label: "Photoelectric smoke alarm (240V hardwired) – supplied & installed", short: "hardwired smoke alarm", cents: PRICE_ALARM * 100 },
  controller: { label: "Smoke alarm remote controller (test / hush / locate)", short: "remote controller", cents: PRICE_CTRL * 100 },
  inspection: { label: "Smoke alarm compliance inspection", short: "compliance inspection", cents: FEE_INSPECT * 100 },
};

const JOB_LIST_COLS = "id,job_no,scheduled_start,duration_min,status,work_type,customer_name,phone,address,suburb,postcode,alarms,pay_status,alarm_units,invoice_items";
const { clean } = J;
function fail(status, msg) { const e = new Error(msg); e.status = status; return e; }
const money = (cents) => "$" + (cents / 100).toFixed(2);

function priceCents(v) {
  const text = String(v == null ? "" : v).trim();
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(text)) throw fail(400, "Enter a valid price for the extra item");
  const [d, c = ""] = text.split(".");
  const cents = Number(d) * 100 + Number(c.padEnd(2, "0"));
  if (cents < 50 || cents > 500000) throw fail(400, "Extra item price must be between $0.50 and $5,000");
  return cents;
}

// Items from the app → priced invoice lines (quantity 0 lines are dropped).
// Older saves used one "alarm" line + a job-level alarm_type; those map onto the typed lines.
function priceItems(raw, legacyType) {
  if (!Array.isArray(raw)) throw fail(400, "Invalid invoice items");
  if (raw.length > 20) throw fail(400, "Too many invoice items");
  const items = [];
  for (const it of raw) {
    const qty = J.intIn(it && it.qty, 0, 50, 0);
    if (!qty) continue;
    if (it.code === "other") {
      const label = clean(it.label, 120);
      if (!label) throw fail(400, "Describe the extra item");
      const unit = priceCents(it.price);
      items.push({ code: "other", label, qty, unit_cents: unit, amount_cents: unit * qty });
    } else {
      const code = it.code === "alarm" ? (legacyType === "hardwired" ? "alarm_hardwired" : "alarm_battery") : it.code;
      if (!Object.hasOwn(CATALOGUE, code)) throw fail(400, "Unknown invoice item");
      const c = CATALOGUE[code], line = items.find((i) => i.code === code);
      if (line) { line.qty += qty; line.amount_cents = line.unit_cents * line.qty; continue; }
      items.push({ code, label: c.label, qty, unit_cents: c.cents, amount_cents: c.cents * qty });
    }
  }
  return items;
}
const alarmQty = (items, code) => (items || []).filter((i) => (code ? i.code === code : ALARM_CODES.includes(i.code))).reduce((n, i) => n + i.qty, 0);
// Summary type for the job row: battery / hardwired, or null when mixed or none.
function alarmType(items) {
  const b = alarmQty(items, "alarm_battery"), h = alarmQty(items, "alarm_hardwired");
  return b && !h ? "battery" : h && !b ? "hardwired" : null;
}
const itemsKey = (items) => (items || []).map((i) => [i.code, i.label, i.qty, i.unit_cents].join("|")).join(";");
function itemsSummary(items) {
  return (items || []).map((i) => `${i.qty} × ${i.code === "other" ? i.label : CATALOGUE[i.code].short}`).join(", ");
}

// Payments the customer already made in advance (inspection fee, balances…).
// Booking fees are a separate charge on the quote, so they are not deducted.
async function prepaid(leadId) {
  if (!leadId) return [];
  try {
    const rows = await sb(`payment_requests?lead_id=eq.${encodeURIComponent(leadId)}&status=eq.paid&payment_type=neq.booking_fee&select=payment_type,description,amount_cents,amount_paid_cents`);
    return (rows || []).map((p) => ({ label: p.description || p.payment_type, cents: Number(p.amount_paid_cents || p.amount_cents || 0) }));
  } catch (_) { return []; }   // payment tracking not set up yet
}
// A job reset for a new electrician but still marked paid (reset before credits existed): carry that payment as a
// credit so the electrician can start the invoice, instead of leaving the job locked as "paid" with nothing on it.
async function healPaidEmpty(job) {
  if (!job || job.pay_status !== "paid" || job.status === "completed" || (job.invoice_items || []).length || !(job.paid_cents > 0)) return job;
  return (await patchJob(job.id, J.carryPaymentFields(job))) || job;
}
// Money received before the job was reverted to assigned counts against the new invoice.
function priorCredit(job) {
  return job && job.prior_paid_cents > 0 ? [{ label: `Paid earlier (${({ cash: "cash", bank_transfer: "bank transfer", card: "card" })[job.prior_pay_method] || "payment"})`, cents: job.prior_paid_cents }] : [];
}
function totals(items, credits) {
  const total = (items || []).reduce((s, i) => s + i.amount_cents, 0);
  const credit = Math.min(total, (credits || []).reduce((s, c) => s + c.cents, 0));
  return { total, credit, due: total - credit };
}

// Default invoice for a job that hasn't been priced yet: from the job + quote.
function defaultItems(job, quote) {
  if (job.work_type === "inspection" || (quote && quote.service === "inspection" && !job.alarms)) return [{ code: "inspection", qty: 1 }];
  // Alarm counts start at 0 — the electrician enters battery / hardwired as installed.
  return quote && quote.controller_qty ? [{ code: "controller", qty: quote.controller_qty }] : [];
}

const UNIT_TYPES = ["battery", "hardwired"];
// One record per alarm installed: where it went, which kind, and its photo (a Dropbox path).
function cleanUnits(input) {
  if (!Array.isArray(input) || input.length > 60) throw fail(400, "Too many alarms in one job.");
  return input.map((u, n) => {
    const type = clean(u && u.type, 20).toLowerCase();
    if (!UNIT_TYPES.includes(type)) throw fail(400, "Choose battery or hardwired for each alarm.");
    const photo = clean(u && u.photo, 500);
    if (photo && (!photo.startsWith("/PowerSmart Jobs/") || photo.includes(".."))) throw fail(400, "Invalid alarm photo.");
    return { id: clean(u && u.id, 30) || `u${n + 1}`, location: clean(u && u.location, 40) || "Other", type, photo };
  });
}

async function authTech(req) {
  const code = clean(req.headers["x-tech-code"], 20);
  if (!code) return null;
  const rows = await sb(`electricians?code=eq.${encodeURIComponent(code)}&active=eq.true&select=id,code,name,phone,email&limit=2`);
  if (!rows || rows.length !== 1) return null;           // unknown, inactive or (shouldn't happen) shared code
  const t = rows[0];
  return { id: t.id, code: t.code, name: t.name, phone: t.phone, email: t.email };
}

async function ownJob(tech, id) {
  id = clean(id, 40);
  if (!id) throw fail(400, "id is required");
  const rows = await sb(`jobs?id=eq.${encodeURIComponent(id)}&electrician_id=eq.${encodeURIComponent(tech.id)}&select=*&limit=1`);
  if (!rows || !rows[0]) throw fail(404, "Job not found");
  return withTypedItems(rows[0]);
}
// Re-prices an older save (single "alarm" line) onto the battery / hardwired lines.
function withTypedItems(job) {
  if (!(job.invoice_items || []).some((i) => i.code === "alarm")) return job;
  const items = priceItems(job.invoice_items.map((i) => ({ ...i, price: (i.unit_cents / 100).toFixed(2) })), job.alarm_type);
  return { ...job, invoice_items: items };
}
async function patchJob(id, body) {
  const rows = await sb(`jobs?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body });
  return rows && rows[0];
}

// Marks a job paid from a paid Stripe Checkout session (app check or webhook). Notes the lead once.
async function reconcileJobPayment(session) {
  const jobId = session && session.metadata && session.metadata.job_id;
  if (!jobId || session.payment_status !== "paid") return null;
  const rows = await sb(`jobs?id=eq.${encodeURIComponent(jobId)}&select=id,job_no,lead_id,pay_status&limit=1`);
  const job = rows && rows[0];
  if (!job) throw new Error("Job for this Stripe payment was not found");
  const updated = await sb(`jobs?id=eq.${encodeURIComponent(jobId)}&pay_status=neq.paid`, { method: "PATCH", body: {
    pay_status: "paid", pay_method: "card", paid_cents: session.amount_total, paid_at: new Date().toISOString(), pay_session_id: session.id,
  } });
  if (updated && updated.length) {
    await J.leadNote(job.lead_id, "Stripe", `💳 Job J${job.job_no} paid on site: ${money(session.amount_total)} AUD by card. Stripe checkout: ${session.id}.`, "payment");
  }
  // A card payment received after sign-off (pay-later invoice) sends the paid tax invoice and the certificate; both check the job is completed.
  if (updated && updated.length) await require("./_after-payment").releaseAfterPayment(jobId, { agent: "Stripe" });
  return (updated && updated[0]) || { ...job, pay_status: "paid" };
}

// Re-checks the job's open Stripe session (in case the webhook hasn't arrived yet).
async function refreshPayment(job) {
  if (job.pay_status === "paid" || !job.pay_session_id || !Stripe.configured()) return job;
  const s = await Stripe.request(`/checkout/sessions/${encodeURIComponent(job.pay_session_id)}`);
  if (s.payment_status === "paid") return { ...job, ...(await reconcileJobPayment(s)) };
  return job;
}

// Booking fee already paid by the customer: shown on the invoice screen, never deducted (the quote adds it separately).
async function bookingFeePaid(leadId) {
  if (!leadId) return 0;
  try {
    const rows = await sb(`payment_requests?lead_id=eq.${encodeURIComponent(leadId)}&payment_type=eq.booking_fee&status=eq.paid&select=amount_paid_cents,amount_cents&order=created_at.desc&limit=1`);
    return Number(rows?.[0]?.amount_paid_cents || rows?.[0]?.amount_cents || 0);
  } catch (_) { return 0; }
}

async function jobDetail(job) {
  job = withTypedItems(job);
  const [quote, credits, bookingFee] = await Promise.all([J.latestQuote(job.lead_id, job.email, job.quote_ref), prepaid(job.lead_id).then((c) => [...c, ...priorCredit(job)]), bookingFeePaid(job.lead_id)]);
  // The invoice starts empty and only holds what the electrician records. Alarm lines follow the alarms
  // added one by one, so counts left over from the old counter are not shown on an unfinished job.
  const hasUnits = Array.isArray(job.alarm_units) && job.alarm_units.length > 0;
  let items = job.invoice_items || [];
  if (job.status !== "completed" && !hasUnits) items = items.filter((i) => !ALARM_CODES.includes(i.code));
  return {
    job, quote, credits, items, booking_fee_cents: bookingFee, totals: totals(items, credits),
    alarm_codes: ALARM_CODES, catalogue: Object.entries(CATALOGUE).map(([code, c]) => ({ code, label: c.label, cents: c.cents })),
  };
}

async function handler(req, res) {
  if (!configured()) return res.status(500).json({ error: "Supabase is not configured" });
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  res.setHeader("Cache-Control", "no-store");
  const b = req.body || {};
  try {
    const tech = await authTech(req);
    if (!tech) {
      await new Promise((r) => setTimeout(r, 400));   // slow down code guessing
      return res.status(401).json({ error: "Code not recognised — check with the office" });
    }

    if (b.action === "me") return res.status(200).json({ tech });

    if (b.action === "jobs") {
      const from = new Date(b.from), to = new Date(b.to);
      if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: "from and to are required" });
      const jobs = await sb(`jobs?electrician_id=eq.${encodeURIComponent(tech.id)}&status=neq.cancelled&scheduled_start=gte.${encodeURIComponent(from.toISOString())}&scheduled_start=lt.${encodeURIComponent(to.toISOString())}&select=${JOB_LIST_COLS}&order=scheduled_start.asc&limit=200`);
      return res.status(200).json({ tech, jobs: jobs || [] });
    }

    if (b.action === "job") {
      const job = await healPaidEmpty(await refreshPayment(await ownJob(tech, b.id)));
      return res.status(200).json(await jobDetail(job));
    }

    // Job photos live in Dropbox (api/_dropbox.js). Allowed on completed jobs too.
    if (b.action === "photos" || b.action === "photo_upload" || b.action === "photo_link") {
      const Dropbox = require("./_dropbox");
      if (!Dropbox.configured()) return res.status(200).json({ configured: false, photos: [] });
      const own = await ownJob(tech, b.id);
      if (b.action === "photos") return res.status(200).json({ configured: true, ...(await Dropbox.photosForJob(own)) });
      if (b.action === "photo_link") {
        const folder = await Dropbox.findJobFolder(own);
        return res.status(200).json({ link: await Dropbox.temporaryLink(Dropbox.assertInside(folder, b.path)) });
      }
      const data = String(b.data || "").replace(/^data:image\/\w+;base64,/, "");
      if (!data || data.length > 4000000) throw fail(413, "Photo is too large. Try again.");
      const bytes = Buffer.from(data, "base64");
      if (bytes.length < 1000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw fail(400, "That doesn't look like a JPEG photo.");
      const saved = await Dropbox.uploadPhoto(own, clean(b.category, 20).toLowerCase(), bytes);
      return res.status(200).json({ ok: true, path: saved.path });
    }

    let job = await ownJob(tech, b.id);

    // Reopen a completed job to correct it; a card-paid invoice stays locked (see "save").
    if (b.action === "reopen") {
      if (job.status !== "completed") throw fail(409, "This job isn't completed.");
      const f = { status: "on_site", completed_at: null };
      if (job.pay_status !== "paid") f.pay_status = "unpaid";
      const updated = await patchJob(job.id, f);
      await J.leadNote(job.lead_id, tech.name, `↩ Job J${job.job_no} reopened for changes by ${tech.name}.`);
      return res.status(200).json(await jobDetail(updated));
    }

    if (job.status === "completed") throw fail(409, "This job is already completed — tap Edit job to change it.");
    job = await healPaidEmpty(job);

    if (b.action === "status") {
      if (!["en_route", "on_site"].includes(b.status)) throw fail(400, "Invalid status");
      const updated = await patchJob(job.id, { status: b.status });
      if (b.status !== job.status) await J.leadNote(job.lead_id, tech.name, `🛠 Job J${job.job_no} status: ${J.STATUS_LABEL[b.status]}.`);
      return res.status(200).json({ ok: true, job: updated });
    }

    if (b.action === "save") {
      const f = {};
      if (b.notes !== undefined) f.tech_notes = clean(b.notes, 2000) || null;
      if (b.items !== undefined) {
        const items = priceItems(b.items);
        const changed = itemsKey(items) !== itemsKey(job.invoice_items);
        if (changed && job.pay_status === "paid") throw fail(409, "The invoice has been paid — it can't be changed.");
        f.invoice_items = items;
        f.invoice_total_cents = totals(items, []).total;
        f.alarms_installed = alarmQty(items);
        f.alarm_type = alarmType(items);
        if (changed) f.approved_at = null;
      }
      if (b.alarm_units !== undefined) f.alarm_units = cleanUnits(b.alarm_units);
      if (b.pay_receipt !== undefined) {
        const receipt = clean(b.pay_receipt, 500);
        if (receipt && (!receipt.startsWith("/PowerSmart Jobs/") || receipt.includes(".."))) throw fail(400, "Invalid receipt photo.");
        f.pay_receipt = receipt || null;
      }
      if (b.approve) {
        const items = f.invoice_items || job.invoice_items;
        if (!items || !items.length) throw fail(400, "Add at least one item before the customer approves.");
        f.approved_at = new Date().toISOString();
      }
      const updated = Object.keys(f).length ? await patchJob(job.id, f) : job;
      return res.status(200).json(await jobDetail(updated));
    }

    if (b.action === "pay" || b.action === "pay_check") {
      if (!Stripe.configured()) throw fail(503, "Card payments are not set up (missing STRIPE_SECRET_KEY).");
      let current = await refreshPayment(job);
      if (b.action === "pay_check" || current.pay_status === "paid") return res.status(200).json({ paid: current.pay_status === "paid", job: current });

      if (!current.invoice_items || !current.invoice_items.length || !current.approved_at) throw fail(409, "Get the customer to approve the invoice first.");
      const t = totals(current.invoice_items, [...(await prepaid(current.lead_id)), ...priorCredit(current)]);
      if (t.due <= 0) throw fail(409, "Nothing to pay — this invoice is already covered.");

      if (current.pay_session_id) {
        const s = await Stripe.request(`/checkout/sessions/${encodeURIComponent(current.pay_session_id)}`);
        if (s.status === "open" && s.amount_total === t.due && s.url) return res.status(200).json({ url: checkoutUrl(s.url), amount_cents: t.due });
        if (s.status === "open") await Stripe.request(`/checkout/sessions/${encodeURIComponent(s.id)}/expire`, {});   // invoice changed
      }
      const summary = itemsSummary(current.invoice_items) + (t.credit ? ` (less ${money(t.credit)} paid in advance)` : "");
      const session = await Stripe.request("/checkout/sessions", {
        mode: "payment", "payment_method_types[0]": "card", ...(current.email ? { customer_email: current.email } : {}),
        success_url: `${PORTAL}/tech?job=${current.id}&paid={CHECKOUT_SESSION_ID}`,
        cancel_url: `${PORTAL}/tech?job=${current.id}`, client_reference_id: current.id,
        "line_items[0][price_data][currency]": "aud", "line_items[0][price_data][unit_amount]": String(t.due),
        "line_items[0][price_data][product_data][name]": `PowerSmart job J${current.job_no} – smoke alarms`,
        "line_items[0][price_data][product_data][description]": summary.slice(0, 250), "line_items[0][quantity]": "1",
        "metadata[job_id]": current.id, "metadata[job_no]": String(current.job_no), "metadata[payment_type]": "job",
        "payment_intent_data[metadata][job_id]": current.id, "payment_intent_data[metadata][payment_type]": "job",
      });
      await patchJob(current.id, { pay_session_id: session.id, pay_status: "pending", amount_due_cents: t.due });
      return res.status(200).json({ url: checkoutUrl(session.url), amount_cents: t.due });
    }

    if (b.action === "complete") {
      let current = await refreshPayment(job);
      const items = current.invoice_items || [];
      if (items.length && !current.approved_at) throw fail(409, "The customer needs to approve the invoice first.");
      const credits = [...(await prepaid(current.lead_id)), ...priorCredit(current)];
      const t = totals(items, credits);

      const signoffName = clean(b.signoff_name, 80), signature = String(b.signature || "");
      if (!signoffName) throw fail(400, "Type your name to sign off the work.");
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) || signature.length > 300000) throw fail(400, "Please sign in the signature box.");

      const METHOD_LABEL = { card: "card", bank_transfer: "bank transfer", cash: "cash" };
      const paidInFull = b.paid_in_full === true;
      const f = { status: "completed", completed_at: new Date().toISOString(), amount_due_cents: t.due,
        signoff_name: signoffName, signoff_signature: signature, signoff_at: new Date().toISOString() };
      let payText;
      if (t.due <= 0) { f.pay_status = "none"; payText = "Nothing to pay on site."; }
      else if (current.pay_status === "paid") { f.pay_status = "paid"; f.pay_method = current.pay_method || "card"; payText = `Paid in full by ${METHOD_LABEL[f.pay_method] || "card"}: ${money(current.paid_cents || t.due)}.`; }
      else if (paidInFull && b.method === "cash") {
        if (!current.pay_receipt) throw fail(409, "Take a photo of the cash receipt and synchronize first.");
        f.pay_status = "paid"; f.pay_method = "cash"; f.paid_cents = t.due; f.paid_at = new Date().toISOString();
        payText = `Paid in full by cash: ${money(t.due)}. Receipt photo saved.`;
      }
      else if (paidInFull) throw fail(409, "Choose how the customer paid: card or cash. For card, take the card payment first. For a bank transfer, choose No and the office confirms it once it arrives.");
      else { f.pay_status = "later"; payText = `Not paid in full: ${money(t.due)} owing. A pending invoice has been emailed.`; }

      const done = await patchJob(current.id, f);
      const paid = f.pay_status !== "later";
      const lead = current.lead_id ? (await sb(`leads?id=eq.${encodeURIComponent(current.lead_id)}&select=email&limit=1`).catch(() => []))?.[0] : null;
      const invoice = await require("./_job-invoice").sendJobInvoice({ job: current, lead, items, totals: t, credits, bookingFee: await bookingFeePaid(current.lead_id), paid, method: f.pay_method, agent: tech.name });
      if (invoice.status === "sent") await patchJob(current.id, { invoice_emailed_at: new Date().toISOString() }).catch(() => {});
      // Certificate only goes out when the job is paid in full (paid on site, or nothing owing).
      const certificate = f.pay_status !== "later" ? await require("./_certificate").issueCertificate(current.id, { agent: tech.name }) : { status: "skipped", reason: "Invoice not paid yet." };
      const invoiceText = invoice.status === "sent" ? `${paid ? "Tax invoice" : "Pending invoice"} emailed to ${invoice.to}.` : `Invoice email not sent (${invoice.error}).`;
      if (current.lead_id) {
        try {
          await sb(`leads?id=eq.${encodeURIComponent(current.lead_id)}`, { method: "PATCH", body: { stage: "won" }, prefer: "return=minimal" });
        } catch (e) { console.error("tech → lead stage update failed:", e.message); }
        const notes = current.tech_notes ? ` Notes: ${current.tech_notes}` : "";
        await J.leadNote(current.lead_id, tech.name,
          `✅ Job J${current.job_no} completed and signed off by ${signoffName}. Invoice ${money(t.total)}${items.length ? ": " + itemsSummary(items) : ""}. ${payText} ${invoiceText}${notes}`);
      }
      return res.status(200).json({ ok: true, job: done, invoice, certificate });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    if (/alarm_units|pay_method|pay_receipt|signoff_|invoice_emailed_at/.test(String(err.message))) {
      return res.status(500).json({ error: "Setup needed: run supabase/tech-job-flow.sql and supabase/certificate.sql in Supabase, then try again." });
    }
    if (!err.status || err.status >= 500) console.error("tech app error:", err.message);
    return res.status(err.status && err.status < 600 ? err.status : 500).json({ error: err.message || "Electrician app error" });
  }
}

module.exports = handler;
Object.assign(module.exports, { reconcileJobPayment, ALARM_CODES, priceItems, totals });
