// Shared SMS helpers used by /api/sms (the SMS portal) and /api/pipeline (lead cards).
// Credentials stay server-side in Vercel env vars. Underscore prefix => not a route.

const { sb } = require("./_supabase");

const SMS_API = "https://api.sms-gate.app/3rdparty/v1";

const smsConfigured = () => Boolean(process.env.SMSGATE_USERNAME && process.env.SMSGATE_PASSWORD);
const cleanPhone = (value) => String(value || "").replace(/[^\d+]/g, "").trim();

// Canonical form for numbers staff type into a lead: AU local (0412 345 678) → +61412345678.
function toE164(value) {
  const p = cleanPhone(value);
  if (!p) return "";
  if (p.startsWith("+")) return p;
  if (p.startsWith("00")) return "+" + p.slice(2);
  if (p.startsWith("0") && p.length === 10) return "+61" + p.slice(1);
  if (p.startsWith("61") && p.length === 11) return "+" + p;
  return p;
}

// Every spelling a number may be stored under in sms_messages (portal-typed "04…",
// webhook "+614…", etc.), so one lead sees the whole conversation.
function phoneVariants(value) {
  const e164 = toE164(value);
  if (!e164) return [];
  const set = new Set([cleanPhone(value), e164, e164.slice(1)]);
  if (e164.startsWith("+61")) set.add("0" + e164.slice(3));
  return [...set].filter(Boolean);
}

const gwHeaders = () => ({
  Authorization: `Basic ${Buffer.from(`${process.env.SMSGATE_USERNAME}:${process.env.SMSGATE_PASSWORD}`).toString("base64")}`,
  "Content-Type": "application/json",
});

async function gateway(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    return await fetch(`${SMS_API}${path}`, { ...options, signal: controller.signal });
  } finally { clearTimeout(timer); }
}

async function insertMessage(row) {
  const rows = await sb("sms_messages", { method: "POST", body: row });
  return Array.isArray(rows) ? rows[0] : rows;
}

function fail(status, error, detail) {
  const e = new Error(error);
  e.status = status;
  if (detail) e.detail = detail;
  return e;
}

// Send one SMS through the gateway and store it. Throws an Error carrying .status.
async function sendSms(phoneInput, messageInput) {
  if (!smsConfigured()) throw fail(503, "SMS Gate is not configured. Add SMSGATE_USERNAME and SMSGATE_PASSWORD in Vercel.");
  const phone = cleanPhone(phoneInput);
  const message = String(messageInput || "").trim();
  if (!phone || phone.length < 8 || !message) throw fail(400, "Enter a valid phone number and message.");
  if (message.length > 1600) throw fail(400, "Message is too long.");

  const variants = phoneVariants(phone).map(encodeURIComponent).join(",");
  const consent = await sb(`sms_messages?phone_number=in.(${variants})&status=in.(optout,optin)&order=created_at.desc&limit=1&select=status`);
  if (consent && consent[0] && consent[0].status === "optout") throw fail(403, "This contact opted out. They must reply START before another SMS can be sent.");

  const response = await gateway("/messages", {
    method: "POST",
    headers: gwHeaders(),
    body: JSON.stringify({
      phoneNumbers: [phone],
      textMessage: { text: message },
      ...(process.env.SMSGATE_DEVICE_ID ? { deviceId: process.env.SMSGATE_DEVICE_ID } : {}),
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw fail(502, "SMS Gate rejected the message.", result.message || result.error || `HTTP ${response.status}`);
  const gatewayId = String(result.id || result.messageId || (result.messages && result.messages[0] && result.messages[0].id) || "");
  return insertMessage({ phone_number: phone, message, direction: "outbound", status: "sent", sms_gate_id: gatewayId || null });
}

// All stored messages for a number, across spellings, oldest first.
async function conversationFor(phoneInput) {
  const variants = phoneVariants(phoneInput).map(encodeURIComponent).join(",");
  if (!variants) return [];
  const rows = await sb(`sms_messages?phone_number=in.(${variants})&order=created_at.asc&limit=500&select=id,phone_number,message,direction,status,created_at`);
  return rows || [];
}

module.exports = { smsConfigured, cleanPhone, toE164, phoneVariants, gwHeaders, gateway, insertMessage, sendSms, conversationFor };
