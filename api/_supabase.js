// Minimal server-side Supabase REST (PostgREST) client.
// Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — server only, never the browser.
// Underscore prefix => Vercel does not expose this file as a route.

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function configured() {
  return Boolean(URL_ && KEY);
}

async function sb(path, { method = "GET", body, prefer } = {}) {
  if (!configured()) {
    const e = new Error("Supabase is not configured (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
    e.status = 500;
    throw e;
  }
  const res = await fetch(`${URL_.replace(/\/$/, "")}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer || (method === "GET" ? "count=none" : "return=representation"),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Supabase ${res.status}`;
    try { const j = await res.json(); msg = j.message || j.hint || msg; } catch (_) {}
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

module.exports = { sb, configured };
