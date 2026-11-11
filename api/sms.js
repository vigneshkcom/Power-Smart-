// Two-way SMS portal API. Credentials stay server-side in Vercel environment variables.
const { sb, configured } = require('./_supabase');
const { readGatewayResponse, gatewayError } = require('./_sms-gateway-error');

const SMS_API = 'https://api.sms-gate.app/3rdparty/v1';
const smsConfigured = () => Boolean(process.env.SMSGATE_USERNAME && process.env.SMSGATE_PASSWORD);
function cleanPhone(value) {
  let phone = String(value || '').replace(/[^\d+]/g, '').trim();
  // Staff commonly enter Australian mobiles as 04xx xxx xxx. SMS Gate requires E.164.
  if (/^04\d{8}$/.test(phone)) phone = `+61${phone.slice(1)}`;
  else if (/^614\d{8}$/.test(phone)) phone = `+${phone}`;
  return phone;
}
// Customer names live on the pipeline leads, not on the SMS rows. Match on the
// last 9 digits so 0451 898 761, +61451898761 and 61451898761 are one person.
const phoneKey = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : '';
};
async function leadNamesByPhone() {
  const names = new Map();
  try {
    const leads = await sb('leads?select=name,phone&phone=not.is.null&order=updated_at.desc&limit=5000');
    // Newest lead wins when the same number appears twice.
    (leads || []).forEach((l) => { const k = phoneKey(l.phone); if (k && l.name && !names.has(k)) names.set(k, l.name); });
  } catch (e) { console.error('[SMS] lead name lookup failed:', e.message); }
  return names;
}

// What the gateway says happened to a message: Pending/Processed (not yet sent by the phone), Sent, Delivered, Failed.
// Accepting a request is not the same as the phone sending it, so the inbox shows the real state. Never throws.
// "Processed" means the phone has taken the message and handed it to Android to send; only Pending means it has not
// reached the phone yet. The phone does not always report "Sent" back, so Processed counts as sent.
const STATE_MAP = { pending: 'queued', processed: 'sent', sent: 'sent', delivered: 'delivered', failed: 'failed' };
async function gatewayState(gateId) {
  if (!gateId) return null;
  try {
    const r = await gateway(`/messages/${encodeURIComponent(gateId)}`, { headers: headers() });
    if (!r.ok) return null;
    const d = await readGatewayResponse(r);
    const rec = Array.isArray(d.recipients) && d.recipients[0] ? d.recipients[0] : {};
    const raw = String(d.state || d.status || rec.state || '').toLowerCase();
    const status = STATE_MAP[raw];
    return status ? { status, raw, error: String(rec.error || d.error || '').slice(0, 200) } : null;
  } catch (_) { return null; }
}
// Check SMS Gate before changing a local status; never resend a message during reconciliation.
// A queued text may be picked up by Android much later. We reconcile rather than guessing "sent".
async function refreshOutbound(rows) {
  const cutoff = Date.now() - 30 * 86400000;
  const todo = (rows || []).filter((m) => m.direction === 'outbound' && m.sms_gate_id &&
    ['queued', 'sent', 'pending', 'unknown'].includes(m.status) && Date.parse(m.created_at) > cutoff).slice(-20);
  let updated = 0;
  // Limit parallel gateway requests to keep the status refresh quick and gentle on SMS Gate.
  for (let i = 0; i < todo.length; i += 5) {
    await Promise.all(todo.slice(i, i + 5).map(async (m) => {
      const st = await gatewayState(m.sms_gate_id);
      if (!st || st.status === m.status) return;
      // Never regress a successfully sent message just because a stale gateway read says Pending.
      if (m.status === 'sent' && st.status === 'queued') return;
      const previous = m.status;
      try {
        await sb(`sms_messages?id=eq.${encodeURIComponent(m.id)}&status=eq.${encodeURIComponent(previous)}`,
          { method: 'PATCH', body: { status: st.status }, prefer: 'return=minimal' });
        m.status = st.status;
        updated++;
      } catch (e) {
        console.error('[SMS] Could not save refreshed message status:', e.message);
      }
    }));
  }
  return { checked: todo.length, updated };
}

