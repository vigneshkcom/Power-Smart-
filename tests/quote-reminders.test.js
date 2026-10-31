const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const leadId='10000000-0000-4000-8000-000000000001',quoteId='20000000-0000-4000-8000-000000000001';
function fixture(options={}) {
  const now=new Date(), sent=new Date(now-86400000).toISOString();
  const db={
    leads:[{id:leadId,name:'Test Customer',phone:'0412345678',email:'test@example.test',stage:'quote_sent',quote_ref:'7011',agent:'Sunny'}],
    sent_emails:[{id:quoteId,lead_id:leadId,kind:'quote',status:'sent',quote_ref:'7011',created_at:sent,body_text:'Quote',to_email:'test@example.test'}],
    quote_reminder_settings:[{lead_id:leadId,quote_id:quoteId,enabled:true,unsubscribed:false,unsubscribe_token:'30000000-0000-4000-8000-000000000001',reminder_count:0,next_at:new Date(now-10000).toISOString(),reply_baseline:sent}],
    quote_reminder_runs:[],sms_messages:[],payment_requests:[],quote_reminder_worker:[{id:true,secret:'test-secret',active:true}]
  },writes=[],sms=[],emails=[],logs=[];
  function matches(row,params){return [...params].every(([k,v])=>{
    if(['select','order','limit'].includes(k))return true;
    if(k==='or')return ['sms_status','email_status'].some(ch=>['pending','sending','unknown'].includes(row[ch]));
    if(v.startsWith('eq.'))return String(row[k])===v.slice(3);
    if(v==='is.null')return row[k]==null;
    if(v.startsWith('in.'))return v.slice(4,-1).split(',').includes(row[k]);
    if(v.startsWith('gt.'))return row[k]>v.slice(3);
    if(v.startsWith('lt.'))return typeof row[k]==='number'?row[k]<Number(v.slice(3)):row[k]<v.slice(3);
    if(v.startsWith('lte.'))return row[k]<=v.slice(4);
    return true;
  });}
  const SB={async sb(query,opt={}){
    if(query==='rpc/claim_quote_reminder'){
      const s=db.quote_reminder_settings[0];if(!s.enabled || s.reminder_count>=3 || Date.parse(s.next_at)>Date.now())return [];
      s.reminder_count++;s.next_at=new Date(Date.now()+3*86400000).toISOString();
      const r={id:'40000000-0000-4000-8000-000000000001',lead_id:leadId,quote_id:quoteId,sequence:s.reminder_count,created_at:new Date().toISOString(),sms_status:'pending',email_status:'pending'};
      db.quote_reminder_runs.push(r);return [{...r}];
    }
    const [table,qs='']=query.split('?'),params=new URLSearchParams(qs),rows=(db[table]||[]).filter(r=>matches(r,params));
    if(opt.method){writes.push({query,...opt});if(opt.method==='PATCH'){rows.forEach(r=>Object.assign(r,opt.body));return rows.map(r=>({...r}));}if(opt.method==='POST'){const row=table==='quote_reminder_runs'?{id:'50000000-0000-4000-8000-00000000000'+((db[table]||[]).length+1),created_at:new Date().toISOString(),sms_status:'pending',email_status:'pending',...opt.body}:{...opt.body};(db[table]||=[]).push(row);return [{...row}];}}
    let sorted=rows.slice();if(params.get('order')?.includes('created_at.desc'))sorted.sort((a,b)=>b.created_at.localeCompare(a.created_at));
    return sorted.slice(0,Number(params.get('limit')||1000)).map(r=>({...r}));
  }};
  const mocks={
    './_supabase':SB,'./_sms-outbound':{cleanPhone:v=>String(v).replace(/^0/,'+61'),async sendLeadSms(data){sms.push(data);if(options.smsFails)throw Error('Uncertain gateway submission');if(options.pauseAfterSms)db.quote_reminder_settings[0].enabled=false;return {status:'submitted'};}},
    './_quote-payments':{async quotePayments(){return db.payment_requests;}},'./_maillog':{async logEmail(row){logs.push(row);return true;}},
    './_senders':require('../api/_senders'),resend:{Resend:class{constructor(){this.emails={send:async(message,key)=>{emails.push({message,key});return options.emailFails?{error:{message:'Timeout'}}:{data:{id:'email1'}};}};}}}
  };
  const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api/_quote-reminders.js'),'utf8'),{module,require:k=>mocks[k]||require(k),console:{error(){}},Buffer,Intl,Date,process:{env:{RESEND_API_KEY:'test',SMSGATE_USERNAME:'test',SMSGATE_PASSWORD:'test'}}});
  const R=module.exports,c=()=>({lead:db.leads[0],s:db.quote_reminder_settings[0],q:db.sent_emails[0]});
  return {R,db,writes,sms,emails,logs,c,SB};
}
async function response(fn,req){let code=200,data;await fn(req,{setHeader(){},status(v){code=v;return this;},json(v){data=v;return this;},send(v){data=v;return this;}});return {code,data};}
test('reminders run only on Queensland weekdays between 9am and 5pm',()=>{
  const {R}=fixture();assert.equal(R.businessHours(new Date('2026-10-29T00:00:00Z')),true);
  for(const time of ['2026-10-29T07:00:00Z','2026-10-28T22:59:00Z','2026-10-31T00:00:00Z'])assert.equal(R.businessHours(new Date(time)),false);
  assert.equal(R.nextWindow('2026-10-31T02:00:00Z'),'2026-11-01T23:00:00.000Z');
});
test('all three reminders include the exact quote, identity and stop instructions',()=>{
  const {R,c}=fixture();for(let n=1;n<=3;n++){const m=R.messages(c().lead,c().q,n,c().s.unsubscribe_token);assert.match(m.sms,/Sunny from PowerSmart/);assert(m.sms.includes(quoteId));assert.match(m.sms,/STOP/);assert.match(m.email,/Stop automatic quote reminders:/);assert(m.email.includes(c().s.unsubscribe_token));}
});
test('expiry uses the date printed on the quote',()=>{
  const {R}=fixture();assert.equal(R.expiresAt({created_at:'2026-10-28T00:00:00Z',body_text:'Valid until: 26 November 2026'}),Date.parse('2026-11-26T13:59:59Z'));
});
test('only the exact current, unpaid Quote Sent customer is eligible',async()=>{
  const f=fixture();assert.equal(await f.R.eligibility(f.c()),null);
  for(const stage of ['new_lead','quote_accepted','scheduled','won','follow_up']){f.db.leads[0].stage=stage;assert.match(await f.R.eligibility(f.c()),/Only customers/);}
  f.db.leads[0].stage='quote_sent';f.db.leads[0].quote_ref='7012';assert.match(await f.R.eligibility(f.c()),/replaced/);
});
test('an accepted customer without reminder enrollment is correctly labelled inactive',async()=>{
  const f=fixture();f.db.leads[0].stage='quote_accepted';f.db.quote_reminder_settings=[];
  const s=await f.R.summary(leadId);assert.equal(s.next_at,null);assert.match(s.reason,/Only customers in Quote Sent/);
});
test('reminder controls are unavailable without a successfully sent current quote',async()=>{
  for(const change of [
    f=>{f.db.leads[0].stage='new_lead';},
    f=>{f.db.quote_reminder_settings=[];},
    f=>{f.db.sent_emails=[];},
    f=>{f.db.sent_emails[0].status='failed';},
    f=>{f.db.sent_emails[0].kind='email';},
    f=>{f.db.sent_emails[0].lead_id='another-customer';},
    f=>{f.db.leads[0].quote_ref='7012';}
  ]){
    const f=fixture();change(f);
    const s=await f.R.summary(leadId);
    assert.equal(s.available,false);assert.equal(s.enabled,false);assert.equal(s.next_at,null);
    for(const enabled of [true,false])await assert.rejects(()=>f.R.toggle(leadId,enabled,'Sunny'),/Send a quote/);
    assert.equal(f.writes.length+f.sms.length+f.emails.length,0);
  }
});
test('a sent current quote exposes controls, including when paused for review',async()=>{
  const f=fixture();let s=await f.R.summary(leadId);
  assert.equal(s.available,true);assert.equal(s.enabled,true);
  f.db.quote_reminder_settings[0].enabled=false;
  s=await f.R.summary(leadId);assert.equal(s.available,true);assert.equal(s.enabled,false);
});
test('paid, expired, opted out, replied and paused customers cannot be sent reminders',async()=>{
  const f=fixture();f.db.payment_requests.push({lead_id:leadId,quote_ref:'7011',status:'paid',amount_paid_cents:3500});assert.match(await f.R.eligibility(f.c()),/Payment received/);f.db.payment_requests=[];
  f.db.sent_emails[0].body_text='Valid until: 1 January 2020';assert.match(await f.R.eligibility(f.c()),/expired/);f.db.sent_emails[0].body_text='';
  f.db.sms_messages.push({phone_number:'+61412345678',status:'optout',created_at:new Date().toISOString(),direction:'inbound'});assert.match(await f.R.eligibility(f.c()),/opted out/);
  f.db.sms_messages[0].status='received';assert.match(await f.R.eligibility(f.c()),/replied/);f.db.sms_messages=[];
  f.db.quote_reminder_settings[0].enabled=false;assert.match(await f.R.eligibility(f.c()),/Paused/);
});
test('both valid destinations are required and an email address change blocks an old quote',async()=>{
  const f=fixture();f.db.leads[0].phone='123';assert.match(await f.R.eligibility(f.c()),/mobile/);f.db.leads[0].phone='0412345678';
  f.db.leads[0].email='other@example.test';assert.match(await f.R.eligibility(f.c()),/Email changed/);
});
test('a reminder submits both channels once and stores the actual messages and provider reference',async()=>{
  const f=fixture(),r=(await f.SB.sb('rpc/claim_quote_reminder',{method:'POST'}))[0];
  await f.R.processRun(r,f.c());await f.R.processRun(r,f.c());
  assert.equal(f.sms.length,1);assert.equal(f.emails.length,1);const saved=f.db.quote_reminder_runs[0];
  assert.equal(saved.sms_status,'submitted');assert.equal(saved.email_status,'submitted');assert.equal(saved.email_provider_id,'email1');assert(saved.sms_body.includes(quoteId));assert(saved.finished_at);assert.equal(f.logs.length,1);
  assert.match(f.emails[0].message.html, /<a href="https:\/\/smokealarms.powersmartco.com.au\/quote\?token=/);
  assert.match(f.emails[0].message.html, /<img src="https:\/\/smokealarms.powersmartco.com.au\/assets/);
});
test('a quote replacement between claim and preparation never sends the old quote',async()=>{
  const f=fixture(),r=(await f.SB.sb('rpc/claim_quote_reminder',{method:'POST'}))[0];f.db.sent_emails[0].id='20000000-0000-4000-8000-000000000002';
  await f.R.processRun(r,f.c());assert.equal(f.sms.length+f.emails.length,0);assert.equal(f.db.quote_reminder_runs[0].sms_status,'skipped');
});
test('pausing between channels suppresses the second message',async()=>{
  const f=fixture({pauseAfterSms:true}),r=(await f.SB.sb('rpc/claim_quote_reminder',{method:'POST'}))[0];await f.R.processRun(r,f.c());assert.equal(f.sms.length,1);assert.equal(f.emails.length,0);assert.equal(f.db.quote_reminder_runs[0].email_status,'skipped');
});
test('uncertain provider results pause the sequence rather than automatically retrying',async()=>{
  const f=fixture({emailFails:true}),r=(await f.SB.sb('rpc/claim_quote_reminder',{method:'POST'}))[0];await f.R.processRun(r,f.c());
  assert.equal(f.db.quote_reminder_settings[0].enabled,false);assert.equal(f.db.quote_reminder_runs[0].email_status,'unknown');
  await assert.rejects(()=>f.R.toggle(leadId,true,'Sunny'),/uncertain/);
});
test('staff pause clears the next date and resume waits three days without resetting the limit',async()=>{
  const f=fixture();await f.R.toggle(leadId,false,'Sunny');assert.equal(f.db.quote_reminder_settings[0].next_at,null);
  f.db.quote_reminder_settings[0].reminder_count=2;await f.R.toggle(leadId,true,'Sunny');assert.equal(f.db.quote_reminder_settings[0].reminder_count,2);assert(Date.parse(f.db.quote_reminder_settings[0].next_at)>=Date.now()+3*86400000-1000);
  f.db.quote_reminder_settings[0].reminder_count=3;await assert.rejects(()=>f.R.toggle(leadId,true,'Sunny'),/Three reminders/);
});
test('worker dry run and outside-hours checks never submit messages or mutate settings',async()=>{
  const f=fixture();await f.R.work({dryRun:true,now:new Date('2030-01-01T00:00:00Z')});await f.R.work({now:new Date('2026-10-31T00:00:00Z')});assert.equal(f.sms.length+f.emails.length+f.writes.length,0);
});
test('worker requires its private secret and staff routes require portal authentication',async()=>{
  const f=fixture();assert.equal((await response(f.R.handler,{method:'POST',headers:{'x-portal-key':'2026'},body:{action:'run'}})).code,401);
  assert.equal((await response(f.R.handler,{method:'GET',headers:{},query:{lead_id:leadId}})).code,401);
});
test('email scanners cannot unsubscribe with GET; customer confirmation stops both channels permanently',async()=>{
  const f=fixture(),query={token:f.c().s.unsubscribe_token};const viewed=await response(f.R.unsubscribe,{method:'GET',query});assert.equal(viewed.code,200);assert.match(viewed.data,/Stop reminders/);assert.equal(f.writes.length,0);
  await response(f.R.unsubscribe,{method:'POST',query});assert.equal(f.db.quote_reminder_settings[0].unsubscribed,true);assert.equal(f.db.quote_reminder_settings[0].enabled,false);
  await assert.rejects(()=>f.R.toggle(leadId,true,'Sunny'),/Customer stopped/);
});
test('Send reminder now submits SMS and email immediately, even when not yet due or paused, and uses up one follow-up',async()=>{
  const f=fixture();f.db.quote_reminder_settings[0].next_at=new Date(Date.now()+2*86400000).toISOString();f.db.quote_reminder_settings[0].enabled=false;f.db.quote_reminder_settings[0].reason='Paused by staff';
  const d=await f.R.sendNow(leadId,'Mani');
  assert.equal(f.sms.length,1);assert.equal(f.emails.length,1);
  assert.equal(f.db.quote_reminder_settings[0].reminder_count,1);assert.equal(f.db.quote_reminder_runs[0].sequence,1);
  assert.equal(f.db.quote_reminder_settings[0].enabled,false,'a staff send does not switch automatic reminders back on');
  assert.equal(d.manual.review_required,false);
  const again=await f.R.sendNow(leadId,'Mani');assert.equal(f.db.quote_reminder_runs[1].sequence,2);assert.equal(f.sms.length,2);assert(again);
});
test('Send reminder now stops at three follow-ups and never overrides opt-out, payment or a replaced quote',async()=>{
  let f=fixture();f.db.quote_reminder_settings[0].reminder_count=3;
  await assert.rejects(()=>f.R.sendNow(leadId,'Mani'),/Three follow-ups/);assert.equal(f.sms.length,0);
  f=fixture();f.db.leads[0].quote_ref='9999';
  await assert.rejects(()=>f.R.sendNow(leadId,'Mani'));assert.equal(f.sms.length+f.emails.length,0);
  f=fixture();f.db.payment_requests.push({lead_id:leadId,quote_ref:'7011',status:'paid',amount_paid_cents:3500});
  await assert.rejects(()=>f.R.sendNow(leadId,'Mani'),/Payment received/);assert.equal(f.sms.length,0);
  f=fixture();f.db.sms_messages.push({phone_number:'+61412345678',status:'optout',direction:'inbound',created_at:new Date().toISOString()});
  await assert.rejects(()=>f.R.sendNow(leadId,'Mani'),/opted out/);assert.equal(f.sms.length,0);
});
