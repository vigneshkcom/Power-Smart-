const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(name, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api', name), 'utf8'), {
    module, exports: module.exports, require: key => key in mocks ? mocks[key] : require(key),
    console: { error() {} }, URL, Buffer, Date, process: { env: {} },
  }, { filename: name });
  return module.exports;
}
function fixture() {
  const payments = [], comments = [], stripeCalls = [], sessions = new Map(), dbCalls = [], smsCalls = [];
  const SB = { configured: () => true, async sb(query, options = {}) {
    dbCalls.push({ query, options });
    const [table, qs = ''] = query.split('?'), params = new URLSearchParams(qs);
    const matches = row => [...params].every(([key, value]) => {
      if (['select','order','limit','on_conflict'].includes(key)) return true;
      const v = decodeURIComponent(value.slice(value.indexOf('.') + 1));
      return value.startsWith('neq.') ? String(row[key]) !== v : String(row[key]) === v;
    });
    if (table === 'leads') return [{ id: 'lead1', name: 'Test Customer', email: '', phone:'+61400000000', quote_ref: '7000' }].filter(matches);
    const rows = table === 'payment_requests' ? payments : comments;
    if (options.method === 'POST') {
      if (table === 'payment_requests' && payments.some(p => p.stripe_session_id === options.body.stripe_session_id)) return [];
      const row = { id: String(rows.length + 1), created_at: new Date().toISOString(), ...options.body }; rows.push(row); return [row];
    }
    if (options.method === 'PATCH') { const found = rows.filter(matches); found.forEach(r => Object.assign(r, options.body)); return found; }
    return rows.filter(matches);
  }};
  const Stripe = { configured: () => true, verifySignature: () => true, async request(url, form, options) {
    stripeCalls.push({ url, form, options });
    if (!form) return sessions.get(url.split('/').pop());
    const prior = [...sessions.values()].find(s => s.key === options.idempotencyKey);
    if (prior) return prior;
    const session = { id: 'cs_' + sessions.size, key: options.idempotencyKey, url: 'https://checkout.stripe.com/c/pay/test',
      status: 'open', payment_status: 'unpaid', currency: 'aud', amount_total: Number(form['line_items[0][price_data][unit_amount]']),
      metadata: { lead_id: form['metadata[lead_id]'], payment_type: form['metadata[payment_type]'] } };
    sessions.set(session.id, session); return session;
  }};
  const P = load('_payments.js', { './_supabase': SB });
  const Sms={cleanPhone:v=>v,async sendLeadSms(args){smsCalls.push(args);return {status:'submitted',phone:args.lead.phone};}};
  const handler = load('payments.js', { './_supabase': SB, './_stripe': Stripe, './_payments': P, './_sms-outbound':Sms });
  async function call(body, extras = {}) {
    let status = 200, data; const response = { setHeader() {}, status(s) { status = s; return this; }, json(d) { data = d; return this; } };
    await handler({ method: 'POST', headers: { 'x-portal-key': '2026' }, body, ...extras }, response);
    return { status, data };
  }
  const body = { action: 'create', lead_id: 'lead1', amount: '316.25', payment_type: 'installation_balance', description: 'Smoke alarm installation balance', request_key: 'payment-request-key-00001', agent: 'Mani' };
  return { payments, comments, stripeCalls, sessions, dbCalls, smsCalls, P, SB, Stripe, handler, call, body };
}

