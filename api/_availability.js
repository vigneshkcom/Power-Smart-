const { sb } = require("./_supabase");
const localities = require("./_availability-localities");

const DILLON_ID = "bf7be32e-7f5e-43b4-b4f1-7d7be4f77b61";
const BASE = "Hawthorne";
const DATES = {
  "2026-11-24": { closed: true },
  "2026-11-25": { southGoldCoast: true, start: 15 * 60, end: 17 * 60 },
  "2026-11-26": { southGoldCoast: true, start: 15 * 60, end: 17 * 60 },
  "2026-11-27": { closed: true },
  "2026-12-02": { start: 7 * 60 + 30, end: 17 * 60 },
  "2026-12-09": { start: 7 * 60 + 30, end: 17 * 60 },
  "2026-12-16": { start: 7 * 60 + 30, end: 17 * 60 },
};
const SOUTH_GOLD_COAST_POSTCODES = new Set(["4220", "4221", "4223", "4224", "4225", "4226", "4227", "4228"]);
const SOUTH_GOLD_COAST_JOB_LIMIT = 3;
const DURATIONS = [30, 45, 60, 90, 120];
const MINUTE = 60_000;
const QUEENSLAND_OFFSET = 10 * 60 * MINUTE;
const dayStart = date => Date.parse(date + "T00:00:00+10:00");
const queenslandDate = time => new Date(time + QUEENSLAND_OFFSET).toISOString().slice(0, 10);
const normalise = value => String(value || "").trim().toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ");

const bySuburb = new Map();
const byPostcode = new Map();
for (const [suburb, postcode, weight, lat, lon] of localities) {
  const key = normalise(suburb);
  const areas = bySuburb.get(key) || new Map();
  if (!areas.has(postcode)) areas.set(postcode, { suburb, postcode, lat, lon });
  bySuburb.set(key, areas);
  const total = byPostcode.get(postcode) || { weight: 0, lat: 0, lon: 0 };
  total.weight += weight;
  total.lat += lat * weight;
  total.lon += lon * weight;
  byPostcode.set(postcode, total);
}

function postcodePoint(postcode) {
  const total = byPostcode.get(postcode);
  return total && { postcode, lat: total.lat / total.weight, lon: total.lon / total.weight };
}

function lookupArea(value) {
  const match = value.match(/^(?:(.*?)\s*[, ]\s*)?(\d{4})$/);
  const name = normalise(match ? match[1] : value);
  const areas = bySuburb.get(name);
  if (match) return name ? areas?.get(match[2]) : postcodePoint(match[2]);
  if (areas?.size === 1) return areas.values().next().value;
  return null;
}

const basePoint = lookupArea("Hawthorne 4171");

function distanceKm(from, to) {
  const rad = Math.PI / 180;
  const lat = (to.lat - from.lat) * rad;
  const lon = (to.lon - from.lon) * rad;
  const a = Math.sin(lat / 2) ** 2 + Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin(lon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, a)));
}

function travelMinutes(from, to) {
  // Locality centroids give an estimate. Allow at least 10 minutes between jobs.
  return from && to ? Math.max(10, Math.ceil(distanceKm(from, to) * 2)) : 30;
}

function mapJob(job) {
  const suburb = String(job.suburb || job.lead?.address_suburb || "").trim();
  const postcode = String(job.postcode || job.lead?.address_postcode || job.lead?.postcode || "").trim();
  const start = Date.parse(job.scheduled_start);
  return {
    id: job.id, jobNo: job.job_no, suburb, postcode, start,
    end: start + (job.duration_min || 60) * MINUTE,
    point: bySuburb.get(normalise(suburb))?.get(postcode) || postcodePoint(postcode) || lookupArea(suburb),
  };
}

function intersects(job, start, end) {
  return job.start < end && job.end > start;
}

function routeMatch(target, previous, next) {
  const stops = [previous, next].filter(Boolean);
  const exact = stops.find(stop => stop.postcode === target.postcode && (
    !target.suburb || normalise(stop.suburb) === normalise(target.suburb)
  ));
  if (exact) return { type: "same_area", distance: 0, anchor: exact };

  const nearby = stops.filter(stop => stop.point).map(stop => ({
    anchor: stop, distance: distanceKm(stop.point, target),
  })).sort((a, b) => a.distance - b.distance)[0];
  if (!nearby) return null;
  if (nearby.distance <= 12) return { type: "nearby", ...nearby };

  // Check the actual gap's two ends. Hawthorne is the route's outer endpoint.
  const from = previous ? previous.point : basePoint;
  const to = next ? next.point : basePoint;
  if (!from || !to || nearby.distance > 18) return null;
  const extraKm = distanceKm(from, target) + distanceKm(target, to) - distanceKm(from, to);
  return extraKm <= 4 ? { type: "on_route", ...nearby } : null;
}

