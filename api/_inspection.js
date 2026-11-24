// Inspection-only state and validation. Prices are GST-inclusive cents.
const SB = require('./_supabase');
const CHECKS = ['coverage', 'photoelectric', 'age_expiry', 'functionality', 'interconnection'];
const LABELS = { compliant: 'Inspection completed: Compliant', declined: 'Inspection completed: Non-compliant, upgrade declined', converted: 'Inspection converted to installation', installed: 'Installation completed and compliant' };
function fail(message) { return Object.assign(new Error(message), { status: 409 }); }
function isInspection(job) { return job.work_type === 'inspection'; }
function tracked(job) { return isInspection(job) || !!job.inspection_converted_at; }
function clean(raw) {
  if (!raw || typeof raw !== 'object') throw fail('Complete the inspection record.');
  const alarms = Array.isArray(raw.alarms) ? raw.alarms : [];
  if (alarms.length > 60) throw fail('Too many existing alarms.');
  const str = (v, n) => String(v || '').trim().slice(0, n);
  const photo = v => { const p = str(v, 500); if (p && (!p.startsWith('/PowerSmart Jobs/') || p.includes('..'))) throw fail('Invalid inspection photo.'); return p; };
  const checks = {};
  for (const k of CHECKS) checks[k] = ['pass','fail','na'].includes(raw.checks?.[k]) ? raw.checks[k] : '';
  return { alarms: alarms.map((a, i) => {
    if (!['battery','hardwired'].includes(a.type)) throw fail('Choose the existing alarm power type.');
    return { id: str(a.id, 30) || 'e' + (i + 1), type: a.type, location: str(a.location, 120),
      expiry: str(a.expiry, 40), photo: photo(a.photo), plate: photo(a.plate) };
  }), checks, findings: str(raw.findings, 4000), reason: str(raw.reason, 2000),
    compliant: typeof raw.compliant === 'boolean' ? raw.compliant : null,
    decision: ['accepted','declined'].includes(raw.decision) ? raw.decision : '',
    customer_name: str(raw.customer_name, 120) };
}
function validate(record) {
  const d = clean(record);
  if (CHECKS.some(k => !d.checks[k])) throw fail('Complete every inspection checklist check.');
  if (d.alarms.some(a => !a.location || !a.expiry || !a.photo || !a.plate)) throw fail('Record each alarm location, age/expiry, alarm photo and compliance plate photo.');
  if (d.compliant === null) throw fail('Record whether the property is compliant.');
  if (d.compliant && (!d.alarms.length || CHECKS.some(k => d.checks[k] !== 'pass'))) throw fail('A compliant property must have alarms and pass every check.');
  if (!d.compliant && !d.reason) throw fail('Record why the property is non-compliant.');
  if (!d.compliant && !d.decision) throw fail('Record the customer upgrade decision.');
  if (!d.compliant && d.decision === 'accepted' && !d.customer_name) throw fail('Record the customer name authorising the upgrade.');
  return d;
}
async function verifyPhotos(job, d) {
  if (!d.alarms.length) return;
  const photos = await require('./_dropbox').photosForJob(job, { all: true });
  const paths = new Set((photos.photos || []).map(p => p.path));
  if (d.alarms.some(a => !paths.has(a.photo) || !paths.has(a.plate))) throw fail('Synchronise the existing alarm and plate photos to this job first.');
}
async function payment(job) {
  if (!job.lead_id || !job.quote_ref) throw fail('Link the inspection to its paid quote before proceeding.');
  const rows = await SB.sb('payment_requests?lead_id=eq.' + encodeURIComponent(job.lead_id) + '&quote_ref=eq.' + encodeURIComponent(job.quote_ref) + '&payment_type=eq.inspection&status=eq.paid&select=id,amount_paid_cents,amount_cents&order=paid_at.asc');
  const p = (rows || []).find(p => (p.amount_paid_cents || p.amount_cents) === 12000 && (!job.inspection_payment_id || p.id === job.inspection_payment_id));
  if (!p) throw fail('The $120 inspection fee must be paid in full upfront.');
  const used = await SB.sb('jobs?inspection_payment_id=eq.' + p.id + '&id=neq.' + job.id + '&select=id&limit=1');
  if (used?.length) throw fail('This inspection payment is already allocated to another job.');
  return p;
}
async function credits(job) {
  const p = await payment(job);
  return [{ label: 'Inspection payment credited in full', cents: p.amount_paid_cents || p.amount_cents, payment_id: p.id }];
}
function installItems(items, job) {
  if (!job.inspection_converted_at) return items;
  const work = items.filter(i => i.code !== 'inspection' && i.code !== 'installation_callout');
  return [...work, { code: 'installation_callout', label: 'Electrician installation call-out fee', qty: 1, unit_cents: 5000, amount_cents: 5000 }];
}
function certificateAllowed(job) {
  if (!tracked(job)) return true;
  if (job.inspection_converted_at) return job.compliance_outcome === 'installed' && !!job.installation_compliant_at;
  try { const d = validate(job.inspection); return d.compliant === true && job.compliance_outcome === 'compliant'; } catch (_) { return false; }
}
module.exports = { CHECKS, LABELS, clean, validate, verifyPhotos, payment, credits, installItems, isInspection, tracked, certificateAllowed };

