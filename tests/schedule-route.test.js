const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require.resolve('../tools/schedule.html'), 'utf8');
function fixture(compute) {
  const elements = {};
  const $ = id => elements[id] ||= {innerHTML:'', classList:{add(){},remove(){}}};
  const calls = [], marker = {}, polyline = {setMap(map){this.map=map;}};
  const route = {distanceMeters:12500,durationMillis:3900000,viewport:{},legs:[{durationMillis:600000,steps:[{instructions:'Turn left <unsafe>',distanceMeters:250}]}],
    createWaypointAdvancedMarkers:async()=>[marker], createPolylines:()=>[polyline]};
  const google = {maps:{Map:class {fitBounds(){}},importLibrary:async()=>({Route:{computeRoutes:async request=>{calls.push(request);return compute ? compute(route) : {routes:[route]};}}})}};
  const context = {google,window:{google},$,state:{techs:[],jobs:[3,1,2].map(n=>({electrician_id:'tech',scheduled_start:`2026-11-05T0${n}:00:00Z`,address:'Stop '+n,job_no:n}))},
    mapsQuery:j=>j.address,addressLine:j=>j.address,timeText:()=>'',esc:s=>String(s).replaceAll('<','&lt;'),toast(){}};
  vm.createContext(context);
  vm.runInContext(html.slice(html.indexOf('  var mapsLoading,'), html.indexOf('  /* ---------- job modal')), context);
  return {context,elements,calls,marker,polyline};
}
const settle = () => new Promise(resolve=>setImmediate(resolve));
test('route uses enabled Routes API in schedule order and displays directions, pins and totals', async()=>{
  const f=fixture(); f.context.openRoute('tech'); await settle();
  assert.equal(f.calls[0].origin,'Stop 1'); assert.equal(f.calls[0].destination,'Stop 3');
  assert.equal(f.calls[0].intermediates[0].location,'Stop 2');
  assert.equal(f.calls[0].travelMode,'DRIVING'); assert.equal(f.calls[0].optimizeWaypointOrder,false);
  assert.match(f.elements['route-panel'].innerHTML,/A → B<\/strong> · 10 mins/);
  assert.doesNotMatch(f.elements['route-panel'].innerHTML,/Turn left|<ol>/);
  assert.match(f.elements['route-sum'].textContent,/12.5 km.*1 hr 5 mins/);
  assert.ok(f.marker.map); assert.ok(f.polyline.map);
  f.context.closeRoute(); assert.equal(f.marker.map,null); assert.equal(f.polyline.map,null);
});
test('closing popup ignores a late route response', async()=>{
  let finish; const f=fixture(route=>new Promise(resolve=>{finish=()=>resolve({routes:[route]});}));
  f.context.openRoute('tech'); await settle(); f.context.closeRoute(); finish(); await settle();
  assert.equal(f.elements['route-sum'].hidden,true); assert.equal(f.marker.map,undefined);
});
test('no route and API errors provide the Google Maps fallback', async()=>{
  for(const compute of [()=>({routes:[]}),()=>{throw new Error('Denied');}]){
    const f=fixture(compute); f.context.openRoute('tech'); await settle();
    assert.match(f.elements['route-panel'].innerHTML,/Open in Google Maps/);
    assert.equal(f.elements['route-sum'].hidden,true);
  }
});
