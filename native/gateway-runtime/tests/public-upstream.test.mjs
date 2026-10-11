import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {isPublicAddress,resolvePublicAddresses,createGateway} from '../dev/transport.mjs';

const nativeLookup=dns.lookup;
const mockDns=(t,lookup)=>t.mock.method(dns,'lookup',(host,options,callback)=>host==='127.0.0.1'?nativeLookup(host,options,callback):lookup(host,options,callback));
const CLIENT_KEY='fixture-client-key-0123456789';
const UPSTREAM_KEY='fixture-upstream-key-0123456789';
const answers=(values)=>((_host,_options,callback)=>callback(null,values));
const public4={address:'8.8.8.8',family:4};
const public6={address:'2606:4700:4700::1111',family:6};
const config=upstream=>({schemaVersion:1,listen:'127.0.0.1:0',routes:[{id:'test',client:'codex',protocol:'openai',upstream}],rules:[]});
const engine=()=>({calls:[],async request(method,input){this.calls.push({method,input});return method==='prepare'?{bodyB64:input.bodyB64,modified:false}:{saved:true};}});
const options=upstream=>({config:config(upstream),routeSecrets:[{routeId:'test',clientKey:CLIENT_KEY,upstreamKey:UPSTREAM_KEY}],engine:engine(),publicUpstreams:true,drainTimeoutMs:10});
const send=gateway=>new Promise((resolve,reject)=>{
 const req=http.request('http://'+gateway.address+'/test/v1/responses',{method:'POST',agent:false,headers:{authorization:'Bearer '+CLIENT_KEY,'content-type':'application/json'}},res=>{
  const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});
 req.on('error',reject);req.end('{}');
});

// Native DNS and HTTPS objects are restored by mock.method after each test; no real upstream is contacted.
test('public address policy rejects private, reserved, mapped and transition networks',()=>{
 for(const value of ['0.0.0.0','10.0.0.1','100.64.0.1','100.127.255.254','127.0.0.1','169.254.169.254','172.16.0.1','172.31.255.255','192.168.1.1','192.0.0.1','192.0.2.1','192.88.99.1','198.18.0.1','198.19.255.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255',
  '::','::1','::ffff:127.0.0.1','::ffff:7f00:1','64:ff9b::808:808','100::1','2001::1','2001:20::1','2001:db8::1','2002:7f00:1::','3fff::1','fc00::1','fe80::1','ff02::1','fe80::1%lo','invalid'])assert.equal(isPublicAddress(value),false,value);
 for(const value of ['8.8.8.8','1.1.1.1','100.63.255.255','172.15.255.255','172.32.0.1','192.0.1.1','198.17.255.255','223.255.255.254','2606:4700:4700::1111','2001:4860:4860::8888','2a00:1450:4001::200e'])assert.equal(isPublicAddress(value),true,value);
});

test('resolver vets every DNS answer, copies results and bypasses DNS only for public literals',async()=>{
 let seen;const original=[public4,public6];
 const resolved=await resolvePublicAddresses('API.example',(_host,request,callback)=>{seen={host:_host,request};callback(null,original);});
 assert.deepEqual(seen,{host:'api.example',request:{all:true,verbatim:true}});assert.deepEqual(resolved,original);assert.notEqual(resolved,original);assert.notEqual(resolved[0],original[0]);
 for(const values of [[],[public4,{address:'127.0.0.1',family:4}],[public4,{address:'::ffff:8.8.8.8',family:6}],[{address:public4.address,family:6}],Array(65).fill(public4),[null]])await assert.rejects(resolvePublicAddresses('api.example',answers(values)),{code:'upstream-dns-not-public'});
 let called=0;assert.deepEqual(await resolvePublicAddresses('8.8.8.8',()=>{called++;}),[public4]);assert.equal(called,0);
 for(const host of ['localhost','x.localhost','x.local','api.example.','invalid/host','127.0.0.1','::ffff:7f00:1'])await assert.rejects(resolvePublicAddresses(host,answers([public4])),{code:'invalid-upstream'});
 await assert.rejects(resolvePublicAddresses('api.example',(_host,_options,callback)=>callback(new Error(UPSTREAM_KEY))),error=>error.code==='upstream-dns-error'&&!error.message.includes(UPSTREAM_KEY));
});

test('resolver abort does not accept a late DNS answer',async()=>{
 const controller=new AbortController();let callback;const result=resolvePublicAddresses('api.example',(_host,_options,done)=>{callback=done;},controller.signal);
 const rejected=assert.rejects(result,{code:'upstream-dns-cancelled'});controller.abort();callback(null,[public4]);await rejected;
});

