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
