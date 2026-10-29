const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');

function fixture() {
  const rows = [
    {id:'newer',name:'Newer lead',stage:'new_lead',pipeline_order_at:'2026-10-28',updated_at:'2026-10-28'},
    {id:'older',name:'Older lead',stage:'new_lead',pipeline_order_at:'2026-10-27',updated_at:'2026-10-27'}
  ];
  const db = {configured:()=>true,async sb(query, options) {
    if (query.startsWith('leads?select=')) {
      const order = new URLSearchParams(query.split('?')[1]).get('order');
      const field = order.split('.')[0];
      return rows.slice().sort((a,b)=>b[field].localeCompare(a[field])).map(r=>({...r}));
    }
    if (query.startsWith('leads?id=') && options?.method === 'PATCH') {
      const row = rows.find(r=>query.endsWith(r.id));
      Object.assign(row,options.body,{updated_at:'2026-10-29'});
      return [{...row}];
    }
    if (query==='lead_comments') return [options.body];
    return [];
  }};
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../api/pipeline'),'utf8'),{
    module,require:k=>k==='./_supabase'?db:k==='./_welcome-sms'?{welcomeLead:async()=>{throw Error('Edit must not send welcome SMS');}}:require(k),Date
  });
  async function call(body) {
    const res={status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
    await module.exports({method:body?'POST':'GET',headers:{'x-portal-key':'2026'},body},res);
    assert.equal(res.code,200);return res.data;
  }
  return {call};
}

test('editing an older new lead and adding activity preserves its position after reload',async()=>{
  const {call}=fixture();
  const before=(await call()).leads.map(r=>r.id);
  await call({action:'update',id:'older',name:'Edited lead'});
  await call({action:'comment',lead_id:'older',kind:'sms',body:'Previously sent message'});
  const after=await call();
  assert.deepEqual(after.leads.map(r=>r.id),before);
  assert.equal(after.leads[1].updated_at,'2026-10-29');
  assert.equal(after.leads[1].name,'Edited lead');
});

test('Not interested accepts a move and remains available after reload',async()=>{
  const {call}=fixture();
  await call({action:'move',id:'older',stage:'not_interested'});
  const result=await call();
  assert.ok(result.stages.includes('not_interested'));
  assert.equal(result.leads.find(r=>r.id==='older').stage,'not_interested');
});
