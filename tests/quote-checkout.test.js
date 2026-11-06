const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Q = require('../api/_quote');
function load(name, mocks) {
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api', name), 'utf8'), {
    module, require:key => key in mocks ? mocks[key] : key === './_payment-summary' ? load('_payment-summary.js', mocks) : key === './_callout-fee' ? require('../api/_callout-fee') : require(key), URL, URLSearchParams, Buffer, Date,
    console:{error(){}}, process:{env:{}},
  });
  return module.exports;
}
function fixture() {
  const lead = {id:'lead1',created_at:'2026-11-05T00:00:00Z',email:'test@example.test',quote_ref:'7011'};
  const rendered = Q.renderQuoteEmail({customerName:'Test',customerEmail:lead.email,ref:'7011',serviceMode:'install',alarmQty:7,controllerQty:1,calloutFee:35,issueDate:'28 October 2026',validUntil:'27 November 2026'});
  const quote = {id:'8abe9f5b-2495-4ee3-b521-0364df34db00',lead_id:lead.id,quote_ref:'7011',quote_total:623,body_html:rendered.html};
  const payments = [], notes = [], sessions = new Map(), calls = [], dbCalls = [];
  const SB = {configured:()=>true, async sb(query, opts={}) {
    dbCalls.push({query,opts});
    if (query.startsWith('sent_emails')) return query.includes('quote_ref=eq.other') ? [] : [quote];
    if (query.startsWith('leads')) return [lead];
    if (query.startsWith('jobs')) return [];
    if (query.startsWith('lead_comments')) {
      if (opts.method==='POST') {notes.push(opts.body);return [];}
      return notes.filter(n=>query.includes(encodeURIComponent(n.body)));
    }
    assert(query.startsWith('payment_requests'),query);
    if (opts.method==='POST') {
      if (!payments.some(p=>p.stripe_session_id===opts.body.stripe_session_id)) payments.push({id:'p'+payments.length,...opts.body});
      return [];
    }
    const params = new URLSearchParams(query.split('?')[1]);
    const matches = p => [...params].every(([k,v])=>['select','order','limit','on_conflict'].includes(k) || (v.startsWith('neq.') ? String(p[k])!==v.slice(4) : String(p[k])===v.slice(3)));
    const rows = payments.filter(matches);
    if(opts.method==='PATCH')rows.forEach(p=>Object.assign(p,opts.body));
    return rows;
  }};
  const Stripe = {configured:()=>true,async request(url, form, opts={}) {
    calls.push({url,form,opts});
    if(url.endsWith('/expire')){const session=sessions.get(url.split('/').at(-2));session.status='expired';return session;}
    if(!form)return sessions.get(url.split('/').pop());
    const old = [...sessions.values()].find(s=>s.key===opts.idempotencyKey);if(old)return old;
    const session = {id:'cs_live_'+'x'.repeat(30)+sessions.size,url:'https://checkout.stripe.com/c/pay/test',key:opts.idempotencyKey,
      amount_total:Number(form['line_items[0][price_data][unit_amount]']),currency:'aud',payment_status:'unpaid',status:'open',
      metadata:{lead_id:form['metadata[lead_id]'],quote_ref:form['metadata[quote_ref]'],payment_type:form['metadata[payment_type]']}};
    sessions.set(session.id,session);return session;
  }};
  const P = load('_payments.js',{'./_supabase':SB});
  const QP = load('_quote-payments.js',{'./_supabase':SB,'./_stripe':Stripe,'./_payments':P,'./_quote':Q});
  return {lead,quote,payments,notes,sessions,calls,dbCalls,SB,Stripe,P,QP};
}
async function invoke(handler, req) {
  let status=200,body;const headers={};
  await handler(req,{setHeader(k,v){headers[k]=v;},status(n){status=n;return this;},send(v){body=v;return this;},json(v){body=v;return this;},end(){return this;}});
  return {status,body,headers};
}

