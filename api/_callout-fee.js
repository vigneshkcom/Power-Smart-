// Existing customers retain the rate offered before this change.
const CUTOVER_UTC = '2026-11-06T03:15:00Z';
const LEGACY_CENTS = 3500;
const CURRENT_CENTS = 5000;

function centsForLead(lead) {
  if (!lead || !lead.created_at) throw new Error('Customer pricing date is unavailable.');
  const created = Date.parse(lead.created_at);
  if (!Number.isFinite(created)) throw new Error('Customer pricing date is invalid.');
  return created < Date.parse(CUTOVER_UTC) ? LEGACY_CENTS : CURRENT_CENTS;
}

module.exports = { CUTOVER_UTC, LEGACY_CENTS, CURRENT_CENTS, centsForLead };
