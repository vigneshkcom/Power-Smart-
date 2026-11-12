/* Job photo gallery for the staff portal. Dropbox API supplies private thumbnails and
   short-lived full-resolution links. Preview them in the portal, never in a new tab.
   PSPhotos.mount(el, load, link): load() -> Promise<{configured,jobs:[{job_no,customer_name,folder_url,photos}]}>;
   link(path) -> Promise<url>. */
(function (root) {
  'use strict';

  function doc() { return root.document; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var css = [
    '.psp-job{margin:0 0 14px}.psp-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:.78rem;font-weight:800;color:#2f6f7b;margin-bottom:6px}',
    '.psp-head a{font-weight:700;color:#398ea0;text-decoration:none}.psp-cat{font-size:.66rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6B8288;margin:8px 0 4px}',
    '.psp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px}.psp-grid button{border:1px solid #d7e4e6;border-radius:8px;padding:0;background:#f4f9fa;cursor:zoom-in;overflow:hidden;aspect-ratio:1}',
    '.psp-item{display:flex;flex-direction:column;gap:3px;min-width:0}.psp-item button{width:100%}.psp-cap{font-size:.68rem;line-height:1.25;font-weight:700;color:#41585D}',
    '.psp-grid img{width:100%;height:100%;object-fit:cover;display:block}.psp-note{font-size:.8rem;color:#6B8288}',
    '.psp-lightbox[hidden]{display:none!important}.psp-lightbox{box-sizing:border-box;position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;padding:14px;background:rgba(5,16,20,.89);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '.psp-view{box-sizing:border-box;width:min(1180px,100%);height:min(860px,96dvh);max-height:96vh;display:flex;flex-direction:column;overflow:hidden;background:#10252B;border:1px solid #36535B;border-radius:16px;color:#fff;box-shadow:0 25px 90px rgba(0,0,0,.45)}',
    '.psp-lb-top{flex:none;display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #29434A}',
    '.psp-lb-title{flex:1;min-width:0;font-size:14px;font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.psp-lb-count{font-size:13px;color:#CADDE0;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.psp-view button{font:inherit;cursor:pointer}.psp-lb-close{width:38px;height:38px;flex:none;border:1px solid #41606A;border-radius:50%;background:#234048;color:#fff;font-size:25px;line-height:1}',
    '.psp-lb-stage{flex:1;min-height:0;display:grid;grid-template-columns:58px minmax(0,1fr) 58px;align-items:stretch;padding:8px}',
    '.psp-lb-arrow{border:0;background:transparent;color:#fff;font-size:36px;line-height:1;border-radius:8px;transition:background .15s}',
    '.psp-lb-arrow:hover,.psp-lb-arrow:focus-visible,.psp-lb-close:hover{background:#345A64}',
    '.psp-lb-media{min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:pan-y}',
    '.psp-lb-media img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;border-radius:5px}',
    '.psp-lb-media img[hidden],.psp-lb-message[hidden]{display:none!important}',
    '.psp-lb-message{color:#D1E2E5;font-size:14px;text-align:center;padding:16px}',
    '.psp-lb-caption{flex:none;min-height:22px;padding:4px 16px 10px;text-align:center;color:#E1EFF1;font-size:13px;font-weight:600}',
    '.psp-lb-strip{flex:none;display:flex;gap:7px;padding:8px 14px 14px;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:thin;border-top:1px solid #29434A}',
    '.psp-lb-thumb{box-sizing:border-box;position:relative;flex:0 0 66px;width:66px;height:64px;padding:2px;background:#203A41;border:2px solid transparent;border-radius:8px;overflow:hidden;color:#fff}',
    '.psp-lb-thumb[aria-current="true"]{border-color:#67DAE9}.psp-lb-thumb img{width:100%;height:100%;object-fit:cover;display:block;border-radius:4px}',
    '.psp-view button:focus-visible{outline:2px solid #8CE8F3;outline-offset:2px}',
    '@media(max-width:650px){.psp-lightbox{padding:0}.psp-view{height:100dvh;max-height:100vh;width:100%;border-radius:0;border:0}.psp-lb-stage{grid-template-columns:42px minmax(0,1fr) 42px;padding:4px}.psp-lb-arrow{font-size:29px}.psp-lb-top{padding:8px 12px}.psp-lb-thumb{flex-basis:56px;width:56px;height:54px}.psp-lb-strip{padding:6px 10px 10px}}'
  ].join('');

  var viewer = null;
  var active = null;

  function ensureViewer() {
    if (viewer) return viewer;
    var overlay = doc().createElement('div');
    overlay.className = 'psp-lightbox';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Job photo viewer');
    overlay.innerHTML = '<div class="psp-view">' +
      '<div class="psp-lb-top"><div class="psp-lb-title"></div><span class="psp-lb-count" aria-live="polite"></span><button type="button" class="psp-lb-close" aria-label="Close photo viewer" title="Close (Esc)">×</button></div>' +
      '<div class="psp-lb-stage"><button type="button" class="psp-lb-arrow psp-lb-prev" aria-label="Previous photo" title="Previous (←)">‹</button>' +
      '<div class="psp-lb-media"><img hidden alt=""><div class="psp-lb-message" role="status" aria-live="polite"></div></div>' +
      '<button type="button" class="psp-lb-arrow psp-lb-next" aria-label="Next photo" title="Next (→)">›</button></div>' +
      '<div class="psp-lb-caption"></div><div class="psp-lb-strip" aria-label="Choose a photo"></div></div>';
    doc().body.appendChild(overlay);
    viewer = {
      overlay: overlay,
      title: overlay.querySelector('.psp-lb-title'),
      count: overlay.querySelector('.psp-lb-count'),
      close: overlay.querySelector('.psp-lb-close'),
      prev: overlay.querySelector('.psp-lb-prev'),
      next: overlay.querySelector('.psp-lb-next'),
      media: overlay.querySelector('.psp-lb-media'),
      image: overlay.querySelector('.psp-lb-media img'),
      message: overlay.querySelector('.psp-lb-message'),
      caption: overlay.querySelector('.psp-lb-caption'),
      strip: overlay.querySelector('.psp-lb-strip')
    };
    viewer.close.addEventListener('click', closeViewer);
    viewer.prev.addEventListener('click', function () { move(-1); });
    viewer.next.addEventListener('click', function () { move(1); });
    overlay.addEventListener('click', function (event) { if (event.target === overlay) closeViewer(); });
    viewer.strip.addEventListener('click', function (event) {
      var target = event.target.closest('button[data-index]');
      if (active && target && viewer.strip.contains(target)) showPhoto(Number(target.dataset.index));
    });
    // Trackpad / mouse wheel moves between images, with a short guard against skipping.
    viewer.media.addEventListener('wheel', function (event) {
      if (!active || event.ctrlKey || Math.max(Math.abs(event.deltaX), Math.abs(event.deltaY)) < 18) return;
      event.preventDefault();
      var now = Date.now();
      if (now - active.lastWheel > 450) {
        active.lastWheel = now;
        move((Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) > 0 ? 1 : -1);
      }
    }, { passive: false });
    var start = null;
    viewer.media.addEventListener('pointerdown', function (event) {
      start = event.pointerType !== 'mouse' ? { x: event.clientX, y: event.clientY } : null;
    });
    viewer.media.addEventListener('pointerup', function (event) {
      if (!active || !start) return;
      var dx = event.clientX - start.x, dy = event.clientY - start.y;
      start = null;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) move(dx < 0 ? 1 : -1);
    });
    viewer.media.addEventListener('pointercancel', function () { start = null; });
    return viewer;
  }

  function keyHandler(event) {
    if (!active) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeViewer(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); move(1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); move(-1); }
    else if (event.key === 'Tab') {
      var controls = Array.prototype.slice.call(viewer.overlay.querySelectorAll('button:not([disabled])'));
      if (!controls.length) return;
      var first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && doc().activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && doc().activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }

  function closeViewer() {
    if (!active) return;
    var old = active;
    active = null; // Invalidate any delayed Dropbox link or image response.
    doc().removeEventListener('keydown', keyHandler, true);
    viewer.image.onload = viewer.image.onerror = null;
    viewer.image.removeAttribute('src');
    viewer.image.hidden = true;
    viewer.overlay.hidden = true;
    doc().body.style.overflow = old.overflow;
    if (old.trigger && old.trigger.isConnected) old.trigger.focus();
  }

  function move(direction) {
    if (!active) return;
    showPhoto((active.index + direction + active.job.photos.length) % active.job.photos.length);
  }

  function showPhoto(index) {
    if (!active || !Number.isInteger(index) || !active.job.photos[index]) return;
    var session = active, p = session.job.photos[index];
    session.index = index;
    var request = ++session.request;
    var label = p.label || p.name || 'Job photo';
    viewer.count.textContent = (index + 1) + ' / ' + session.job.photos.length;
    viewer.caption.textContent = label;
    viewer.image.hidden = true;
    viewer.image.removeAttribute('src');
    viewer.image.alt = label;
    viewer.message.hidden = false;
    viewer.message.textContent = 'Loading photo…';
    var buttons = viewer.strip.querySelectorAll('button[data-index]');
    for (var n = 0; n < buttons.length; n++) {
      var selected = n === index;
      buttons[n].setAttribute('aria-current', selected ? 'true' : 'false');
      if (selected && buttons[n].scrollIntoView) buttons[n].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    var cached = session.links.get(p.path);
    if (!cached) {
      cached = Promise.resolve().then(function () { return session.link(p.path); });
      session.links.set(p.path, cached);
    }
    cached.then(function (url) {
      if (active !== session || request !== session.request) return;
      if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw new Error('Invalid photo link');
      viewer.image.onload = function () {
        if (active !== session || request !== session.request) return;
        viewer.message.hidden = true;
        viewer.image.hidden = false;
      };
      viewer.image.onerror = function () {
        if (active !== session || request !== session.request) return;
        session.links.delete(p.path);
        viewer.message.textContent = 'Could not load this photo. Select it again to retry.';
      };
      viewer.image.src = url;
    }).catch(function () {
      if (active !== session || request !== session.request) return;
      session.links.delete(p.path);
      viewer.message.textContent = 'Could not load this photo. Select it again to retry.';
    });
  }

  function openViewer(job, index, link, trigger) {
    if (!job || !job.photos || !job.photos.length) return;
    if (active) closeViewer();
    var v = ensureViewer();
    active = {
      job: job, index: 0, request: 0, link: link, trigger: trigger,
      links: new Map(), lastWheel: 0, overflow: doc().body.style.overflow
    };
    v.title.textContent = 'J' + job.job_no + ' · ' + (job.customer_name || 'Job photos');
    v.strip.innerHTML = '';
    job.photos.forEach(function (p, n) {
      var button = doc().createElement('button');
      button.type = 'button';
      button.className = 'psp-lb-thumb';
      button.dataset.index = String(n);
      button.setAttribute('aria-label', 'Photo ' + (n + 1) + ': ' + (p.label || p.name || p.category || 'Job photo'));
      if (p.thumb) {
        var img = doc().createElement('img');
        img.src = p.thumb;
        img.alt = '';
        button.appendChild(img);
      } else button.textContent = String(n + 1);
      v.strip.appendChild(button);
    });
    v.overlay.hidden = false;
    doc().body.style.overflow = 'hidden';
    doc().addEventListener('keydown', keyHandler, true);
    v.close.focus();
    showPhoto(index);
  }

  function mount(el, load, link) {
    if (!doc().getElementById('psp-css')) {
      var style = doc().createElement('style');
      style.id = 'psp-css';
      style.textContent = css;
      doc().head.appendChild(style);
    }
    el.innerHTML = '<p class="psp-note">Loading photos…</p>';
    var jobs = [];
    el.onclick = function (event) {
      var button = event.target.closest('button[data-photo-index]');
      if (!button || !el.contains(button)) return;
      var job = jobs[Number(button.dataset.jobIndex)];
      if (job) openViewer(job, Number(button.dataset.photoIndex), link, button);
    };
    return load().then(function (d) {
      if (!d || d.configured === false) { el.innerHTML = '<p class="psp-note">Photo storage is not set up yet.</p>'; return; }
      jobs = (d.jobs || []).filter(function (j) { return j.photos && j.photos.length; });
      if (!jobs.length) { el.innerHTML = '<p class="psp-note">No photos uploaded yet.</p>'; return; }
      el.innerHTML = jobs.map(function (j, ji) {
        var cats = {};
        j.photos.forEach(function (p, pi) { (cats[p.category] = cats[p.category] || []).push({ photo: p, index: pi }); });
        return '<div class="psp-job"><div class="psp-head"><span>J' + esc(j.job_no) + ' · ' + esc(j.customer_name) + ' (' + j.photos.length + ')</span>' +
          (j.folder_url ? '<a href="' + esc(j.folder_url) + '" target="_blank" rel="noopener">Open in Dropbox</a>' : '') + '</div>' +
          Object.keys(cats).map(function (category) {
            return '<div class="psp-cat">' + esc(category) + '</div><div class="psp-grid">' + cats[category].map(function (entry) {
              var p = entry.photo, label = p.label || p.name || 'Job photo';
              return '<div class="psp-item"><button type="button" data-job-index="' + ji + '" data-photo-index="' + entry.index + '" title="View ' + esc(label) + '">' +
                (p.thumb ? '<img src="' + esc(p.thumb) + '" alt="' + esc(label) + '">' : esc(p.name)) + '</button>' +
                (p.label ? '<span class="psp-cap">' + esc(p.label) + '</span>' : '') + '</div>';
            }).join('') + '</div>';
          }).join('') + '</div>';
      }).join('');
    }).catch(function (error) {
      el.innerHTML = '<p class="psp-note">Could not load photos: ' + esc(error.message) + '</p>';
    });
  }

  root.PSPhotos = { mount: mount };
})(window);