test('quote checkout charges the issued booking fee with customer and quote metadata, and retries reuse one session', async()=>{
  const f=fixture();await f.QP.checkout(f.quote,f.lead);await f.QP.checkout(f.quote,f.lead);
  assert.equal(f.payments.length,1);assert.equal(f.sessions.size,1);assert.equal(f.payments[0].amount_cents,3500);
  const form=f.calls.find(c=>c.form).form;
  assert.equal(form['metadata[quote_ref]'],'7011');assert.equal(form['metadata[lead_id]'],'lead1');assert.equal(form['metadata[payment_type]'],'booking_fee');
  assert.match(form.success_url,/kind=confirmation&session_id=\{CHECKOUT_SESSION_ID\}/);
  assert.equal(f.payments[0].quote_ref,'7011');assert.equal(f.notes.length,1);
});

test('new quote adds the $50 electrician call-out fee to alarm and controller prices', async()=>{
  const f=fixture();
  const rendered=Q.renderQuoteEmail({customerName:'Test',customerEmail:f.lead.email,ref:'7011',serviceMode:'install',alarmQty:5,controllerQty:1,calloutFee:50});
  f.quote.body_html=rendered.html;f.quote.quote_total=480;
  const priced=f.QP.quoteOptions(f.quote).calculation;
  assert.equal(priced.total,480);assert.equal(priced.payableToday,50);assert.equal(priced.balance,430);
  assert.equal(priced.lines.some(line=>line.label==='Electrician call-out fee'&&line.amount===50),true);
  assert.match(rendered.html,/fee=50/);
  assert.match(rendered.html,/model=additional/);
  assert.match(rendered.text,/Electrician call-out fee \(1 x \$50\.00\): \$50\.00/);
  await f.QP.checkout(f.quote,f.lead);
  assert.equal(f.payments[0].amount_cents,5000);
  assert.equal(f.calls.find(call=>call.form).form['line_items[0][price_data][product_data][name]'],'PowerSmart smoke alarm deposit');
  assert.match(f.calls.find(call=>call.form).form['line_items[0][price_data][product_data][description]'],/covers the electrician call-out fee/);
  assert.doesNotMatch(f.payments[0].description,/deposit/i);
});

test('reopening a $50 quote replaces an unpaid Stripe checkout with the deposit label',async()=>{
  const f=fixture();const rendered=Q.renderQuoteEmail({customerName:'Test',customerEmail:f.lead.email,ref:'7011',serviceMode:'install',alarmQty:5,controllerQty:1,calloutFee:50});
  f.quote.body_html=rendered.html;f.quote.quote_total=480;
  f.payments.push({id:'old',lead_id:f.lead.id,quote_ref:'7011',payment_type:'booking_fee',description:'Electrician call-out fee for quote 7011',amount_cents:5000,currency:'aud',status:'sent',stripe_session_id:'cs_live_old',checkout_url:'https://checkout.stripe.com/c/pay/old'});
  f.sessions.set('cs_live_old',{id:'cs_live_old',url:'https://checkout.stripe.com/c/pay/old',amount_total:5000,currency:'aud',payment_status:'unpaid',status:'open',metadata:{lead_id:f.lead.id}});
  const result=await f.QP.checkout(f.quote,f.lead);
  assert.equal(f.payments[0].status,'expired');assert.equal(f.sessions.get('cs_live_old').status,'expired');
  assert.equal(f.payments.length,2);assert.notEqual(result.url,'https://checkout.stripe.com/c/pay/old');
  assert.equal(f.calls.find(c=>c.form && c.url==='/checkout/sessions').form['line_items[0][price_data][product_data][name]'],'PowerSmart smoke alarm deposit');
});

test('previously issued $50 included-deposit quote remains at its saved total and payment terms', async()=>{
  const f=fixture();
  const rendered=Q.renderQuoteEmail({customerName:'Test',customerEmail:f.lead.email,ref:'7011',serviceMode:'install',alarmQty:7,controllerQty:1,calloutFee:50,calloutIncluded:true});
  f.quote.body_html=rendered.html;f.quote.quote_total=588;
  const priced=f.QP.quoteOptions(f.quote).calculation;
  assert.equal(priced.total,588);assert.equal(priced.payableToday,50);assert.equal(priced.balance,538);
  assert.equal(priced.lines.some(line=>line.label==='Electrician call-out fee'),false);
  assert.doesNotMatch(rendered.html,/model=additional/);
  await f.QP.checkout(f.quote,f.lead);
  assert.equal(f.calls.find(call=>call.form).form['line_items[0][price_data][product_data][name]'],'PowerSmart smoke alarm deposit');
});

