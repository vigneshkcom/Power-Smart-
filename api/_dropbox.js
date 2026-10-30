// Dropbox storage for job photos (underscore prefix => not its own Vercel function).
//
// Env vars (Vercel → Settings → Environment Variables):
//   DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN
// The refresh token comes from scripts/dropbox-refresh-token.js (one-time setup, see README).
//
// Layout:  /PowerSmart Jobs/J1013 - Peter Wallmer - 52 Diamantina St/{Before,After,Alarms,Other}/<photo>.jpg
// The folder is found again by its "J1013 - " prefix, so renaming the customer never splits a job's photos.

const ROOT = "/PowerSmart Jobs";
const CATEGORIES = { before: "Before", after: "After", alarms: "Alarms", other: "Other" };
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic)$/i;

function configured() {
  return Boolean(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET && process.env.DROPBOX_REFRESH_TOKEN);
}
function fail(status, message) { return Object.assign(new Error(message), { status }); }

let cached = { token: "", exp: 0 };
async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: process.env.DROPBOX_REFRESH_TOKEN }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw fail(502, "Dropbox sign-in failed. Check the Dropbox keys in Vercel.");
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in || 14400) * 1000 };
  return cached.token;
}

async function rpc(endpoint, body, { allowNotFound = false } = {}) {
  const response = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: "POST",
    headers: { Authorization: "Bearer " + (await accessToken()), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error_summary: text }; }
  if (!response.ok) {
    if (allowNotFound && /not_found/.test(data.error_summary || "")) return null;
    throw fail(502, "Dropbox: " + String(data.error_summary || response.status).slice(0, 160));
  }
  return data;
}

// Keep folder names filesystem-safe and short.
function safe(text) {
  return String(text || "").replace(/[\\/<>:"|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 60);
}
function folderName(job) {
  const place = job.address ? `${safe(job.address)}` : "";
  return [`J${job.job_no}`, safe(job.customer_name), place].filter(Boolean).join(" - ").slice(0, 150);
}

async function listAll(path, recursive) {
  let res = await rpc("files/list_folder", { path, recursive: Boolean(recursive), limit: 2000 }, { allowNotFound: true });
  if (!res) return null;
  const entries = [...res.entries];
  while (res.has_more) {
    res = await rpc("files/list_folder/continue", { cursor: res.cursor });
    entries.push(...res.entries);
  }
  return entries;
}

// Existing folder for a job (matched by its "J<no> - " prefix), or null.
async function findJobFolder(job) {
  const entries = await listAll(ROOT, false);
  const prefix = `J${job.job_no} - `;
  const hit = (entries || []).find((e) => e[".tag"] === "folder" && (e.name.startsWith(prefix) || e.name === `J${job.job_no}`));
  return hit ? hit.path_display : null;
}
async function ensureJobFolder(job) {
  const existing = await findJobFolder(job);
  if (existing) return existing;
  const path = `${ROOT}/${folderName(job)}`;
  const made = await rpc("files/create_folder_v2", { path, autorename: false });
  return made.metadata.path_display;
}

function assertInside(base, path) {
  const p = String(path || "");
  if (!base || !p.startsWith(base + "/") || p.includes("..") || p.length > 500) throw fail(400, "Invalid photo path");
  return p;
}

async function uploadPhoto(job, category, bytes) {
  const folder = await ensureJobFolder(job);
  const sub = CATEGORIES[category] || CATEGORIES.other;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rnd = Math.random().toString(36).slice(2, 6);
  const path = `${folder}/${sub}/${sub.toLowerCase()}-${stamp}-${rnd}.jpg`;
  const response = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + (await accessToken()),
      "Dropbox-API-Arg": JSON.stringify({ path, mode: "add", autorename: true, mute: true }),
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  });
  if (!response.ok) throw fail(502, "Dropbox upload failed: " + (await response.text()).slice(0, 120));
  return { path };
}

async function thumbnails(paths) {
  const out = {};
  for (let i = 0; i < paths.length; i += 25) {
    const chunk = paths.slice(i, i + 25);
    const res = await rpc("files/get_thumbnail_batch", { entries: chunk.map((path) => ({ path, format: "jpeg", size: "w256h256", mode: "strict" })) });
    (res.entries || []).forEach((entry, n) => {
      if (entry[".tag"] === "success" && entry.thumbnail) out[chunk[n]] = "data:image/jpeg;base64," + entry.thumbnail;
    });
  }
  return out;
}

// Photos for one job, newest first, with small inline thumbnails (first 60 only).
async function photosForJob(job) {
  const folder = await findJobFolder(job);
  if (!folder) return { folder: null, photos: [] };
  const entries = (await listAll(folder, true)) || [];
  const files = entries.filter((e) => e[".tag"] === "file" && IMAGE_EXT.test(e.name))
    .sort((a, b) => String(b.server_modified).localeCompare(String(a.server_modified))).slice(0, 60);
  const thumbs = files.length ? await thumbnails(files.map((f) => f.path_display)).catch(() => ({})) : {};
  const photos = files.map((f) => ({
    path: f.path_display, name: f.name, modified: f.server_modified,
    category: (f.path_display.slice(folder.length + 1).split("/")[0] || "Other"),
    thumb: thumbs[f.path_display] || "",
  }));
  return { folder, folder_url: "https://www.dropbox.com/home" + encodeURI(folder), photos };
}

async function temporaryLink(path) {
  const res = await rpc("files/get_temporary_link", { path });
  return res.link;
}

module.exports = { ROOT, CATEGORIES, configured, fail, safe, folderName, ensureJobFolder, findJobFolder, uploadPhoto, photosForJob, temporaryLink, assertInside };
