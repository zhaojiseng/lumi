import test from 'node:test';
import assert from 'node:assert/strict';
import {createOutputRateTracker,createTraceHistory} from '../electron/services/gateway-runtime/live-metrics.mjs';
import {parseGatewayOutput} from '../shared/gateway-validation';
const event=(value:unknown)=>Buffer.from('data: '+JSON.stringify(value)+'\n\n');
const delta=(text:string)=>event({type:'response.output_text.delta',delta:text});
function tracker(endpoint='/v1/responses'){
 let at=0;const observer=createOutputRateTracker(endpoint,{elapsed:()=>at});observer.begin({sse:true});
 return {observer,at(value:number){at=value;},push(text:string,time:number){at=time;observer.push(delta(text));}};
}
test('5s trailing output window evicts old deltas, updates while idle and freezes when finished',()=>{
 const t=tracker();assert.equal(t.observer.snapshot().charsPerSecond,null);
 t.push('abcdefghij',1000);assert.equal(t.observer.snapshot().charsPerSecond,10);
 t.push('文😀',3000);t.at(6000);assert.deepEqual(t.observer.snapshot(),{windowMs:5000,coveredMs:5000,outputChars:2,charsPerSecond:0.4,source:'content-delta'});
 t.push('新',6200);assert.equal(t.observer.snapshot().charsPerSecond,0.6);t.at(8100);assert.equal(t.observer.snapshot().charsPerSecond,0.2);
 t.observer.finish();const end=t.observer.snapshot();t.at(30000);assert.deepEqual(t.observer.snapshot(),end);
});
test('character observations decode split Unicode/CRLF and do not count keep-alive, JSON metadata or SSE messages',()=>{
 const t=tracker();t.at(1000);t.observer.push(Buffer.from(': hello\r\n\r\ndata: [DONE]\r\n\r\n'));assert.equal(t.observer.snapshot().outputChars,null);
 const bytes=Buffer.from('event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"中😀e"}\r\n\r\n');
 for(let i=0;i<bytes.length;i++)t.observer.push(bytes.subarray(i,i+1));assert.equal(t.observer.snapshot().outputChars,3);
 t.observer.push(event({type:'response.completed',response:{output:[{content:[{text:'中😀e'}]}],usage:{output_tokens:400}}}));assert.equal(t.observer.snapshot().outputChars,3);
 t.at(6500);assert.equal(t.observer.snapshot().charsPerSecond,0);assert.equal(t.observer.snapshot().source,'content-delta');
});
test('Chat and Messages observe only generated text/tool/thinking deltas, without inventing token counts',()=>{
 const chat=tracker('/v1/chat/completions');chat.at(1000);
 chat.observer.push(event({choices:[{delta:{content:'答😀',reasoning_content:'想',tool_calls:[{id:'ignore id',function:{name:'ignore name',arguments:'{}'}}]}}],usage:{completion_tokens:999}}));
 assert.equal(chat.observer.snapshot().outputChars,5);assert.ok(!('outputTokens' in chat.observer.snapshot()));
 const messages=tracker('/v1/messages');messages.at(1000);messages.observer.push(event({type:'message_start',message:{usage:{output_tokens:1}}}));assert.equal(messages.observer.snapshot().outputChars,null);
 for(const d of [{type:'text_delta',text:'ab'},{type:'thinking_delta',thinking:'c'},{type:'input_json_delta',partial_json:'{}'},{type:'signature_delta',signature:'not output text'}])messages.observer.push(event({type:'content_block_delta',delta:d}));
 messages.observer.push(event({type:'message_delta',usage:{output_tokens:40}}));assert.equal(messages.observer.snapshot().outputChars,5);
});
test('successful JSON is measured once; failed/encoded/malformed/oversized data stays unavailable and never changes forwarding',()=>{
 for(const options of [{successful:false,sse:true},{encoded:true,sse:true},{json:true}]){
  let at=1000;const t=createOutputRateTracker('/v1/responses',{elapsed:()=>at});t.begin(options);t.push(options.json?Buffer.from('{broken'):delta('secret-body-not-in-summary'));t.finish();assert.equal(t.snapshot().source,'unavailable');
 }
 let at=1000;const t=createOutputRateTracker('/v1/responses',{elapsed:()=>at});t.begin({json:true});t.push(Buffer.from(JSON.stringify({output:[{type:'message',content:[{text:'真实😀'}]},{type:'function_call',arguments:'{}'}]})));t.finish();assert.equal(t.snapshot().outputChars,5);assert.equal(t.snapshot().source,'json-content');assert.ok(!JSON.stringify(t.snapshot()).includes('真实'));
 const invalid=tracker();invalid.at(1000);invalid.observer.push(Buffer.from('data: {"type":"response.output_text.delta","delta":"a","delta":"b"}\n\n'));assert.equal(invalid.observer.snapshot().outputChars,null);
 const huge=tracker();huge.at(1000);huge.observer.push(Buffer.alloc(600*1024,120));assert.equal(huge.observer.snapshot().outputChars,null);
});
test('rate observer has a bounded sample history and restores known measurements after overflow leaves the 5s window',()=>{
 const t=tracker();for(let i=1;i<=4100;i++)t.push('x',i);assert.equal(t.observer.snapshot().source,'unavailable');t.push('恢复',10000);assert.equal(t.observer.snapshot().outputChars,2);
});
const chain=(model='model-a')=>({providerId:'provider-a',providerName:'provider-a',requestedModel:model,upstreamModel:model,entryEndpoint:'/v1/responses',upstreamEndpoint:'/v1/responses',entryTier:{state:'missing'},configVersion:1,changes:[],changesTruncated:false,routeReason:'model-match'});
const trace=(id:string,phase='prepared')=>({id,startedAtMs:1,providerId:'provider-a',agentId:'agent-a',entryEndpoint:'/v1/responses',requestedModel:'model-a',phase,elapsedMs:1,httpStatus:null,errorCode:null,chain:chain()});
test('active traces survive later completed traffic; live clock/rate update without changing event counts or revision',()=>{
 let elapsed=2000;const history=createTraceHistory({liveMetrics:()=>[{id:'long',elapsedMs:elapsed,rateWindow:{windowMs:5000,coveredMs:Math.min(elapsed,5000),outputChars:4,charsPerSecond:4000/Math.min(elapsed,5000),source:'content-delta'}}]});
 history.receive(trace('long'));for(let i=0;i<100;i++)history.receive(trace('done-'+i,'finished'));
 const first=history.snapshot();parseGatewayOutput('gateway.chain.snapshot',first);assert.equal(first.traces.length,65);assert.equal(first.traces[0].id,'long');assert.equal(first.totals.requests,101);assert.equal(first.traces[0].elapsedMs,2000);
 elapsed=6000;const next=history.snapshot();assert.equal(next.revision,first.revision);assert.equal(next.traces[0].rateWindow!.charsPerSecond,0.8);assert.equal(next.traces[0].elapsedMs,6000);assert.deepEqual(next.totals,first.totals);
});
test('all 128 admitted live requests remain within the bounded snapshot, including worst-size model names and diagnostics',()=>{
 const history=createTraceHistory();for(let i=0;i<128;i++){const row=trace('live-'+i);row.chain={...chain('模'.repeat(256)),providerName:'名'.repeat(100),upstreamModel:'实'.repeat(256),changes:Array.from({length:16},(_,index)=>({stage:'model',field:'/metadata',ruleId:'rule-'+index,action:'override',changed:true}))} as any;row.requestedModel=row.chain.requestedModel;history.receive(row);}
 for(let i=0;i<70;i++)history.receive(trace('finished-'+i,'finished'));
 const value=history.snapshot();assert.equal(value.traces.filter(r=>r.phase!=='finished').length,128);assert.ok(Buffer.byteLength(JSON.stringify(value))<=192*1024);assert.equal(value.truncated,true);parseGatewayOutput('gateway.chain.snapshot',value);
});
test('strict window DTO rejects inconsistent rates and arbitrary metadata; old host traces without rateWindow remain valid',()=>{
 const history=createTraceHistory();history.receive(trace('legacy','finished'));const value=history.snapshot();parseGatewayOutput('gateway.chain.snapshot',value);
 for(const rateWindow of [{windowMs:5000,coveredMs:5000,outputChars:10,charsPerSecond:30,source:'content-delta'},{windowMs:4000,coveredMs:4000,outputChars:4,charsPerSecond:1,source:'content-delta'},{windowMs:5000,coveredMs:0,outputChars:0,charsPerSecond:0,source:'content-delta'},{windowMs:5000,coveredMs:5000,outputChars:null,charsPerSecond:null,source:'unavailable',body:'private'}])assert.throws(()=>parseGatewayOutput('gateway.chain.snapshot',{...value,traces:[{...value.traces[0],rateWindow}]}));
});
