const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const payload = {
  lead_id: '2327002961177371', name: 'Test Customer', phone: '0412345678',
  email: 'test@example.com', postcode: '4000', form_id: '123456789',
  campaign_name: 'Brisbane Black Friday', campaign_id: '456789',
  adset_name: 'Brisbane', adset_id: '10022', ad_name: 'Smoke alarms', ad_id: '10033',
};

function fixture(prior = null) {
  const rows = new Map(), calls = [];
  if (prior) rows.set(prior.leadgen_id, { ...prior });
  const sb = {
    configured: () => true,
    async sb(path, options = {}) {
      calls.push({ path, options });
      if (path.includes('on_conflict=leadgen_id')) {
        const id = options.body.leadgen_id;
        if (rows.has(id)) return [];
        const row = { leadgen_id: id, processed_at: null, received_at: new Date().toISOString() };
        rows.set(id, row);
        return [row];
      }
      if (path.startsWith('meta_lead_deliveries?leadgen_id=eq.')) {
        const id = decodeURIComponent(path.split('leadgen_id=eq.')[1].split('&')[0]);
        const row = rows.get(id);
        if (options.method === 'PATCH') { Object.assign(row, options.body); return null; }
        if (options.method === 'DELETE') {
          if (!row) return options.prefer === 'return=representation' ? [] : null;
          rows.delete(id);
          return options.prefer === 'return=representation' ? [row] : null;
        }
        return row ? [row] : [];
      }
      if (path === 'lead_comments') return null;
      throw new Error('Unexpected query: ' + path);
    },
  };
  const orig = Module._load;
  Module._load = function(request, ...args) {
    if (request === './_supabase') return sb;
    return orig(request, ...args);
  };
  delete require.cache[require.resolve('../api/_make-lead')];
  const handler = require('../api/_make-lead');
  Module._load = orig;
  process.env.MAKE_LEADS_API_KEY = '0123456789abcdef0123456789abcdef01234567';
  async function send(body, opts = {}) {
    const key = opts.key === undefined ? process.env.MAKE_LEADS_API_KEY : opts.key;
    const intake = opts.intake || (async (req, r) => r.status(200).json({ ok:true, lead_id:'CRM-1' }));
    const res = { status(n) { this.code = n; return this; },
      json(x) { this.body = x; return this; }, setHeader() {} };
    await handler({ method:'POST', headers:{'x-api-key':key}, body }, res,
      async () => Buffer.from('{}'), intake);
    return res;
  }
  return { send, rows, calls };
}

test('imports a fresh Make lead through existing intake, saves attribution and marks processed', async () => {
  const f = fixture(); let seen;
  const r = await f.send(payload, { intake: async (req, res, source) => {
    seen = { req, source };
    res.status(200).json({ ok:true, lead_id:'CRM-1' });
  } });
  assert.equal(r.code, 200);
  assert.equal(r.body.duplicate, false);
  assert.equal(seen.source, 'Instant Form');
  assert.equal(seen.req.body.name, payload.name);
  assert.ok(f.rows.get(payload.lead_id).processed_at);
  const note = f.calls.find(c => c.path === 'lead_comments');
  assert.match(note.options.body.body, /Brisbane Black Friday/);
  assert.equal(note.options.body.kind, 'system');
});

test('a Meta lead already processed by native webhook is skipped', async () => {
  const f = fixture({ leadgen_id: payload.lead_id, processed_at: new Date().toISOString() });
  const r = await f.send(payload, { intake: () => { throw Error('must not import'); } });
  assert.equal(r.code, 200);
  assert.equal(r.body.duplicate, true);
});

test('incorrect or absent credentials fail before the DB write', async () => {
  const f = fixture();
  assert.equal((await f.send(payload, { key: 'incorrect' })).code, 401);
  const previous = process.env.MAKE_LEADS_API_KEY;
  delete process.env.MAKE_LEADS_API_KEY;
  try { assert.equal((await f.send(payload)).code, 503); }
  finally { process.env.MAKE_LEADS_API_KEY = previous; }
  assert.equal(f.rows.size, 0);
});

test('invalid lead ID fails without claiming', async () => {
  const f = fixture();
  assert.equal((await f.send({ ...payload, lead_id:'invalid' })).code, 400);
  assert.equal(f.rows.size, 0);
});

test('unprocessed concurrent lead returns a retryable failure', async () => {
  const f = fixture({ leadgen_id: payload.lead_id, processed_at: null,
    received_at: new Date().toISOString() });
  assert.equal((await f.send(payload)).code, 503);
});

test('failed intake clears delivery claim to allow retry', async () => {
  const f = fixture();
  const r = await f.send(payload, { intake: async (req, res) => res.status(502).json({ ok:false }) });
  assert.equal(r.code, 503);
  assert.equal(f.rows.has(payload.lead_id), false);
});