test('public gateway rejects HTTP and private literal/DNS upstreams before listening',async t=>{
 mockDns(t,(_host,_request,callback)=>callback(null,[{address:'10.0.0.1',family:4}]));
 for(const upstream of ['http://127.0.0.1:1','https://127.0.0.1','https://[::1]','https://192.0.2.1','https://[::ffff:7f00:1]','https://localhost','https://api.example'])await assert.rejects(createGateway(options(upstream)));
 await assert.rejects(createGateway({...options(('https://'+'8.8.8.8')),publicUpstreams:'false'}),{code:'invalid-gateway-config'});
});

test('request-time DNS rebinding rejects the request before HTTPS receives credentials',async t=>{
 let dnsCalls=0,upstreamCalls=0;
 mockDns(t,(_host,_request,callback)=>callback(null,++dnsCalls===1?[public4]:[public4,{address:'169.254.169.254',family:4}]));
 t.mock.method(https,'request',()=>{upstreamCalls++;throw new Error('should not forward');});
 const current=options('https://api.example/v1'),gateway=await createGateway(current);t.after(()=>gateway.stop());
 const result=await send(gateway);assert.equal(result.status,502);assert.deepEqual(JSON.parse(result.body),{error:{code:'upstream-dns-not-public'}});assert.equal(upstreamCalls,0);assert.equal(dnsCalls,2);
 await delay(10);assert.equal(current.engine.calls.find(call=>call.method==='finish').input.status,'gateway-rejected');
});

test('every forwarding request pins the freshly validated address while preserving TLS hostname and credential boundary',async t=>{
 let dnsCalls=0;const captured=[];
 mockDns(t,(_host,_request,callback)=>callback(null,[dnsCalls++===2?{address:'1.1.1.1',family:4}:public4,public6]));
 t.mock.method(https,'request',(target,requestOptions)=>{
  captured.push({target,requestOptions});const request=new EventEmitter();request.destroy=()=>{};
  request.end=body=>{captured.at(-1).body=body;queueMicrotask(()=>{const response=new PassThrough();response.statusCode=200;response.headers={'content-type':'application/json'};request.emit('response',response);response.end('{}');});};return request;
 });
 const gateway=await createGateway(options('https://API.example/v1'));t.after(()=>gateway.stop());
 assert.equal((await send(gateway)).status,200);assert.equal((await send(gateway)).status,200);assert.equal(dnsCalls,3);
 for(const [index,item] of captured.entries()){
  assert.equal(item.target.hostname,'api.example');assert.equal(item.target.pathname,'/v1/responses');assert.equal(item.requestOptions.agent,false);assert.equal(item.requestOptions.rejectUnauthorized,undefined);assert.equal(item.requestOptions.checkServerIdentity,undefined);
  assert.equal(item.requestOptions.headers.authorization,'Bearer '+UPSTREAM_KEY);assert.equal(JSON.stringify(item.requestOptions.headers).includes(CLIENT_KEY),false);
  assert.equal(item.requestOptions.family,4);assert.equal(item.requestOptions.autoSelectFamily,false);
  const address=await new Promise((resolve,reject)=>item.requestOptions.lookup('api.example',{},(error,value,family)=>error?reject(error):resolve({address:value,family})));
  assert.deepEqual(address,index===0?public4:{address:'1.1.1.1',family:4});
  const all=await new Promise((resolve,reject)=>item.requestOptions.lookup('api.example',{all:true},(error,value)=>error?reject(error):resolve(value)));assert.deepEqual(all,[address]);
  await assert.rejects(new Promise((resolve,reject)=>item.requestOptions.lookup('different.example',{},error=>error?reject(error):resolve())),{code:'upstream-address-changed'});
 }
});

test('gateway stop cancels a stalled request-time DNS resolution without attempting HTTPS',async t=>{
 let dnsCalls=0,pendingLookup,upstreamCalls=0;
 mockDns(t,(_host,_request,callback)=>{dnsCalls++;if(dnsCalls===1)callback(null,[public4]);else pendingLookup=callback;});
 t.mock.method(https,'request',()=>{upstreamCalls++;throw new Error('should not forward');});
 const current=options('https://api.example'),gateway=await createGateway(current);t.after(()=>gateway.stop());
 const pending=send(gateway).catch(error=>error);for(let attempt=0;!pendingLookup&&attempt<100;attempt++)await delay(5);
 assert.equal(typeof pendingLookup,'function');const start=Date.now();await gateway.stop();assert.ok(Date.now()-start<1500);pendingLookup(null,[public4]);await pending;assert.equal(upstreamCalls,0);
});