// Customers (pipeline leads) whose saved mobile is this number, newest first, each with their latest sent quote link.
async function leadsForPhone(phone) {
  const key = phoneKey(phone);
  if (!key) return [];
  const rows = await sb('leads?select=id,name,phone,email,stage,quote_ref,quote_total&phone=not.is.null&order=updated_at.desc&limit=5000');
  const hits = (rows || []).filter((l) => phoneKey(l.phone) === key).slice(0, 5);
  for (const l of hits) {
    l.quote_url = '';
    if (!l.quote_ref) continue;
    try {
      const q = await sb(`sent_emails?lead_id=eq.${encodeURIComponent(l.id)}&kind=eq.quote&status=eq.sent&order=created_at.desc&limit=1&select=id`);
      if (q && q[0]) l.quote_url = `${require('./_quote').QUOTE_SITE}/quote?token=${q[0].id}`;
    } catch (_) { /* the link is a convenience */ }
  }
  return hits;
}
const leadNote = (leadId, body) => sb('lead_comments', { method: 'POST', body: { lead_id: leadId, author: 'SMS inbox', kind: 'note', body }, prefer: 'return=minimal' }).catch(() => {});
const safeId = (v) => (/^[\w-]{1,40}$/.test(String(v || '')) ? String(v) : '');

const headers = () => ({
  Authorization: `Basic ${Buffer.from(`${process.env.SMSGATE_USERNAME}:${process.env.SMSGATE_PASSWORD}`).toString('base64')}`,
  'Content-Type': 'application/json',
});

async function gateway(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    return await fetch(`${SMS_API}${path}`, { ...options, signal: controller.signal });
  } finally { clearTimeout(timer); }
}

// Customer replies reach the portal only through a webhook. SMS Gate's cloud never calls the portal itself:
// it hands the webhook list to the phone, and the PHONE posts each received text here.
// The portal registers it itself (idempotent), so inbound messages never depend on someone setting it up by hand.
const WEBHOOK_URL = 'https://portal.powersmartco.com.au/api/sms';
const WEBHOOK_ID = 'powersmart-sms-received';
const isPortalHook = (w) => w && w.event === 'sms:received' && w.url === WEBHOOK_URL;
async function listWebhooks() {
  const response = await gateway('/webhooks', { headers: headers() });
  const result = await readGatewayResponse(response);
  if (!response.ok) { const e = new Error(gatewayError(response.status, result).error); e.info = gatewayError(response.status, result); throw e; }
  return Array.isArray(result) ? result : [];
}
// The webhook is registered WITHOUT a device ID so every phone on the account forwards replies.
// A webhook tied to a device ID only fires on that one phone: after the SMS Gate app is reinstalled or
// re-registered the phone gets a new ID and the old webhook silently stops firing, while still "pointing at the portal".
async function ensureWebhook() {
  const existing = await listWebhooks();
  if (existing.some((w) => isPortalHook(w) && !w.deviceId)) return 'already';
  // Same ID replaces (upserts) the earlier device-bound registration rather than adding a second one.
  const response = await gateway('/webhooks', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ id: WEBHOOK_ID, url: WEBHOOK_URL, event: 'sms:received' }),
  });
  const result = await readGatewayResponse(response);
  if (!response.ok) { const e = new Error(gatewayError(response.status, result).error); e.info = gatewayError(response.status, result); throw e; }
  return 'registered';
}

// Ask the phone(s) to re-send recent received texts through the webhook. /inbox/refresh is the current
// SMS Gate endpoint; /messages/inbox/export is its deprecated predecessor, kept as a fallback.
// No device ID: every phone on the account re-sends, so a stale SMSGATE_DEVICE_ID cannot block it.
async function requestInboxResend(since, until) {
  const range = { since: since.toISOString(), until: until.toISOString() };
  let response = await gateway('/inbox/refresh', { method: 'POST', headers: headers(), body: JSON.stringify({ ...range, messageTypes: ['SMS'], webhookDelivery: 'Individual' }) });
  if (response.status === 404 || response.status === 405) {
    response = await gateway('/messages/inbox/export', { method: 'POST', headers: headers(), body: JSON.stringify(range) });
  }
  return response;
}

