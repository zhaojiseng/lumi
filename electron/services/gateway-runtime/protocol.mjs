// Protocol output conversion is bounded and explicit. Original upstream bytes are observed separately.
import {randomUUID} from 'node:crypto';
const CHAT='/v1/chat/completions',RESPONSES='/v1/responses',MESSAGES='/v1/messages';
const MAX_EVENT=256*1024,MAX_OUTPUT=8*1024*1024;
const failure=code=>Object.assign(new Error(code),{code,status:502});
const known=n=>Number.isSafeInteger(n)&&n>=0;
const nullable=n=>known(n)?n:null;

function decimalIdentity(raw){
 const [mantissa,power='0']=raw.toLowerCase().split('e');const negative=mantissa.startsWith('-');const unsigned=negative?mantissa.slice(1):mantissa;
 const point=unsigned.indexOf('.');let digits=unsigned.replace('.','').replace(/^0+/,'');if(!digits)return '0';
 let exponent=Number(power)-(point<0?0:unsigned.length-point-1);const trailing=/0+$/.exec(digits)?.[0].length??0;if(trailing){digits=digits.slice(0,-trailing);exponent+=trailing;}
 return (negative?'-':'')+digits+'e'+exponent;
}
/** Reject duplicate keys and lossy number parsing instead of silently changing provider content. */
export function strictJson(text){
 let i=0;
 const space=()=>{while(/[\t\r\n ]/.test(text[i]??'!'))i++;};
 function value(depth=0){
  if(depth>64)throw failure('conversion-invalid-response');space();const c=text[i];
  if(c==='"'){const start=i++;while(i<text.length){const c=text[i++];if(c==='\\'){i++;continue;}if(c==='"')return JSON.parse(text.slice(start,i));}throw failure('conversion-invalid-response');}
  if(c==='{'||c==='['){i++;space();const object=c==='{'?Object.create(null):[];const end=c==='{'?'}':']';const keys=new Set();
   if(text[i]===end){i++;return object;}
   while(i<text.length){space();if(c==='{'){if(text[i]!=='"')throw failure('conversion-invalid-response');const key=value(depth+1);if(keys.has(key))throw failure('conversion-duplicate-key');keys.add(key);space();if(text[i++]!==':')throw failure('conversion-invalid-response');object[key]=value(depth+1);}else object.push(value(depth+1));
    space();if(text[i]===end){i++;return object;}if(text[i++]!==',')throw failure('conversion-invalid-response');}
   throw failure('conversion-invalid-response');
  }
  for(const [literal,result]of [['true',true],['false',false],['null',null]])if(text.startsWith(literal,i)){i+=literal.length;return result;}
  const m=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));if(!m)throw failure('conversion-invalid-response');
  i+=m[0].length;const number=Number(m[0]);if(!Number.isFinite(number)||(Number.isInteger(number)&&!Number.isSafeInteger(number))||decimalIdentity(m[0])!==decimalIdentity(JSON.stringify(number)))throw failure('conversion-number-out-of-range');return number;
 }
 try{const parsed=value();space();if(i!==text.length)throw failure('conversion-invalid-response');return parsed;}catch(e){throw e?.code?e:failure('conversion-invalid-response');}
}
function usage(raw,source){
 if(!raw||typeof raw!=='object')return {input:null,output:null,cacheRead:null,cacheWrite:null};
 const input=nullable(source===CHAT?raw.prompt_tokens:raw.input_tokens),output=nullable(source===CHAT?raw.completion_tokens:raw.output_tokens);
 const cacheRead=nullable(source===MESSAGES?raw.cache_read_input_tokens:source===CHAT?raw.prompt_tokens_details?.cached_tokens:raw.input_tokens_details?.cached_tokens);
 const cacheWrite=source===MESSAGES?nullable(raw.cache_creation_input_tokens):null;
 // Anthropic's input_tokens excludes the reported cache buckets. Never add them twice.
 return {input:source===MESSAGES&&input!==null&&cacheRead!==null&&cacheWrite!==null?input+cacheRead+cacheWrite:input,output,cacheRead,cacheWrite};
}
function finishReason(reason,source,hasTools){
 if(source===CHAT){if(reason==='length')return 'length';if(reason==='tool_calls')return 'tool_calls';if(reason==='stop')return 'stop';}
 else if(source===MESSAGES){if(reason==='max_tokens')return 'length';if(reason==='tool_use')return 'tool_calls';if(['end_turn','stop_sequence'].includes(reason))return 'stop';}
 else if(reason==='completed')return hasTools?'tool_calls':'stop';else if(reason==='max_output_tokens')return 'length';
 throw failure('conversion-finish-unsupported');
}
function blocksFromJson(v,source){
 if(source===CHAT){
  if(!Array.isArray(v.choices)||v.choices.length!==1)throw failure('conversion-choice-unsupported');const m=v.choices[0].message;
  if(!m||m.reasoning_content!=null||m.audio!=null||m.refusal!=null)throw failure('conversion-content-unsupported');
  const blocks=[];if(typeof m.content==='string')blocks.push({kind:'text',text:m.content});else if(m.content!=null)throw failure('conversion-content-unsupported');
  for(const t of m.tool_calls??[]){if(t.type!=='function'||typeof t.id!=='string'||typeof t.function?.name!=='string'||typeof t.function?.arguments!=='string')throw failure('conversion-tool-unsupported');blocks.push({kind:'tool',id:t.id,name:t.function.name,args:t.function.arguments});}
  return blocks;
 }
 if(source===MESSAGES){
  if(!Array.isArray(v.content))throw failure('conversion-invalid-response');return v.content.map(b=>{
   if(b.type==='text'&&typeof b.text==='string')return {kind:'text',text:b.text};
   if(b.type==='tool_use'&&typeof b.id==='string'&&typeof b.name==='string'&&b.input&&typeof b.input==='object')return {kind:'tool',id:b.id,name:b.name,args:JSON.stringify(b.input)};
   throw failure('conversion-content-unsupported');
  });
 }
 if(!Array.isArray(v.output))throw failure('conversion-invalid-response');const blocks=[];
 for(const b of v.output){if(b.type==='message'){for(const c of b.content??[]){if(c.type!=='output_text'||typeof c.text!=='string'||(c.annotations?.length??0)>0)throw failure('conversion-content-unsupported');blocks.push({kind:'text',text:c.text});}}
  else if(b.type==='function_call'&&typeof b.call_id==='string'&&typeof b.name==='string'&&typeof b.arguments==='string')blocks.push({kind:'tool',id:b.call_id,name:b.name,args:b.arguments});
  else throw failure('conversion-content-unsupported');}
 return blocks;
}
function mappedUsage(u,target){
 if(u.input===null||u.output===null)return target===RESPONSES?null:undefined;
 if(target===MESSAGES){const v={input_tokens:u.input-(u.cacheRead??0)-(u.cacheWrite??0),output_tokens:u.output};if(v.input_tokens<0)throw failure('conversion-invalid-usage');if(u.cacheRead!==null)v.cache_read_input_tokens=u.cacheRead;if(u.cacheWrite!==null)v.cache_creation_input_tokens=u.cacheWrite;return v;}
 const v=target===CHAT?{prompt_tokens:u.input,completion_tokens:u.output,total_tokens:u.input+u.output}:{input_tokens:u.input,output_tokens:u.output,total_tokens:u.input+u.output};
 if(u.cacheRead!==null)v[target===CHAT?'prompt_tokens_details':'input_tokens_details']={cached_tokens:u.cacheRead};return v;
}
function encodeJson(c,target){
 if(target===CHAT){const calls=c.blocks.filter(b=>b.kind==='tool');const message={role:'assistant',content:c.blocks.filter(b=>b.kind==='text').map(b=>b.text).join('')||null};if(calls.length)message.tool_calls=calls.map(b=>({id:b.id,type:'function',function:{name:b.name,arguments:b.args}}));
  const result={id:c.id,object:'chat.completion',created:Math.floor(Date.now()/1000),model:c.model,choices:[{index:0,message,finish_reason:c.finish}]};const u=mappedUsage(c.usage,target);if(u)result.usage=u;return result;}
 if(target===MESSAGES){const u=mappedUsage(c.usage,target);if(!u)throw failure('conversion-usage-unavailable');return {id:c.id,type:'message',role:'assistant',model:c.model,content:c.blocks.map(b=>b.kind==='text'?{type:'text',text:b.text}:{type:'tool_use',id:b.id,name:b.name,input:strictJson(b.args||'{}')}),stop_reason:c.finish==='length'?'max_tokens':c.finish==='tool_calls'?'tool_use':'end_turn',stop_sequence:null,usage:u};}
 return {id:c.id,object:'response',created_at:Math.floor(Date.now()/1000),status:c.finish==='length'?'incomplete':'completed',error:null,incomplete_details:c.finish==='length'?{reason:'max_output_tokens'}:null,model:c.model,
  output:c.blocks.map((b,i)=>b.kind==='text'?{id:'msg_'+c.localId+'_'+i,type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:b.text,annotations:[]}]}:{id:'fc_'+c.localId+'_'+i,type:'function_call',status:'completed',call_id:b.id,name:b.name,arguments:b.args}),usage:mappedUsage(c.usage,target)};
}
export function convertJsonResponse(bytes,source,target,model){
 const v=strictJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(v?.error){const e=v.error;return Buffer.from(JSON.stringify(target===MESSAGES?{type:'error',error:{type:typeof e.type==='string'?e.type:'api_error',message:typeof e.message==='string'?e.message:'upstream-error'}}:{error:{type:typeof e.type==='string'?e.type:'upstream_error',message:typeof e.message==='string'?e.message:'upstream-error',...(typeof e.code==='string'?{code:e.code}:{})}}));}
 const blocks=blocksFromJson(v,source);const reason=source===CHAT?v.choices[0].finish_reason:source===MESSAGES?v.stop_reason:v.status==='incomplete'?v.incomplete_details?.reason:v.status;
 const c={id:typeof v.id==='string'?v.id:'lumi_'+randomUUID(),localId:randomUUID().replaceAll('-',''),model:typeof v.model==='string'?v.model:model,blocks,usage:usage(v.usage,source),finish:finishReason(reason,source,blocks.some(b=>b.kind==='tool'))};
 return Buffer.from(JSON.stringify(encodeJson(c,target)));
}
const sse=(name,value)=>Buffer.from((name?'event: '+name+'\n':'')+'data: '+(typeof value==='string'?value:JSON.stringify(value))+'\n\n');
export function conversionError(error,target){const code=/^[a-z][a-z0-9-]{0,63}$/.test(error?.code??'')?error.code:'conversion-failed';return target===MESSAGES?{type:'error',error:{type:'api_error',message:code}}:{error:{type:'gateway_conversion_error',code,message:code}};}

