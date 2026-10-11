import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {startEngine} from '../dev/engine.mjs';
import {createManagementGateway} from '../dev/management.mjs';
import {createTlsIdentity} from '../dev/tls-identity.mjs';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const fixtureRoot=path.join(repository,'.cache','gateway-management-tests');
const fixtureBinary=path.join(repository,'.cache','gateway-target','debug','examples',
  'fixture-engine'+(process.platform==='win32'?'.exe':''));
const clientKey='fixture-client-key-0123456789';
const upstreamKey='fixture-upstream-key-9876543210';
const owner={hostId:'fixture-host-a',pluginId:'extension.lumi.gateway'};
const otherOwner={hostId:'fixture-host-b',pluginId:'extension.lumi.gateway'};

async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});return server.address().port;}
async function close(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
async function unusedPort(){const server=net.createServer();const port=await listen(server);await close(server);return port;}
async function bytes(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks);}
async function fixture(){
  await fs.mkdir(fixtureRoot,{recursive:true});
  const dataDir=await fs.mkdtemp(path.join(fixtureRoot,'peer-'));
  const forwarded=[];
  const upstream=http.createServer((req,res)=>{void (async()=>{
    const body=await bytes(req);forwarded.push({path:req.url,authorization:req.headers.authorization,body});
    if(req.headers['x-client-request-id']==='hold-until-cancel') {
      res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {\"type\":\"response.output_text.delta\",\"delta\":\"waiting\"}\n\n');return;
    }
    const response=Buffer.from(JSON.stringify({service_tier:'default',output_text:'fixture reply',authorization:'fake-upstream-body-secret',usage:{input_tokens:11,output_tokens:5}}));
    res.writeHead(200,{'content-type':'application/json','content-length':response.length});res.end(response);
  })().catch(()=>{res.destroy();});});
  let engine,management;
  try{
    const port=await listen(upstream);
    const config={schemaVersion:1,listen:'127.0.0.1:0',routes:[{id:'primary',client:'codex',protocol:'openai',enabled:true,upstream:'http://127.0.0.1:'+port+'/v1'}],
      rules:[{id:'chosen-tier',enabled:true,priority:0,match:{},action:{type:'preserve'}}],
      recording:{bodies:true,retentionDays:7,maxRecords:10000,maxBytes:1024**3,captureBytes:1024**2},maxConcurrency:4,maxRequestBytes:2*1024*1024};
    await fs.writeFile(path.join(dataDir,'config.json'),JSON.stringify(config,null,2));
    engine=await startEngine({dataDir,testBinary:fixtureBinary});
    const identity={instanceId:randomUUID(),alias:'独立 TLS 夹具',port:await unusedPort(),...createTlsIdentity(),token:randomBytes(32).toString('hex')};
    management=await createManagementGateway({dataDir,engine,identity,routeSecrets:engine.bootstrap.routeSecrets,allowFixtureUpstream:true});
    return {dataDir,engine,management,identity,forwarded,
      async dispose(){await management.close();await engine.close();await close(upstream);
        const checkedRoot=await fs.realpath(fixtureRoot),checkedDir=await fs.realpath(dataDir);
        assert.equal(path.dirname(checkedDir),checkedRoot);await fs.rm(checkedDir,{recursive:true,force:true});}};
  }catch(error){await management?.close().catch(()=>{});await engine?.close().catch(()=>{});await close(upstream).catch(()=>{});throw error;}
}
function call(item,method,input={},options={}){
  const payload=options.payload??{protocolVersion:options.protocolVersion??1,instanceId:options.instanceId??item.identity.instanceId,
    owner:options.owner??owner,input};
  const body=Buffer.from(JSON.stringify(payload));
  const fingerprint=options.fingerprint??item.identity.fingerprintSha256;
  return new Promise((resolve,reject)=>{
    const req=https.request({host:'127.0.0.1',port:item.identity.port,path:options.path??'/management/v1/'+method,method:options.method??'POST',
      ca:options.ca??item.identity.certificatePem,agent:false,servername:'',minVersion:'TLSv1.2',rejectUnauthorized:true,
      checkServerIdentity(host,certificate){return tls.checkServerIdentity(host,certificate)??
        (createHash('sha256').update(certificate.raw).digest('hex')===fingerprint?undefined:new Error('fixture-certificate-pin-mismatch'));},
      headers:{host:'127.0.0.1:'+item.identity.port,authorization:options.authorization??'Bearer '+item.identity.token,
        'content-type':'application/json','content-length':body.length,...options.headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('error',reject);res.once('end',()=>{
        try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(error){reject(error);}
      });
    });req.once('error',reject);req.end(body);
  });
}
async function success(item,method,input={},options={}){const result=await call(item,method,input,options);assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.protocolVersion,1);assert.equal(result.body.instanceId,item.identity.instanceId);return result.body.result;}
async function reject(item,method,input,code,status,options={}){const result=await call(item,method,input,options);assert.equal(result.status,status);assert.equal(result.body.error.code,code);}
function send(address,body,{contentType='application/json',contentEncoding}={}){return new Promise((resolve,reject)=>{
  const req=http.request('http://'+address+'/primary/v1/responses',{method:'POST',agent:false,
    headers:{authorization:'Bearer '+clientKey,'content-type':contentType,'content-length':body.length,...(contentEncoding?{'content-encoding':contentEncoding}:{})}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks)}));
    });req.once('error',reject);req.end(body);
});}
async function completed(item,count){const deadline=Date.now()+3000;while(Date.now()<deadline){const value=await success(item,'records.list',{limit:100});
  if(value.records.length===count&&value.records.every(record=>record.status!=='forwarding'))return value.records;await delay(10);}
  assert.fail('fixture records did not reach a terminal state');}

