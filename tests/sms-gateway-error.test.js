const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {readGatewayResponse,gatewayError}=require('../api/_sms-gateway-error');
function fixture({status=502,body='',networkError=null}={}) {
  const calls=[],writes=[],module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api/sms.js'),'utf8'),{
    module,require:key=>key==='./_supabase'?{configured:()=>true,sb:async(q,opts)=>{if(opts?.method==='POST'){writes.push(opts.body);return [opts.body];}return [];}}:require(path.join(__dirname,'../api',key)),
    Buffer,AbortController,setTimeout,clearTimeout,console:{error(){}},process:{env:{SMSGATE_USERNAME:'test-user',SMSGATE_PASSWORD:'test-pass'}},
    fetch:async(url,options)=>{calls.push({url,options});if(networkError)throw networkError;return new Response(body,{status});}
  });
  const res={setHeader(){},status(code){this.code=code;return this;},json(value){this.body=value;return this;}};
  return {handler:module.exports,res,calls,writes};
}
test('empty, HTML and null gateway errors retain HTTP status and meaningful uncertainty',async()=>{
  for(const body of ['', '<html>Bad gateway</html>', 'null']) {
    const parsed=await readGatewayResponse(new Response(body,{status:502}));
    const e=gatewayError(502,parsed);assert.equal(e.detail,'HTTP 502');assert.equal(e.uncertain,true);assert.match(e.error,/temporarily unavailable/);assert.doesNotMatch(e.error,/rejected/);
  }
});
test('JSON validation details and credential/rate-limit guidance remain useful',()=>{
  assert.match(gatewayError(400,{message:'Invalid phone number'}).detail,/HTTP 400: Invalid phone number/);
  assert.match(gatewayError(401).error,/credentials/);assert.match(gatewayError(429).error,/limiting/);
  assert.equal(gatewayError(400).uncertain,false);
});
test('provider credential values are redacted from returned detail',()=>{
  const previous=process.env.SMSGATE_PASSWORD;
  try {process.env.SMSGATE_PASSWORD='private-example-password';assert.doesNotMatch(gatewayError(401,{message:'Failed: private-example-password'}).detail,/private-example-password/);}
  finally {if(previous===undefined)delete process.env.SMSGATE_PASSWORD;else process.env.SMSGATE_PASSWORD=previous;}
});
test('manual inbox send returns HTTP 502 reason and never records an outage as sent',async()=>{
  const f=fixture();await f.handler({method:'POST',query:{},headers:{},body:{action:'send',phone:'0451 898 761',message:'Test draft'}},f.res);
  assert.equal(f.res.code,502);assert.equal(f.res.body.detail,'HTTP 502');assert.equal(f.res.body.code,'sms_submission_unknown');assert.equal(f.writes.length,0);
  assert.equal(JSON.parse(f.calls[0].options.body).phoneNumbers[0],'+61451898761');
});
test('invalid mobile fails before any gateway request',async()=>{
  const f=fixture();await f.handler({method:'POST',query:{},headers:{},body:{action:'send',phone:'04123',message:'Test draft'}},f.res);
  assert.equal(f.res.code,400);assert.equal(f.calls.length,0);
});
test('connection diagnostic is staff-only, read-only and does not send a test SMS',async()=>{
  const f=fixture({status:200,body:'[{"id":"device-one"}]'});
  await f.handler({method:'GET',query:{action:'diagnostics'},headers:{}},f.res);assert.equal(f.res.code,401);assert.equal(f.calls.length,0);
  await f.handler({method:'GET',query:{action:'diagnostics'},headers:{'x-portal-key':'2026'}},f.res);
  assert.equal(f.res.body.gatewayReachable,true);assert.equal(f.res.body.deviceCount,1);assert(f.calls[0].url.endsWith('/devices'));assert.equal(f.calls[0].options.method,undefined);assert.equal(f.writes.length,0);
});
test('connection diagnostic reports a timeout without claiming a message was sent',async()=>{
  const f=fixture({networkError:Object.assign(new Error('Timed out'),{name:'AbortError'})});
  await f.handler({method:'GET',query:{action:'diagnostics'},headers:{'x-portal-key':'2026'}},f.res);
  assert.equal(f.res.body.gatewayReachable,false);assert.match(f.res.body.error,/not responding/);assert.equal(f.writes.length,0);
});
