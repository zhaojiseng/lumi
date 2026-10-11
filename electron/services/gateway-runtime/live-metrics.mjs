// Read-only live summaries. Payloads are parsed transiently and never retained in snapshots.
import {randomUUID} from 'node:crypto';
import {strictJson} from './protocol.mjs';
const WINDOW=5000,MAX_EVENT=256*1024,MAX_JSON=8*1024*1024,MAX_SAMPLES=4096;
const endpoints=new Set(['/v1/responses','/v1/chat/completions','/v1/messages']);
const chars=value=>{if(typeof value!=='string')return 0;let count=0;for(const _ of value)count++;return count;};
export function emptyOutputRateWindow(elapsedMs=0){return {windowMs:WINDOW,coveredMs:Math.min(WINDOW,Math.max(0,Math.floor(elapsedMs))),outputChars:null,charsPerSecond:null,source:'unavailable'};}
function streamChars(value,endpoint){
 if(endpoint==='/v1/responses'){
  if(['response.output_text.delta','response.refusal.delta','response.function_call_arguments.delta','response.reasoning_summary_text.delta'].includes(value?.type)&&typeof value.delta==='string')return chars(value.delta);
 }else if(endpoint==='/v1/messages'){
  if(value?.type==='content_block_delta'){
   const delta=value.delta;
   if(delta?.type==='text_delta'&&typeof delta.text==='string')return chars(delta.text);
   if(delta?.type==='input_json_delta'&&typeof delta.partial_json==='string')return chars(delta.partial_json);
   if(delta?.type==='thinking_delta'&&typeof delta.thinking==='string')return chars(delta.thinking);
  }
  if(value?.type==='content_block_start'&&value.content_block?.type==='text'&&typeof value.content_block.text==='string')return chars(value.content_block.text);
 }else if(Array.isArray(value?.choices)){
  let total=0,known=false;
  for(const choice of value.choices){const delta=choice?.delta;if(!delta||typeof delta!=='object')continue;
   for(const field of ['content','refusal','reasoning_content'])if(typeof delta[field]==='string'){known=true;total+=chars(delta[field]);}
   for(const call of delta.tool_calls??[])if(typeof call?.function?.arguments==='string'){known=true;total+=chars(call.function.arguments);}
  }
  if(known)return total;
 }
 return null;
}
function jsonChars(value,endpoint){
 if(value?.error||typeof value!=='object')return null;
 if(endpoint==='/v1/responses'&&Array.isArray(value.output)){
  let total=0;for(const item of value.output){if(item.type==='function_call')total+=chars(item.arguments);for(const block of item.content??[])total+=chars(block.text??block.refusal);for(const block of item.summary??[])total+=chars(block.text);}return total;
 }
 if(endpoint==='/v1/messages'&&Array.isArray(value.content)){let total=0;for(const block of value.content){if(block.type==='text')total+=chars(block.text);else if(block.type==='thinking')total+=chars(block.thinking);else if(block.type==='tool_use'&&block.input)total+=chars(JSON.stringify(block.input));}return total;}
 if(endpoint==='/v1/chat/completions'&&Array.isArray(value.choices)){let total=0,known=false;for(const choice of value.choices){const message=choice?.message;if(!message)continue;known=true;for(const field of ['content','refusal','reasoning_content'])total+=chars(message[field]);for(const call of message.tool_calls??[])total+=chars(call?.function?.arguments);}return known?total:null;}
 return null;
}
/** Five-second trailing window of observed output Unicode code points, never estimated tokens. */
export function createOutputRateTracker(endpoint,{elapsed}={}){
 if(!endpoints.has(endpoint)||typeof elapsed!=='function')throw new TypeError('invalid-live-rate-input');
 let format='none',source='unavailable',known=false,invalid=false,ended=null,pending='',eventData=[],eventBytes=0,jsonBytes=0,overflowUntil=-1;
 const decoder=new TextDecoder('utf-8',{fatal:true}),jsonChunks=[],samples=[];
 const clock=()=>Math.max(0,Math.floor(elapsed()));
 function purge(at){while(samples.length&&samples[0].at<=at-WINDOW)samples.shift();}
 function add(count,at){if(count===null)return;known=true;purge(at);if(count===0)return;
  if(samples.at(-1)?.at===at)samples.at(-1).count+=count;else samples.push({at,count});
  if(samples.length>MAX_SAMPLES){samples.length=0;overflowUntil=at+WINDOW;}
 }
 function frame(at){if(eventData.length){const text=eventData.join('\n');if(text!=='[DONE]')add(streamChars(strictJson(text),endpoint),at);}eventData=[];eventBytes=0;}
 function line(text,at){if(text===''){frame(at);return;}if(text.startsWith(':'))return;if(text.startsWith('data:')){const data=text.slice(5).replace(/^ /,'');eventBytes+=Buffer.byteLength(data);if(eventBytes>MAX_EVENT)throw new Error();eventData.push(data);}}
 function consume(text,at){pending+=text;if(Buffer.byteLength(pending)>MAX_EVENT*2)throw new Error();while(true){const match=/\r\n|\n|\r/.exec(pending);if(!match||match[0]==='\r'&&match.index===pending.length-1)break;line(pending.slice(0,match.index),at);pending=pending.slice(match.index+match[0].length);}}
 function discard(){invalid=true;pending='';eventData=[];jsonChunks.length=0;samples.length=0;}
 return {
  begin({sse,json,encoded=false,successful=true}={}){format=successful&&!encoded?(sse?'sse':json?'json':'none'):'none';source=format==='sse'?'content-delta':format==='json'?'json-content':'unavailable';},
  push(chunk){if(invalid||ended!==null||format==='none')return;try{if(format==='sse')consume(decoder.decode(chunk,{stream:true}),clock());else {jsonBytes+=chunk.length;if(jsonBytes>MAX_JSON)throw new Error();jsonChunks.push(Buffer.from(chunk));}}catch{discard();}},
  finish(){if(ended!==null)return;const at=clock();try{if(!invalid&&format==='sse'){consume(decoder.decode(),at);if(pending.endsWith('\r'))pending=pending.slice(0,-1);if(pending)line(pending,at);frame(at);}else if(!invalid&&format==='json')add(jsonChars(strictJson(decoder.decode(Buffer.concat(jsonChunks))),endpoint),at);}catch{discard();}ended=at;pending='';eventData=[];jsonChunks.length=0;},
  snapshot(){const at=ended??clock(),result=emptyOutputRateWindow(at);purge(at);if(!known||invalid||at<overflowUntil||!result.coveredMs)return result;const count=samples.reduce((total,sample)=>total+sample.count,0);return {...result,outputChars:count,charsPerSecond:count*1000/result.coveredMs,source};}
 };
}
/** Keep all admitted live requests even when a long-running one outlives 64 completed requests. */
export function createTraceHistory({recordDto=value=>value,liveMetrics=()=>[]}={}){
 const snapshotId=randomUUID(),traces=new Map(),totals={requests:0,upstreamAttempts:0,rectified:0,rerouted:0,errors:0};let revision=0;
 function receive(event){let row=traces.get(event.id);if(!row){row={...event,events:[]};traces.set(event.id,row);totals.requests++;}
  if(event.phase==='upstream')totals.upstreamAttempts++;
  if(event.phase==='prepared'&&event.chain?.changes.some(change=>change.changed))totals.rectified++;
  if(event.phase==='finished'&&event.errorDelivered)totals.errors++;
  const {record,errorDelivered:_delivered,...safe}=event;Object.assign(row,safe);if(record)row.record=recordDto(record);
  row.events.push({phase:event.phase,elapsedMs:event.elapsedMs,errorCode:event.errorCode??null});if(row.events.length>8)row.events.shift();revision++;
  let finished=[...traces.values()].filter(value=>value.phase==='finished');while(finished.length>64){traces.delete(finished.shift().id);}
 }
 function snapshot(){const live=new Map(liveMetrics().map(value=>[value.id,value]));const list=[...traces.values()].reverse().map(row=>structuredClone({...row,...live.get(row.id)}));
  list.sort((a,b)=>Number(a.phase==='finished')-Number(b.phase==='finished'));const result={snapshotId,revision,traces:list,truncated:false,totals:{...totals}};
  const size=()=>Buffer.byteLength(JSON.stringify(result));
  while(size()>192*1024){const index=list.findLastIndex(row=>row.phase==='finished');if(index<0)break;list.splice(index,1);result.truncated=true;}
  if(size()>192*1024){result.truncated=true;for(const row of list){row.events=[];row.requestedModel=null;delete row.record;if(row.chain)row.chain={...row.chain,providerName:row.chain.providerId,upstreamModel:null,changes:[],changesTruncated:true};}}
  if(size()>192*1024)throw new Error('chain-snapshot-too-large');return result;
 }
 return {receive,snapshot};
}
