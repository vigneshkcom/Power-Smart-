// Two-way SMS portal API. Credentials stay server-side in Vercel environment variables.
const { sb, configured } = require('./_supabase');

const SMS_API = 'https://api.sms-gate.app/3rdparty/v1';
const smsConfigured = () => Boolean(process.env.SMSGATE_USERNAME && process.env.SMSGATE_PASSWORD);
const cleanPhone = value => String(value || '').replace(/[^\d+]/g, '').trim();
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

async function insertMessage(row) {
  const rows = await sb('sms_messages', { method: 'POST', body: row });
  return Array.isArray(rows) ? rows[0] : rows;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'SMS storage is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel.' });

  try {
    const body = req.body || {};
    if (req.method === 'POST' && body.event === 'sms:received' && body.payload) {
      // SMS Gate posts directly to this endpoint and cannot attach the staff portal key.
      const p = body.payload;
      const phone = cleanPhone(p.phoneNumber || p.phone || p.sender);
      const message = String(p.message || p.textMessage || p.text || '').trim();
      if (!phone || !message) return res.status(400).json({ error: 'Webhook payload is missing a phone number or message.' });
      const gatewayId = String(p.id || p.messageId || p.smsId || '');
      if (gatewayId) {
        const existing = await sb(`sms_messages?sms_gate_id=eq.${encodeURIComponent(gatewayId)}&select=id&limit=1`);
        if (existing && existing.length) return res.status(200).json({ ok: true, duplicate: true });
      }
      const normalised = message.trim().toUpperCase();
      const status = ['STOP', 'UNSUBSCRIBE', 'OPT OUT'].includes(normalised) ? 'optout' : ['START', 'UNSTOP'].includes(normalised) ? 'optin' : 'received';
      await insertMessage({ phone_number: phone, message, direction: 'inbound', status, sms_gate_id: gatewayId || null });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET') {
      const action = String(req.query.action || 'contacts');
      if (action === 'health') return res.status(200).json({
        storageConfigured: true,
        smsGateConfigured: smsConfigured(),
        deviceConfigured: Boolean(process.env.SMSGATE_DEVICE_ID),
        apiBase: 'https://api.sms-gate.app',
      });
      if (action === 'conversation') {
        const phone = cleanPhone(req.query.phone);
        if (!phone) return res.status(400).json({ error: 'A phone number is required.' });
        const rows = await sb(`sms_messages?phone_number=eq.${encodeURIComponent(phone)}&order=created_at.asc&select=id,phone_number,message,direction,status,created_at`);
        return res.status(200).json({ messages: rows || [] });
      }
      const rows = await sb('sms_messages?order=created_at.desc&limit=1000&select=id,phone_number,message,direction,status,created_at');
      const conversations = [];
      const seen = new Set();
      for (const row of rows || []) {
        if (!seen.has(row.phone_number)) { seen.add(row.phone_number); conversations.push(row); }
      }
      return res.status(200).json({ conversations });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
    if (body.action === 'send') {
      if (!smsConfigured()) return res.status(503).json({ error: 'SMS Gate is not configured. Add SMSGATE_USERNAME and SMSGATE_PASSWORD in Vercel.' });
      const phone = cleanPhone(body.phone);
      const message = String(body.message || '').trim();
      if (!phone || phone.length < 8 || !message) return res.status(400).json({ error: 'Enter a valid phone number and message.' });
      if (message.length > 1600) return res.status(400).json({ error: 'Message is too long.' });
      const consent = await sb(`sms_messages?phone_number=eq.${encodeURIComponent(phone)}&status=in.(optout,optin)&order=created_at.desc&limit=1&select=status`);
      if (consent && consent[0] && consent[0].status === 'optout') return res.status(403).json({ error: 'This contact opted out. They must reply START before another SMS can be sent.' });
      const response = await gateway('/messages', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ phoneNumbers: [phone], textMessage: { text: message }, ...(process.env.SMSGATE_DEVICE_ID ? { deviceId: process.env.SMSGATE_DEVICE_ID } : {}) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = typeof result.message === 'string'
          ? result.message
          : typeof result.error === 'string'
            ? result.error
            : JSON.stringify(result).slice(0, 600) || `HTTP ${response.status}`;
        return res.status(502).json({ error: 'SMS Gate rejected the message.', detail });
      }
      const gatewayId = String(result.id || result.messageId || (result.messages && result.messages[0] && result.messages[0].id) || '');
      const saved = await insertMessage({ phone_number: phone, message, direction: 'outbound', status: 'sent', sms_gate_id: gatewayId || null });
      return res.status(200).json({ ok: true, message: saved });
    }

    if (body.action === 'sync') {
      if (!smsConfigured()) return res.status(503).json({ error: 'SMS Gate is not configured.' });
      const response = await gateway('/inbox/export', { method: 'POST', headers: headers(), body: JSON.stringify({ ...(process.env.SMSGATE_DEVICE_ID ? { deviceId: process.env.SMSGATE_DEVICE_ID } : {}) }) });
      if (!response.ok) return res.status(502).json({ error: 'Could not request inbox sync.' });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown SMS action.' });
  } catch (error) {
    console.error('[SMS]', error.message);
    return res.status(error.status || 500).json({ error: error.message || 'SMS portal request failed.' });
  }
};
