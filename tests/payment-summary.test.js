const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Summary=require('../api/_payment-summary');
const quote={id:'quote1',lead_id:'lead1',quote_ref:'7011',quote_total:623};
const booking={id:'p1',lead_id:'lead1',quote_ref:'7011',payment_type:'booking_fee',status:'paid',amount_paid_cents:3500,paid_at:'2026-10-28T05:49:24Z',stripe_session_id:'cs_booking'};
const paidJob={id:'j1',job_no:1001,lead_id:'lead1',quote_ref:'7011',pay_status:'paid',paid_cents:58800,pay_session_id:'cs_install',paid_at:'2026-10-29T01:00:00Z'};

function load(file,mocks){const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api',file),'utf8'),{
  module,require:k=>k in mocks?mocks[k]:k.startsWith('./')?load(k.slice(2)+'.js',mocks):require(k),
  console:{error(){}},URL,URLSearchParams,Buffer,Date,process:{env:{}},
});return module.exports;}
async function call(handler,body){let status=200,data;await handler({method:body?'POST':'GET',headers:{'x-portal-key':'2026'},body},{setHeader(){},status(n){status=n;return this;},json(d){data=d;return this;}});return {status,data};}
function database({requests=[booking],jobs=[],quotes=[quote],failPayments=false,stage="quote_accepted"}={}){
  const writes=[];
  const leads=[{id:'lead1',name:'Customer',quote_ref:'7011',stage}];
  const SB={configured:()=>true,async sb(query,opts={}){
    const [table,filter='']=query.split('?');
    if(opts.method){writes.push({table,body:opts.body});if(table==='jobs'&&opts.method==='POST')return [{id:'new-job',job_no:1002,...opts.body}];return [];}
    if(table==='payment_requests'&&failPayments)throw Error('Storage unavailable');
    const rows={sent_emails:quotes,leads,payment_requests:requests,jobs,electricians:[]}[table]||[];
    const params=new URLSearchParams(filter);
    return rows.filter(row=>[...params].every(([key,value])=>!value.startsWith('eq.')||String(row[key])===value.slice(3)));
  }};return {SB,writes};
}
function issued(q=quote){return {...q,status:'sent',kind:'quote',to_email:'test@example.test',to_name:'Customer',body_text:'- Photoelectric interconnected smoke alarms (7 x $79.00): $553.00',created_at:'2026-10-27T00:00:00Z'};}

test('booking payment produces part-paid status and the exact remaining quote balance',()=>{
  const s=Summary.summarize(quote,[booking]);assert.equal(s.total_cents,62300);assert.equal(s.received_cents,3500);assert.equal(s.booking_paid_cents,3500);assert.equal(s.pending_cents,58800);assert.equal(s.status,'part_paid');
});
test('later on-site payment settles the quote, without counting a duplicate Stripe checkout twice',()=>{
  const records=[booking,...Summary.jobPayments([paidJob]),{...booking,id:'duplicate',payment_type:'installation_balance',stripe_session_id:'cs_install',amount_paid_cents:58800}];
  const s=Summary.summarize(quote,records);assert.equal(s.received_cents,62300);assert.equal(s.pending_cents,0);assert.equal(s.status,'paid');assert.equal(s.payments.length,2);
});
test('pending, failed, expired, another customer and another quote never reduce the balance',()=>{
  const records=['sent','expired','failed'].map(status=>({...booking,status}));records.push({...booking,quote_ref:'7012'},{...booking,lead_id:'other'},{...booking,amount_paid_cents:null});
  const s=Summary.summarize(quote,records);assert.equal(s.status,'unpaid');assert.equal(s.received_cents,0);assert.equal(s.pending_cents,62300);
});
test('overpayments are a credit and never a negative pending amount',()=>{
  const s=Summary.summarize(quote,[{...booking,amount_paid_cents:65000}]);assert.equal(s.status,'overpaid');assert.equal(s.pending_cents,0);assert.equal(s.overpaid_cents,2700);
});
test('Quote Tracker shows a booking payment as part paid and isolates each quote for the same customer',async()=>{
  const db=database({quotes:[issued(),issued({...quote,id:'quote2',quote_ref:'7012',quote_total:465})]});
  const result=await call(load('quote-tracker.js',{'./_supabase':db.SB}));assert.equal(result.status,200);
  assert.equal(result.data.quotes[0].status,'part_paid');assert.equal(result.data.quotes[0].payment_summary.pending_cents,58800);
  assert.equal(result.data.quotes[1].payment_summary.received_cents,0);assert.equal(result.data.quotes[1].payment_summary.pending_cents,46500);
});
test('Quote Tracker includes confirmed on-site payments and reports paid in full',async()=>{
  const db=database({quotes:[issued()],jobs:[paidJob]});const result=await call(load('quote-tracker.js',{'./_supabase':db.SB}));
  assert.equal(result.status,200);assert.equal(result.data.quotes[0].status,'paid');assert.equal(result.data.quotes[0].payment_summary.received_cents,62300);
});
test('scheduling gets the same live payment summary without creating or changing a job',async()=>{
  const db=database({quotes:[issued()]});const result=await call(load('_jobs.js',{'./_supabase':db.SB}),{action:'lead_quote',lead_id:'lead1'});
  assert.equal(result.status,200);assert.equal(result.data.payment.received_cents,3500);assert.equal(result.data.payment.pending_cents,58800);assert.equal(db.writes.length,0);
});
test('unavailable payment storage is explicit and does not display a false zero received',async()=>{
  const db=database({quotes:[issued()],failPayments:true});const h=load('_jobs.js',{'./_supabase':db.SB});
  const result=await call(h,{action:'lead_quote',lead_id:'lead1'});assert.equal(result.status,200);assert.equal(result.data.payment,null);assert.match(result.data.payment_error,/could not be loaded/);
  assert.equal((await call(load('quote-tracker.js',{'./_supabase':db.SB}))).status,500);
});
test('a new job saves its issued quote reference and existing jobs read that reference after a later quote',async()=>{
  const db=database({quotes:[issued()]});const h=load('_jobs.js',{'./_supabase':db.SB});
  const result=await call(h,{action:'job_create',customer_name:'Customer',lead_id:'lead1'});assert.equal(result.status,200);assert.equal(result.data.job.quote_ref,'7011');
  const linked=database({quotes:[issued({...quote,id:'newer',quote_ref:'7012',quote_total:465}),issued()],jobs:[{...paidJob,pay_status:'unpaid'}]});
  const existing=await call(load('_jobs.js',{'./_supabase':linked.SB}),{action:'lead_quote',job_id:'j1'});
  assert.equal(existing.status,200);assert.equal(existing.data.quote.ref,'7011');assert.equal(existing.data.payment.pending_cents,58800);
});


test('a scheduled customer keeps an accepted quote status without a payment',async()=>{
  const db=database({quotes:[issued()],requests:[],stage:'scheduled'});
  const result=await call(load('quote-tracker.js',{'./_supabase':db.SB}));
  assert.equal(result.status,200);assert.equal(result.data.quotes[0].status,'accepted');
  assert.equal(result.data.quotes[0].lead_stage,'scheduled');
});