test('an existing quote link without a fee parameter preserves the promised $35',()=>{
  const f=fixture();f.quote.body_html=f.quote.body_html.replace(/&amp;fee=35/,'');
  assert.equal(f.QP.quoteOptions(f.quote).calculation.payableToday,35);
  assert.equal(f.QP.quoteOptions(f.quote).calculation.total,623);
});

test('inspection quotes charge $120 and never use the $35 shared payment link',async()=>{
  const f=fixture();f.quote.body_html=Q.renderQuoteEmail({ref:'7011',customerEmail:f.lead.email,serviceMode:'inspect',alarmQty:0,controllerQty:0}).html;f.quote.quote_total=120;
  await f.QP.checkout(f.quote,f.lead);assert.equal(f.payments[0].amount_cents,12000);assert.equal(f.payments[0].payment_type,'inspection');
});

test('a paid fee found before webhook delivery is recorded and cannot create another checkout',async()=>{
  const f=fixture();await f.QP.checkout(f.quote,f.lead);const s=[...f.sessions.values()][0];s.status='complete';s.payment_status='paid';
  const result=await f.QP.checkout(f.quote,f.lead);assert.equal(result.paid,true);assert.match(result.url,/quote\?token=/);assert.equal(f.sessions.size,1);assert.equal(f.payments[0].status,'paid');
});

test('an expired quote checkout is replaced and does not affect another quote',async()=>{
  const f=fixture();await f.QP.checkout(f.quote,f.lead);[...f.sessions.values()][0].status='expired';
  await f.QP.checkout(f.quote,f.lead);assert.equal(f.sessions.size,2);assert.equal(f.payments[0].status,'expired');
  const other={...f.quote,quote_ref:'7012'};assert.equal((await f.QP.quotePayments(other)).length,0);
});

test('quote total is unchanged while the live viewer shows $35 received and $588 remaining, without a second fee prompt',async()=>{
  const f=fixture();f.payments.push({id:'payment1',lead_id:'lead1',quote_ref:'7011',status:'paid',payment_type:'booking_fee',amount_paid_cents:3500});
  const viewer=load('_view-quote.js',{'./_supabase':f.SB,'./_quote-payments':f.QP});
  const result=await invoke(viewer,{method:'GET',query:{token:f.quote.id}});
  assert.equal(result.status,200);assert.match(result.body,/Electrician call-out fee paid/);assert.match(result.body,/\$35\.00/);assert.match(result.body,/Remaining balance/);assert.match(result.body,/\$588\.00/);assert.match(result.body,/\$623\.00/);
  assert.doesNotMatch(result.body,/Accept this quote|payable today|Accepting takes you/);assert.match(f.quote.body_html,/Accept this quote/);
  assert.equal(result.headers['Cache-Control'],'no-store');
});

test('unpaid, failed, expired and other-quote payments never appear as money received',()=>{
  const f=fixture();for(const status of ['sent','failed','expired'])assert.equal(f.QP.renderPaidQuote(f.quote,[{status,amount_paid_cents:3500}]),f.quote.body_html);
  assert.throws(()=>f.QP.quoteOptions({...f.quote,quote_total:1}),/could not be verified/);
});

test('Stripe return verifies payment and redirects to the same quote even before the webhook',async()=>{
  const f=fixture();await f.QP.checkout(f.quote,f.lead);const s=[...f.sessions.values()][0];s.payment_status='paid';s.status='complete';
  const handler=load('_payment-confirmation.js',{'./_supabase':f.SB,'./_stripe':f.Stripe,'./_payments':f.P,'./_quote':Q});
  const result=await invoke(handler,{method:'GET',query:{session_id:s.id}});
  assert.equal(result.status,303);assert.equal(result.headers.Location,`${Q.QUOTE_SITE}/quote?token=${f.quote.id}`);assert.equal(f.payments[0].status,'paid');
  assert.equal((await invoke(handler,{method:'GET',query:{session_id:'made-up'}})).status,404);
});