test('amount validation preserves exact cents and rejects malformed or unsafe values', () => {
  const { P } = fixture();
  for (const [input, expected] of [['0.50',50],['316.25',31625],['35',3500],['999999.99',99999999]]) assert.equal(P.amountCents(input), expected);
  for (const input of ['',null,0,-1,'0.49','1.001','1e3','Infinity','1,000','1000000','NaN']) assert.throws(() => P.amountCents(input));
});
test('requests require staff authentication before reading customer data', async () => {
  const f = fixture(), result = await f.call(f.body, { headers: {} });
  assert.equal(result.status, 401); assert.equal(f.dbCalls.length, 0);
});
test('custom checkout uses exact amount, purpose and lead metadata and writes a full payment note', async () => {
  const f = fixture(), result = await f.call(f.body);
  assert.equal(result.status, 200); assert.equal(f.payments[0].amount_cents, 31625);
  assert.equal(f.payments[0].payment_type, 'installation_balance');
  assert.equal(f.payments[0].customer_email, '');
  const form = f.stripeCalls[0].form;
  assert.equal(form['metadata[lead_id]'], 'lead1'); assert.equal(form['metadata[quote_ref]'], '7000');
  assert.equal(form['payment_method_types[0]'], 'card');
  assert.match(f.comments[0].body, /316\.25 AUD.*Smoke alarm installation balance.*Payment pending/);
  assert.equal(f.comments[0].kind, 'payment');
});
test('retrying the same request returns the same checkout without a duplicate payment or note', async () => {
  const f = fixture(); const first = await f.call(f.body), second = await f.call(f.body);
  assert.equal(second.status, 200); assert.equal(first.data.payment.id, second.data.payment.id);
  assert.equal(f.payments.length, 1); assert.equal(f.sessions.size, 1); assert.equal(f.comments.length, 1);
});
test('paid booking fee does not block an installation balance or custom payment', async () => {
  const f = fixture(); f.payments.push({ id: 'old', lead_id: 'lead1', payment_type: 'booking_fee', status: 'paid' });
  assert.equal((await f.call(f.body)).status, 200);
  assert.equal((await f.call({ ...f.body, payment_type: 'booking_fee' })).status, 409);
});
test('reopening the form reuses an identical pending checkout', async () => {
  const f=fixture();await f.call(f.body);
  const result=await f.call({...f.body,request_key:'different-form-request-key'});
  assert.equal(result.status,200);assert.equal(f.payments.length,1);assert.equal(f.sessions.size,1);assert.equal(f.comments.length,1);
});
test('booking fee confirmed in Stripe blocks another fee before webhook delivery', async () => {
  const f=fixture(),body={...f.body,payment_type:'booking_fee'};await f.call(body);
  const s=f.sessions.get(f.payments[0].stripe_session_id);s.payment_status='paid';s.status='complete';
  const result=await f.call({...body,request_key:'different-booking-request-key'});
  assert.equal(result.status,409);assert.equal(f.payments[0].status,'paid');assert.equal(f.sessions.size,1);
});
test('invalid purpose, amount, description and retry token fail before Stripe checkout creation', async () => {
  for (const patch of [{payment_type:'__proto__'},{amount:'1.234'},{description:''},{request_key:'bad'}]) {
    const f = fixture(); assert.equal((await f.call({...f.body,...patch})).status,400); assert.equal(f.stripeCalls.length,0);
  }
});
test('confirmed payment refresh updates its own row and notes exactly once', async () => {
  const f = fixture(); await f.call(f.body);
  const p = f.payments[0], s = f.sessions.get(p.stripe_session_id); s.payment_status='paid'; s.status='complete'; s.payment_intent='pi_123';
  for(let i=0;i<2;i++) assert.equal((await f.call({action:'refresh',lead_id:'lead1',payment_id:p.id})).status,200);
  assert.equal(p.status,'paid'); assert.equal(p.amount_paid_cents,31625); assert.equal(p.stripe_payment_intent_id,'pi_123');
  assert.equal(f.comments.filter(c=>c.author==='Stripe').length,1);
  assert.match(f.comments.find(c=>c.author==='Stripe').body,/Installation balance paid: \$316\.25/);
  assert.equal((await f.call(f.body)).status,409);
});
test('refresh refuses cross-customer access and mismatched Stripe amount or ownership', async () => {
  const f = fixture(); await f.call(f.body); const p=f.payments[0], s=f.sessions.get(p.stripe_session_id);
  assert.equal((await f.call({action:'refresh',lead_id:'other',payment_id:p.id})).status,404);
  s.payment_status='paid'; s.amount_total=100;
  assert.equal((await f.call({action:'refresh',lead_id:'lead1',payment_id:p.id})).status,500); assert.equal(p.status,'sent');
  s.amount_total=p.amount_cents; s.metadata.lead_id='other';
  assert.equal((await f.call({action:'refresh',lead_id:'lead1',payment_id:p.id})).status,500); assert.equal(p.status,'sent');
});
test('expired sessions become expired and cannot be reopened as a new charge by retry', async () => {
  const f=fixture(); await f.call(f.body);const p=f.payments[0]; f.sessions.get(p.stripe_session_id).status='expired';
  assert.equal((await f.call({action:'refresh',lead_id:'lead1',payment_id:p.id})).data.payment.status,'expired');
  assert.equal((await f.call(f.body)).status,409); assert.equal(f.sessions.size,1);
});
test('a failed note write can be repaired by refreshing an already paid payment', async () => {
  const f=fixture();await f.call(f.body);const p=f.payments[0],s=f.sessions.get(p.stripe_session_id);
  p.status='paid';p.amount_paid_cents=p.amount_cents;s.payment_status='paid';s.status='complete';
  await f.P.reconcile(p,s); assert.equal(f.comments.filter(c=>c.author==='Stripe').length,1);
});
test('checkout links are restricted to the Stripe HTTPS host', () => {
  const {P}=fixture();assert.match(P.checkoutUrl('https://checkout.stripe.com/c/pay/example'),/^https:/);
  for(const url of ['javascript:alert(1)','https://checkout.stripe.com.evil.test','http://checkout.stripe.com'])assert.throws(()=>P.checkoutUrl(url));
});
test('webhook confirms correct purpose and retries without duplicate notes', async () => {
  const f=fixture();await f.call(f.body);const p=f.payments[0],s=f.sessions.get(p.stripe_session_id);s.payment_status='paid';s.status='complete';
  const webhook=load('stripe-webhook.js',{'./_stripe':f.Stripe,'./_supabase':f.SB,'./_payments':f.P});
  async function deliver(session) {
    let status=200;const req={method:'POST',headers:{'stripe-signature':'valid'},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({id:'evt_1',type:'checkout.session.completed',data:{object:session}}));}};
    const res={status(n){status=n;return this;},json(){return this;},send(){return this;},setHeader(){}};
    await webhook(req,res);return status;
  }
  assert.equal(await deliver(s),200);assert.equal(await deliver(s),200);
  assert.equal(f.comments.filter(c=>c.author==='Stripe').length,1);assert.equal(p.stripe_event_id,'evt_1');
  assert.equal(await deliver({...s,id:'cs_not_saved'}),500);
});
test('payment SMS requires preview of the correct saved phone and full payment message',async()=>{
  const f=fixture();await f.call(f.body);const p=f.payments[0];
  const preview=await f.call({action:'preview_sms',lead_id:'lead1',payment_id:p.id});
  assert.equal(preview.status,200);assert.match(preview.data.message,/316\.25 AUD/);assert.match(preview.data.message,/\/pay\?token=/);assert.equal(f.smsCalls.length,0);
  const body={action:'send_sms',lead_id:'lead1',payment_id:p.id,expected_phone:preview.data.phone,expected_message:preview.data.message};
  assert.equal((await f.call({...body,expected_phone:'+61499999999'})).status,409);assert.equal(f.smsCalls.length,0);
  assert.equal((await f.call(body)).status,200);assert.equal(f.smsCalls.length,1);assert.equal(f.smsCalls[0].message,preview.data.message);
});
test('paid, expired and cross-customer payments cannot be texted',async()=>{
  const f=fixture();await f.call(f.body);const p=f.payments[0],session=f.sessions.get(p.stripe_session_id);
  assert.equal((await f.call({action:'send_sms',lead_id:'other',payment_id:p.id})).status,404);
  session.status='expired';assert.equal((await f.call({action:'preview_sms',lead_id:'lead1',payment_id:p.id})).status,409);
  session.status='complete';session.payment_status='paid';assert.equal((await f.call({action:'send_sms',lead_id:'lead1',payment_id:p.id})).status,409);assert.equal(f.smsCalls.length,0);
});
