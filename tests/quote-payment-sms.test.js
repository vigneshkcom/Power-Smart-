const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function load(name,mocks,globals={}){
  const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api',name),'utf8'),{
    module,require:key=>key in mocks ? mocks[key] : require(key),console:{error(){}},URL,URLSearchParams,Buffer,AbortController,setTimeout,clearTimeout,process:{env:{SMSGATE_USERNAME:'test',SMSGATE_PASSWORD:'test',RESEND_API_KEY:'test'}},...globals,
  },{filename:name});return module.exports;
}
function smsFixture({reject=false,timeout=false,optout=false,noteFailure=false}={}){
  const rows=[],notes=[],calls=[];
  const SB={async sb(query,opts={}){
    if(query.includes('status=in.'))return optout ? [{status:'optout'}] : [];
    if(query.startsWith('lead_comments')){
      if(opts.method==='POST'){if(noteFailure)throw Error('Note unavailable');notes.push(opts.body);return [];}
      return notes.filter(n=>query.includes(encodeURIComponent(n.body)));
    }
    const id=(query.match(/id=eq\.([^&]+)/)||[])[1];
    if(opts.method==='POST'){
      if(rows.some(r=>r.id===opts.body.id)){const e=Error('Duplicate');e.status=409;throw e;}
      rows.push({...opts.body});return [opts.body];
    }
    if(opts.method==='PATCH'){const matches=rows.filter(r=>r.id===id && (!query.includes('status=eq.failed') || r.status==='failed'));matches.forEach(r=>Object.assign(r,opts.body));return matches;}
    return rows.filter(r=>r.id===id);
  }};
  const Sms=load('_sms-outbound.js',{'./_supabase':SB},{fetch:async(url,opts)=>{calls.push(JSON.parse(opts.body));if(timeout)throw Error('Timeout');return {ok:!reject,status:reject?400:202,json:async()=>reject?{message:'Invalid device'}:{id:'gateway-id'}};}});
  const args={lead:{id:'lead1',phone:'0451 898 761'},message:'Hi Test, view your quote here: https://example.test/quote',key:'quote-email-id',author:'Sunny'};
  return {Sms,args,rows,notes,calls};
}
test('SMS uses PowerSmart gateway, normalizes mobile, appears in inbox and logs full text',async()=>{
  const f=smsFixture(),r=await f.Sms.sendLeadSms(f.args);assert.equal(r.status,'submitted');assert.equal(r.phone,'+61451898761');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].phoneNumbers[0],'+61451898761');assert.equal(f.rows[0].status,'sent');assert.equal(f.calls[0].id,f.rows[0].id);
  assert.equal(f.notes[0].kind,'sms');assert(f.notes[0].body.endsWith(f.args.message));
});
test('duplicate and simultaneous SMS requests submit once',async()=>{
  const f=smsFixture();await Promise.allSettled([f.Sms.sendLeadSms(f.args),f.Sms.sendLeadSms(f.args)]);
  const r=await f.Sms.sendLeadSms(f.args);assert.equal(r.duplicate,true);assert.equal(f.calls.length,1);assert.equal(f.notes.length,1);
});
test('opted-out and invalid mobile numbers never reach the SMS gateway',async()=>{
  const f=smsFixture({optout:true});await assert.rejects(()=>f.Sms.sendLeadSms(f.args),/opted out/);assert.equal(f.calls.length,0);
  const g=smsFixture();await assert.rejects(()=>g.Sms.sendLeadSms({...g.args,lead:{id:'lead1',phone:'0721417792'}}),/valid customer mobile/);assert.equal(g.calls.length,0);
});
test('ambiguous submissions are recorded as unknown and not automatically retried',async()=>{
  const f=smsFixture({timeout:true});await assert.rejects(()=>f.Sms.sendLeadSms(f.args),/could not be confirmed/);assert.equal(f.rows[0].status,'unknown');
  await assert.rejects(()=>f.Sms.sendLeadSms(f.args),/uncertain/);assert.equal(f.calls.length,1);
});
test('rejected messages do not get a false success note',async()=>{
  const f=smsFixture({reject:true});await assert.rejects(()=>f.Sms.sendLeadSms(f.args),/rejected/);assert.equal(f.rows[0].status,'failed');assert.equal(f.notes.length,0);
});
test('note failure reports submitted SMS with a warning, without resending',async()=>{
  const f=smsFixture({noteFailure:true});const r=await f.Sms.sendLeadSms(f.args);assert.equal(r.status,'submitted');assert.match(r.warning,/note could not be saved/);
  const second=await f.Sms.sendLeadSms(f.args);assert.equal(second.duplicate,true);assert.equal(f.calls.length,1);
});