function findSlot({ jobs, target, start, end, now, duration, southGoldCoast }) {
  const candidates = [];
  let previous = null;

  function consider(next) {
    const route = routeMatch(target, previous, next);
    if (!route && jobs.length && !southGoldCoast) return;
    const leavePrevious = previous ? previous.end + travelMinutes(previous.point, target) * MINUTE : start;
    const limit = next ? next.start - travelMinutes(target, next.point) * MINUTE : end;
    const earliest = Math.max(start, leavePrevious, now);
    const slotStart = Math.ceil(earliest / (15 * MINUTE)) * 15 * MINUTE;
    const slotEnd = slotStart + duration * MINUTE;
    if (slotEnd > Math.min(end, limit)) return;
    candidates.push({
      start: slotStart, end: slotEnd, anchor: route?.anchor,
      distance: route?.distance ?? Infinity,
      type: route?.type || (southGoldCoast ? "south_gold_coast" : "route_pending"),
    });
  }

  for (const job of jobs) {
    if (!previous || job.start >= previous.end) consider(job);
    if (!previous || job.end >= previous.end) previous = job;
  }
  consider(null);
  return candidates.sort((a, b) => a.distance - b.distance || a.start - b.start)[0];
}

function bookingInfo(job) {
  if (!job) return null;
  return { id: job.id, jobNo: job.jobNo, suburb: job.suburb, postcode: job.postcode, start: new Date(job.start).toISOString() };
}

function buildAvailability({ dates, jobs, target, now, duration, name }) {
  const lateJobCount = Object.keys(DATES).filter(date => DATES[date].southGoldCoast).reduce((count, date) => {
    const { start, end } = DATES[date];
    const midnight = dayStart(date);
    return count + jobs.filter(job => intersects(job, midnight + start * MINUTE, midnight + end * MINUTE)).length;
  }, 0);

  return {
    electrician: name,
    base: BASE,
    days: dates.map(date => {
      const rule = DATES[date];
      const midnight = dayStart(date);
      const dayJobs = jobs.filter(job => intersects(job, midnight, midnight + 24 * 60 * MINUTE));
      const route = [...new Set(dayJobs.map(job => [job.suburb, job.postcode].filter(Boolean).join(" ")).filter(Boolean))];
      const base = { date, jobCount: dayJobs.length, route, southGoldCoast: Boolean(rule.southGoldCoast), suggestion: null };
      if (rule.closed) return { ...base, status: "booked_out" };

      const start = midnight + rule.start * MINUTE;
      const end = midnight + rule.end * MINUTE;
      const window = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
      const withinArea = rule.southGoldCoast
        ? SOUTH_GOLD_COAST_POSTCODES.has(target?.postcode)
        : dayJobs.length || (target && distanceKm(basePoint, target) <= 120);
      const lateLimitReached = rule.southGoldCoast && lateJobCount >= SOUTH_GOLD_COAST_JOB_LIMIT;
      const slot = target && withinArea && !lateLimitReached && findSlot({
        jobs: dayJobs, target, start, end, now, duration, southGoldCoast: rule.southGoldCoast,
      });
      const suggestion = slot ? {
        start: new Date(slot.start).toISOString(), end: new Date(slot.end).toISOString(),
        type: slot.type, booking: bookingInfo(slot.anchor),
      } : null;
      return { ...base, window, status: lateLimitReached ? "booked_out" : "working", suggestion };
    }),
  };
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const params = new URL(req.url, "http://local").searchParams;
  const area = (params.get("area") || "").trim();
  const duration = Number(params.get("duration") || 60);
  const target = area.length <= 100 && area ? lookupArea(area) : null;
  if (area && !target) {
    return res.status(400).json({ error: "Enter a Queensland postcode or a suburb and postcode." });
  }
  if (!DURATIONS.includes(duration)) {
    return res.status(400).json({ error: "Select a job length between 30 and 120 minutes." });
  }

  try {
    const now = Date.now();
    const today = queenslandDate(now);
    const allDates = Object.keys(DATES);
    const dates = allDates.filter(date => date >= today);
    if (!dates.length) return res.status(200).json({ electrician: "Dillon Moritz", base: BASE, days: [] });

    // Include both late shifts when checking their shared job limit, even after the first shift has passed.
    const lookback = dates.some(date => DATES[date].southGoldCoast) ? "2026-11-25" : dates[0];
    const firstDate = dates[0] < lookback ? dates[0] : lookback;
    const from = new Date(dayStart(firstDate) - 12 * 60 * MINUTE).toISOString();
    const to = new Date(dayStart(dates.at(-1)) + 24 * 60 * MINUTE).toISOString();
    const cols = "id,job_no,scheduled_start,duration_min,suburb,postcode,lead:leads(address_suburb,address_postcode,postcode)";
    const [electricians, rows] = await Promise.all([
      sb(`electricians?id=eq.${DILLON_ID}&active=eq.true&select=name`),
      sb(`jobs?electrician_id=eq.${DILLON_ID}&status=neq.cancelled&scheduled_start=gte.${encodeURIComponent(from)}&scheduled_start=lt.${encodeURIComponent(to)}&select=${cols}&order=scheduled_start.asc,id.asc&limit=250`),
    ]);
    if (!electricians?.length || !Array.isArray(rows) || rows.length === 250) {
      throw new Error("Dillon's schedule could not be verified");
    }

    return res.status(200).json(buildAvailability({
      dates, jobs: rows.map(mapJob), target, now, duration, name: electricians[0].name,
    }));
  } catch (error) {
    console.error("Electrician availability:", error.message);
    return res.status(502).json({ error: "PowerSmart bookings could not be checked. Try again." });
  }
}

module.exports = { handler, buildAvailability, lookupArea, mapJob };
