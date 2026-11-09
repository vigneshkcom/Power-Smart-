const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

// Real api/_sms-outbound.js (quote and welcome texts) with a fake gateway whose message state we control.
function fixture({ states = ['Sent'], env = {} } = {}) {
  const module = { exports: {} }, rows = [], posts = [], notes = [];
  const SB = { async sb(q, o = {}) {
    if (q.includes('status=in.(optout,optin)')) return [];
    if (q.startsWith('lead_comments')) { if (o.method === 'POST') { notes.push(o.body); return []; } return []; }
    const id = (/id=eq\.([^&]+)/.exec(q) || [])[1];
    if (o.method === 'POST') { rows.push({ ...o.body }); return [o.body]; }
    if (o.method === 'PATCH') { const r = rows.find((x) => x.id === id); if (r) Object.assign(r, o.body); return r ? [r] : []; }
    return rows.filter((r) => r.id === id);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/_sms-outbound.js'), 'utf8'), {
    module, require: (k) => (k === './_supabase' ? SB : require(k.startsWith('.') ? path.join(__dirname, '../api', k) : k)), console: { error() {} }, Buffer, AbortController, setTimeout, clearTimeout,
    process: { env: { SMS_ENABLED: 'true', SMSGATE_USERNAME: 'u', SMSGATE_PASSWORD: 'p', SMS_STATE_WAIT_MS: '0', ...env } },
    fetch: async (url, opts = {}) => {
      if (opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ id: JSON.parse(opts.body).id, state: 'Pending' }), { status: 202 }); }
      const s = states.length > 1 ? states.shift() : states[0];
      return new Response(JSON.stringify({ state: s, recipients: [{ state: s, error: s === 'Failed' ? 'No service' : null }] }), { status: 200 });
    },
  });
  return { send: () => module.exports.sendLeadSms({ lead: { id: 'lead1', phone: '0451 898 761' }, message: 'Hi Test, your quote 7001 is ready.', key: 'quote-abc', author: 'Sunny' }), rows, posts, notes };
}

test('a quote text the phone has sent is reported as submitted with no warning', async () => {
  const f = fixture({ states: ['Pending', 'Sent'] });
  const r = await f.send();
  assert.equal(r.status, 'submitted'); assert.equal(r.warning, undefined);
  assert.equal(f.rows[0].status, 'sent');
});

test('a quote text still waiting on the gateway phone is flagged, not silently called sent', async () => {
  const f = fixture({ states: ['Pending'] });
  const r = await f.send();
  assert.equal(r.status, 'submitted'); assert.equal(r.delivery, 'queued'); assert.match(r.warning, /has not sent it yet/);
  assert.equal(f.rows[0].status, 'queued');
  assert.match(f.notes[0].body, /not sent by the phone yet/);
});

test('a failed quote text throws with the reason so the staff see it', async () => {
  const f = fixture({ states: ['Failed'] });
  await assert.rejects(() => f.send(), /could not send this text: No service/);
  assert.equal(f.rows[0].status, 'failed');
});

test('no SIM slot is ever sent: the phone uses its only SIM', async () => {
  const f = fixture(); await f.send();
  assert.equal(f.posts[0].simNumber, undefined);
});