// Every connection uses the generated certificate as its CA and independently pins its
// SHA-256 fingerprint; this exercises real TLS and the actual private Rust stdio peer.
test('management TLS rejects wrong pin, credentials, identity, origin and listener ownership',async()=>{
  const item=await fixture();try{
    assert.deepEqual(await success(item,'hello'),{protocolVersion:1});
    await assert.rejects(call(item,'hello',{}, {fingerprint:'00'.repeat(32)}),/fixture-certificate-pin-mismatch/);
    await reject(item,'hello',{},'unauthorized',401,{authorization:'Bearer fake-invalid-management-token'});
    await reject(item,'hello',{},'instance-or-protocol-mismatch',409,{instanceId:randomUUID()});
    await reject(item,'hello',{},'instance-or-protocol-mismatch',409,{protocolVersion:2});
    await reject(item,'hello',{},'invalid-host-or-origin',403,{headers:{origin:'http://localhost'}});
    await reject(item,'hello',{},'invalid-host-or-origin',403,{headers:{host:'localhost:'+item.identity.port}});
    await reject(item,'arbitrary.file.write',{},'unsupported-method',404);
    await reject(item,'hello',{file:'arbitrary'},'invalid-input',400);
    await reject(item,'hello',{},'invalid-owner',400,{owner:{hostId:'fixture-host-a',pluginId:'arbitrary.plugin'}});
    await reject(item,'hello',{},'invalid-input',400,{payload:{protocolVersion:1,instanceId:item.identity.instanceId,owner,input:{},extra:true}});
    const started=await success(item,'listener.start');assert.equal(started.state,'listening');assert.equal(started.owned,true);
    const outsider=await success(item,'listener.status',{}, {owner:otherOwner});assert.equal(outsider.state,'listening');assert.equal(outsider.owned,false);
    await reject(item,'listener.start',{},'listener-owned-by-another-host',403,{owner:otherOwner});
    await reject(item,'listener.stop',{mode:'cancel'},'listener-owned-by-another-host',403,{owner:otherOwner});
    const guardedRules=await success(item,'rules.list');
    await reject(item,'rules.replace',{expectedVersion:guardedRules.policyVersion,rules:guardedRules.rules},'listener-owned-by-another-host',403,{owner:otherOwner});
    const guardedRecording=await success(item,'recording.config.get');
    await reject(item,'recording.config.set',{expectedVersion:guardedRecording.configVersion,recording:guardedRecording.recording},'listener-owned-by-another-host',403,{owner:otherOwner});
    const guardedRoutes=await success(item,'routes.config.get');
    await reject(item,'routes.config.set',{expectedVersion:guardedRoutes.configVersion,routes:guardedRoutes.routes},'listener-owned-by-another-host',403,{owner:otherOwner});
    await reject(item,'records.delete',{selection:{recordIds:[randomUUID()]}},'listener-owned-by-another-host',403,{owner:otherOwner});
    const target=await success(item,'cli.target',{tool:'codex',routeId:'primary'});
    assert.equal(target.baseUrl,'http://'+started.address+'/primary/v1');assert.equal(target.authToken,clientKey);assert.equal(target.protocol,'openai');assert.match(target.sessionFingerprint,/^[a-f0-9]{64}$/);
    await reject(item,'cli.target',{tool:'codex',routeId:'primary'},'listener-owned-by-another-host',403,{owner:otherOwner});
    await reject(item,'cli.target',{tool:'claude-code',routeId:'primary'},'incompatible-cli-route',400);
    assert.equal((await success(item,'listener.stop',{mode:'drain'})).state,'stopped');
    await reject(item,'cli.target',{tool:'codex',routeId:'primary'},'start-listener-before-cli-setup',409);
  }finally{await item.dispose();}
});

