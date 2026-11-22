// Electrician card payments use Revolut's card-only popup. Its iframe handles
// card details, billing address and bank verification; none enter app storage.
(function () {
  'use strict';
  var loading = null, loadedMode = null, active = false;

  function load(mode) {
    if (loading && loadedMode === mode) return loading;
    if (loading) return Promise.reject(new Error('Payment settings changed. Please reload the app.'));
    loadedMode = mode;
    loading = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var timer = setTimeout(function () { fail(); }, 20000);
      function fail() {
        clearTimeout(timer);
        script.remove(); loading = null; loadedMode = null;
        reject(new Error('The card form could not load. Check your connection and try again.'));
      }
      script.id = 'revolut-checkout';
      script.src = (mode === 'sandbox' ? 'https://sandbox-merchant.revolut.com' : 'https://merchant.revolut.com') + '/embed.js';
      script.onload = function () {
        if (typeof window.RevolutCheckout !== 'function') { fail(); return; }
        clearTimeout(timer); resolve(window.RevolutCheckout);
      };
      script.onerror = fail;
      document.head.appendChild(script);
    });
    return loading;
  }

  function open(checkout) {
    if (active) return Promise.reject(new Error('A card payment is already open.'));
    if (checkout.provider !== 'revolut' || typeof checkout.token !== 'string' || !checkout.token || !['prod', 'sandbox'].includes(checkout.mode)) {
      return Promise.reject(new Error('Could not open the card form. Please try again.'));
    }
    active = true;
    var instance;
    return load(checkout.mode).then(function (sdk) {
      return sdk(checkout.token);
    }).then(function (widget) {
      instance = widget;
      var customer = checkout.customer || {};
      return new Promise(function (resolve, reject) {
        instance.payWithPopup({
          name: customer.name || undefined, email: customer.email || undefined,
          phone: customer.phone || undefined,
          // Revolut hides its postcode input when a valid billing postcode is
          // supplied. Incomplete addresses are collected by the secure form.
          billingAddress: customer.billingAddress,
          // This is a one-off payment on a staff phone.
          savePaymentMethodFor: 'none', upsellBanner: false,
          onSuccess: function () { resolve('success'); },
          onCancel: function () { resolve('cancelled'); },
          onError: function (error) { reject(new Error(error && error.message || 'Card payment failed. Please try again.')); },
        });
      });
    }).finally(function () {
      active = false;
      if (instance) instance.destroy();
    });
  }

  window.PowerSmartCardPayment = { open: open };
})();
