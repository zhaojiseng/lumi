import test from 'node:test';
import assert from 'node:assert/strict';
import {convertJsonResponse,createStreamConverter,strictJson} from '../electron/services/gateway-runtime/protocol.mjs';
import {parseGatewayInput,parseGatewayOutput} from '../shared/gateway-validation';
const chat='/v1/chat/completions',responses='/v1/responses',messages='/v1/messages';
const fixtures:Record<string,unknown>={
 [chat]:{id:'chat_a',model:'real-model',choices:[{index:0,message:{role:'assistant',content:'回答 ✦',tool_calls:[{id:'call_a',type:'function',function:{name:'lookup',arguments:'{"id":3}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:11,completion_tokens:5,prompt_tokens_details:{cached_tokens:2}}},
 [responses]:{id:'resp_a',model:'real-model',status:'completed',output:[{id:'msg_a',type:'message',role:'assistant',content:[{type:'output_text',text:'回答 ✦',annotations:[]}]},{id:'fc_a',type:'function_call',call_id:'call_a',name:'lookup',arguments:'{"id":3}'}],usage:{input_tokens:11,output_tokens:5,input_tokens_details:{cached_tokens:2}}},
 [messages]:{id:'msg_a',type:'message',role:'assistant',model:'real-model',content:[{type:'text',text:'回答 ✦'},{type:'tool_use',id:'call_a',name:'lookup',input:{id:3}}],stop_reason:'tool_use',usage:{input_tokens:8,cache_read_input_tokens:2,cache_creation_input_tokens:1,output_tokens:5}},
};
for(const source of [chat,responses,messages])for(const target of [chat,responses,messages].filter(t=>t!==source))test('JSON response projects real text/tools/usage '+source+' -> '+target,()=>{
 const result=JSON.parse(convertJsonResponse(Buffer.from(JSON.stringify(fixtures[source])),source,target,'fallback').toString());const text=JSON.stringify(result);
 assert.ok(text.includes('回答 ✦'));assert.ok(text.includes('call_a'));assert.ok(text.includes('lookup'));assert.ok(text.includes('real-model'));assert.ok(text.includes('5'));assert.ok(!text.includes('fallback'));
 if(target===messages){assert.equal(result.usage.input_tokens+result.usage.cache_read_input_tokens+(result.usage.cache_creation_input_tokens??0),11);assert.deepEqual(result.content[1].input,{id:3});}
 else if(target===chat)assert.equal(result.usage.prompt_tokens,11);else assert.equal(result.usage.input_tokens,11);
});
const event=(name:string,data:unknown)=>Buffer.from((name?'event: '+name+'\r\n':'')+'data: '+(typeof data==='string'?data:JSON.stringify(data))+'\r\n\r\n');
const streams:Record<string,Buffer[]>={
 [chat]:[
  event('',{id:'chat_a',model:'real-model',choices:[{index:0,delta:{role:'assistant',content:'回答 '},finish_reason:null}]}),
  event('',{id:'chat_a',choices:[{index:0,delta:{content:'✦',tool_calls:[{index:0,id:'call_a',type:'function',function:{name:'look'}}]},finish_reason:null}]}),
  event('',{id:'chat_a',choices:[{index:0,delta:{tool_calls:[{index:0,function:{name:'up',arguments:'{"id":'}}]},finish_reason:null}]}),
  event('',{id:'chat_a',choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'3}'}}]},finish_reason:null}]}),
  event('',{choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}),event('',{choices:[],usage:{prompt_tokens:11,completion_tokens:5,prompt_tokens_details:{cached_tokens:2}}}),event('','[DONE]'),
 ],
 [messages]:[
  event('message_start',{type:'message_start',message:{id:'msg_a',model:'real-model',usage:{input_tokens:8,cache_read_input_tokens:2,cache_creation_input_tokens:1,output_tokens:0}}}),
  event('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}),event('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'回答 ✦'}}),event('content_block_stop',{type:'content_block_stop',index:0}),
  event('content_block_start',{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'call_a',name:'lookup',input:{}}}),event('content_block_delta',{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"id":3}'}}),event('content_block_stop',{type:'content_block_stop',index:1}),
  event('message_delta',{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:5}}),event('message_stop',{type:'message_stop'}),
 ],
 [responses]:[
  event('response.created',{type:'response.created',response:{id:'resp_a',model:'real-model',status:'in_progress'}}),
  event('response.output_item.added',{type:'response.output_item.added',output_index:0,item:{id:'msg_a',type:'message',role:'assistant',content:[]}}),
  event('response.content_part.added',{type:'response.content_part.added',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}}),
  event('response.output_text.delta',{type:'response.output_text.delta',output_index:0,content_index:0,delta:'回答 ✦'}),event('response.output_text.done',{type:'response.output_text.done',output_index:0,content_index:0,text:'回答 ✦'}),
  event('response.output_item.added',{type:'response.output_item.added',output_index:1,item:{type:'function_call',id:'fc_a',call_id:'call_a',name:'lookup',arguments:''}}),
  event('response.function_call_arguments.delta',{type:'response.function_call_arguments.delta',output_index:1,delta:'{"id":'}),event('response.function_call_arguments.delta',{type:'response.function_call_arguments.delta',output_index:1,delta:'3}'}),
  event('response.function_call_arguments.done',{type:'response.function_call_arguments.done',output_index:1,arguments:'{"id":3}'}),event('response.completed',{type:'response.completed',response:fixtures[responses]}),
 ],
};
function decodedEvents(body:string){return body.replaceAll('\r\n','\n').split('\n\n').filter(Boolean).map(e=>{const raw=e.split('\n').filter(l=>l.startsWith('data: ')).map(l=>l.slice(6)).join('\n');return raw==='[DONE]'?raw:JSON.parse(raw);});}
for(const source of [chat,responses,messages])for(const target of [chat,responses,messages].filter(t=>t!==source))test('SSE UTF-8 fragments preserve tools and terminal events '+source+' -> '+target,()=>{
 const converter=createStreamConverter(source,target,{model:'fallback',requestId:'request-a'}),chunks:Buffer[]=[];let beforeFinal=0;
 for(const [index,part]of streams[source].entries()){for(let i=0;i<part.length;i+=3)chunks.push(...converter.push(part.subarray(i,i+3)));if(index===0)beforeFinal=chunks.length;}
 chunks.push(...converter.finish());const body=Buffer.concat(chunks).toString(),events=decodedEvents(body);assert.ok(body.includes('call_a'));assert.ok(body.includes('lookup'));assert.ok(!body.includes('\ufffd'));
 if(target===responses){const done=events.at(-1);assert.equal(done.type,'response.completed');assert.equal(done.response.output.find((x:any)=>x.type==='function_call').arguments,'{"id":3}');assert.equal(done.response.usage.input_tokens,11);assert.ok(events.some(e=>e.type==='response.output_text.delta'));assert.deepEqual(events.map(e=>e.sequence_number),events.map((_,i)=>i));}
 else if(target===chat){assert.equal(events.at(-1),'[DONE]');const fragments=events.flatMap(e=>typeof e==='string'?[]:(e.choices??[]).flatMap((c:any)=>(c.delta?.tool_calls??[]).map((t:any)=>t.function?.arguments??'')));assert.equal(fragments.join(''),' {"id":3}'.trim());}
 else{assert.equal(beforeFinal,0);assert.equal(events[0].type,'message_start');assert.equal(events[0].message.usage.input_tokens+events[0].message.usage.cache_read_input_tokens+(events[0].message.usage.cache_creation_input_tokens??0),11);assert.equal(events.at(-1).type,'message_stop');assert.equal(events.find(e=>e.type==='message_delta').usage.output_tokens,5);}
});
test('missing usage remains unknown in Responses and explicitly fails Messages conversion',()=>{
 const value={id:'chat_a',model:'m',choices:[{index:0,message:{content:'hello'},finish_reason:'stop'}]};
 assert.equal(JSON.parse(convertJsonResponse(Buffer.from(JSON.stringify(value)),chat,responses,'m').toString()).usage,null);
 assert.throws(()=>convertJsonResponse(Buffer.from(JSON.stringify(value)),chat,messages,'m'),/conversion-usage-unavailable/);
});
test('duplicate keys, unsafe numeric parsing, opaque thinking and truncated streams fail explicitly',()=>{
 assert.throws(()=>strictJson('{"key":1,"key":2}'),/conversion-duplicate-key/);assert.throws(()=>strictJson('{"n":9007199254740993}'),/conversion-number-out-of-range/);
 assert.throws(()=>convertJsonResponse(Buffer.from(JSON.stringify({...fixtures[messages] as object,content:[{type:'thinking',thinking:'private',signature:'opaque'}]})),messages,chat,'m'),/conversion-content-unsupported/);
 const c=createStreamConverter(chat,responses,{model:'m'});c.push(streams[chat][0]);assert.throws(()=>c.finish(),/conversion-incomplete-stream/);
});
test('actual HTTP upstream error is translated without fabricating a success',()=>{
 const result=JSON.parse(convertJsonResponse(Buffer.from('{"error":{"type":"rate_limit_error","message":"try later"}}'),messages,responses,'m').toString());assert.equal(result.error.message,'try later');assert.equal(result.error.type,'rate_limit_error');assert.ok(!result.output);
});
test('new SDK config boundaries are typed, bounded and cannot carry credentials or unsafe endpoints',()=>{
 const rule={id:'r',enabled:true,priority:0,stage:'entry',field:'/reasoning/effort',match:{},action:{type:'override',value:'high'}};
 assert.doesNotThrow(()=>parseGatewayInput('gateway.rectifiers.replace',{sessionId:'s',expectedVersion:1,rectifiers:[rule]}));
 for(const changed of [{...rule,field:'/authorization'},{...rule,field:'/tools/*/cache_control',action:{type:'override',value:{type:'ephemeral'}}},{...rule,action:{type:'override',value:'x'.repeat(5000)}}])assert.throws(()=>parseGatewayInput('gateway.rectifiers.replace',{sessionId:'s',expectedVersion:1,rectifiers:[changed]}));
 assert.throws(()=>parseGatewayInput('gateway.agents.replace',{sessionId:'s',expectedVersion:1,agents:[{id:'a',name:'A',credentialRef:'p',providerIds:['p'],enabled:true,apiKey:'secret'}]}));
 assert.throws(()=>parseGatewayOutput('gateway.chain.snapshot',{snapshotId:'s',revision:0,traces:[],truncated:false,totals:{requests:0,rectified:0,rerouted:0,errors:0},body:'private'}));
});

