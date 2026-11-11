// Authenticated Make.com Instant Form importer. /api/make-lead is rewritten
// to the existing /api/lead function to avoid adding a Vercel function.
// It shares Meta lead-ID deduplication with the direct Meta webhook.
const crypto = require('node:crypto');
const SB = require('./_supabase');

function clean(value, limit) {
  return String(value == null ? '' : value).trim().slice(0, limit).replace(/[\u0000-\u001f\u007f]/g, ' ');
}
function equalSecret(a, b) {
  const actual = Buffer.from(String(a || ''), 'utf8');
  const expected = Buffer.from(String(b || ''), 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
async function parseBody(req, rawBody) {
  if (req.body == null) return JSON.parse((await rawBody(req)).toString('utf8'));
  if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  return JSON.parse(req.body.toString('utf8'));
}
function attribution(body, id) {
  const fields = [
    ['Meta lead ID', id], ['Form ID', clean(body.form_id, 80)],
    ['Campaign', clean(body.campaign_name, 180)], ['Campaign ID', clean(body.campaign_id, 80)],
    ['Ad set', clean(body.adset_name, 180)], ['Ad set ID', clean(body.adset_id, 80)],
    ['Ad', clean(body.ad_name, 180)], ['Ad ID', clean(body.ad_id, 80)],
  ];
  return 'Meta Instant Form imported via Make.com.\n' +
    fields.filter(([, value]) => value).map(([label, value]) => label + ': ' + value).join('\n');
}
const deliveryPath = id => 'meta_lead_deliveries?leadgen_id=eq.' + encodeURIComponent(id);
async function claim(id) {
  const conflict = 'meta_lead_deliveries?on_conflict=leadgen_id';
  let rows = await SB.sb(conflict, {
    method: 'POST', body: { leadgen_id: id },
    prefer: 'resolution=ignore-duplicates,return=representation',
  });
  if (rows?.length) return 'claimed';
  const path = deliveryPath(id);
  const prior = await SB.sb(path + '&select=processed_at,received_at&limit=1');
  if (prior?.[0]?.processed_at) return 'processed';
  // Only reclaim an abandoned unprocessed claim after 15 minutes.
  const cutoff = new Date(Date.now() - 15 * 60000).toISOString();
  if (prior?.[0]?.received_at && Date.parse(prior[0].received_at) < Date.parse(cutoff)) {
    const deleted = await SB.sb(path + '&processed_at=is.null&received_at=lt.' + encodeURIComponent(cutoff), {
      method: 'DELETE', prefer: 'return=representation',
    });
    if (deleted?.length) {
      rows = await SB.sb(conflict, {
        method: 'POST', body: { leadgen_id: id },
        prefer: 'resolution=ignore-duplicates,return=representation',
      });
      if (rows?.length) return 'claimed';
    }
  }
  return 'busy';
}

module.exports = async function makeLead(req, res, rawBody, handleLead) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const secret = process.env.MAKE_LEADS_API_KEY || '';
  if (secret.length < 32 || !SB.configured()) {
    return res.status(503).json({ error: 'Make lead integration is not configured' });
  }
  if (!equalSecret(req.headers?.['x-api-key'], secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let data;
  try { data = await parseBody(req, rawBody); }
  catch (_) { return res.status(400).json({ error: 'Invalid JSON' }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'JSON object required' });
  }
  const id = clean(data.lead_id, 40);
  const name = clean(data.name, 120);
  const phone = clean(data.phone, 40);
  const email = clean(data.email, 254);
  const postcode = clean(data.postcode, 12);
  if (!/^\d{6,40}$/.test(id) || !name || !phone) {
    return res.status(400).json({ error: 'Valid Meta lead ID, name and phone are required' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  let state;
  try { state = await claim(id); }
  catch (error) {
    console.error('Make lead claim error:', error.message);
    return res.status(503).json({ error: 'Could not claim lead; retry later' });
  }
  if (state === 'processed') return res.status(200).json({ ok: true, duplicate: true });
  if (state === 'busy') return res.status(503).json({ error: 'Lead currently processing; retry later' });

  const path = deliveryPath(id);
  try {
    let status = 200;
    let result = {};
    const inner = {
      setHeader() {},
      status(code) { status = code; return this; },
      json(data) { result = data; return this; },
    };
    await handleLead({ method: 'POST', body: { name, phone, email, postcode } }, inner, 'Instant Form');
    if (status !== 200 || !result?.ok) throw new Error('Existing intake failed with status ' + status);
    if (result.lead_id) {
      await SB.sb('lead_comments', {
        method: 'POST',
        body: { lead_id: result.lead_id, author: 'Make.com', kind: 'system', body: attribution(data, id) },
        prefer: 'return=minimal',
      });
    }
    await SB.sb(path, {
      method: 'PATCH', body: { processed_at: new Date().toISOString() },
      prefer: 'return=minimal',
    });
    return res.status(200).json({ ok: true, duplicate: false, lead_id: result.lead_id || null });
  } catch (error) {
    // A retry matches existing CRM records by email/phone, rather than creating a new card.
    await SB.sb(path, { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {});
    console.error('Make lead import error:', error.message);
    return res.status(503).json({ error: 'Lead import failed; retry later' });
  }
};
module.exports._test = { clean, equalSecret, attribution, claim };
