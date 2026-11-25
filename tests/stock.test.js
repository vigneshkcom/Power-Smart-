const test = require('node:test'), assert = require('node:assert/strict');
const { buildSummary, trackingStart } = require('../api/_stock');
const counts = (j) => ({ hardwired: j.h || 0, battery: j.b || 0, controllers: j.c || 0, untyped: j.u || 0 });
test('on hand = given - installed since first stock day (Brisbane)', () => {
  const techs = [{ id: 't1', name: 'Dillon', code: '1' }, { id: 't2', name: 'Other' }];
  const moves = [
    { electrician_id: 't1', product: 'battery', qty: 20, created_at: '2026-11-10T22:00:00Z' },   // 8am 11 Nov Brisbane
    { electrician_id: 't1', product: 'controller', qty: 5, created_at: '2026-11-10T22:00:00Z' },
    { electrician_id: 't1', product: 'battery', qty: -2, created_at: '2026-11-12T00:00:00Z' },
  ];
  const jobs = [
    { electrician_id: 't1', completed_at: '2026-11-11T03:00:00Z', b: 4, c: 1 },
    { electrician_id: 't1', completed_at: '2026-11-10T01:00:00Z', b: 9 },                          // before tracking: ignored
    { electrician_id: 't1', completed_at: '2026-11-11T05:00:00Z', b: 1, u: 2 },
  ];
  const r = buildSummary(techs, moves, jobs, counts);
  const d = r.find((x) => x.electrician_id === 't1');
  assert.deepEqual(d.on_hand, { hardwired: 0, battery: 13, controller: 4 });
  assert.equal(d.unclassified, 2);
  assert.equal(trackingStart('2026-11-10T22:00:00Z'), '2026-11-10T14:00:00.000Z');
});
test('Excel includes full running history, gross stock breakdown and warranty usage for selected electrician',async()=>{
  const f=fixture(),sheets=[];
  class Workbook{
    constructor(){this.xlsx={writeBuffer:async()=>Buffer.from('xlsx')};}
    addWorksheet(name){const sheet={name,tables:[],mergeCells(){},getCell(){return {};},getRow(){return {};},addTable(t){this.tables.push(t);}};sheets.push(sheet);return sheet;}
  }
  const m={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api/_stock.js'),'utf8'),{module:m,Buffer,require:k=>k==='exceljs'?{Workbook}:{sb:async()=>[]}});
  const data={electricians:f.summaries,ledger:f.ledger,jobs:f.jobs,all:f.moves,names:{t1:'Dillon',t2:'Other'},faulty:[]};
  await m.exports.workbook(data,fullCounts,'t1');
  const history=sheets.find(s=>s.name==='Full stock history').tables[0];
  assert.equal(history.rows.length,f.ledger.filter(e=>e.electrician_id==='t1').length);
  assert(history.rows.every(r=>r[1]==='Dillon'));
  const installed=sheets.find(s=>s.name==='Installed').tables[0];
  assert.equal(installed.rows.find(r=>r[1]==='J1002')[6],2);
  const summary=sheets.find(s=>s.name==='Stock summary').tables[0];
  assert.equal(summary.columns.length,summary.rows[0].length);
  assert(summary.columns.some(c=>c.name==='Battery smoke alarm returned'));
  assert.equal(history.columns.length,history.rows[0].length);
});
const {buildLedger}=require('../api/_stock');
const History=require('../assets/stock-history');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const fullCounts=j=>({...counts(j),warranty_hardwired:j.wh||0,warranty_battery:j.wb||0});
function fixture(){
  const techs=[{id:'t1',name:'Dillon',code:'89128'},{id:'t2',name:'Other',code:'1011'}];
  const moves=[
    {id:'m1',electrician_id:'t1',product:'battery',qty:20,kind:'issue',created_at:'2026-11-10T00:00:00Z',created_by:'Sunny'},
    {id:'m2',electrician_id:'t1',product:'battery',qty:-2,kind:'return',created_at:'2026-11-12T00:00:00Z'},
    {id:'m3',electrician_id:'t1',product:'battery',qty:3,kind:'adjust',created_at:'2026-11-13T00:00:00Z'},
    {id:'m4',electrician_id:'t1',product:'battery',qty:-1,kind:'return',condition:'faulty',created_at:'2026-11-14T00:00:00Z'},
    {id:'m5',electrician_id:'t2',product:'controller',qty:5,kind:'issue',created_at:'2026-11-10T00:00:00Z'}
  ];
  const jobs=[
    {id:'j0',electrician_id:'t1',completed_at:'2026-11-08T00:00:00Z',b:9},
    {id:'j1',job_no:1001,electrician_id:'t1',completed_at:'2026-11-11T00:00:00Z',b:4,customer_name:'Alice',address:'Main St',suburb:'Brisbane'},
    {id:'j2',job_no:1002,electrician_id:'t1',completed_at:'2026-11-12T02:00:00Z',work_type:'warranty',wb:2},
    {id:'j3',job_no:1003,electrician_id:'t1',completed_at:'2026-11-13T01:00:00Z',u:1},
    {id:'j4',job_no:1004,electrician_id:'t2',completed_at:'2026-11-11T00:00:00Z',c:1}
  ];
  const summaries=buildSummary(techs,moves,jobs,fullCounts);
  return {moves,jobs,summaries,ledger:buildLedger(summaries,moves,jobs,fullCounts)};
}
test('full ledger reconciles issues, returns, signed corrections, job usage and faulty returns per electrician',()=>{
  const f=fixture(),t=f.summaries.find(t=>t.electrician_id==='t1');
  assert.equal(t.issued.battery,20);assert.equal(t.returned.battery,2);assert.equal(t.adjusted.battery,3);
  assert.equal(t.on_hand.battery,15);assert.equal(t.faulty_held.battery,1);
  assert(!f.ledger.some(e=>e.job_id==='j0'));
  for(const t of f.summaries){
    const last=f.ledger.filter(e=>e.electrician_id===t.electrician_id).at(-1);
    assert.deepEqual(last.balance,t.on_hand);assert.deepEqual(last.faulty_balance,t.faulty_held);
  }
  const used=f.ledger.find(e=>e.job_no===1001);
  assert.equal(used.balance.battery,16);assert.equal(used.customer,'Alice');
  assert.equal(f.ledger.find(e=>e.job_no===1002).faulty_delta.battery,2);
  assert.equal(f.ledger.find(e=>e.job_no===1003).unclassified,1);
});
test('history filters do not reset lifetime balances and handle Queensland dates, jobs and product types',()=>{
  const f=fixture();
  const rows=History.filter(f.ledger,{tech:'t1',kind:'warranty',product:'battery',from:'2026-11-12',to:'2026-11-12',search:'J1002'});
  assert.equal(rows.length,1);assert.equal(rows[0].balance.battery,12);
  assert.equal(History.filter(f.ledger,{search:'Alice'}).length,1);
  assert.equal(History.filter(f.ledger,{tech:'t2',product:'battery'}).length,0);
  assert.equal(History.filter([{...f.ledger[0],at:'2026-11-10T14:05:00Z'}],{from:'2026-11-11',to:'2026-11-11'}).length,1);
});
test('summary cards distinguish gross given from returned and corrections',()=>{
  const t=History.totals(fixture().summaries);
  assert.equal(t.issued.battery,20);assert.equal(t.returned.battery,2);assert.equal(t.on_hand.battery,15);
  assert.equal(t.on_hand.controller,4);assert.equal(t.warranty_used.battery,2);
});
test('CSV exports every filtered entry with job references and formula-safe notes',()=>{
  const f=fixture();f.ledger[0].note='=HYPERLINK("bad")';
  const csv=History.csv(f.ledger);
  assert(csv.startsWith('\uFEFF'));assert(csv.includes('J1001'));assert(csv.includes("'=HYPERLINK"));
  assert.equal(csv.split('\r\n').length,f.ledger.length+1);
});
test('database pagination continues when PostgREST returns a shorter capped page',async()=>{
  const rows=Array.from({length:5},(_,i)=>({id:i})),offsets=[];
  const m={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api/_stock.js'),'utf8'),{module:m,require:k=>{
    assert.equal(k,'./_supabase');
    return {sb:async q=>{const offset=Number(new URLSearchParams(q.split('?')[1]).get('offset'));offsets.push(offset);return rows.slice(offset,offset+2);}};
  }});
  assert.equal((await m.exports.allRows('stock_movements?select=*&order=id.asc')).length,5);
  assert.deepEqual(offsets,[0,2,4,5]);
});
test('negative and unclassified stock remains visible rather than being clamped',()=>{
  const f=fixture(),m={...f.moves[0],qty:1};
  const summaries=buildSummary([{id:'t1',name:'Dillon'}],[m],f.jobs,fullCounts),ledger=buildLedger(summaries,[m],f.jobs,fullCounts);
  assert.equal(summaries[0].on_hand.battery,-5);
  assert.equal(ledger.at(-1).balance.battery,-5);
});
test('history UI renders, filters, pages and escapes customer content',()=>{
  const ids=['sh-tech','sh-kind','sh-product','sh-from','sh-to','sh-search','sh-cards','sh-reconcile','sh-warning','sh-scope','sh-count','sh-ledger','sh-page','sh-prev','sh-next','sh-export','sh-reset'];
  const elements=Object.fromEntries(ids.map(id=>[id,{value:'',innerHTML:'',textContent:'',handlers:{},addEventListener(type,fn){this.handlers[type]=fn;},scrollIntoView(){}}]));
  const context={document:{getElementById:id=>elements[id]},window:{},console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/stock-history.js'),'utf8'),context);
  const ui=context.window.PSStockHistory.create(),f=fixture();
  f.ledger.find(e=>e.job_no===1001).customer='<img src=x onerror=alert(1)>';
  const many=Array.from({length:85},(_,i)=>({...f.ledger.find(e=>e.job_no===1001),id:'j'+i,job_no:i+1000}));
  ui.setData({electricians:f.summaries,ledger:many});
  assert.equal((elements['sh-ledger'].innerHTML.match(/<tr>/g)||[]).length,41);
  assert(elements['sh-ledger'].innerHTML.includes('&lt;img'));assert(!elements['sh-ledger'].innerHTML.includes('<img'));
  assert.equal(elements['sh-next'].disabled,false);
  elements['sh-next'].handlers.click();assert.match(elements['sh-page'].textContent,/41–80/);
  elements['sh-search'].value='J1001';elements['sh-search'].handlers.input();
  assert.match(elements['sh-page'].textContent,/1–1 of 1/);
  assert.equal(elements['sh-next'].disabled,true);
  ui.select('t2');assert.equal(ui.selected(),'t2');assert.match(elements['sh-ledger'].innerHTML,/No stock activity/);
});

