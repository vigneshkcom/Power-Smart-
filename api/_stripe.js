const crypto = require("crypto");

const API = "https://api.stripe.com/v1";

function configured() {
  return Boolean((process.env.STRIPE_SECRET_KEY || "").trim() || (process.env.REVOLUT_SECRET_KEY || "").trim());
}

async function request(path, form, options = {}) {
  // The checkout callers share a session representation. Existing cs_* and
  // payment-intent requests always go to Stripe, regardless of the cutover.
  const revolutSession = /^\/checkout\/sessions\/(rv_[a-f0-9-]{36})(\/expire)?$/i.exec(path);
  if (revolutSession) {
    const Revolut = require('./_revolut');
    if (revolutSession[2]) await Revolut.request('/orders/' + revolutSession[1].slice(3) + '/cancel', {});
    return Revolut.getSession(revolutSession[1]);
  }
  if (path === '/checkout/sessions' && form && (process.env.REVOLUT_SECRET_KEY || '').trim()) {
    const Revolut = require('./_revolut');
    if (await Revolut.gatewayFor(form) === 'revolut') return Revolut.createSession(form, options);
  }
  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) {
    const error = new Error("Stripe is not configured");
    error.status = 500;
    throw error;
  }
  const res = await fetch(API + path, {
    method: form ? "POST" : "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}) },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    const error = new Error((data.error && data.error.message) || `Stripe ${res.status}`);
    error.status = 502;
    throw error;
  }
  return data;
}

function verifySignature(raw, header) {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((part) => part.trim().split("=", 2)));
  if (!parts.t || !parts.v1 || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex");
  const actual = Buffer.from(parts.v1, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

module.exports = { configured, request, verifySignature };
