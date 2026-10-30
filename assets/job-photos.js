/* Job photo gallery for the staff portal. Photos live in Dropbox; the API returns thumbnails
   and short-lived links, so nothing is public.
   PSPhotos.mount(el, load, link): load() -> Promise<{configured, jobs:[{job_no, customer_name, folder_url, photos}]}>,
   link(path) -> Promise<url>. */
(function (root) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var css = '.psp-job{margin:0 0 14px}.psp-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:.78rem;font-weight:800;color:#2f6f7b;margin-bottom:6px}' +
    '.psp-head a{font-weight:700;color:#398ea0;text-decoration:none}.psp-cat{font-size:.66rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6B8288;margin:8px 0 4px}' +
    '.psp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px}.psp-grid button{border:1px solid #d7e4e6;border-radius:8px;padding:0;background:#f4f9fa;cursor:pointer;overflow:hidden;aspect-ratio:1}' +
    '.psp-grid img{width:100%;height:100%;object-fit:cover;display:block}.psp-note{font-size:.8rem;color:#6B8288}';
  function mount(el, load, link) {
    if (!doc().getElementById('psp-css')) { var st = doc().createElement('style'); st.id = 'psp-css'; st.textContent = css; doc().head.appendChild(st); }
    el.innerHTML = '<p class="psp-note">Loading photos…</p>';
    return load().then(function (d) {
      if (!d || d.configured === false) { el.innerHTML = '<p class="psp-note">Photo storage is not set up yet.</p>'; return; }
      var jobs = (d.jobs || []).filter(function (j) { return j.photos && j.photos.length; });
      if (!jobs.length) { el.innerHTML = '<p class="psp-note">No photos uploaded yet.</p>'; return; }
      el.innerHTML = jobs.map(function (j) {
        var cats = {}; j.photos.forEach(function (p) { (cats[p.category] = cats[p.category] || []).push(p); });
        return '<div class="psp-job"><div class="psp-head"><span>J' + esc(j.job_no) + ' · ' + esc(j.customer_name) + ' (' + j.photos.length + ')</span>' +
          (j.folder_url ? '<a href="' + esc(j.folder_url) + '" target="_blank" rel="noopener">Open in Dropbox</a>' : '') + '</div>' +
          Object.keys(cats).map(function (c) {
            return '<div class="psp-cat">' + esc(c) + '</div><div class="psp-grid">' + cats[c].map(function (p) {
              return '<button type="button" data-path="' + esc(p.path) + '" title="' + esc(p.name) + '">' + (p.thumb ? '<img src="' + esc(p.thumb) + '" alt="' + esc(c) + ' photo">' : esc(p.name)) + '</button>';
            }).join('') + '</div>';
          }).join('') + '</div>';
      }).join('');
    }).catch(function (e) { el.innerHTML = '<p class="psp-note">Could not load photos: ' + esc(e.message) + '</p>'; })
      .then(function () {
        el.onclick = function (e) {
          var b = e.target.closest('button[data-path]'); if (!b) return;
          var w = root.open('about:blank', '_blank'); if (w) w.opener = null;
          link(b.dataset.path).then(function (url) { if (w) w.location.replace(url); }).catch(function () { if (w) w.close(); });
        };
      });
  }
  function doc() { return root.document; }
  root.PSPhotos = { mount: mount };
})(window);
