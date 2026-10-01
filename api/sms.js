// Two-way SMS portal API. Credentials stay server-side in Vercel environment variables.
const { sb, configured } = require('./_supabase');
const { smsConfigured, cleanPhone, gwHeaders: headers, gateway, insertMessage, sendSms, conversationFor } = require('./_sms');

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
        return res.status(200).json({ messages: await conversationFor(phone) });
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
      const saved = await sendSms(body.phone, body.message);
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
    return res.status(error.status || 500).json({ error: error.message || 'SMS portal request failed.', ...(error.detail ? { detail: error.detail } : {}) });
  }
};
