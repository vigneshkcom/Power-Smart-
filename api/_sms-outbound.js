const crypto = require('crypto');
const SB = require('./_supabase');
const { readGatewayResponse, gatewayError } = require('./_sms-gateway-error');
function cleanPhone(value) {
  let phone = String(value || '').replace(/[^\d+]/g, '').trim();
  if (/^04\d{8}$/.test(phone)) phone = '+61' + phone.slice(1);
  else if (/^614\d{8}$/.test(phone)) phone = '+' + phone;
  return phone;
}
async function logNote(leadId, author, body) {
  if (!leadId) return;
  const rows = await SB.sb(`lead_comments?lead_id=eq.${encodeURIComponent(leadId)}&kind=eq.sms&body=eq.${encodeURIComponent(body)}&select=id&limit=1`);
  if (!rows?.length) await SB.sb('lead_comments', { method: 'POST', body: { lead_id: leadId, author: author || 'Team', kind: 'sms', body }, prefer: 'return=minimal' });
}
async function sendLeadSms({ lead, message, key, author }) {
  const phone = cleanPhone(lead?.phone), text = String(message || '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phone) || (phone.startsWith('+61') && !/^\+614\d{8}$/.test(phone))) throw new Error('Add a valid customer mobile number before sending SMS.');
  if (!text || text.length > 1600) throw new Error('SMS must contain between 1 and 1600 characters.');
  if (!process.env.SMSGATE_USERNAME || !process.env.SMSGATE_PASSWORD) throw new Error('PowerSmart SMS service is not configured.');
  const consent = await SB.sb(`sms_messages?phone_number=eq.${encodeURIComponent(phone)}&status=in.(optout,optin)&order=created_at.desc&limit=1&select=status`);
  if (consent?.[0]?.status === 'optout') throw new Error('This customer has opted out of SMS.');
  const hex = crypto.createHash('sha256').update(`${key}:${phone}`).digest('hex').slice(0,32);
  const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  const existing = (await SB.sb(`sms_messages?id=eq.${id}&select=*&limit=1`))?.[0];
  const noteBody = `SMS submitted to ${phone}: ${text}`;
  if (existing && existing.message !== text) throw new Error('This SMS request already exists with different contents. Review the SMS inbox.');
  if (existing?.status === 'sent') {
    try {await logNote(lead.id, author, noteBody);} catch(e) {return {status:'submitted',duplicate:true,phone,warning:'SMS was submitted, but its customer note could not be saved. Check the SMS inbox.'};}
    return { status: 'submitted', duplicate: true, phone };
  }
  if (existing && existing.status !== 'failed') throw new Error('This SMS is already pending or its delivery is uncertain. Check the SMS inbox before sending again.');
  if (existing) {
    const claimed = await SB.sb(`sms_messages?id=eq.${id}&status=eq.failed`, { method: 'PATCH', body: {status:'pending'} });
    if (!claimed?.length) throw new Error('This SMS is already being sent.');
  } else {
    try { await SB.sb('sms_messages', { method: 'POST', body: { id, phone_number:phone, message:text, direction:'outbound', status:'pending', sms_gate_id:id } }); }
    catch(e) { if(e.status === 409)throw new Error('This SMS is already being sent.');throw e; }
  }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 9000);
  let response;
  try {
    response = await fetch('https://api.sms-gate.app/3rdparty/v1/messages', {
      method:'POST', signal:controller.signal,
      headers:{Authorization:'Basic '+Buffer.from(`${process.env.SMSGATE_USERNAME}:${process.env.SMSGATE_PASSWORD}`).toString('base64'),'Content-Type':'application/json'},
      body:JSON.stringify({id, phoneNumbers:[phone],textMessage:{text},ttl:3600,...(process.env.SMSGATE_DEVICE_ID ? {deviceId:process.env.SMSGATE_DEVICE_ID} : {})}),
    });
  } catch(e) {
    await SB.sb(`sms_messages?id=eq.${id}`, {method:'PATCH',body:{status:'unknown'},prefer:'return=minimal'});
    throw new Error('SMS submission could not be confirmed. Check the SMS inbox before trying again.');
  } finally { clearTimeout(timer); }
  const result = await readGatewayResponse(response);
  if (!response.ok) {
    // An upstream server failure can happen after acceptance. Do not retry it blindly.
    const info = gatewayError(response.status, result);
    const status = info.uncertain ? 'unknown' : 'failed';
    await SB.sb(`sms_messages?id=eq.${id}`, {method:'PATCH',body:{status},prefer:'return=minimal'});
    throw new Error(info.error + ' ' + info.detail);
  }
  await SB.sb(`sms_messages?id=eq.${id}`, {method:'PATCH',body:{status:'sent',sms_gate_id:String(result.id || result.messageId || id)},prefer:'return=minimal'});
  try {await logNote(lead.id, author, noteBody);} catch(e) {return {status:'submitted',phone,warning:'SMS was submitted, but its customer note could not be saved. Check the SMS inbox.'};}
  return {status:'submitted',phone};
}
module.exports = {cleanPhone,sendLeadSms,logNote};
