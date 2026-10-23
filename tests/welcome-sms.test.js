const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function load(file,mocks,globals={}){
  const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api',file),'utf8'),{module,require:k=>k in mocks?mocks[k]:require(k),console:{error(){}},process:{env:{RESEND_API_KEY:'test'}},...globals});return module.exports;
}
function fixture({recent=[],failure=false}={}){
  const calls=[],notes=[],queries=[];
  const Sms={cleanPhone:v=>String(v||'').replace(/^04/,'+614'),async sendLeadSms(args){calls.push(args);if(failure)throw Error('Customer opted out');return {status:'submitted'};},async logNote(id,author,body){notes.push({id,author,body});}};
  const W=load('_welcome-sms.js',{'./_supabase':{async sb(q){queries.push(q);return recent;}},'./_sms-outbound':Sms});
  const lead={id:'lead1',name:'  Anirudh Test ',phone:'0400000000',stage:'new_lead'};
  return {W,calls,notes,queries,lead};
}
test('uses the exact approved welcome template and first name',()=>{
  const {W}=fixture();assert.equal(W.welcomeMessage(' Anirudh Test '),'Hi Anirudh, thanks for getting in touch with PowerSmart about your smoke alarms. We’ve received your enquiry and look forward to helping you. Our team will be in touch within the next 24 hours.');assert.match(W.welcomeMessage(''),/^Hi there,/);
});
test('new enquiries submit one welcome using a stable normalized-phone key',async()=>{
  const f=fixture(),now=new Date('2026-10-23T11:00:00Z'),r=await f.W.welcomeLead(f.lead,now);
  assert.equal(r.status,'submitted');assert.equal(f.calls.length,1);assert.equal(f.calls[0].author,'System');assert.equal(f.calls[0].key,'welcome-+61400000000-2026-10-23');
  const q=decodeURIComponent(f.queries[0]);assert.match(q,/created_at=gte.2026-10-22T11:00:00.000Z/);assert.match(q,/message=like.Hi \*, thanks/);
});
test('a recent welcome suppresses repeat submissions even if lead name changes',async()=>{
  const f=fixture({recent:[{status:'sent'}]}),r=await f.W.welcomeLead({...f.lead,name:'Different Name'});
  assert.equal(r.status,'skipped');assert.equal(r.duplicate,true);assert.equal(f.calls.length,0);assert.match(f.notes[0].body,/Welcome SMS not repeated/);
});
test('pending or uncertain welcome is never automatically resent',async()=>{
  for(const status of ['pending','unknown']){const f=fixture({recent:[{status}]}),r=await f.W.welcomeLead(f.lead);assert.equal(r.duplicate,true);assert.match(r.error,/uncertain/);assert.equal(f.calls.length,0);}
});
test('SMS opt-out or gateway failure is recorded without rejecting the saved lead',async()=>{
  const f=fixture({failure:true}),r=await f.W.welcomeLead(f.lead);assert.equal(r.status,'failed');assert.match(r.error,/opted out/);assert(f.notes[0].body.includes(f.W.welcomeMessage(f.lead.name)));
});
test('non-mobile leads are retained but no welcome is submitted',async()=>{
  const f=fixture(),r=await f.W.welcomeLead({...f.lead,phone:'0721417792'});assert.equal(r.status,'failed');assert.equal(f.calls.length,0);assert.equal(f.queries.length,0);
});
test('existing or quote-sent leads do not receive a welcome',async()=>{
  const f=fixture();assert.equal((await f.W.welcomeLead(null)).status,'skipped');assert.equal((await f.W.welcomeLead({...f.lead,stage:'quote_sent'})).status,'skipped');assert.equal(f.calls.length,0);assert.equal(f.queries.length,0);
});
test('website lead is saved before welcome, and welcome failure does not fail the enquiry',async()=>{
  const events=[];const handler=load('lead.js',{
    './_supabase':{configured:()=>true,async sb(q,o){events.push('saved');assert.equal(o.prefer,undefined);return [{id:'lead1',...o.body}];}},
    './_welcome-sms':{async welcomeLead(lead){events.push('welcome');assert.equal(lead.stage,'new_lead');return {status:'failed',error:'Gateway unavailable'};}},
    resend:{Resend:class{constructor(){this.emails={send:async()=>{events.push('email');return {};}};}}},
  });
  let status=200,data;await handler({method:'POST',body:{name:'Test',phone:'0400000000'}},{setHeader(){},status(n){status=n;return this;},json(d){data=d;return this;}});
  assert.equal(status,200);assert.equal(data.ok,true);assert.equal(data.welcome_sms.status,'failed');assert.deepEqual(events,['saved','welcome','email']);
});
test('staff lead creation triggers welcome, while edits do not',async()=>{
  const calls=[];const handler=load('pipeline.js',{
    './_supabase':{configured:()=>true,async sb(q,o){return [{id:'lead1',...o?.body}];}},
    './_welcome-sms':{async welcomeLead(lead){calls.push(lead);return {status:'submitted'};}},
  });
  async function call(body){let data;await handler({method:'POST',headers:{'x-portal-key':'2026'},body},{setHeader(){},status(){return this;},json(d){data=d;return this;}});return data;}
  assert.equal((await call({action:'create',name:'Test',phone:'0400000000'})).welcome_sms.status,'submitted');assert.equal(calls.length,1);
  await call({action:'update',id:'lead1',name:'Changed'});assert.equal(calls.length,1);
});
