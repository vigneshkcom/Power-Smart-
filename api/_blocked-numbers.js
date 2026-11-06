// Competitors whose website enquiries are silently dropped. The visitor still sees the
// normal "thanks, we'll be in touch" response, but nothing is saved and no SMS or email
// is sent. An enquiry is dropped if its phone, email OR name matches.
// Underscore prefix => not a Vercel route.

const BLOCKED_PHONES = ["0425200047", "0400608098", "0415706675"];   // any format: 04…, +614…, 614…

const BLOCKED_EMAILS = [
  "amit.chowdhary2011@gmail.com",
  "amit@goldsure.com.au",
  "adam@goldsure.com.au",
  "adam@primsal.com",
  "caneva525@gmail.com",
];

// Matched against the name with everything except letters removed, so spacing,
// capitals and punctuation don't matter ("Ben  Caneva" and "bencaneva" both hit).
const BLOCKED_NAME_PARTS = ["caneva", "sicari"];
// Amit + any spelling of Chowdhury (Chowdhary, Choudhary, Chaudhary, Chodwdhary...).
const BLOCKED_NAME_PATTERNS = [/amit.*ch[a-z]{0,3}d[a-z]{0,2}h?[au]r[yi]/];

// Reduce any Australian mobile format to its 9 significant digits.
function phoneKey(value) {
  let d = String(value || "").replace(/\D/g, "");
  if (d.startsWith("0061")) d = d.slice(4);
  else if (d.startsWith("61") && d.length >= 11) d = d.slice(2);
  return d.replace(/^0+/, "");
}

const PHONE_KEYS = new Set(BLOCKED_PHONES.map(phoneKey));
const EMAILS = new Set(BLOCKED_EMAILS.map((e) => e.toLowerCase()));

function isBlockedPhone(phone) { const k = phoneKey(phone); return k.length > 0 && PHONE_KEYS.has(k); }
function isBlockedEmail(email) { return EMAILS.has(String(email || "").trim().toLowerCase()); }
function isBlockedName(name) {
  const n = String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
  return n.length > 0 && (BLOCKED_NAME_PARTS.some((p) => n.includes(p)) || BLOCKED_NAME_PATTERNS.some((re) => re.test(n)));
}

function isBlocked(arg) {
  if (arg && typeof arg === "object") return isBlockedPhone(arg.phone) || isBlockedEmail(arg.email) || isBlockedName(arg.name);
  return isBlockedPhone(arg);
}

module.exports = { isBlocked, isBlockedPhone, isBlockedEmail, isBlockedName };
