const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../assets/job-photos.js'), 'utf8');

test('gallery script parses and never opens a new browser tab for an image', () => {
  new vm.Script(src);
  assert.doesNotMatch(src, /(?:window|root)\.open\s*\(/);
  assert.match(src, /psp-lightbox/);
  assert.match(src, /aria-modal/);
});

test('viewer has arrow, Escape, touch-swipe, wheel and thumbnail-strip navigation', () => {
  assert.match(src, /ArrowLeft/);
  assert.match(src, /ArrowRight/);
  assert.match(src, /Escape/);
  assert.match(src, /pointerup/);
  assert.match(src, /addEventListener\('wheel'/);
  assert.match(src, /psp-lb-strip/);
});

test('gallery maps photos to the correct job and photo index', async () => {
  const document = {
    getElementById: () => null,
    createElement: () => ({ textContent: '', id: '' }),
    head: { appendChild: () => {} },
  };
  const window = { document, open: () => { throw new Error('Must not open a tab'); } };
  vm.runInNewContext(src, { window, Promise, Map, Date });
  const el = { innerHTML: '', onclick: null };
  await window.PSPhotos.mount(el, async () => ({
    configured: true, jobs: [
      { job_no: 1019, customer_name: 'Rajendra Kumar', folder_url: 'https://www.dropbox.com/home/',
        photos: [
          { path: '/jobs/a.jpg', category: 'Alarms', name: 'A', thumb: 'data:image/jpeg;base64,a' },
          { path: '/jobs/b.jpg', category: 'Alarms', name: 'B', label: 'Smoke Alarm 2', thumb: 'data:image/jpeg;base64,b' }
        ] },
    ],
  }), async () => 'https://dropbox.example/photo');
  assert.match(el.innerHTML, /data-job-index="0" data-photo-index="0"/);
  assert.match(el.innerHTML, /data-job-index="0" data-photo-index="1"/);
  assert.match(el.innerHTML, /Smoke Alarm 2/);
  assert.match(el.innerHTML, /Open in Dropbox/);
});