test('actual TLS management edits Rust policy, forwards changed bytes, pages encrypted redacted bodies and deletes a frozen filter',async()=>{
  const item=await fixture();try{
    const initialRules=await success(item,'rules.list');assert.equal(initialRules.policyVersion,1);
    const rules=[{id:'chosen-tier',enabled:true,priority:0,match:{routeId:'primary',clientAlias:'codex',model:'fixture-model'},action:{type:'override',value:'priority'}}];
    const ruleUpdate=await success(item,'rules.replace',{expectedVersion:1,rules});assert.equal(ruleUpdate.policyVersion,2);
    const preview=await success(item,'rules.preview',{routeId:'primary',endpoint:'/v1/responses',model:'fixture-model',originalTier:{state:'string',value:'flex'}});
    assert.deepEqual(preview.original,{state:'string',value:'flex'});assert.deepEqual(preview.effective,{state:'string',value:'priority'});assert.equal(preview.ruleId,'chosen-tier');assert.equal(preview.modified,true);assert.equal(preview.compatible,true);
    const before=await fs.readFile(path.join(item.dataDir,'config.json'));
    await reject(item,'rules.replace',{expectedVersion:1,rules},'config-conflict',409);
    assert.deepEqual(await fs.readFile(path.join(item.dataDir,'config.json')),before);
    await reject(item,'rules.replace',{expectedVersion:2,rules:[{...rules[0],action:{type:'override',value:'invalid tier'}}]},'invalid-config',400);
    assert.deepEqual(await fs.readFile(path.join(item.dataDir,'config.json')),before);
    const recording=await success(item,'recording.config.get');assert.equal(recording.configVersion,2);assert.equal(recording.encryptionAvailable,true);assert.equal(recording.recording.bodies,true);
    await reject(item,'recording.config.set',{expectedVersion:2,recording:{...recording.recording,captureBytes:1024**2+1}},'invalid-config',400);
    assert.deepEqual(await fs.readFile(path.join(item.dataDir,'config.json')),before);
    const started=await success(item,'listener.start');
    const routes=await success(item,'routes.config.get');assert.equal(routes.configVersion,2);assert.equal(routes.routes[0].credentialPresent,true);
    await reject(item,'routes.config.set',{expectedVersion:2,routes:routes.routes},'stop-listener-before-changing-routes',409);
    const body=Buffer.from(JSON.stringify({model:'fixture-model',service_tier:'flex',input:'私密🙂'.repeat(20_000),api_key:('fake-request-'+'body-secret')}));
    const response=await send(started.address,body);assert.equal(response.status,200);assert.equal(JSON.parse(response.body).service_tier,'default');
    assert.equal(item.forwarded.length,1);assert.equal(item.forwarded[0].path,'/v1/responses');assert.equal(item.forwarded[0].authorization,'Bearer '+upstreamKey);
    const sent=JSON.parse(item.forwarded[0].body);assert.equal(sent.service_tier,'priority');assert.equal(sent.input,JSON.parse(body).input);
    const [record]=await completed(item,1);assert.equal(record.clientAlias,'codex');assert.equal(record.routeId,'primary');assert.equal(record.model,'fixture-model');
    assert.deepEqual(record.original,{state:'string',value:'flex'});assert.deepEqual(record.effective,{state:'string',value:'priority'});assert.deepEqual(record.reported,{state:'string',value:'default'});
    assert.equal(record.inputTokens,11);assert.equal(record.outputTokens,5);assert.equal(record.cacheReadTokens,null);assert.equal(record.recordingPartial,false);
    assert.equal((await success(item,'records.get',{recordId:record.id})).body,null);
    let detail=await success(item,'records.get',{recordId:record.id,includeBody:true});
    const revokeCursor=detail.body.nextCursor;assert.ok(revokeCursor);let full=detail.body.text;
    assert.equal(detail.body.encrypted,true);assert.equal(detail.body.redacted,true);assert.ok(Buffer.byteLength(detail.body.text)<=64*1024);
    while(detail.body.nextCursor){detail=await success(item,'records.get',{recordId:record.id,includeBody:true,bodyCursor:detail.body.nextCursor});assert.ok(Buffer.byteLength(detail.body.text)<=64*1024);full+=detail.body.text;}
    assert.equal(detail.body.complete,true);assert.equal(detail.body.truncated,false);
    const wrapper=JSON.parse(full);assert.equal(JSON.parse(wrapper.request).api_key,'[REDACTED]');assert.equal(JSON.parse(wrapper.response).authorization,'[REDACTED]');
    assert.ok(!full.includes('fake-request-body-secret'));assert.ok(!full.includes('fake-upstream-body-secret'));
    await reject(item,'records.get',{recordId:record.id,includeBody:true,bodyCursor:revokeCursor},'invalid-cursor',400);
    const recent=await success(item,'records.get',{recordId:record.id,includeBody:true});const cursor=recent.body.nextCursor;assert.ok(cursor);
    const disabled=await success(item,'recording.config.set',{expectedVersion:2,recording:{...recording.recording,bodies:false}});assert.equal(disabled.configVersion,3);
    await reject(item,'records.get',{recordId:record.id,includeBody:true,bodyCursor:cursor},'recording-disabled',400);
    assert.equal((await success(item,'records.get',{recordId:record.id})).body,null);
    const enabled=await success(item,'recording.config.set',{expectedVersion:3,recording:{...recording.recording,policyVersion:3}});assert.equal(enabled.configVersion,4);
    await reject(item,'records.get',{recordId:record.id,includeBody:true,bodyCursor:cursor},'invalid-cursor',400);
    const selected=await success(item,'records.list',{limit:100,filter:{routeId:'primary',clientAlias:'codex',model:'fixture-model',endpoint:'/v1/responses',status:'completed',tier:'priority',fromMs:record.startedAtMs,toMs:record.startedAtMs}});
    assert.equal(selected.records.length,1);assert.equal(selected.records[0].id,record.id);
    await reject(item,'records.list',{limit:100,filter:{arbitraryPath:'bad'}},'invalid-input',400);
    assert.equal((await success(item,'records.delete',{selection:{filter:{routeId:'primary',tier:'priority'},throughMs:record.startedAtMs}})).deleted,1);
    await reject(item,'records.get',{recordId:record.id,includeBody:true},'record-not-found',400);
    assert.equal((await success(item,'records.list',{limit:100})).records.length,0);
    await success(item,'listener.stop',{mode:'drain'});
    const latestRoutes=await success(item,'routes.config.get');
    assert.equal((await success(item,'routes.config.set',{expectedVersion:4,routes:latestRoutes.routes.map(route=>({...route,enabled:false}))})).configVersion,5);
    await reject(item,'listener.start',{},'no-enabled-routes',400);
    const persisted=JSON.parse(await fs.readFile(path.join(item.dataDir,'config.json'),'utf8'));
    assert.equal(persisted.routes[0].enabled,false);assert.equal(persisted.rules[0].action.value,'priority');assert.equal(persisted.recording.bodies,true);
    for(const suffix of ['','-wal','-shm']){const disk=await fs.readFile(path.join(item.dataDir,'records.sqlite'+suffix)).catch(()=>Buffer.alloc(0));
      assert.equal(disk.includes(Buffer.from('fake-request-body-secret')),false);assert.equal(disk.includes(Buffer.from('fake-upstream-body-secret')),false);}
  }finally{await item.dispose();}
});


