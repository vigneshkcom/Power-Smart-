// Phone numbers whose website enquiries are silently dropped (competitors).
// The visitor still sees the normal "thanks, we'll be in touch" response, but nothing
// is saved and no SMS or email is sent. Add numbers in any format (04…, +614…, 614…).
// Underscore prefix => not a Vercel route.

const BLOCKED = ["0425200047", "0400608098", "0415706675"];

// Reduce any Australian mobile format to its 9 significant digits.
function key(value) {
  let d = String(value || "").replace(/\D/g, "");
  if (d.startsWith("0061")) d = d.slice(4);
  else if (d.startsWith("61") && d.length >= 11) d = d.slice(2);
  return d.replace(/^0+/, "");
}

const BLOCKED_KEYS = new Set(BLOCKED.map(key));

function isBlocked(phone) {
  const k = key(phone);
  return k.length > 0 && BLOCKED_KEYS.has(k);
}

module.exports = { isBlocked, BLOCKED };
