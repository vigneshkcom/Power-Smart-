const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const inspection = require('../assets/inspection-care');
function load(db = {sb:async()=>[]}) {
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api/_care-notice.js'),'utf8'),{
    module, require:k=>({
      'pdf-lib':{rgb:(...v)=>v},'./_supabase':db,'./_senders':{},'./_quote':require('../api/_quote'),'./_maillog':{logEmail:async()=>{}},'../assets/inspection-care':inspection
    }[k]), Buffer,Date,setTimeout,clearTimeout,console,process:{env:{}}
  });return module.exports;
}
test('inspection email explains optional future installation and excludes existing inspected alarms',()=>{
  const cn=load(),mail=cn.careNoticeEmail({name:'Test',ref:'QA-1',acceptedAt:'2026-11-24T00:00:00Z',version:inspection.VERSION});
  for(const body of [mail.text,mail.html]){
    assert.match(body,/If you wish to proceed with our smoke alarm supply and installation/);
    assert.match(body,/An inspection-only visit does not provide warranty or replacement cover for your existing alarms/);
    assert.match(body,/accepting your inspection quote/);
    assert.match(body,/If an alarm supplied and installed by PowerSmart/);
    assert.doesNotMatch(body,/Your alarms are backed for 10 years/);
  }
  assert.match(mail.subject,/If you proceed/);
});
test('installation care wording and previous acknowledged versions are preserved',()=>{
  const cn=load(),args={name:'Test',ref:'QA-1',acceptedAt:'2026-11-24T00:00:00Z'};
  assert.match(cn.careNoticeEmail(args).text,/Your alarms are backed for 10 years/);
  assert.doesNotMatch(cn.careNoticeEmail(args).text,/accepting your inspection quote/);
  assert.match(cn.careNoticeEmail({...args,version:'v1'}).text,/electrician has already wired/);
  assert.match(cn.careNoticeEmail({...args,version:'v2'}).text,/electrician would have already wired/);
});
test('inspection acknowledgement saves conditional tick and version on the customer',async()=>{
  const queries=[],records=[],cn=load({sb:async(q,o={})=>{queries.push(q);if(o.body)records.push(o.body);return [];}});
  await cn.recordAcceptance({lead:{id:'qa',name:'Test'},ref:'QA-1',version:inspection.VERSION,now:new Date('2026-11-24T00:00:00Z')});
  assert.match(decodeURIComponent(queries[0]),/\(v3\) accepted for quote QA-1/);
  assert.match(records[0].body,/\(v3\) accepted for quote QA-1/);
  assert.ok(records[0].body.includes(inspection.TICK));
});
test('inspection-only certificates and archives never get installation care documents',async()=>{
  let lookups=0;const cn=load({sb:async()=>{lookups++;throw Error('should not look up documents');}});
  assert.equal(await cn.careNoticeForJob({job_no:1,lead_id:'qa',work_type:'inspection'}),null);
  assert.equal((await cn.archiveForJob({job_no:1,lead_id:'qa',work_type:'inspection'})).status,'skipped');
  assert.equal(lookups,0);
});
test('completed installation does not archive the earlier optional-inspection acknowledgement as installation care',async()=>{
  const cn=load({sb:async()=>[{body:'Alarm Care Notice and Acknowledgement (v3) accepted for quote QA-1 at x',created_at:'2026-11-24T00:00:00Z'}]});
  const result=await cn.archiveForJob({job_no:1,lead_id:'qa',work_type:'install',inspection_converted_at:'2026-11-24'});
  assert.equal(result.status,'skipped');assert.match(result.reason,/installation care notice will accompany/);
});
test('inspection page and server share the same conditional wording and required version',()=>{
  const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/inspection-care.js'),'utf8'),context);
  assert.equal(context.window.PSInspectionCare.LEAD,inspection.LEAD);
  const html=fs.readFileSync(path.join(__dirname,'../accept.html'),'utf8');
  assert.match(html,/<script src="\/assets\/inspection-care.js"><\/script>/);
  assert.match(html,/noticeTitle"\).textContent = care.HEADLINE/);
  assert.match(html,/careNoticeVersion:mode === "inspect"/);
  for(const m of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)) new Function(m[1]);
});
