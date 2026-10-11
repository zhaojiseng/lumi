import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {mkdir,mkdtemp,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import {GatewayLocalService} from '../electron/services/gateway-local';
import {gatewayPairingTlsOptions,type GatewayPairing} from '../electron/services/gateway-pairing';
import {parseGatewayOutput} from '../shared/gateway-validation';
const binaryPath=path.resolve(process.env.LUMI_GATEWAY_TEST_BINARY??'dist-native/lumi-gateway-runtime'+(process.platform==='win32'?'.exe':''));
const built=await stat(binaryPath).then(s=>s.isFile()).catch(()=>false);
const skip=process.platform!=='win32'?'DPAPI 须在 Windows 验证。':!built?'尚未构建固定网关核心。':false;
const pluginId='extension.lumi.gateway',client='fixture-agent-key-0123456789';
const endpoints=['/v1/responses','/v1/chat/completions','/v1/messages'] as const;
async function listen(server:net.Server){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return (server.address() as net.AddressInfo).port;}
async function close(server:http.Server){server.closeAllConnections?.();await new Promise<void>(resolve=>server.close(()=>resolve()));}
async function port(){const server=net.createServer(),p=await listen(server);await new Promise<void>(resolve=>server.close(()=>resolve()));return p;}
async function management(pairing:GatewayPairing,method:string,input:unknown={}){
 const bytes=Buffer.from(JSON.stringify({protocolVersion:1,instanceId:pairing.instanceId,owner:{hostId:'fixture-interop-host',pluginId},input}));
 return new Promise<any>((resolve,reject)=>{const r=https.request({host:'127.0.0.1',port:pairing.port,path:'/management/v1/'+method,method:'POST',agent:false,...gatewayPairingTlsOptions(pairing),headers:{host:'127.0.0.1:'+pairing.port,authorization:'Bearer '+pairing.token,'content-type':'application/json','content-length':bytes.length}},res=>{const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('error',reject);res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200)return reject(new Error(value.error?.code??'fixture-management-failed'));resolve(value.result);}catch(e){reject(e);}});});r.on('error',reject);r.end(bytes);});
}
async function data(p:number,endpoint:string,value?:unknown,token=client){const bytes=value===undefined?undefined:Buffer.from(JSON.stringify(value));return new Promise<{status:number;body:string;headers:http.IncomingHttpHeaders}>((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:p,path:endpoint,method:bytes?'POST':'GET',agent:false,headers:{authorization:'Bearer '+token,...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})}},res=>{const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode!,body:Buffer.concat(chunks).toString(),headers:res.headers}));});req.on('error',reject);req.end(bytes);});}
function request(endpoint:string,model:string,stream:boolean){
 const tools=endpoint==='/v1/messages'?[{name:'lookup',input_schema:{type:'object',properties:{id:{type:'integer'}}}}]:endpoint==='/v1/responses'?[{type:'function',name:'lookup',strict:false,parameters:{type:'object',properties:{id:{type:'integer'}}}}]:[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{id:{type:'integer'}}}}}];
 if(endpoint==='/v1/responses')return {model,stream,temperature:0.8,max_output_tokens:512,tools,input:[{role:'user',content:'hello'},{type:'function_call',call_id:'previous_call',name:'lookup',arguments:'{"id":1}'},{type:'function_call_output',call_id:'previous_call',output:'previous result'}]};
 if(endpoint==='/v1/messages')return {model,stream,temperature:0.8,max_tokens:512,tools,messages:[{role:'user',content:'hello'},{role:'assistant',content:[{type:'tool_use',id:'previous_call',name:'lookup',input:{id:1}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'previous_call',content:'previous result'}]}]};
 return {model,stream,temperature:0.8,max_completion_tokens:512,tools,messages:[{role:'user',content:'hello'},{role:'assistant',content:null,tool_calls:[{id:'previous_call',type:'function',function:{name:'lookup',arguments:'{"id":1}'}}]},{role:'tool',tool_call_id:'previous_call',content:'previous result'}]};
}
function reply(endpoint:string,model:string){
 if(endpoint==='/v1/responses')return {id:'resp_fixture',object:'response',model,status:'completed',service_tier:'default',output:[{id:'msg_fixture',type:'message',role:'assistant',content:[{type:'output_text',text:'actual reply',annotations:[]}]},{id:'fc_fixture',type:'function_call',call_id:'next_call',name:'lookup',arguments:'{"id":2}'}],usage:{input_tokens:11,output_tokens:5,input_tokens_details:{cached_tokens:2}}};
 if(endpoint==='/v1/messages')return {id:'msg_fixture',type:'message',role:'assistant',model,content:[{type:'text',text:'actual reply'},{type:'tool_use',id:'next_call',name:'lookup',input:{id:2}}],stop_reason:'tool_use',usage:{input_tokens:8,output_tokens:5,cache_read_input_tokens:2,cache_creation_input_tokens:1,service_tier:'standard'}};
 return {id:'chat_fixture',object:'chat.completion',model,service_tier:'default',choices:[{index:0,message:{role:'assistant',content:'actual reply',tool_calls:[{id:'next_call',type:'function',function:{name:'lookup',arguments:'{"id":2}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:11,completion_tokens:5,prompt_tokens_details:{cached_tokens:2}}};
}
function stream(endpoint:string,value:any){const event=(type:string,v:unknown)=> (type?'event: '+type+'\n':'')+'data: '+JSON.stringify(v)+'\n\n';
 if(endpoint==='/v1/responses')return event('response.created',{type:'response.created',response:{id:value.id,model:value.model,status:'in_progress'}})+event('response.output_item.added',{type:'response.output_item.added',output_index:0,item:{type:'message',id:'msg_fixture',role:'assistant',content:[]}})+event('response.output_text.delta',{type:'response.output_text.delta',output_index:0,content_index:0,delta:'actual reply'})+event('response.output_item.added',{type:'response.output_item.added',output_index:1,item:{type:'function_call',id:'fc_fixture',call_id:'next_call',name:'lookup',arguments:''}})+event('response.function_call_arguments.delta',{type:'response.function_call_arguments.delta',output_index:1,delta:'{"id":2}'})+event('response.completed',{type:'response.completed',response:value});
 if(endpoint==='/v1/messages')return event('message_start',{type:'message_start',message:{id:value.id,model:value.model,usage:{...value.usage,output_tokens:0}}})+event('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}})+event('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'actual reply'}})+event('content_block_stop',{type:'content_block_stop',index:0})+event('content_block_start',{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'next_call',name:'lookup',input:{}}})+event('content_block_delta',{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"id":2}'}})+event('content_block_stop',{type:'content_block_stop',index:1})+event('message_delta',{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:5}})+event('message_stop',{type:'message_stop'});
 return event('',{id:value.id,model:value.model,object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'actual reply',tool_calls:[{index:0,id:'next_call',type:'function',function:{name:'lookup',arguments:'{"id":2}'}}]},finish_reason:null}]})+event('',{id:value.id,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+event('',{id:value.id,object:'chat.completion.chunk',choices:[],usage:value.usage,service_tier:'default'})+'data: [DONE]\n\n';
}
test('real managed Rust/DPAPI gateway forwards 3x3 JSON/SSE tool round trips, two stages and live chain without paid traffic',{skip},async t=>{
 const parent=path.resolve('.test-data/gateway-interop');await mkdir(parent,{recursive:true});const dir=await mkdtemp(path.join(parent,'runtime-'));const sent:Array<{endpoint:string;body:any;auth:string|undefined}>=[];
 const upstream=http.createServer((req,res)=>void(async()=>{const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));const body=JSON.parse(Buffer.concat(chunks).toString());sent.push({endpoint:req.url!,body,auth:typeof req.headers.authorization==='string'?req.headers.authorization:typeof req.headers['x-api-key']==='string'?req.headers['x-api-key']:undefined});const value=reply(req.url!,body.model);res.writeHead(200,{'content-type':body.stream?'text/event-stream':'application/json'});if(body.stream){const bytes=Buffer.from(stream(req.url!,value));for(let i=0;i<bytes.length;i+=37)res.write(bytes.subarray(i,i+37));res.end();}else res.end(JSON.stringify(value));})().catch(()=>res.destroy()));
 const upstreamPort=await listen(upstream),listenPort=await port(),managementPort=await port();const service=new GatewayLocalService({dataDir:dir,binaryPath,allowFixtureUpstream:true});
 t.after(async()=>{await service.shutdown();await close(upstream);const relative=path.relative(parent,dir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(dir,{recursive:true,force:true});});
 const providers=endpoints.map((endpoint,i)=>({id:'provider-'+i,clientAlias:'legacy-'+i,name:'供应商 '+i,protocol:i===2?'anthropic' as const:'openai' as const,upstreamBase:'http://127.0.0.1:'+upstreamPort+'/v1',enabled:true,capabilities:{serviceTier:i!==2},models:[{id:'model-'+i,upstreamModel:'real-model-'+i,enabled:true}],entryEndpoints:[...endpoints],upstreamEndpoint:endpoint}));
 let result=await service.setup(pluginId,{alias:'整流与协议夹具',listenPort,managementPort,route:providers[0],credentials:{clientApiKey:client,upstreamApiKey:'fixture-upstream-0'}});let pairing=result.pairing,version=result.configVersion;
 for(let i=1;i<3;i++){result=await service.saveRoute(pluginId,{expectedVersion:version,route:providers[i],credentials:{clientApiKey:'fixture-other-client-'+i+'-0123456789',upstreamApiKey:'fixture-upstream-'+i}});pairing=result.pairing;version=result.configVersion;}
 ({configVersion:version}=await management(pairing,'agents.replace',{expectedVersion:version,agents:[{id:'test-agent',name:'测试 Agent',credentialRef:'provider-0',providerIds:providers.map(r=>r.id),enabled:true}]}));
 const rules=[{id:'entry-temperature',enabled:true,priority:10,stage:'entry',field:'/temperature',match:{clientAlias:'test-agent'},action:{type:'clamp',min:0,max:0.5}},...providers.map((p,i)=>({id:'tier-'+i,enabled:true,priority:10,stage:'model',field:'/service_tier',match:{routeId:p.id},action:{type:'override',value:i===2?'auto':'priority'}}))];
 ({configVersion:version}=await management(pairing,'rectifiers.replace',{expectedVersion:version,rectifiers:rules}));
 assert.equal((await management(pairing,'rectifiers.list')).rectifiers.length,4);
 const preview=await management(pairing,'rectifiers.preview',{routeId:'provider-2',endpoint:'/v1/responses',body:JSON.stringify(request('/v1/responses','model-2',false)),clientAlias:'test-agent'});assert.equal(JSON.parse(preview.sentBody).service_tier,'auto');assert.equal(JSON.parse(preview.sentBody).temperature,0.5);assert.equal(sent.length,0);
 await management(pairing,'listener.start');assert.equal((await data(listenPort,'/v1/models',undefined,'wrong')).status,401);const models=await data(listenPort,'/v1/models');assert.equal(models.status,200);assert.deepEqual(JSON.parse(models.body).data.map((m:any)=>m.id),['model-0','model-1','model-2']);assert.equal(sent.length,0);
 for(let target=0;target<3;target++)for(const source of endpoints)for(const isStream of [false,true]){
  const out=await data(listenPort,source,request(source,'model-'+target,isStream));assert.equal(out.status,200,source+' -> '+endpoints[target]+' '+out.body);assert.ok(out.body.includes('actual reply'));assert.ok(out.body.includes('next_call'));assert.ok(out.body.includes('lookup'));
  const actual=sent.at(-1)!;assert.equal(actual.endpoint,endpoints[target]);assert.equal(actual.body.model,'real-model-'+target);assert.equal(actual.body.temperature,0.5);assert.equal(actual.body.service_tier,target===2?'auto':'priority');assert.ok(JSON.stringify(actual.body).includes('previous_call'));assert.ok(JSON.stringify(actual.body).includes('previous result'));assert.equal(actual.auth,target===2?'fixture-upstream-2':'Bearer fixture-upstream-'+target);assert.ok(!JSON.stringify(actual.body).includes(client));
 }
 assert.equal(sent.length,18);
 const rejected=await data(listenPort,'/v1/responses',{model:'model-2',input:'hello',previous_response_id:'opaque-state'});assert.equal(rejected.status,400);assert.equal(JSON.parse(rejected.body).error?.code,'conversion-field-unsupported',rejected.body);assert.equal(sent.length,18);
 let snapshot:any;
 for(let i=0;i<100;i++){snapshot=await management(pairing,'chain.snapshot');if(snapshot.traces.filter((r:any)=>r.record).length===18)break;await new Promise(resolve=>setTimeout(resolve,10));}
 parseGatewayOutput('gateway.chain.snapshot',snapshot);assert.equal(snapshot.totals.requests,19);assert.equal(snapshot.totals.upstreamAttempts,18);assert.equal(snapshot.totals.rectified,18);assert.equal(snapshot.totals.rerouted,0);assert.equal(snapshot.totals.errors,1);assert.equal(snapshot.traces.filter((r:any)=>r.record).length,18);
 const row=snapshot.traces.find((r:any)=>r.chain?.providerId==='provider-2'&&r.record);assert.equal(row.agentId,'test-agent');assert.equal(row.chain.upstreamModel,'real-model-2');assert.equal(row.chain.routeReason,'model-match');assert.equal(row.record.original.state,'missing');assert.equal(row.record.effective.value,'auto');assert.equal(row.record.reported.value,'standard');assert.deepEqual(row.events.map((e:any)=>e.phase),['received','prepared','upstream','streaming','finished']);
 assert.ok(!JSON.stringify(snapshot).includes('previous result'));assert.ok(!JSON.stringify(snapshot).includes('fixture-upstream'));assert.ok(!JSON.stringify(snapshot).includes(client));
 await management(pairing,'listener.stop',{mode:'drain'});
 await assert.rejects(management(pairing,'agents.replace',{expectedVersion:version,agents:[{id:'a',name:'A',credentialRef:'provider-0',providerIds:['missing'],enabled:true}]}),/invalid-config/);
});


test('real gateway preserves upstream HTTP errors bypassing success SSE conversion and completes compatible Chat EOF',{skip},async t=>{
 const parent=path.resolve('.test-data/gateway-interop');await mkdir(parent,{recursive:true});const dir=await mkdtemp(path.join(parent,'upstream-errors-'));
 const event=(name:string,data:unknown)=>(name?'event: '+name+'\n':'')+'data: '+JSON.stringify(data)+'\n\n';
 const replies=[{status:404,type:'text/event-stream',body:': keep-alive\n\n404 page not found\n'},
  {status:404,type:'application/json',body:'{"error":{"code":"endpoint_not_found","message":"fixture Responses endpoint unavailable"}}'},
  {status:502,type:'text/html',body:'<html>fixture upstream failure</html>'},
  {status:429,type:'text/event-stream',body:'event: error\ndata: {"error":{"type":"rate_limit_error","message":"fixture retry later"}}\n\n'},
  {status:200,type:'text/event-stream',body:event('',{id:'chat_deepseek_fixture',model:'fixture-deepseek',choices:[{index:0,delta:{content:'实际回答'},finish_reason:null}]}).toString()+event('',{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:19,completion_tokens:7,prompt_tokens_details:{cached_tokens:3}}}).toString()},
  {status:200,type:'text/event-stream',body:event('',{id:'truncated_fixture',choices:[{index:0,delta:{content:'partial only'},finish_reason:null}]}).toString()}];
 let current=0,attempts=0;
 const upstream=http.createServer((req,res)=>void(async()=>{for await(const _ of req){}attempts++;const r=replies[current];res.writeHead(r.status,{'content-type':r.type,'content-length':Buffer.byteLength(r.body)});res.end(r.body);})().catch(()=>res.destroy()));
 const upstreamPort=await listen(upstream),listenPort=await port(),managementPort=await port();const service=new GatewayLocalService({dataDir:dir,binaryPath,allowFixtureUpstream:true});
 t.after(async()=>{await service.shutdown();await close(upstream);const relative=path.relative(parent,dir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(dir,{recursive:true,force:true});});
 const route={id:'provider-error',clientAlias:'fixture-client',protocol:'openai' as const,upstreamBase:'http://127.0.0.1:'+upstreamPort+'/v1',enabled:true,capabilities:{serviceTier:true},models:[{id:'fixture-deepseek',upstreamModel:'fixture-deepseek',enabled:true}],entryEndpoints:[...endpoints],upstreamEndpoint:'/v1/chat/completions' as const};
 const {pairing}=await service.setup(pluginId,{alias:'上游错误与兼容流夹具',listenPort,managementPort,route,credentials:{clientApiKey:client,upstreamApiKey:'fixture-upstream-error-key-0123456789'}});
 await management(pairing,'listener.start');
 for(current=0;current<4;current++){
  const reply=replies[current];const out=await data(listenPort,'/provider-error/v1/responses',{model:'fixture-deepseek',input:'fixture only',stream:true});
  assert.equal(out.status,reply.status);assert.equal(out.headers['content-type'],reply.type);assert.equal(out.body,reply.body);assert.ok(!out.body.includes('gateway_conversion_error'));
  assert.equal(attempts,current+1,'no fallback request or paid retry');
 }
 const success=await data(listenPort,'/provider-error/v1/responses',{model:'fixture-deepseek',input:'fixture only',stream:true});
 assert.equal(success.status,200);assert.ok(success.body.includes('response.completed'));assert.ok(success.body.includes('实际回答'));assert.ok(!success.body.includes('event: error'));
 current++;
 const truncated=await data(listenPort,'/provider-error/v1/responses',{model:'fixture-deepseek',input:'fixture only',stream:true});assert.equal(truncated.status,200);assert.ok(truncated.body.includes('conversion-incomplete-stream'));assert.ok(!truncated.body.includes('response.completed'));
 assert.equal(attempts,6);
 let snapshot:any;
 for(let i=0;i<100;i++){snapshot=await management(pairing,'chain.snapshot');if(snapshot.traces.filter((r:any)=>r.record).length===6)break;await new Promise(resolve=>setTimeout(resolve,10));}
 const records=snapshot.traces.map((r:any)=>r.record);assert.equal(records.filter((r:any)=>r?.status==='upstream-error').length,4);assert.equal(records.filter((r:any)=>r?.status==='completed').length,1);assert.equal(records.filter((r:any)=>r?.errorCode==='conversion-incomplete-stream').length,1);
 await management(pairing,'listener.stop',{mode:'drain'});
});
