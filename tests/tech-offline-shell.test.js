const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('offline electrician app caches required photo helpers and never serves HTML for a missing script', async () => {
  const handlers = {}, cached = new Map(), stored = [];
  const source = fs.readFileSync(path.join(__dirname, '../assets/pwa/tech-sw.js'), 'utf8');
  const self = { addEventListener(name, handler) { handlers[name] = handler; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
  const error = { error: true };
  vm.runInNewContext(source, {
    self, URL, location: { origin: 'https://portal.example' },
    fetch: async () => { throw new Error('Offline'); }, Response: { error: () => error },
    caches: {
      open: async () => ({ addAll: async files => stored.push(...files) }),
      match: async request => cached.get(typeof request === 'string' ? request : new URL(request.url).pathname),
    },
  });
  let installed;
  handlers.install({ waitUntil(promise) { installed = promise; } });
  await installed;
  assert(stored.includes('/assets/controller-photos.js'));
  assert(stored.includes('/assets/js/tech-card-payment.js'));
  for (const file of stored.filter(file => file.endsWith('.js'))) assert(fs.existsSync(path.join(__dirname, '..', file)));
  const script = { javascript: true };
  cached.set('/assets/controller-photos.js', script); cached.set('/tech', { html: true });
  let result;
  handlers.fetch({ request: { method: 'GET', mode: 'cors', url: 'https://portal.example/assets/controller-photos.js' }, respondWith(promise) { result = promise; } });
  assert.equal(await result, script);
  handlers.fetch({ request: { method: 'GET', mode: 'cors', url: 'https://portal.example/assets/js/tech-card-payment.js' }, respondWith(promise) { result = promise; } });
  assert.equal(await result, error, 'An uncached script must not become a cached HTML page');
});
