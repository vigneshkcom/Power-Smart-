/* Shared Google Places (New) address picker. Manual fields remain available. */
(function (root) {
  'use strict';
  function parseAddress(place) {
    var components = place.addressComponents || [];
    function part(type, short) {
      var c = components.find(function (x) { return (x.types || []).includes(type); });
      return c ? (short ? c.shortText : c.longText) || '' : '';
    }
    var street = [part('street_number'), part('route')].filter(Boolean).join(' ');
    var unit = part('subpremise');
    return {
      street: (unit ? unit + '/' : '') + street,
      suburb: part('locality') || part('postal_town') || part('sublocality_level_1'),
      state: part('administrative_area_level_1', true),
      postcode: part('postal_code'),
      country: part('country', true),
      full: place.formattedAddress || street
    };
  }
  // Also used by the focused address-component tests.
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseAddress: parseAddress };
  if (!root.document) return;
  var doc = root.document, loading;
  function loadPlaces(key) {
    if (!loading) loading = new Promise(function (resolve, reject) {
      var script = doc.createElement('script');
      root.powerSmartPlacesReady = function () { resolve(); };
      script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&loading=async&libraries=places&v=weekly&callback=powerSmartPlacesReady&region=AU&language=en';
      script.async = true;
      script.referrerPolicy = 'origin';
      script.onerror = function () { reject(new Error('Address search unavailable')); };
      doc.head.appendChild(script);
    }).then(function () { return root.google.maps.importLibrary('places'); });
    return loading;
  }
  function attach(input, Places) {
    var wrap = doc.createElement('div');
    wrap.style.cssText = 'margin-bottom:10px;min-width:0';
    var compact = input.dataset.addressCompact !== undefined;
    var host = (input.dataset.addressAnchor && doc.getElementById(input.dataset.addressAnchor)) || input.parentNode;
    var label = doc.createElement('label');
    label.textContent = 'Find address';
    label.style.cssText = compact ? 'display:none' : 'display:block;font-size:12px;font-weight:700;margin-bottom:6px';
    var picker, list, token, options = [], active = -1, timer, query = 0;
    if (compact) {
      picker = doc.createElement('input');
      picker.type = 'text';
      picker.className = 'addr-search';
      picker.autocomplete = 'off';
      picker.setAttribute('role', 'combobox');
      picker.setAttribute('aria-expanded', 'false');
      list = doc.createElement('ul');
      list.className = 'addr-suggest';
      list.setAttribute('role', 'listbox');
      list.hidden = true;
      token = new Places.AutocompleteSessionToken();
    } else {
      picker = new Places.PlaceAutocompleteElement({
        includedRegionCodes: ['au'],
        locationBias: { center: { lat: -27.47, lng: 153.03 }, radius: 50000 }
      });
    }
    picker.id = input.id + '-search';
    picker.setAttribute('placeholder', 'Start typing an Australian address');
    picker.setAttribute('aria-label', 'Find Australian address');
    if (!compact) picker.style.cssText = 'display:block;width:100%;color-scheme:light';
    label.htmlFor = picker.id;
    var note = doc.createElement('div');
    note.style.cssText = 'font-size:12px;margin-top:5px;color:#52676c';
    note.setAttribute('aria-live', 'polite');
    var hint = compact ? 'Pick a suggestion to fill the address and postcode. Use Edit address to add a unit number.' : 'Select a suggestion, then check the address and unit number below.';
    note.textContent = hint;
    if (compact) {
      var box = doc.createElement('div');
      box.className = 'addr-search-box';
      box.append(picker, list);
      wrap.append(label, box, note);
    } else wrap.append(label, picker, note);
    host.insertBefore(wrap, host.firstChild);
    var generation = 0;
    if (root.IntersectionObserver) new root.IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) { generation++; picker.value = ''; }
    }).observe(wrap);
    function targets() {
      return [input].concat(['addressSuburb', 'addressState', 'addressPostcode', 'addressExtraPostcode'].map(function (key) {
        return doc.getElementById(input.dataset[key]);
      }).filter(Boolean));
    }
    picker.addEventListener('gmp-error', function () { note.textContent = 'Address search is unavailable. Enter the address below.'; });
    picker.addEventListener('gmp-select', function (event) { return choose(event.placePrediction); });
    async function choose(prediction) {
      var request = ++generation, fields = targets(), before = fields.map(function (f) { return f.value; });
      try {
        var place = prediction.toPlace();
        await place.fetchFields({ fields: ['addressComponents', 'formattedAddress'] });
        // Never replace edits made during the lookup or fill a closed/different customer card.
        if (request !== generation || !(compact ? picker : input).getClientRects().length || fields.some(function (f, i) { return f.value !== before[i]; })) return;
        var a = parseAddress(place);
        if (a.country !== 'AU' || !a.street || !a.suburb || !a.postcode) {
          note.textContent = 'Choose a full street address, or enter the missing details below.';
          return;
        }
        var values = [input.dataset.addressFull ? a.full : a.street, a.suburb, a.state, a.postcode, a.postcode];
        var ids = [input.id, input.dataset.addressSuburb, input.dataset.addressState, input.dataset.addressPostcode, input.dataset.addressExtraPostcode];
        ids.forEach(function (id, i) {
          var field = id && doc.getElementById(id);
          if (field) { field.value = values[i]; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); }
        });
        note.textContent = compact ? 'Address filled in.' : 'Address filled. Check the unit number and details before saving.';
      } catch (_) { note.textContent = 'Could not retrieve this address. Please enter it below.'; }
    }
    if (!compact) return;
    function close() { list.hidden = true; picker.setAttribute('aria-expanded', 'false'); active = -1; }
    function mark(i) {
      active = i;
      Array.from(list.children).forEach(function (li, n) { li.classList.toggle('on', n === i); });
    }
    function pick(i) {
      var prediction = options[i];
      if (!prediction) return;
      picker.value = prediction.text.text;
      close();
      token = new Places.AutocompleteSessionToken();
      choose(prediction);
    }
    function show(suggestions) {
      options = suggestions.map(function (x) { return x.placePrediction; }).filter(Boolean);
      list.textContent = '';
      options.forEach(function (prediction, i) {
        var li = doc.createElement('li');
        li.setAttribute('role', 'option');
        var main = doc.createElement('strong');
        main.textContent = prediction.mainText ? prediction.mainText.text : prediction.text.text;
        li.append(main);
        if (prediction.secondaryText) {
          var rest = doc.createElement('span');
          rest.textContent = prediction.secondaryText.text;
          li.append(rest);
        }
        li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(i); });
        list.append(li);
      });
      list.hidden = !options.length;
      picker.setAttribute('aria-expanded', String(options.length > 0));
      active = -1;
    }
    picker.addEventListener('input', function () {
      clearTimeout(timer);
      var text = picker.value.trim(), mine = ++query;
      if (text.length < 3) { close(); return; }
      timer = setTimeout(async function () {
        try {
          var res = await Places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: text, sessionToken: token, includedRegionCodes: ['au'],
            locationBias: { center: { lat: -27.47, lng: 153.03 }, radius: 50000 }
          });
          if (mine === query) show(res.suggestions || []);
        } catch (_) { close(); note.textContent = 'Address search is unavailable. Use Edit address to enter it.'; }
      }, 200);
    });
    picker.addEventListener('keydown', function (e) {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); mark((active + 1) % options.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); mark((active - 1 + options.length) % options.length); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
      else if (e.key === 'Escape') close();
    });
    picker.addEventListener('blur', close);
  }
  async function init() {
    var inputs = Array.from(doc.querySelectorAll('[data-address-autofill]'));
    if (!inputs.length) return;
    try {
      var response = await fetch('/api/pipeline?resource=address-config');
      if (!response.ok) return;
      var config = await response.json();
      if (!config.enabled || !config.key) return;
      var Places = await loadPlaces(config.key);
      inputs.forEach(function (input) { attach(input, Places); });
    } catch (_) { /* Keep all existing manual fields usable when Google is unavailable. */ }
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})(typeof window === 'undefined' ? {} : window);