export function createStreamConverter(source,target,{model,requestId}={}){
 const localId=(requestId??randomUUID()).replaceAll('-',''),c={id:'lumi_'+localId,localId,model,blocks:[],usage:{input:null,output:null,cacheRead:null,cacheWrite:null},finish:null};
 const byKey=new Map();const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',eventName='',eventData=[],eventBytes=0,outputBytes=0,started=false,terminal=false,chatFinished=false,sequence=0;
 const outputs=[];
 function emit(name,v){if(target===RESPONSES&&v&&typeof v==='object')v.sequence_number=sequence++;outputs.push(sse(name,v));}
 function start(){if(started||target===MESSAGES)return;started=true;
  if(target===RESPONSES){const response={id:c.id,object:'response',status:'in_progress',model:c.model,output:[],usage:null,error:null,incomplete_details:null};emit('response.created',{type:'response.created',response});emit('response.in_progress',{type:'response.in_progress',response});}
  else emit('',{id:c.id,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:c.model,choices:[{index:0,delta:{role:'assistant'},finish_reason:null}]});
 }
 function block(key,kind,info={}){let b=byKey.get(key);if(b){if(b.kind!==kind)throw failure('conversion-invalid-response');return b;}b={kind,text:'',args:'',id:'',name:'',index:c.blocks.length,begun:false,...info};c.blocks.push(b);byKey.set(key,b);return b;}
 function begin(b){if(b.begun||target===MESSAGES)return;if(b.kind==='tool'&&(!b.id||!b.name))return;start();b.begun=true;
  if(target===RESPONSES){const item=b.kind==='text'?{id:'msg_'+localId+'_'+b.index,type:'message',status:'in_progress',role:'assistant',content:[]}:{id:'fc_'+localId+'_'+b.index,type:'function_call',status:'in_progress',call_id:b.id,name:b.name,arguments:''};b.itemId=item.id;
   emit('response.output_item.added',{type:'response.output_item.added',output_index:b.index,item});if(b.kind==='text')emit('response.content_part.added',{type:'response.content_part.added',item_id:b.itemId,output_index:b.index,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  }else if(b.kind==='tool')emit('',{id:c.id,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:c.model,choices:[{index:0,delta:{tool_calls:[{index:c.blocks.filter(x=>x.kind==='tool').indexOf(b),id:b.id,type:'function',function:{name:b.name,arguments:''}}]},finish_reason:null}]});
 }
 function add(b,fragment){if(typeof fragment!=='string')throw failure('conversion-invalid-response');outputBytes+=Buffer.byteLength(fragment);if(outputBytes>MAX_OUTPUT)throw failure('conversion-response-too-large');
  const wasBegun=b.begun;if(b.kind==='text')b.text+=fragment;else b.args+=fragment;begin(b);if(!b.begun||!fragment||target===MESSAGES)return;fragment=!wasBegun&&b.kind==='tool'?b.args:fragment;
  if(target===RESPONSES)emit(b.kind==='text'?'response.output_text.delta':'response.function_call_arguments.delta',{type:b.kind==='text'?'response.output_text.delta':'response.function_call_arguments.delta',item_id:b.itemId,output_index:b.index,...(b.kind==='text'?{content_index:0}:{}),delta:fragment});
  else emit('',{id:c.id,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:c.model,choices:[{index:0,delta:b.kind==='text'?{content:fragment}:{tool_calls:[{index:c.blocks.filter(x=>x.kind==='tool').indexOf(b),function:{arguments:fragment}}]},finish_reason:null}]});
 }
 function authoritative(b,full){if(typeof full!=='string')throw failure('conversion-invalid-response');const old=b.kind==='text'?b.text:b.args;if(!full.startsWith(old))throw failure('conversion-invalid-response');add(b,full.slice(old.length));}
 function complete(reason){if(terminal)throw failure('conversion-invalid-response');c.finish=finishReason(reason,source,c.blocks.some(b=>b.kind==='tool'));
  for(const b of c.blocks){if(b.kind==='tool'&&!b.args)b.args='{}';if(b.kind==='tool'&&(!b.id||!b.name))throw failure('conversion-invalid-response');begin(b);}
  if(target===MESSAGES){const message=encodeJson(c,target);emit('message_start',{type:'message_start',message:{...message,content:[],stop_reason:null,stop_sequence:null,usage:{...message.usage,output_tokens:0}}});
   // output_tokens=0 describes the empty message_start, not an unknown final usage.
   message.content.forEach((b,index)=>{emit('content_block_start',{type:'content_block_start',index,content_block:b.type==='text'?{type:'text',text:''}:{type:'tool_use',id:b.id,name:b.name,input:{}}});
    emit('content_block_delta',{type:'content_block_delta',index,delta:b.type==='text'?{type:'text_delta',text:b.text}:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}});emit('content_block_stop',{type:'content_block_stop',index});});
   emit('message_delta',{type:'message_delta',delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:message.usage.output_tokens}});emit('message_stop',{type:'message_stop'});
  }else if(target===CHAT){start();emit('',{id:c.id,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:c.model,choices:[{index:0,delta:{},finish_reason:c.finish}]});const u=mappedUsage(c.usage,target);if(u)emit('',{id:c.id,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:c.model,choices:[],usage:u});emit('','[DONE]');}
  else {start();const response=encodeJson(c,target);c.blocks.forEach((b,index)=>{const item=response.output[index];
    if(b.kind==='text'){emit('response.output_text.done',{type:'response.output_text.done',item_id:b.itemId,output_index:index,content_index:0,text:b.text});emit('response.content_part.done',{type:'response.content_part.done',item_id:b.itemId,output_index:index,content_index:0,part:item.content[0]});}
    else emit('response.function_call_arguments.done',{type:'response.function_call_arguments.done',item_id:b.itemId,output_index:index,arguments:b.args});emit('response.output_item.done',{type:'response.output_item.done',output_index:index,item});});
   const type=c.finish==='length'?'response.incomplete':'response.completed';emit(type,{type,response});
  }terminal=true;
 }
 function processEvent(){if(!eventData.length){eventName='';eventBytes=0;return;}const raw=eventData.join('\n'),name=eventName;eventName='';eventData=[];eventBytes=0;
  if(raw==='[DONE]'){if(source!==CHAT||!chatFinished)throw failure('conversion-incomplete-stream');complete(c.finish);return;}
  const v=strictJson(raw);if(v.error||v.type==='error')throw failure('conversion-upstream-error');if(terminal)throw failure('conversion-invalid-response');
  if(typeof v.id==='string'&&!started)c.id=v.id;if(typeof v.model==='string')c.model=v.model;
  if(source===CHAT){if(v.usage)c.usage=usage(v.usage,source);for(const choice of v.choices??[]){if(choice.index!==0)throw failure('conversion-choice-unsupported');const d=choice.delta??{};if(d.reasoning_content!=null||d.refusal!=null||d.audio!=null)throw failure('conversion-content-unsupported');if(typeof d.content==='string')add(block('text', 'text'),d.content);
    for(const t of d.tool_calls??[]){if(!Number.isSafeInteger(t.index)||t.index<0||t.index>128)throw failure('conversion-invalid-response');const b=block('tool-'+t.index,'tool');if(b.begun&&(t.id||t.function?.name))throw failure('conversion-tool-header-changed');if(t.id)b.id+=t.id;if(t.function?.name)b.name+=t.function.name;if(t.function?.arguments!=null)add(b,t.function.arguments);}
    if(choice.finish_reason!=null){c.finish=choice.finish_reason;chatFinished=true;}}
  }else if(source===MESSAGES){const type=v.type??name;
   if(type==='message_start'){const m=v.message;if(!m)throw failure('conversion-invalid-response');c.id=m.id??c.id;c.model=m.model??c.model;c.usage=usage(m.usage,source);}
   else if(type==='content_block_start'){const b=v.content_block;if(b?.type==='text')add(block('block-'+v.index,'text'),b.text??'');else if(b?.type==='tool_use'){const tool=block('block-'+v.index,'tool',{id:b.id,name:b.name});if(b.input&&Object.keys(b.input).length)add(tool,JSON.stringify(b.input));}else throw failure('conversion-content-unsupported');}
   else if(type==='content_block_delta'){const b=byKey.get('block-'+v.index);if(!b)throw failure('conversion-invalid-response');if(v.delta?.type==='text_delta'&&b.kind==='text')add(b,v.delta.text);else if(v.delta?.type==='input_json_delta'&&b.kind==='tool')add(b,v.delta.partial_json);else throw failure('conversion-content-unsupported');}
   else if(type==='message_delta'){if(v.usage?.output_tokens!=null)c.usage.output=nullable(v.usage.output_tokens);c.finish=v.delta?.stop_reason??c.finish;}
   else if(type==='message_stop')complete(c.finish);else if(!['content_block_stop','ping'].includes(type))throw failure('conversion-event-unsupported');
  }else {const type=v.type??name;
   if(['response.created','response.in_progress'].includes(type)){c.id=v.response?.id??c.id;c.model=v.response?.model??c.model;}
   else if(type==='response.output_item.added'){const item=v.item;if(item?.type==='message'){}else if(item?.type==='function_call')block('item-'+v.output_index,'tool',{id:item.call_id,name:item.name});else throw failure('conversion-content-unsupported');}
   else if(type==='response.content_part.added'){if(v.part?.type!=='output_text')throw failure('conversion-content-unsupported');block('item-'+v.output_index+'-content-'+v.content_index,'text');}
   else if(type==='response.output_text.delta')add(block('item-'+v.output_index+'-content-'+v.content_index,'text'),v.delta);
   else if(type==='response.output_text.done')authoritative(block('item-'+v.output_index+'-content-'+v.content_index,'text'),v.text);
   else if(type==='response.function_call_arguments.delta'){const b=byKey.get('item-'+v.output_index);if(!b)throw failure('conversion-invalid-response');add(b,v.delta);}
   else if(type==='response.function_call_arguments.done'){const b=byKey.get('item-'+v.output_index);if(!b)throw failure('conversion-invalid-response');authoritative(b,v.arguments);}
   else if(type==='response.output_item.done'){const item=v.item;if(item?.type==='function_call'){const b=byKey.get('item-'+v.output_index);if(!b)throw failure('conversion-invalid-response');authoritative(b,item.arguments);}}
   else if(['response.completed','response.incomplete'].includes(type)){const r=v.response;if(!r)throw failure('conversion-invalid-response');c.usage=usage(r.usage,source);if(c.blocks.length===0){for(const [index,b]of blocksFromJson(r,source).entries()){const actual=block('final-'+index,b.kind,b.kind==='tool'?{id:b.id,name:b.name}:{});add(actual,b.kind==='text'?b.text:b.args);}}
    complete(type==='response.incomplete'?r.incomplete_details?.reason:'completed');}
   else if(['response.failed','response.error'].includes(type))throw failure('conversion-upstream-error');else if(!['response.content_part.done'].includes(type))throw failure('conversion-event-unsupported');
  }
 }
 function line(value){if(value===''){processEvent();return;}if(value.startsWith(':'))return;if(value.startsWith('event:'))eventName=value.slice(6).trim();else if(value.startsWith('data:')){const v=value.slice(5).replace(/^ /,'');eventBytes+=Buffer.byteLength(v);if(eventBytes>MAX_EVENT)throw failure('conversion-event-too-large');eventData.push(v);}}
 function consume(text){pending+=text;if(Buffer.byteLength(pending)>MAX_EVENT*2)throw failure('conversion-event-too-large');while(true){const m=/\r\n|\n|\r/.exec(pending);if(!m)break;if(m[0]==='\r'&&m.index===pending.length-1)break;const value=pending.slice(0,m.index);pending=pending.slice(m.index+m[0].length);line(value);}}
 return {
  push(chunk){outputs.length=0;try{consume(decoder.decode(chunk,{stream:true}));}catch(e){throw e?.code?e:failure('conversion-invalid-response');}return [...outputs];},
  finish(){
   outputs.length=0;
   try{
    consume(decoder.decode());if(pending.endsWith('\r'))pending=pending.slice(0,-1);if(pending)line(pending);pending='';processEvent();
    // Compatible Chat providers may close cleanly after the finish-reason/usage frame.
    // EOF alone, a partial answer, or a bare DONE marker never proves completion.
    if(!terminal && source===CHAT && chatFinished)complete(c.finish);
    if(!terminal)throw failure('conversion-incomplete-stream');
   }catch(e){throw e?.code?e:failure('conversion-invalid-response');}
   return [...outputs];
  },
 };
}