// Post a harmless test event to the public webhook address, the way the phone does, to prove the portal accepts it.
// Catches what no SMS Gate setting shows: a redirect, a firewall/bot challenge, a wrong domain, or a crashing handler.
async function webhookSelfTest() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'PowerSmart-portal-webhook-check' },
      body: JSON.stringify({ event: 'system:ping', id: 'portal-self-test', payload: { selfTest: true } }),
    });
    const text = await response.text().catch(() => '');
    let json = {}; try { json = JSON.parse(text); } catch (_) { /* not ours */ }
    if (response.ok && json.receiver === 'powersmart-sms') return { ok: true, status: response.status };
    const where = response.headers.get('location');
    const detail = response.status >= 300 && response.status < 400 ? `the address redirects${where ? ' to ' + where : ''}; the phone needs a direct HTTPS address`
      : response.status === 403 || response.status === 429 ? 'the request was blocked (Vercel Firewall / Bot Protection or Attack Challenge Mode); allow POST /api/sms'
      : response.ok ? 'something other than the SMS portal answered at this address'
      : `the portal answered HTTP ${response.status}`;
    return { ok: false, status: response.status, detail };
  } catch (e) {
    return { ok: false, status: null, detail: e.name === 'AbortError' ? 'the portal did not answer within 6 seconds' : 'could not reach the portal address: ' + e.message };
  } finally { clearTimeout(timer); }
}
const maskPhone = (p) => (String(p || '').length > 4 ? '…' + String(p).slice(-3) : String(p || ''));

