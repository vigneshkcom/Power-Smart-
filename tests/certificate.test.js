const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');

// Fake Supabase injected before the module loads.
const tables = { jobs: [], electricians: [], leads: [], lead_comments: [] };
const calls = [];
const fake = {
  configured: () => true,
  async sb(q, opts = {}) {
    const method = opts.method || 'GET';
    calls.push({ q, method, body: opts.body });
    const [table, query = ''] = q.split('?');
    const params = [...new URLSearchParams(query)].filter(([k]) => !['select', 'limit', 'order'].includes(k));
    const rows = tables[table] = tables[table] || [];
    if (method === 'POST') { rows.push({ id: table + rows.length, ...opts.body }); return [opts.body]; }
    const hit = rows.filter((r) => params.every(([k, v]) => v.startsWith('eq.') ? String(r[k]) === v.slice(3) : v === 'is.null' ? r[k] == null : true));
    if (method === 'PATCH') { hit.forEach((r) => Object.assign(r, opts.body)); return hit.map((r) => ({ ...r })); }
    return hit.map((r) => ({ ...r }));
  },
};
const sbPath = require.resolve('../api/_supabase');
require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: fake };
process.env.RESEND_API_KEY = 'test-key-never-used';   // every test here stops before any email is sent
const C = require('../api/_certificate');

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
function job(extra) {
  return { id: 'j1', job_no: 1008, status: 'completed', pay_status: 'paid', email: 'a@b.com', customer_name: 'Vig', address: '2 Addison Street', suburb: 'Greenbank', postcode: '4124',
    electrician_id: 't1', signoff_name: 'Jake Turner', signoff_signature: SIG, signoff_at: '2026-10-30T01:00:00Z', ...extra };
}
function reset(j, tech) { tables.jobs = [j]; tables.electricians = [{ id: 't1', name: 'Jake Turner', ...tech }]; tables.lead_comments = []; calls.length = 0; }

test('only completed jobs paid in full (or with nothing owing) qualify', () => {
  assert.equal(C.paidInFull(job()), true);
  assert.equal(C.paidInFull(job({ pay_status: 'none' })), true);
  for (const pay_status of ['later', 'unpaid', 'pending']) assert.equal(C.paidInFull(job({ pay_status })), false, pay_status);
  assert.equal(C.paidInFull(job({ status: 'on_site' })), false);
});

test('an unpaid or already-sent job is skipped without touching anything', async () => {
  reset(job({ pay_status: 'later' }), { licence_no: '1515658' });
  assert.equal((await C.issueCertificate('j1')).status, 'skipped');
  reset(job({ certificate_sent_at: '2026-10-30T02:00:00Z' }), { licence_no: '1515658' });
  assert.equal((await C.issueCertificate('j1')).status, 'skipped');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('a missing licence number blocks the certificate and tells the office', async () => {
  reset(job(), {});
  const r = await C.issueCertificate('j1');
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /licence/i);
  assert.equal(tables.jobs[0].certificate_sent_at, undefined, 'not marked as sent');
});

test('the certificate shows the job details and draws the signature in white', () => {
  const html = C.renderCertificateHtml({ job: job(), electrician: { name: 'Jake Turner', licence_no: '1515658' } });
  for (const text of ['30 / 10 / 2026', 'QLD', '4124', '2 ADDISON STREET', 'GREENBANK', 'Jake Turner', '1515658']) assert.ok(html.includes(text), text);
  assert.match(html, /<img src="data:image\/png;base64,[^"]+" alt="Electrician signature"[^>]*filter:brightness\(0\) invert\(1\)/);
  assert.equal((html.match(/class="pg"/g) || []).length, 2, 'certificate + information page');
  assert.ok(!/\{\{\w+\}\}/.test(html), 'no unfilled placeholders');
});

test('customer details are HTML-escaped on the certificate', () => {
  const html = C.renderCertificateHtml({ job: job({ address: '<b>1 x</b>', suburb: 'A&B' }), electrician: { licence_no: '1' } });
  assert.ok(!html.includes('<b>1 x</b>'));
  assert.ok(html.includes('&lt;B&gt;1 X&lt;/B&gt;') && html.includes('A&amp;B'));
});

test('state comes from the postcode', () => {
  assert.deepEqual(['4124', '2000', '2601', '3000', '5000', '6000', '7000', '0800', ''].map(C.stateFor), ['QLD', 'NSW', 'ACT', 'VIC', 'SA', 'WA', 'TAS', 'NT', 'QLD']);
});
