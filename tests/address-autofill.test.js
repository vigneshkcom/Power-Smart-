const test = require('node:test'), assert = require('node:assert/strict');
const { parseAddress } = require('../assets/address-autofill');
const config = require('../api/_address-config');
const fs=require('node:fs'),vm=require('node:vm');
function component(type, longText, shortText=longText) { return {types:[type],longText,shortText}; }
test('Australian street address separates unit, suburb, state and postcode', () => {
  const a=parseAddress({addressComponents:[component('subpremise','4'),component('street_number','112'),component('route','High Street'),component('locality','Blackstone'),component('administrative_area_level_1','Queensland','QLD'),component('postal_code','4304'),component('country','Australia','AU')]});
  assert.equal(a.street,'4/112 High Street'); assert.equal(a.suburb,'Blackstone'); assert.equal(a.state,'QLD'); assert.equal(a.postcode,'4304'); assert.equal(a.country,'AU');
});
async function pickerFixture() {
  class Element {
    constructor(){ this.style={};this.dataset={};this.value='';this.events={};this.children=[]; }
    append(...elements){this.children.push(...elements);}
    insertBefore(element){this.children.unshift(element);}
    setAttribute(){}
    addEventListener(name,fn){this.events[name]=fn;}
    dispatchEvent(){}
    getClientRects(){return this.hidden?[]:[{}];}
  }
  const fields={}; ['street','suburb','state','postcode','leadPostcode'].forEach(id=>{fields[id]=new Element();fields[id].id=id;});
  fields.street.dataset={addressSuburb:'suburb',addressState:'state',addressPostcode:'postcode',addressExtraPostcode:'leadPostcode'};
  fields.street.parentNode=new Element();
  let widget;
  class Picker extends Element { constructor(options){super();this.options=options;widget=this;} }
  const window={google:{maps:{importLibrary:async()=>({PlaceAutocompleteElement:Picker})}}};
  window.document={readyState:'complete',querySelectorAll:()=>[fields.street],getElementById:id=>fields[id],createElement:()=>new Element(),head:{appendChild(){queueMicrotask(()=>window.powerSmartPlacesReady());}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/address-autofill'),'utf8'),{window,Event:class{},fetch:async()=>({ok:true,json:async()=>({enabled:true,key:'test-only'})})});
  await new Promise(resolve=>setImmediate(resolve));
  const place={addressComponents:[component('street_number','112'),component('route','High Street'),component('locality','Blackstone'),component('administrative_area_level_1','Queensland','QLD'),component('postal_code','4304'),component('country','Australia','AU')],fetchFields:async()=>{}};
  return {fields,widget,place,select:()=>widget.events['gmp-select']({placePrediction:{toPlace:()=>place}})};
}
test('selecting a suggestion fills every linked field, including lead postcode', async()=>{
  const f=await pickerFixture();await f.select();
  assert.equal(f.fields.street.value,'112 High Street');assert.equal(f.fields.suburb.value,'Blackstone');assert.equal(f.fields.state.value,'QLD');assert.equal(f.fields.postcode.value,'4304');assert.equal(f.fields.leadPostcode.value,'4304');
  assert.deepEqual(Array.from(f.widget.options.includedRegionCodes),['au']);
});
test('late Google responses cannot overwrite manual edits or a closed customer card', async()=>{
  const f=await pickerFixture();let finish;
  f.place.fetchFields=()=>new Promise(resolve=>{finish=resolve;});
  const pending=f.select();f.fields.street.value='My manually entered address';finish();await pending;
  assert.equal(f.fields.street.value,'My manually entered address');assert.equal(f.fields.suburb.value,'');
  f.fields.street.hidden=true;const closed=f.select();finish();await closed;assert.equal(f.fields.suburb.value,'');
});
test('missing components stay empty rather than carrying another customer address', () => {
  assert.deepEqual(parseAddress({}),{street:'',suburb:'',state:'',postcode:'',country:'',full:''});
  assert.equal(parseAddress({addressComponents:[component('postal_town','Brisbane')]}).suburb,'Brisbane');
});
test('address config exposes only the dedicated browser key and safely disables without it', () => {
  const previous=process.env.GOOGLE_MAPS_BROWSER_KEY;
  const response={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  try {
    delete process.env.GOOGLE_MAPS_BROWSER_KEY; config({method:'GET'},response); assert.deepEqual(response.body,{enabled:false,key:''});
    process.env.GOOGLE_MAPS_BROWSER_KEY=' browser-key '; config({method:'GET'},response); assert.deepEqual(response.body,{enabled:true,key:'browser-key'});
    config({method:'POST'},response); assert.equal(response.code,405);
  } finally { if(previous===undefined)delete process.env.GOOGLE_MAPS_BROWSER_KEY; else process.env.GOOGLE_MAPS_BROWSER_KEY=previous; }
});