async function insertMessage(row) {
  const rows = await sb('sms_messages', { method: 'POST', body: row });
  return Array.isArray(rows) ? rows[0] : rows;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'SMS storage is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel.' });

  try {
    let body = req.body || {};
    // The phone's HTTP client may send a charset or content type Vercel does not auto-parse.
    if (typeof body === 'string' || Buffer.isBuffer(body)) { try { body = JSON.parse(String(body)); } catch (_) { body = {}; } }
    if (req.method === 'POST' && typeof body.event === 'string' && /^(sms|mms|system|app):/.test(body.event)) {
      // SMS Gate's phone posts directly to this endpoint and cannot attach the staff portal key.
      if (body.event !== 'sms:received' || !body.payload) {
        // Pings, app start and the portal's own self-test: acknowledge so the phone does not retry.
        console.log('[SMS webhook]', body.event, body.id === 'portal-self-test' ? '(portal self-test)' : '', 'acknowledged');
        return res.status(200).json({ ok: true, receiver: 'powersmart-sms', event: body.event });
      }
      const p = body.payload;
      // `sender` is the customer; `phoneNumber` is its deprecated alias in older SMS Gate app versions.
      const phone = cleanPhone(p.sender || p.phoneNumber || p.phone);
      const message = String(p.message || p.textMessage || p.text || '').trim();
      if (!phone || !message) {
        console.error('[SMS webhook] sms:received rejected: missing', !phone ? 'sender' : 'message', '| payload keys:', Object.keys(p).join(','));
        return res.status(400).json({ error: 'Webhook payload is missing a phone number or message.' });
      }
      const gatewayId = String(p.messageId || p.id || p.smsId || '');
      if (gatewayId) {
        const existing = await sb(`sms_messages?sms_gate_id=eq.${encodeURIComponent(gatewayId)}&direction=eq.inbound&phone_number=eq.${encodeURIComponent(phone)}&select=id&limit=1`);
        if (existing && existing.length) {
          console.log('[SMS webhook] sms:received from', maskPhone(phone), 'duplicate, already stored');
          return res.status(200).json({ ok: true, receiver: 'powersmart-sms', duplicate: true });
        }
      }
      const normalised = message.trim().toUpperCase();
      const status = ['STOP', 'UNSUBSCRIBE', 'OPT OUT'].includes(normalised) ? 'optout' : ['START', 'UNSTOP'].includes(normalised) ? 'optin' : 'received';
      await insertMessage({ phone_number: phone, message, direction: 'inbound', status, sms_gate_id: gatewayId || null });
      console.log('[SMS webhook] sms:received from', maskPhone(phone), 'stored as', status);
      return res.status(200).json({ ok: true, receiver: 'powersmart-sms' });
    }

    if (req.method === 'GET') {
      const action = String(req.query.action || 'contacts');
      if (action === 'diagnostics') {
        if (req.headers?.['x-portal-key'] !== '2026') return res.status(401).json({ error: 'Invalid portal key' });
        if (!smsConfigured()) return res.status(503).json({ error: 'SMS Gate is not configured.' });
        try {
          // Run the slow checks side by side; the self-test calls this same endpoint over the public internet.
          const [response, hooks, selfTest, lastInbound, lastOutbound] = await Promise.all([
            gateway('/devices', { headers: headers() }),
            listWebhooks().catch(() => null),
            webhookSelfTest(),
            sb('sms_messages?direction=eq.inbound&order=created_at.desc&limit=1&select=created_at').catch(() => null),
            sb('sms_messages?direction=eq.outbound&status=eq.sent&order=created_at.desc&limit=1&select=created_at').catch(() => null),
          ]);
          const result = await readGatewayResponse(response);
          if (!response.ok) {
            const info = gatewayError(response.status, result);
            return res.status(200).json({ gatewayReachable: false, httpStatus: response.status, error: response.status >= 500 ? 'SMS Gate is temporarily unavailable.' : info.error, detail: info.detail, selfTest });
          }
          const devices = (Array.isArray(result) ? result : []).filter(Boolean);
          const deviceIds = devices.map((d) => d.id);
          // Connected only if a portal webhook will actually fire on a phone that still exists.
          let inboundConnected = null, webhookUrls = [], staleWebhook = false;
          if (hooks) {
            webhookUrls = hooks.filter((w) => w.event === 'sms:received').map((w) => w.url);
            const ours = hooks.filter(isPortalHook);
            inboundConnected = ours.some((w) => !w.deviceId || deviceIds.includes(w.deviceId));
            staleWebhook = !inboundConnected && ours.length > 0;
          }
          const configuredId = process.env.SMSGATE_DEVICE_ID || '';
          const lastSeen = devices.map((d) => d.lastSeen || d.last_seen || d.updatedAt).filter(Boolean).sort().pop() || null;
          return res.status(200).json({
            gatewayReachable: true, httpStatus: response.status, deviceCount: devices.length, inboundConnected, staleWebhook, webhookUrls,
            deviceIdConfigured: Boolean(configuredId), deviceIdMatches: configuredId ? deviceIds.includes(configuredId) : null,
            deviceLastSeen: lastSeen, lastInboundAt: lastInbound?.[0]?.created_at || null, lastOutboundAt: lastOutbound?.[0]?.created_at || null,
            selfTest,
          });
        } catch (_) {
          return res.status(200).json({ gatewayReachable: false, error: 'SMS Gate is not responding. SMS sending may be unavailable.', detail: 'Connection check failed or timed out.' });
        }
      }
      if (action === 'health') return res.status(200).json({
        storageConfigured: true,
        smsGateConfigured: smsConfigured(),
        deviceConfigured: Boolean(process.env.SMSGATE_DEVICE_ID),
        apiBase: 'https://api.sms-gate.app',
      });
      if (action === 'conversation') {
        const phone = cleanPhone(req.query.phone);
        if (!phone) return res.status(400).json({ error: 'A phone number is required.' });
        const rows = await sb(`sms_messages?phone_number=eq.${encodeURIComponent(phone)}&order=created_at.asc&select=id,phone_number,message,direction,status,created_at,sms_gate_id`);
        try { await refreshOutbound(rows); } catch (e) { console.error('[SMS] status refresh failed:', e.message); }
        const names = await leadNamesByPhone();
        let leads = [];
        try { leads = await leadsForPhone(phone); } catch (e) { console.error('[SMS] lead lookup failed:', e.message); }
        return res.status(200).json({ messages: (rows || []).map(({ sms_gate_id, ...m }) => m), name: names.get(phoneKey(phone)) || '', leads });
      }
      if (action === 'lead_search') {
        const q = String(req.query.q || '').replace(/[,()*%\\]/g, ' ').trim().slice(0, 60);
        if (q.length < 2) return res.status(200).json({ leads: [] });
        const found = await sb(`leads?or=(name.ilike.*${encodeURIComponent(q)}*,email.ilike.*${encodeURIComponent(q)}*,phone.ilike.*${encodeURIComponent(q)}*)&select=id,name,phone,email,stage,quote_ref&order=updated_at.desc&limit=10`);
        return res.status(200).json({ leads: found || [] });
      }
      const rows = await sb('sms_messages?order=created_at.desc&limit=1000&select=id,phone_number,message,direction,status,created_at');
      const conversations = [];
      const seen = new Set();
      for (const row of rows || []) {
        if (!seen.has(row.phone_number)) { seen.add(row.phone_number); conversations.push(row); }
      }
      const names = await leadNamesByPhone();
      conversations.forEach((c) => { c.name = names.get(phoneKey(c.phone_number)) || ''; });
      return res.status(200).json({ conversations });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
    if (body.action === 'refresh_outbound') {
      if (!smsConfigured()) return res.status(503).json({ error: 'SMS Gate is not configured.' });
      // Refresh old queued messages in rotating small batches. This never submits or resends SMS.
      const rows = await sb('sms_messages?direction=eq.outbound&status=in.(queued,pending,unknown)&sms_gate_id=not.is.null&order=created_at.asc&limit=500&select=id,direction,status,created_at,sms_gate_id');
      const waiting = (rows || []).length;
      const requested = Number(body.offset);
      const offset = Number.isSafeInteger(requested) && requested >= 0 && requested < waiting ? requested : 0;
      const batch = (rows || []).slice(offset, offset + 20);
      const result = await refreshOutbound(batch);
      return res.status(200).json({ ok: true, checked: result.checked, updated: result.updated, waiting,
        nextOffset: offset + batch.length >= waiting ? 0 : offset + batch.length });
    }
    if (body.action === 'send') {
      if (String(process.env.SMS_ENABLED || '').toLowerCase() !== 'true') return res.status(503).json({ error: 'SMS is paused for now (new SIM being set up). Use email instead.' });
      if (!smsConfigured()) return res.status(503).json({ error: 'SMS Gate is not configured. Add SMSGATE_USERNAME and SMSGATE_PASSWORD in Vercel.' });
      const phone = cleanPhone(body.phone);
      const message = String(body.message || '').trim();
      if (!/^\+[1-9]\d{7,14}$/.test(phone) || (phone.startsWith('+61') && !/^\+614\d{8}$/.test(phone)) || !message) return res.status(400).json({ error: 'Enter a valid phone number and message.' });
      if (message.length > 1600) return res.status(400).json({ error: 'Message is too long.' });
      const consent = await sb(`sms_messages?phone_number=eq.${encodeURIComponent(phone)}&status=in.(optout,optin)&order=created_at.desc&limit=1&select=status`);
      if (consent && consent[0] && consent[0].status === 'optout') return res.status(403).json({ error: 'This contact opted out. They must reply START before another SMS can be sent.' });
      const msgId = require('crypto').randomUUID();
      const response = await gateway('/messages', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ id: msgId, phoneNumbers: [phone], textMessage: { text: message }, ttl: 3600, ...(process.env.SMSGATE_DEVICE_ID ? { deviceId: process.env.SMSGATE_DEVICE_ID } : {}) }),
      });
      const result = await readGatewayResponse(response);
      if (!response.ok) return res.status(502).json(gatewayError(response.status, result));
      const gatewayId = String(result.id || result.messageId || (result.messages && result.messages[0] && result.messages[0].id) || msgId);
      // Accepted by the gateway is not sent by the phone: look at what the gateway says for a few seconds.
      let state = null;
      for (let i = 0; i < 3 && !(state && state.status !== 'queued'); i++) { await new Promise((r) => setTimeout(r, i === 0 ? 1200 : 1500)); state = await gatewayState(gatewayId); }
      const status = state ? state.status : 'queued';
      const saved = await insertMessage({ id: msgId, phone_number: phone, message, direction: 'outbound', status, sms_gate_id: gatewayId });
      // Acceptance is not delivery. Do not label unreadable or Pending gateway states as sent.
      const warning = status === 'failed' ? 'The gateway phone could not send this message' + (state && state.error ? ': ' + state.error : '.')
        : status === 'queued' ? 'Accepted by SMS Gate, but still awaiting confirmation from the sending phone.' : '';
      return res.status(200).json({ ok: true, message: saved, delivery: status, warning });
    }

    // Connect this number to a customer: save it as the customer's mobile, so their texts, quotes and card line up.
    if (body.action === 'link_lead') {
      const leadId = safeId(body.lead_id), phone = cleanPhone(body.phone);
      if (!leadId || !/^\+[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ error: 'Choose a customer and a valid mobile number.' });
      const lead = (await sb(`leads?id=eq.${encodeURIComponent(leadId)}&select=id,name,phone&limit=1`))?.[0];
      if (!lead) return res.status(404).json({ error: 'That customer was not found.' });
      if (lead.phone && phoneKey(lead.phone) !== phoneKey(phone) && body.replace !== true) {
        return res.status(409).json({ error: `${lead.name} already has a different number saved (${lead.phone}).`, code: 'phone_differs', existing: lead.phone });
      }
      await sb(`leads?id=eq.${encodeURIComponent(leadId)}`, { method: 'PATCH', body: { phone }, prefer: 'return=minimal' });
      await leadNote(leadId, `Mobile ${phone} connected from the SMS inbox${lead.phone && phoneKey(lead.phone) !== phoneKey(phone) ? ` (replaced ${lead.phone})` : ''}.`);
      return res.status(200).json({ ok: true, lead: { id: lead.id, name: lead.name } });
    }
    if (body.action === 'create_lead') {
      const phone = cleanPhone(body.phone), name = String(body.name || '').trim().slice(0, 120), email = String(body.email || '').trim().toLowerCase().slice(0, 254);
      if (!name) return res.status(400).json({ error: 'Enter the customer name.' });
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ error: 'That mobile number is not valid.' });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'That email address is not valid.' });
      const rows = await sb('leads', { method: 'POST', body: { name, phone, email: email || null, source: 'SMS', stage: 'new_lead' } });
      const lead = Array.isArray(rows) ? rows[0] : rows;
      if (lead && lead.id) await leadNote(lead.id, 'Customer created from the SMS inbox.');
      return res.status(200).json({ ok: true, lead: lead && { id: lead.id, name: lead.name } });
    }

    // Delete one message from the inbox. Opt-out / opt-in messages are the customer's consent record, so they are kept.
    if (body.action === 'delete_message') {
      const id = safeId(body.id);
      if (!id) return res.status(400).json({ error: 'Choose a message to delete.' });
      const row = (await sb(`sms_messages?id=eq.${encodeURIComponent(id)}&select=id,status&limit=1`))?.[0];
      if (!row) return res.status(404).json({ error: 'That message was not found. It may already be deleted.' });
      if (row.status === 'optout' || row.status === 'optin') return res.status(409).json({ error: "This message records the customer's STOP / START choice, so it can't be deleted." });
      await sb(`sms_messages?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
      return res.status(200).json({ ok: true });
    }

    // Delete whole conversations from the inbox (and from Supabase). STOP / START messages are the customer's consent
    // record and are kept, so a customer who opted out can never be texted again by accident.
    if (body.action === 'delete_conversations') {
      const phones = [...new Set((Array.isArray(body.phones) ? body.phones : []).map(cleanPhone).filter((p) => /^\+[1-9]\d{7,14}$/.test(p)))].slice(0, 100);
      if (!phones.length) return res.status(400).json({ error: 'Choose at least one conversation to delete.' });
      let deleted = 0, kept = 0;
      for (const phone of phones) {
        const removed = await sb(`sms_messages?phone_number=eq.${encodeURIComponent(phone)}&or=(status.is.null,status.not.in.(optout,optin))`, { method: 'DELETE', prefer: 'return=representation' });
        deleted += Array.isArray(removed) ? removed.length : 0;
        const left = await sb(`sms_messages?phone_number=eq.${encodeURIComponent(phone)}&select=id`);
        kept += Array.isArray(left) ? left.length : 0;
      }
      return res.status(200).json({ ok: true, conversations: phones.length, deleted, kept_consent_records: kept });
    }

    if (body.action === 'connect') {
      if (!smsConfigured()) return res.status(503).json({ error: 'SMS Gate is not configured.' });
      try { return res.status(200).json({ ok: true, webhook: await ensureWebhook() }); }
      catch (e) { return res.status(502).json({ error: e.info?.error || e.message, detail: e.info?.detail || '' }); }
    }

    if (body.action === 'sync') {
      if (!smsConfigured()) return res.status(503).json({ error: 'SMS Gate is not configured.' });
      // Make sure replies are wired up, then ask the phone to re-send the last week of received texts through the webhook.
      let webhook = 'unknown';
      try { webhook = await ensureWebhook(); } catch (e) { webhook = 'failed: ' + (e.info?.detail || e.message); }
      const until = new Date(), since = new Date(until.getTime() - 7 * 86400000);
      const response = await requestInboxResend(since, until);
      if (!response.ok) { const info = gatewayError(response.status, await readGatewayResponse(response)); return res.status(502).json({ error: 'Replies connected: ' + (String(webhook).startsWith('failed') ? 'NO (' + String(webhook).slice(8) + ')' : 'yes (' + webhook + ')') + '. Could not request an older-texts sync: ' + info.error, detail: info.detail, webhook }); }
      return res.status(200).json({ ok: true, webhook });
    }
    return res.status(400).json({ error: 'Unknown SMS action.' });
  } catch (error) {
    if (error.name === 'AbortError') return res.status(504).json({ error: 'SMS Gate did not respond in time. Submission could not be confirmed. Check the SMS inbox and gateway before trying again.', code: 'sms_submission_unknown' });
    if (error instanceof TypeError && /fetch|network/i.test(error.message)) return res.status(502).json({ error: 'Could not connect to SMS Gate. Submission could not be confirmed. Check the SMS inbox and gateway before trying again.', code: 'sms_submission_unknown' });
    console.error('[SMS]', error.message);
    return res.status(error.status || 500).json({ error: error.message || 'SMS portal request failed.' });
  }
};
