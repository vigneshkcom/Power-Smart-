const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
  const html=fs.readFileSync(require.resolve('../tools/pipeline.html'),'utf8');
  const code=html.slice(html.indexOf('  function reminderDate('),html.indexOf("  $('lm-reminder-state').addEventListener"));
  const nodes={},requests=[],ctx={
    $:id=>nodes[id]||=( {} ),esc:String,toast(){},
    currentId:'new',leads:[{id:'new',stage:'new_lead'},{id:'quoted',stage:'quote_sent'},{id:'other',stage:'follow_up'}],
    reminderApi:id=>new Promise(resolve=>requests.push({id,resolve})),Date
  };
  vm.createContext(ctx);vm.runInContext(code,ctx);
  return {ctx,nodes,requests};
}
const sent={available:true,enabled:true,history:[],reminders_sent:0,sms_sent:0,email_sent:0};
test('new leads do not display or request the reminder panel',()=>{
  const f=fixture();f.ctx.loadReminders('new');
  assert.equal(f.nodes['lm-reminders'].hidden,true);assert.equal(f.requests.length,0);
});
test('Quote Sent stage alone does not display the panel before a sent quote is confirmed',async()=>{
  const f=fixture();f.ctx.currentId='quoted';f.ctx.loadReminders('quoted');
  assert.equal(f.nodes['lm-reminders'].hidden,true);
  f.requests[0].resolve({available:false});await new Promise(setImmediate);
  assert.equal(f.nodes['lm-reminders'].hidden,true);
});
test('sent quotes show the compact summary and reset expanded history when switching leads',async()=>{
  const f=fixture();f.ctx.currentId='quoted';f.ctx.loadReminders('quoted');
  f.requests[0].resolve(sent);await new Promise(setImmediate);
  assert.equal(f.nodes['lm-reminders'].hidden,false);
  assert.match(f.nodes['lm-reminder-summary'].innerHTML,/Next follow-up/);
  f.nodes['lm-reminder-details'].open=true;
  f.ctx.currentId='new';f.ctx.loadReminders('new');
  assert.equal(f.nodes['lm-reminders'].hidden,true);assert.equal(f.nodes['lm-reminder-details'].open,false);
});
test('a late quote response cannot show reminders on another lead',async()=>{
  const f=fixture();f.ctx.currentId='quoted';f.ctx.loadReminders('quoted');
  f.ctx.currentId='new';f.ctx.loadReminders('new');
  f.requests[0].resolve(sent);await new Promise(setImmediate);
  assert.equal(f.nodes['lm-reminders'].hidden,true);
});
