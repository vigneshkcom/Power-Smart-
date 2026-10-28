// Preserve useful gateway errors even when the service returns HTML or no body.
async function readGatewayResponse(response) {
  if (typeof response.text !== 'function') return response.json().catch(() => ({}));
  const text = await response.text();
  try { return JSON.parse(text); } catch (_) { return {}; }
}
function gatewayError(status, result = {}) {
  result = result && typeof result === 'object' ? result : {};
  const uncertain = status >= 500 || status === 408 || status === 409;
  let detail = typeof result.message === 'string' ? result.message : typeof result.error === 'string' ? result.error : '';
  for (const secret of [process.env.SMSGATE_USERNAME, process.env.SMSGATE_PASSWORD]) {
    if (secret) detail = detail.split(secret).join('[redacted]');
  }
  detail = detail.replace(/<[^>]*>/g, '').replace(/[\r\n\t]+/g, ' ').slice(0, 300).trim();
  const explanation = status === 401 || status === 403 ? 'SMS Gate could not authenticate the portal. Check the SMS Gate credentials in Vercel.'
    : status === 429 ? 'SMS Gate is limiting requests. Please wait before trying again.'
    : uncertain ? 'SMS Gate is temporarily unavailable. Submission could not be confirmed. Check the SMS inbox and gateway before trying again.'
    : 'SMS Gate rejected the message.';
  return { error: explanation, detail: `HTTP ${status}${detail ? ': ' + detail : ''}`, code: uncertain ? 'sms_submission_unknown' : 'sms_rejected', uncertain };
}
module.exports = { readGatewayResponse, gatewayError };
