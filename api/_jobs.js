// Job schedule API for /tools/schedule, served through /api/pipeline?resource=jobs
// (underscore prefix => not its own Vercel function; the plan allows 12).
//
// Auth: header x-portal-key must match the portal passcode (same as /api/pipeline).
// Data: Supabase tables `electricians` + `jobs` (see supabase/jobs.sql).
//
// GET  ?resource=jobs&from=<ISO>&to=<ISO> → { electricians, jobs (scheduled in range), waiting (unassigned) }
// POST { action: "job_create" | "job_update" | "job_delete" | "lead_quote" | "tech_create" | "tech_update", ... }
// The electrician phone app (/tech) has its own API in api/_tech.js and reuses the helpers exported below.

const { sb, configured } = require("./_supabase");

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
async function latestQuote(leadId, email) {
  const cols = "quote_ref,quote_total,body_text,created_at";
  try {
    let rows = leadId ? await sb(`sent_emails?kind=eq.quote&status=eq.sent&lead_id=eq.${encodeURIComponent(leadId)}&select=${cols}&order=created_at.desc&limit=1`) : [];
    if (!(rows && rows[0]) && email) rows = await sb(`sent_emails?kind=eq.quote&status=eq.sent&to_email=eq.${encodeURIComponent(email)}&select=${cols}&order=created_at.desc&limit=1`);
    const q = rows && rows[0];
    if (!q) return null;
    const text = q.body_text || "";
    return {
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
      if ("customer_name" in f && !f.customer_name) return res.status(400).json({ error: "Customer name can't be empty" });
      if (!Object.keys(f).length) return res.status(400).json({ error: "Nothing to update" });

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

    // Latest sent quote for a lead → alarm/controller counts for the job card.
    if (b.action === "lead_quote") {
      const leadId = clean(b.lead_id, 40);
      const email = clean(b.email, 254).toLowerCase();
      if (!leadId && !email) return res.status(400).json({ error: "lead_id or email is required" });
      return res.status(200).json({ quote: await latestQuote(leadId, email) });
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