test('live rule replacements refresh transport compatibility gates for subsequent requests',async()=>{
  const item=await fixture();try{
    const overriding=[{id:'chosen-tier',enabled:true,priority:0,match:{},action:{type:'override',value:'priority'}}];
    assert.equal((await success(item,'rules.replace',{expectedVersion:1,rules:overriding})).policyVersion,2);
    const started=await success(item,'listener.start');
    const body=Buffer.from('{"input":"compatibility fixture","service_tier":"flex"}');
    assert.equal((await send(started.address,body,{contentType:'text/plain'})).status,415);
    assert.equal(item.forwarded.length,0);
    const preserving=overriding.map(rule=>({...rule,action:{type:'preserve'}}));
    assert.equal((await success(item,'rules.replace',{expectedVersion:2,rules:preserving})).policyVersion,3);
    const allowed=await send(started.address,body,{contentType:'text/plain'});assert.equal(allowed.status,200);
    assert.equal(item.forwarded.length,1);assert.deepEqual(item.forwarded[0].body,body);
    assert.equal((await success(item,'rules.replace',{expectedVersion:3,rules:overriding})).policyVersion,4);
    assert.equal((await send(started.address,body,{contentType:'text/plain'})).status,415);
    assert.equal(item.forwarded.length,1);
    const compatible=await send(started.address,body);assert.equal(compatible.status,200);
    assert.equal(JSON.parse(item.forwarded[1].body).service_tier,'priority');
    await completed(item,2);
  }finally{await item.dispose();}
});

