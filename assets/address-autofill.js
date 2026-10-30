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
    var picker = new Places.PlaceAutocompleteElement({
      includedRegionCodes: ['au'],
      locationBias: { center: { lat: -27.47, lng: 153.03 }, radius: 50000 }
    });
    picker.id = input.id + '-search';
    picker.setAttribute('placeholder', 'Start typing an Australian address');
    picker.setAttribute('aria-label', 'Find Australian address');
    picker.style.cssText = 'display:block;width:100%;color-scheme:light';
    label.htmlFor = picker.id;
    var note = doc.createElement('div');
    note.style.cssText = 'font-size:12px;margin-top:5px;color:#52676c';
    note.setAttribute('aria-live', 'polite');
    var hint = compact ? 'Pick a suggestion to fill the address and postcode. Use Edit address to add a unit number.' : 'Select a suggestion, then check the address and unit number below.';
    note.textContent = hint;
    wrap.append(label, picker, note);
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
    picker.addEventListener('gmp-select', async function (event) {
      var request = ++generation, fields = targets(), before = fields.map(function (f) { return f.value; });
      try {
        var place = event.placePrediction.toPlace();
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
    });
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
