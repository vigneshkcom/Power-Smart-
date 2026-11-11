// Meta Page leadgen webhook. Configure the Page subscription and secrets in Vercel.
// A notification contains a lead ID only; the answers are fetched with the Page token.
const crypto = require('node:crypto');
const SB = require('./_supabase');
const { handleLead } = require('./lead');

module.exports.config = { api: { bodyParser: false }, maxDuration: 60 };

const PAGE_ID = '1369534046242772';
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v24.0';

function same(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function rawBody(req) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 1024 * 1024) throw new Error('Webhook body too large');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function answers(fieldData) {
  const fields = new Map((fieldData || []).map(({ name, values }) => [String(name).toLowerCase(), String(values?.[0] || '').trim()]));
  return {
    name: fields.get('full_name') || [fields.get('first_name'), fields.get('last_name')].filter(Boolean).join(' '),
    phone: fields.get('phone_number') || '',
    email: fields.get('email') || '',
    postcode: fields.get('post_code') || fields.get('postcode') || '',
  };
}

async function fetchLead(id) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(id)}?fields=id,field_data,form_id,ad_id`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.META_PAGE_ACCESS_TOKEN}` } });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(`Meta lead retrieval failed (${response.status}): ${data.error?.message || 'Unknown error'}`);
  return data;
}

async function deliver(id) {
  const claimed = await SB.sb('meta_lead_deliveries?on_conflict=leadgen_id', {
    method: 'POST', body: { leadgen_id: id }, prefer: 'resolution=ignore-duplicates,return=representation',
  });
  if (!claimed?.length) {
    const rows = await SB.sb(`meta_lead_deliveries?leadgen_id=eq.${encodeURIComponent(id)}&select=processed_at&limit=1`);
    if (rows?.[0]?.processed_at) return;
    throw new Error(`Meta lead ${id} is already being processed`);
  }

  try {
    const lead = await fetchLead(id);
    const body = answers(lead.field_data);
    if (!body.name || !body.phone) throw new Error(`Meta lead ${id} has no name or phone`);
    let code = 200;
    const result = {};
    const response = {
      setHeader() {},
      status(value) { code = value; return this; },
      json(value) { Object.assign(result, value); return value; },
    };
    await handleLead({ method: 'POST', body }, response, 'Instant Form');
    if (code !== 200 || !result.ok) throw new Error(`Lead intake failed (${code}): ${result.error || 'Unknown error'}`);
    await SB.sb(`meta_lead_deliveries?leadgen_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', body: { processed_at: new Date().toISOString() }, prefer: 'return=minimal',
    });
  } catch (error) {
    await SB.sb(`meta_lead_deliveries?leadgen_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {});
    throw error;
  }
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query || {};
    if (mode === 'subscribe' && process.env.META_WEBHOOK_VERIFY_TOKEN && same(token, process.env.META_WEBHOOK_VERIFY_TOKEN)) {
      return res.status(200).send(String(challenge || ''));
    }
    return res.status(403).send('Verification failed');
  }
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  if (!process.env.META_APP_SECRET || !process.env.META_PAGE_ACCESS_TOKEN || !SB.configured()) {
    return res.status(503).send('Lead integration is not configured');
  }
  let raw;
  try { raw = await rawBody(req); } catch (_) { return res.status(413).send('Invalid body'); }
  const digest = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
  if (!same(req.headers['x-hub-signature-256'], digest)) return res.status(403).send('Invalid signature');

  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).send('Invalid JSON'); }
  if (payload.object !== 'page') return res.status(200).send('Ignored');
  const ids = new Set();
  for (const entry of payload.entry || []) {
    if (String(entry.id) !== PAGE_ID) continue;
    for (const change of entry.changes || []) {
      if (change.field === 'leadgen' && String(change.value?.page_id) === PAGE_ID && change.value?.leadgen_id) {
        ids.add(String(change.value.leadgen_id));
      }
    }
  }
  try {
    for (const id of ids) await deliver(id);
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Meta lead webhook:', error.message);
    return res.status(503).send('Retry later');
  }
};

module.exports._test = { answers, same };