function heldRequest(address,body){
  let resolveFirst,rejectFirst;const first=new Promise((resolve,reject)=>{resolveFirst=resolve;rejectFirst=reject;});
  let response;const req=http.request('http://'+address+'/primary/v1/responses',{method:'POST',agent:false,
    headers:{authorization:'Bearer '+clientKey,'content-type':'application/json','content-length':body.length,'x-client-request-id':'hold-until-cancel'}},res=>{
      response=res;res.once('data',resolveFirst);res.once('error',error=>{if(!response)rejectFirst(error);});res.resume();
    });req.once('error',rejectFirst);req.end(body);return {first,close(){req.destroy();response?.destroy();}};
}
test('cancel stop terminates a held upstream promptly and records one uncertain result',async()=>{
  const item=await fixture();let held;
  try{
    const started=await success(item,'listener.start');held=heldRequest(started.address,Buffer.from('{"input":"held fixture"}'));
    await held.first;assert.equal(item.forwarded.length,1);
    const startedAt=Date.now();const stopped=await success(item,'listener.stop',{mode:'cancel'});assert.equal(stopped.state,'stopped');
    assert.ok(Date.now()-startedAt<2000,'cancel must not wait for the 15-second drain deadline');
    const [record]=await completed(item,1);assert.equal(record.status,'execution-unknown');assert.equal(record.errorCode,'gateway-stopping');assert.equal(record.recordingPartial,true);
    assert.equal(item.forwarded.length,1);
  }finally{held?.close();await item.dispose();}
});

test('a route can persist service-tier capability off and preserve actual request bytes',async()=>{
  const item=await fixture();try{
    const routes=await success(item,'routes.config.get');
    assert.equal(routes.routes[0].capabilities.serviceTier,true);
    const replaced=await success(item,'routes.config.set',{expectedVersion:1,routes:routes.routes.map(route=>({...route,capabilities:{serviceTier:false}}))});
    assert.equal(replaced.configVersion,2);
    assert.equal((await success(item,'routes.config.get')).routes[0].capabilities.serviceTier,false);
    const rules=[{id:'chosen-tier',enabled:true,priority:0,match:{},action:{type:'override',value:'priority'}}];
    assert.equal((await success(item,'rules.replace',{expectedVersion:2,rules})).policyVersion,3);
    const preview=await success(item,'rules.preview',{routeId:'primary',endpoint:'/v1/responses',originalTier:{state:'string',value:'flex'}});
    assert.equal(preview.compatible,false);assert.equal(preview.modified,false);assert.equal(preview.ruleId,null);assert.deepEqual(preview.effective,{state:'string',value:'flex'});
    const started=await success(item,'listener.start');
    const body=Buffer.from('{ "service_tier": "flex", "input": "preserve exact fixture bytes" }');
    assert.equal((await send(started.address,body,{contentType:'text/plain'})).status,200);
    assert.equal(item.forwarded.length,1);assert.deepEqual(item.forwarded[0].body,body);
    const [record]=await completed(item,1);assert.equal(record.ruleId,null);assert.deepEqual(record.original,record.effective);assert.deepEqual(record.effective,{state:'string',value:'flex'});
    assert.equal(JSON.parse(await fs.readFile(path.join(item.dataDir,'config.json'),'utf8')).routes[0].serviceTier,false);
  }finally{await item.dispose();}
});