test('cross-protocol response numbers reject exponent and decimal precision loss',()=>{
 for(const value of ['9007199254740993e0','9007199254740993.0','0.100000000000000001','1e-400'])assert.throws(()=>strictJson('{"value":'+value+'}'),/conversion-number-out-of-range/);
 for(const value of ['1e3','0.10','1e-7','-0','1.2300'])assert.equal((strictJson('{"value":'+value+'}') as any).value,Number(value));
});


for(const reason of ['stop','length','tool_calls'])test('compatible Chat stream uses explicit finish reason at clean EOF: '+reason,()=>{
 const converter=createStreamConverter(chat,responses,{model:'fixture-deepseek'}),chunks:Buffer[]=[];
 const parts=[Buffer.from(': keep-alive\r\n\r\n'),event('',{id:'deepseek_fixture',model:'fixture-deepseek',choices:[{index:0,delta:{content:reason==='tool_calls'?null:'实际回答'},finish_reason:null}]}),
  ...(reason==='tool_calls'?[event('',{choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_d',type:'function',function:{name:'lookup',arguments:'{"id":1}'}}]},finish_reason:null}]})]:[]),
  Buffer.from('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:reason}],usage:{prompt_tokens:19,completion_tokens:7,prompt_tokens_details:{cached_tokens:3}}}))];
 for(const part of parts)for(let i=0;i<part.length;i+=3)chunks.push(...converter.push(part.subarray(i,i+3)));
 chunks.push(...converter.finish());const events=decodedEvents(Buffer.concat(chunks).toString()),done=events.at(-1);
 assert.equal(done.type,reason==='length'?'response.incomplete':'response.completed');assert.equal(done.response.usage.input_tokens,19);assert.equal(done.response.usage.output_tokens,7);assert.equal(done.response.usage.input_tokens_details.cached_tokens,3);
 if(reason==='tool_calls')assert.equal(done.response.output[0].call_id,'call_d');
 else assert.equal(done.response.output[0].content[0].text,'实际回答');
 assert.deepEqual(events.map(e=>e.sequence_number),events.map((_,i)=>i));
});
test('Chat EOF cannot fabricate completion from a DONE marker, keep-alive, or partial output',()=>{
 for(const parts of [[event('','[DONE]')],[Buffer.from(': keep-alive\n\n')],[streams[chat][0]],[streams[chat][0],event('','[DONE]')]]){
  const converter=createStreamConverter(chat,responses,{model:'m'});assert.throws(()=>{for(const part of parts)converter.push(part);converter.finish();},/conversion-incomplete-stream/);
 }
});