test('public acceptance uses stored quote quantities and amount, ignores changed URL prices, and refuses another email',async()=>{
  const f=fixture();const handler=load('accept-quote.js',{'./_quote':Q,'./_supabase':f.SB,'./_quote-payments':f.QP});
  const body={ref:'7011',customerEmail:f.lead.email,customerName:'Test',serviceMode:'inspect',alarmQty:0,paymentMethod:'stripe',addressLine1:'1 Test Road',addressSuburb:'Brisbane',addressState:'QLD',addressPostcode:'4000'};
  const r=await invoke(handler,{method:'POST',body});assert.equal(r.status,200);assert.equal(f.payments[0].amount_cents,3500);assert.equal(f.payments[0].payment_type,'booking_fee');
  assert.equal((await invoke(handler,{method:'POST',body:{...body,customerEmail:'other@example.test'}})).status,500);assert.equal(f.sessions.size,1);
});

test('staff booking checkout reuses its saved link and records Stripe payment before refusing a second fee',async()=>{
  const f=fixture();const handler=load('send-booking-fee.js',{'./_supabase':f.SB,'./_stripe':f.Stripe,'./_quote-payments':f.QP,resend:{Resend:class{}}});
  const req={method:'POST',headers:{'x-portal-key':'2026'},body:{lead_id:f.lead.id,action:'checkout',agent:'Sunny'}};
  assert.equal((await invoke(handler,req)).status,200);assert.equal((await invoke(handler,req)).status,200);assert.equal(f.sessions.size,1);
  const s=[...f.sessions.values()][0];s.payment_status='paid';s.status='complete';
  assert.equal((await invoke(handler,req)).status,409);assert.equal(f.payments[0].status,'paid');assert.equal(f.sessions.size,1);
});

test('staff checkout follows the issued quote model for $50 call-out and older included deposits',async()=>{
  for (const included of [false,true]) {
    const f=fixture();f.lead.created_at='2026-11-07T00:00:00Z';
    const rendered=Q.renderQuoteEmail({customerName:'Test',customerEmail:f.lead.email,ref:'7011',serviceMode:'install',alarmQty:5,controllerQty:1,calloutFee:50,calloutIncluded:included});
    f.quote.body_html=rendered.html;f.quote.quote_total=included?430:480;
    const handler=load('send-booking-fee.js',{'./_supabase':f.SB,'./_stripe':f.Stripe,'./_quote-payments':f.QP,resend:{Resend:class{}}});
    const result=await invoke(handler,{method:'POST',headers:{'x-portal-key':'2026'},body:{lead_id:f.lead.id,action:'checkout',agent:'Sunny'}});
    assert.equal(result.status,200);assert.equal(f.payments[0].amount_cents,5000);
    assert.equal(f.calls.find(call=>call.form).form['line_items[0][price_data][product_data][name]'],'PowerSmart smoke alarm deposit');
  }
});

test('a different-purpose partial credit does not remove the booking payment button',()=>{
  const f=fixture();const html=f.QP.renderPaidQuote(f.quote,[{id:'p1',lead_id:'lead1',quote_ref:'7011',status:'paid',payment_type:'other',amount_paid_cents:1000}]);
  assert.match(html,/Remaining balance/);assert.match(html,/\$613\.00/);assert.match(html,/Accept this quote/);assert.doesNotMatch(html,/Electrician call-out fee paid/);
});

test('a discounted quote reduces the balance only, and its saved total still verifies for checkout', ()=>{
  const f=fixture();
  const rendered=Q.renderQuoteEmail({customerName:'Test',customerEmail:f.lead.email,ref:'7012',serviceMode:'install',alarmQty:7,controllerQty:1,discount:50,calloutFee:35,revised:true,issueDate:'1 November 2026',validUntil:'1 December 2026'});
  assert.equal(rendered.quote.total,573);
  assert.equal(rendered.quote.payableToday,35);
  assert.equal(rendered.quote.balance,538);
  const options=f.QP.quoteOptions({quote_total:573,body_html:rendered.html});
  assert.equal(options.discount,50);
  assert.equal(options.calculation.total,573);
  assert.equal(Q.normalise({serviceMode:'inspect',discount:50}).discount,0);
  assert.equal(Q.buildQuote(Q.normalise({serviceMode:'install',alarmQty:1,discount:9999})).balance,0);
});
