const test = require('node:test'), assert = require('node:assert/strict');
const D = require('../api/_dropbox');
test('folder names are safe, short and start with the job number', () => {
  const name = D.folderName({ job_no: 1013, customer_name: 'Peter / Wallmer: "Jr"', address: '52 / 2 Diamantina St?' });
  assert.match(name, /^J1013 - Peter Wallmer Jr - 52 2 Diamantina St$/);
  assert.ok(D.folderName({ job_no: 1, customer_name: 'x'.repeat(300), address: '' }).length <= 150);
});
test('photo paths must stay inside the job folder', () => {
  const base = '/PowerSmart Jobs/J1013 - Peter';
  assert.equal(D.assertInside(base, base + '/Before/a.jpg'), base + '/Before/a.jpg');
  assert.throws(() => D.assertInside(base, '/PowerSmart Jobs/J1014 - Other/Before/a.jpg'));
  assert.throws(() => D.assertInside(base, base + '/../J1014/a.jpg'));
  assert.throws(() => D.assertInside(null, base + '/a.jpg'));
});
test('storage reports not configured without the Dropbox keys', () => {
  const keep = { ...process.env };
  delete process.env.DROPBOX_APP_KEY;
  assert.equal(D.configured(), false);
  Object.assign(process.env, keep);
});

test('Dropbox browser links include the app folder and open the alarm photos', () => {
  const folder = '/PowerSmart Jobs/J1019 - Rajendra Kumar - 49 Harrison Crescent';
  assert.equal(D.dropboxWebFolderUrl(folder, 'Alarms'),
    'https://www.dropbox.com/home/Apps/PowerSmart%20Job%20Photos%20QLD/PowerSmart%20Jobs/J1019%20-%20Rajendra%20Kumar%20-%2049%20Harrison%20Crescent/Alarms');
  assert.equal(D.dropboxWebFolderUrl(folder),
    'https://www.dropbox.com/home/Apps/PowerSmart%20Job%20Photos%20QLD/PowerSmart%20Jobs/J1019%20-%20Rajendra%20Kumar%20-%2049%20Harrison%20Crescent');
});

test('PDF documents upload into a Documents folder using idempotent overwrite', async () => {
  const originalFetch = global.fetch;
  const original = { key: process.env.DROPBOX_APP_KEY, secret: process.env.DROPBOX_APP_SECRET, refresh: process.env.DROPBOX_REFRESH_TOKEN };
  process.env.DROPBOX_APP_KEY = 'dummy-key';
  process.env.DROPBOX_APP_SECRET = 'dummy-secret';
  process.env.DROPBOX_REFRESH_TOKEN = 'dummy-refresh';
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'dummy-access', expires_in: 3600 }) };
    if (url.endsWith('/files/list_folder')) return { ok: true, text: async () => JSON.stringify({ entries: [
      { '.tag': 'folder', name: 'J1019 - Rajendra Kumar - 49 Harrison Crescent', path_display: '/PowerSmart Jobs/J1019 - Rajendra Kumar - 49 Harrison Crescent' },
    ], has_more: false }) };
    if (url.endsWith('/files/get_metadata')) return { ok: false, status: 409, text: async () => JSON.stringify({ error_summary: 'path/not_found/...' }) };
    if (url.endsWith('/files/create_folder_v2')) return { ok: true, text: async () => JSON.stringify({ metadata: { path_display: '/PowerSmart Jobs/J1019 - Rajendra Kumar - 49 Harrison Crescent/Documents' } }) };
    if (url.endsWith('/files/upload')) return { ok: true, text: async () => '{}' };
    throw new Error('Unexpected URL: ' + url);
  };
  try {
    const content = Buffer.from('%PDF-1.7 test');
    const result = await D.uploadDocuments({ job_no: 1019, customer_name: 'Rajendra Kumar', address: '49 Harrison Crescent' }, [
      { filename: 'Tax-Invoice-J1019.pdf', content },
    ]);
    assert.deepEqual(result.saved, ['Tax-Invoice-J1019.pdf']);
    assert.deepEqual(result.failed, []);
    const upload = requests.find((r) => r.url.endsWith('/files/upload'));
    assert(upload);
    const args = JSON.parse(upload.options.headers['Dropbox-API-Arg']);
    assert.equal(args.path, '/PowerSmart Jobs/J1019 - Rajendra Kumar - 49 Harrison Crescent/Documents/Tax-Invoice-J1019.pdf');
    assert.equal(args.mode, 'overwrite');
    assert.equal(upload.options.body, content);
  } finally {
    global.fetch = originalFetch;
    for (const [key, env] of [['DROPBOX_APP_KEY', 'key'], ['DROPBOX_APP_SECRET', 'secret'], ['DROPBOX_REFRESH_TOKEN', 'refresh']]) {
      if (original[env] === undefined) delete process.env[key];
      else process.env[key] = original[env];
    }
  }
});