function quoteFixture({emailFails=false,smsFails=false,saveFails=false,phone='0400000000'}={}){
  const smsCalls=[],logs=[],emails=[],notes=[],lead={id:'lead1',name:'Test Customer',email:'test@example.test',phone};
  const SB={configured:()=>true,async sb(query,opts={}){
    if(query==='rpc/next_quote_reference')return 7001;
    if(query==='lead_comments'){notes.push(opts.body);return [];}
    if(query.startsWith('leads?')){if(opts.method==='PATCH')Object.assign(lead,opts.body);return [lead];}
    if(query==='leads')return [lead];return [];
  }};
  const Sms={cleanPhone:v=>v||'',async sendLeadSms(args){smsCalls.push(args);if(smsFails)throw Error('Customer opted out');return {status:'submitted'};},async logNote(id,author,body){notes.push({lead_id:id,author,body});}};
  const Q=load('_quote.js',{}),S={resolveSender:()=>({key:'sunny'}),fromHeader:()=> 'PowerSmart <support@powersmartco.com.au>'};
  class Resend {
    constructor(){this.emails={send:async args=>{emails.push(args);return emailFails?{error:{message:'Rejected'}}:{data:{id:'email-id'}};}};}
  }
  const handler=load('send-quote.js',{'./_quote':Q,'./_supabase':SB,'./_senders':S,'./_sms-outbound':Sms,'./_maillog':{async logEmail(row){logs.push(row);return !saveFails;}},resend:{Resend}});
  async function call(headers={'x-portal-key':'2026'}){let status=200,data;await handler({method:'POST',headers,body:{leadId:'lead1',customerName:lead.name,customerEmail:lead.email,agentName:'Sunny',alarmQty:4,controllerQty:0}}, {setHeader(){},status(n){status=n;return this;},json(d){data=d;return this;}});return {status,data};}
  return {call,smsCalls,logs,emails,notes};
}
test('successful quote email triggers a text with the exact saved full quote URL',async()=>{
  const f=quoteFixture(),r=await f.call();assert.equal(r.status,200);assert.equal(r.data.sms.status,'submitted');assert.equal(f.smsCalls.length,1);
  assert(f.smsCalls[0].message.includes('View your quote here: '+r.data.quote_url));assert(f.smsCalls[0].message.includes('quote 7001'));
  assert(r.data.quote_url.endsWith(f.logs[0].id));assert.match(f.logs[0].body_html,/Accept this quote/);assert.equal(f.smsCalls[0].lead.id,'lead1');
});
test('email rejection never triggers quote SMS',async()=>{
  const f=quoteFixture({emailFails:true}),r=await f.call();assert.equal(r.status,502);assert.equal(f.smsCalls.length,0);
});
test('SMS failure is reported independently of a successful email',async()=>{
  const f=quoteFixture({smsFails:true}),r=await f.call();assert.equal(r.status,200);assert.equal(r.data.ok,true);assert.equal(r.data.sms.status,'failed');assert.match(r.data.sms.error,/opted out/);assert.equal(f.emails.length,1);
});
test('a missing saved quote does not result in a broken link SMS',async()=>{
  const f=quoteFixture({saveFails:true}),r=await f.call();assert.equal(r.status,200);assert.equal(r.data.quote_url,null);assert.equal(f.smsCalls.length,0);assert.match(r.data.sms.error,/online copy/);
});
test('unauthenticated quote-email callers cannot trigger SMS',async()=>{
  const f=quoteFixture(),r=await f.call({});assert.equal(r.status,200);assert.equal(r.data.sms.status,'skipped');assert.equal(f.smsCalls.length,0);
});
async function publicCall(handler,token){let status=200,body,headers={};await handler({method:'GET',query:{token}},{setHeader(k,v){headers[k]=v;},status(n){status=n;return this;},send(v){body=v;return this;},end(){return this;}});return {status,body,headers};}
test('public quote viewer requires an unguessable token and serves only successfully saved quotes',async()=>{
  const token='8abe9f5b-2495-4ee3-b521-0364df34db00';let calls=0;
  const handler=load('_view-quote.js',{'./_quote-payments':{async quotePayments(){return [];},renderPaidQuote(q){return q.body_html;}},'./_supabase':{async sb(q){calls++;assert.match(q,/kind=eq.quote&status=eq.sent/);return [{body_html:'<h1>Quote 7001</h1>'}];}}});
  assert.equal((await publicCall(handler,'7001')).status,404);assert.equal(calls,0);
  const r=await publicCall(handler,token);assert.equal(r.status,200);assert.equal(r.body,'<h1>Quote 7001</h1>');assert.equal(r.headers['Cache-Control'],'no-store');assert.match(r.headers['Content-Security-Policy'],/default-src 'none'/);
});
test('short payment link redirects only to a valid Stripe host and does not reopen paid payments',async()=>{
  let row={status:'sent',checkout_url:'https://checkout.stripe.com/c/pay/test'};
  const handler=load('_payment-link.js',{'./_supabase':{async sb(){return [row];}},'./_payments':{checkoutUrl(value){const u=new URL(value);if(u.hostname!=='checkout.stripe.com')throw Error('Bad host');return u.href;}}});
  const token='8abe9f5b-2495-4ee3-b521-0364df34db00';assert.equal((await publicCall(handler,token)).status,302);
  row.status='paid';assert.match((await publicCall(handler,token)).body,/already been received/);
  row.status='expired';assert.equal((await publicCall(handler,token)).status,410);
});
