const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture({ failLoad = false } = {}) {
  const scripts = [], tokens = [], popups = [];
  let destroyed = 0;
  const window = {};
  const document = {
    createElement() { return { remove() { this.removed = true; } }; },
    head: { appendChild(script) {
      scripts.push(script);
      queueMicrotask(() => {
        if (failLoad) { failLoad = false; script.onerror(); return; }
        window.RevolutCheckout = token => {
          tokens.push(token);
          return Promise.resolve({ payWithPopup(options) { popups.push(options); }, destroy() { destroyed++; } });
        };
        script.onload();
      });
    } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/tech-card-payment.js'), 'utf8'), { window, document, setTimeout, clearTimeout });
  const checkout = { provider: 'revolut', token: 'public-token', mode: 'prod', customer: { name: 'Test Customer', email: 'customer@example.test' } };
  return { open: window.PowerSmartCardPayment.open, checkout, scripts, tokens, popups, destroyed: () => destroyed };
}

const mounted = () => new Promise(resolve => setImmediate(resolve));

test('opens only the Revolut card popup with customer details, saving and promotions disabled', async () => {
  const f = fixture(), payment = f.open(f.checkout);
  await mounted();
  assert.equal(f.scripts[0].src, 'https://merchant.revolut.com/embed.js');
  assert.deepEqual(f.tokens, ['public-token']);
  assert.equal(f.popups.length, 1);
  assert.equal(f.popups[0].name, 'Test Customer');
  assert.equal(f.popups[0].email, 'customer@example.test');
  assert.equal(f.popups[0].savePaymentMethodFor, 'none');
  assert.equal(f.popups[0].upsellBanner, false);
  f.popups[0].onSuccess();
  assert.equal(await payment, 'success');
  assert.equal(f.destroyed(), 1);
});

test('cancelling and declining permit retry with the same token and no automatic resubmission', async () => {
  const f = fixture(), first = f.open(f.checkout);
  await mounted();
  await assert.rejects(f.open(f.checkout), /already open/);
  f.popups[0].onCancel();
  assert.equal(await first, 'cancelled');
  const second = f.open(f.checkout);
  const rejected = assert.rejects(second, /Card declined/);
  await mounted();
  f.popups[1].onError({ message: 'Card declined' });
  await rejected;
  assert.equal(f.scripts.length, 1, 'Reuse the loaded SDK');
  assert.deepEqual(f.tokens, ['public-token', 'public-token']);
  assert.equal(f.destroyed(), 2);
});

test('supplies the saved billing address to Revolut to hide the repeated postcode prompt', async () => {
  const f = fixture();
  f.checkout.customer.billingAddress = { countryCode: 'AU', streetLine1: '4 Example Road', city: 'Doonside', postcode: '2767', region: 'NSW' };
  const payment = f.open(f.checkout);
  await mounted();
  assert.deepEqual(f.popups[0].billingAddress, f.checkout.customer.billingAddress);
  f.popups[0].onCancel();
  await payment;
});

test('failed SDK loads can be retried, with no hosted wallet-page fallback', async () => {
  const f = fixture({ failLoad: true });
  await assert.rejects(f.open(f.checkout), /could not load/);
  assert.equal(f.scripts[0].removed, true);
  const retry = f.open(f.checkout);
  await mounted();
  f.popups[0].onCancel();
  await retry;
  assert.equal(f.scripts.length, 2);
});

test('sandbox checkouts use the sandbox SDK and invalid configuration fails before loading', async () => {
  const f = fixture();
  await assert.rejects(f.open({ ...f.checkout, token: '' }), /Could not open/);
  await assert.rejects(f.open({ ...f.checkout, mode: 'https://example.test' }), /Could not open/);
  assert.equal(f.scripts.length, 0);
  const payment = f.open({ ...f.checkout, mode: 'sandbox' });
  await mounted();
  assert.equal(f.scripts[0].src, 'https://sandbox-merchant.revolut.com/embed.js');
  f.popups[0].onCancel();
  await payment;
});
