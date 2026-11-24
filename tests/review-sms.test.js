const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup({recent=[],enabled=true}={}){
  const sent=[],queries=[],patches=[];
  const SB={async sb(q,o={}){queries.push(q);if(o.method==='PATCH'){patches.push({q,body:o.body});return [];}return recent;}};
  const Sms={SMS_PAUSED_MESSAGE:'SMS is paused for now',smsEnabled:()=>enabled,cleanPhone:v=>String(v||'').replace(/^04/,'+614'),async sendLeadSms(a){sent.push(a);return {status:'submitted'};}};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api/_review-sms.js'),'utf8'),{module,require:k=>k==='./_supabase'?SB:k==='./_sms-outbound'?Sms:require(k),console:{error(){}},process:{env:{}},Date});
  return {R:module.exports,sent,queries,patches};
}
const job=(o={})=>({id:'j1',job_no:7,lead_id:'l1',customer_name:'Jo Smith',phone:'0400000000',work_type:'install',...o});
test('sends one review SMS with the Google link, keyed to the job, and stamps it',async()=>{
  const {R,sent,patches}=setup(),r=await R.sendForCompletedJob(job());
  assert.equal(r.status,'sent');assert.equal(sent.length,1);assert.equal(sent[0].key,'review-j1');
  assert.match(sent[0].message,/^Hi Jo,/);assert.match(sent[0].message,/https:\/\/g\.page\/r\/CTNPjpqOUVo2EBM\/review/);
  assert.ok(patches[0].body.review_sms_sent_at);
});
test('the office can stop it per job',async()=>{
  const {R,sent}=setup(),r=await R.sendForCompletedJob(job({review_sms:false}));
  assert.equal(r.status,'skipped');assert.equal(sent.length,0);
});
test('never sent for warranty visits, already-sent jobs, no-text customers, no phone or paused SMS',async()=>{
  for(const o of [{work_type:'warranty'},{review_sms_sent_at:'2026-01-01'},{notify_sms:false},{notify_customer:false},{phone:''}]){
    const {R,sent}=setup();assert.equal((await R.sendForCompletedJob(job(o))).status,'skipped');assert.equal(sent.length,0);
  }
  const p=setup({enabled:false});assert.equal((await p.R.sendForCompletedJob(job())).status,'skipped');assert.equal(p.sent.length,0);
});
test('a customer asked for a review in the last 90 days is not asked again',async()=>{
  const {R,sent}=setup({recent:[{id:'x'}]}),r=await R.sendForCompletedJob(job());
  assert.equal(r.status,'skipped');assert.equal(sent.length,0);
});
test('the office button sends regardless of the stop switch or a recent request, and stamps the job',async()=>{
  const {R,sent,patches}=setup({recent:[{id:'x'}]}),r=await R.sendManual(job({review_sms:false}));
  assert.equal(r.phone,'+61400000000');assert.equal(sent.length,1);assert.match(sent[0].message,/thank you for choosing PowerSmart Co for your smoke alarm service/);
  assert.match(sent[0].key,/^review-manual-j1-/);assert.ok(patches[0].body.review_sms_sent_at);
});
test('the office button explains why it cannot send',async()=>{
  await assert.rejects(setup().R.sendManual(job({phone:''})),/mobile number/);
  await assert.rejects(setup({enabled:false}).R.sendManual(job()),/undefined|paused/i);
});
