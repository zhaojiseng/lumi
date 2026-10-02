import {Buffer} from 'node:buffer';
import type {LocalSessionEvent,LocalSessionMetadata,Tool} from '../../shared/types';

const PREVIEW_BYTES=32*1024,DETAIL_BYTES=1024,DETAIL_TOTAL_BYTES=8*1024,PROMPT_CHARACTERS=320;
type RecordValue=Record<string,any>;
const record=(value:unknown):RecordValue=>value!==null && typeof value==='object' && !Array.isArray(value) ? value as RecordValue : {};
const string=(value:unknown):string|undefined=>typeof value==='string' && value.trim() ? value : undefined;
const firstString=(...values:unknown[])=>values.map(string).find(value=>value!==undefined);
const characters=(value:string,limit:number)=>Array.from(value.slice(0,limit*2)).slice(0,limit).join('');

/** Inspect at most a bounded prefix, and never cut a UTF-8 character in half. */
function clip(value:string,bytes:number):{text:string;truncated:boolean}{
  const prefix=value.slice(0,bytes),buffer=Buffer.from(prefix);
  let end=Math.min(bytes,buffer.length);
  while(end>0 && end<buffer.length && (buffer[end]&0xc0)===0x80)end--;
  return {text:buffer.subarray(0,end).toString('utf8'),truncated:prefix.length<value.length || end<buffer.length};
}

class Preview {
  text='';truncated=false;remaining=PREVIEW_BYTES;
  append(value:string){
    const part=clip(value,this.remaining);this.text+=part.text;
    this.remaining-=Buffer.byteLength(part.text);this.truncated ||= part.truncated;
  }
  section(value:string){if(this.text)this.append('\n\n');this.append(value);}
}

const IMAGE_TYPES=new Set(['image','input_image','output_image','image_url']);
const FILE_TYPES=new Set(['attachment','file','input_file','document','audio','input_audio','output_audio','video']);
function attachment(value:RecordValue):string|undefined {
  if(!IMAGE_TYPES.has(value.type) && !FILE_TYPES.has(value.type))return;
  const source=record(value.source),file=record(value.file);
  const name=firstString(value.filename,value.file_name,value.name,value.title,file.filename);
  const mime=firstString(value.mime_type,value.media_type,source.media_type,source.mime_type);
  return (IMAGE_TYPES.has(value.type) ? '[图片附件' : '[附件')+
    (name ? ': '+clip(name,256).text : '')+(mime ? ' ('+clip(mime,128).text+')' : '')+']';
}

/** Only selected content/arguments reach this writer; it never serializes an event. */
function describe(value:unknown,preview:Preview,depth=0,budget={nodes:256},seen=new WeakSet<object>(),quoted=false):void {
  if(!preview.remaining){preview.truncated=true;return;}
  if(--budget.nodes<0 || depth>6){preview.append('[更多内容见原始数据]');preview.truncated=true;return;}
  if(typeof value==='string'){
    if(!quoted){preview.append(value);return;}
    const part=clip(value,preview.remaining);
    preview.append(JSON.stringify(part.text));preview.truncated ||= part.truncated;return;
  }
  if(value===null || typeof value==='number' || typeof value==='boolean'){preview.append(String(value));return;}
  if(typeof value!=='object'){preview.append('[无内容]');return;}
  const media=attachment(record(value));if(media){preview.append(media);return;}
  if(seen.has(value)){preview.append('[循环引用]');preview.truncated=true;return;}
  seen.add(value);
  const array=Array.isArray(value);preview.append(array ? '[' : '{');let count=0;
  // Stop both traversal and allocation once the preview/node budget is exhausted.
  for(const key in value){
    if(!Object.hasOwn(value,key))continue;
    if(!preview.remaining || budget.nodes<=0){preview.truncated=true;break;}
    if(count++)preview.append(', ');
    if(!array)preview.append(JSON.stringify(clip(key,128).text)+': ');
    if(/^(?:data|base64|b64_json|file_data|image_url|encrypted_content|signature)$/i.test(key))preview.append('[原始数据]');
    else describe((value as RecordValue)[key],preview,depth+1,budget,seen,true);
  }
  preview.append(array ? ']' : '}');seen.delete(value);
}

const INJECTED_TAGS='environment_context|system-reminder|system_reminder|developer_instructions|user_instructions|instructions|permissions|turn_aborted|local-command-caveat|local-command-stdout';
function promptText(value:string):string {
  let text=value;
  if(/^\s*#\s*AGENTS\.md instructions\b/i.test(text)){
    if(!/<instructions\b/i.test(text))return '';
    text=text.replace(/^\s*#\s*AGENTS\.md instructions[^\r\n]*(?:\r?\n)?/i,'');
  }
  text=text.replace(new RegExp('<('+INJECTED_TAGS+')\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>','gi'),'');
  // An unfinished context block is still injected context, never a fallback title.
  text=text.replace(new RegExp('<(?:'+INJECTED_TAGS+')\\b[\\s\\S]*$','gi'),'');
  if(/^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/i.test(text))return '';
  if(/^\s*# Context from my IDE:/i.test(text)){
    const marker=/## My request for Codex:\s*/i.exec(text);if(!marker)return '';
    text=text.slice(marker.index+marker[0].length);
  }
  return text.replace(/\s+/g,' ').trim();
}

function firstPrompt(content:unknown):string|undefined {
  let result='',nodes=0;
  function visit(value:unknown,depth=0):void {
    if(depth>6 || ++nodes>256 || Array.from(result).length>=PROMPT_CHARACTERS)return;
    if(typeof value==='string'){
      const text=promptText(value);if(text)result=characters(result+(result ? ' ' : '')+characters(text,PROMPT_CHARACTERS),PROMPT_CHARACTERS);
    }else if(Array.isArray(value)){
      for(const item of value){visit(item,depth+1);if(nodes>=256 || Array.from(result).length>=PROMPT_CHARACTERS)break;}
    }else{
      const block=record(value);
      if(['text','input_text','output_text'].includes(block.type))visit(block.text,depth+1);
    }
  }
  visit(content);return result || undefined;
}

function projectFromCwd(cwd:string|undefined):string|undefined {
  const path=cwd?.replace(/[\\/]+$/,'');
  return path && !/^[a-z]:$/i.test(path) ? path.split(/[\\/]/).at(-1) || undefined : undefined;
}

/** Pure metadata accumulation. `title` is explicit; `firstPrompt` is the title fallback. */
export function updateSessionMetadata(tool:Tool,event:any,current:LocalSessionMetadata):LocalSessionMetadata {
  const root=record(event),payload=record(root.payload),meta=record(root.metadata),payloadMeta=record(payload.metadata);
  const next={...current},sessionMeta=tool==='codex' && root.type==='session_meta';
  const claudeName=tool==='claude' && ['custom-title','custom_title','session-name','session_name'].includes(root.type);
  const codexName=tool==='codex' && (sessionMeta || /^(?:session|thread)[_-](?:name|title)(?:[_-]updated)?$/.test(firstString(payload.type,root.type) || ''));
  const explicitTitle=tool==='claude'
    ? firstString(root.customTitle,root.custom_title,root.sessionName,root.session_name,claudeName ? root.title : undefined,claudeName ? root.name : undefined,payload.customTitle,payload.sessionName,claudeName ? payload.title : undefined,claudeName ? payload.name : undefined)
    : firstString(codexName ? payload.title : undefined,payload.thread_name,payload.thread_title,payload.session_title,codexName ? payload.name : undefined,codexName ? root.title : undefined,root.thread_name,codexName ? root.name : undefined,codexName ? meta.title : undefined,meta.thread_name,codexName ? meta.name : undefined,codexName ? payloadMeta.title : undefined,payloadMeta.thread_name,codexName ? payloadMeta.name : undefined);
  if(explicitTitle)next.title=characters(explicitTitle.trim(),PROMPT_CHARACTERS);
  const cwd=firstString(payload.cwd,root.cwd,payloadMeta.cwd,meta.cwd);
  if(cwd)next.cwd=clip(cwd,2048).text;
  const project=firstString(payload.project,root.project,record(payload.project).name,record(root.project).name,payloadMeta.project,meta.project);
  if(project)next.project=clip(project,512).text;
  else if(!next.project || cwd && current.project===projectFromCwd(current.cwd)){
    const derived=projectFromCwd(next.cwd);if(derived)next.project=derived;
  }
  const branch=firstString(payload.gitBranch,payload.git_branch,record(payload.git).branch,root.gitBranch,root.git_branch,record(root.git).branch,payloadMeta.gitBranch,meta.gitBranch);
  const version=firstString(payload.cli_version,payload.version,root.version,root.cli_version,meta.version);
  const sessionKey=firstString(sessionMeta ? payload.id : undefined,payload.sessionKey,payload.session_id,payload.sessionId,payload.thread_id,root.sessionKey,root.sessionId,root.session_id,root.thread_id,meta.session_id);
  const source=firstString(payload.source,root.source,payloadMeta.source,meta.source,record(payload.source).subagent ? 'subagent' : undefined,sessionMeta ? payload.originator : undefined);
  if(branch)next.gitBranch=clip(branch,512).text;
  if(version)next.version=clip(version,128).text;
  if(sessionKey)next.sessionKey=clip(sessionKey,512).text;
  if(source)next.source=clip(source,512).text;
  if(!next.firstPrompt && !(root.isMeta || root.is_meta || root.isSynthetic || root.is_synthetic || root.isCompactSummary || root.is_compact_summary || payload.isMeta || payload.is_meta || payload.isSynthetic || payload.is_synthetic)){
    let prompt:string|undefined;
    if(tool==='codex' && root.type==='response_item' && payload.type==='message' && payload.role==='user')prompt=firstPrompt(payload.content);
    else if(tool==='codex' && root.type==='event_msg' && payload.type==='user_message')prompt=firstPrompt(payload.message ?? payload.text);
    else if(tool==='claude' && root.type==='user' && (!record(root.message).role || root.message.role==='user'))prompt=firstPrompt(record(root.message).content);
    if(prompt)next.firstPrompt=prompt;
  }
  return next;
}

const DETAIL_FIELDS=['id','uuid','sessionId','session_id','thread_id','parentUuid','parent_tool_use_id','model','cwd','project','gitBranch','git_branch','version','cli_version','source','originator','role','phase','channel','status','subtype','stop_reason','stop_sequence','call_id','tool_use_id','name','is_error','isApiErrorMessage','error_code','code','exit_code','duration_ms','reasoning_effort','effort'] as const;
const TOKEN_FIELDS=['input_tokens','output_tokens','total_tokens','cached_input_tokens','cache_read_input_tokens','cache_creation_input_tokens','reasoning_output_tokens'] as const;
function scalar(value:unknown):string|undefined {
  if(typeof value==='string')return value;
  if(typeof value==='boolean' || typeof value==='number' && Number.isFinite(value))return String(value);
}

class Details {
  items:LocalSessionEvent['details']=[];truncated=false;private bytes=0;
  add(label:string,value:unknown){
    const text=scalar(value);if(text===undefined || !text)return;
    if(this.items.some(item=>item.label===label && item.value===text))return;
    if(this.items.length>=48 || this.bytes>=DETAIL_TOTAL_BYTES){this.truncated=true;return;}
    const part=clip(text,Math.min(DETAIL_BYTES,DETAIL_TOTAL_BYTES-this.bytes));
    this.items.push({label,value:part.text});this.bytes+=Buffer.byteLength(part.text);this.truncated ||= part.truncated;
  }
  metadata(value:RecordValue,prefix=''){
    for(const key of DETAIL_FIELDS)this.add(prefix+key,value[key]);
    for(const group of ['usage','total_token_usage','last_token_usage']){
      const usage=record(value[group]);for(const key of TOKEN_FIELDS)this.add(prefix+group+'.'+key,usage[key]);
    }
    this.add(prefix+'git.branch',record(value.git).branch);
  }
}

function timestamp(...values:unknown[]):number|undefined {
  for(const value of values){
    // Seconds match the other local-session timestamps; tolerate millisecond producers.
    if(typeof value==='number' && Number.isFinite(value)){const seconds=value>1e11 ? value/1000 : value;if(Number.isFinite(new Date(seconds*1000).getTime()))return seconds;}
    if(typeof value==='string'){const ms=Date.parse(value);if(Number.isFinite(ms))return ms/1000;}
  }
}

const CALL_TYPES=new Set(['function_call','custom_tool_call','tool_use']);
const RESULT_TYPES=new Set(['function_call_output','custom_tool_call_output','tool_result']);
const REASON_TYPES=new Set(['reasoning','thinking','redacted_thinking','agent_reasoning']);
const role=(value:unknown):LocalSessionEvent['role']=>value==='user' || value==='assistant' || value==='tool' || value==='system' ? value : value==='developer' ? 'system' : 'event';
function hasFields(value:RecordValue):boolean {for(const key in value)if(Object.hasOwn(value,key))return true;return false;}

/**
 * Bounded, inert display data. Both Codex message sources are returned independently:
 * the caller chooses canonical events/associations. Raw byte counts belong to the
 * file reader, so this helper deliberately leaves `rawBytes` unset.
 */
export function parseSessionEvent(tool:Tool,event:any,id:string):LocalSessionEvent {
  const root=record(event),wrapped=tool==='codex' && ['response_item','event_msg','session_meta','turn_context'].includes(root.type);
  const body=wrapped ? record(root.payload) : root,message=record(body.message);
  const type=firstString(body.type,root.type) || 'unknown',preview=new Preview(),details=new Details();
  details.add('type',wrapped && type!==root.type ? root.type+'.'+clip(type,128).text : type);
  details.metadata(root);if(wrapped)details.metadata(body,'payload.');
  details.metadata(message,'message.');details.metadata(record(body.metadata),'metadata.');
  details.metadata(record(root.metadata),'metadata.');details.metadata(record(body.info),'info.');
  details.metadata(record(root.toolUseResult),'toolUseResult.');
  const parsed:LocalSessionEvent={id,role:'event',kind:clip(type,128).text,text:'',details:details.items};
  const createdAt=timestamp(root.timestamp,root.created_at,root.createdAt,body.timestamp,message.timestamp);
  if(createdAt!==undefined)parsed.createdAt=createdAt;
  const kinds=new Set<string>();let contentNodes=0;
  function content(value:unknown,depth=0,context='message'):void {
    if(depth>6 || ++contentNodes>256){preview.section('[更多内容见原始数据]');preview.truncated=true;return;}
    if(!preview.remaining){preview.truncated=true;return;}
    if(typeof value==='string'){kinds.add(context);preview.section(value);return;}
    if(Array.isArray(value)){
      for(let index=0;index<value.length;index++){
        content(value[index],depth+1,context);
        if(!preview.remaining || contentNodes>=256){preview.truncated ||= index<value.length-1;break;}
      }
      return;
    }
    const block=record(value),blockType=block.type,media=attachment(block);
    if(media){kinds.add('attachment');preview.section(media);return;}
    if(REASON_TYPES.has(blockType)){
      kinds.add('reasoning');preview.section('[思考]');
      if(blockType==='redacted_thinking'){preview.append('\n[已隐藏的思考内容]');return;}
      const text=block.thinking ?? block.text;
      if(text!==undefined)content(text,depth+1,'reasoning');
      if(block.summary!==undefined)content(block.summary,depth+1,'reasoning');
      if(block.content!==undefined && block.content!==block.summary)content(block.content,depth+1,'reasoning');
      if(block.encrypted_content)preview.section('[加密思考内容，见原始数据]');
      return;
    }
    if(CALL_TYPES.has(blockType)){
      kinds.add('tool_call');const name=firstString(block.name,block.tool_name),call=firstString(block.call_id,block.id);
      parsed.toolName ??= name ? clip(name,256).text : undefined;parsed.toolCallId ??= call ? clip(call,512).text : undefined;
      details.add('toolName',name);details.add('toolCallId',call);
      preview.section('[工具调用'+(name ? ': '+clip(name,256).text : '')+']');
      const input=block.arguments ?? block.input ?? block.parameters;
      if(input!==undefined){preview.append('\n');describe(input,preview);}
      return;
    }
    if(RESULT_TYPES.has(blockType)){
      kinds.add(block.is_error ? 'error' : 'tool_result');
      const call=firstString(block.call_id,block.tool_use_id),name=firstString(block.name,block.tool_name);
      parsed.toolCallId ??= call ? clip(call,512).text : undefined;parsed.toolName ??= name ? clip(name,256).text : undefined;
      details.add('toolCallId',call);details.add('toolName',name);details.add('is_error',block.is_error);
      preview.section(block.is_error ? '[工具错误]' : '[工具结果]');
      const output=block.output ?? block.content ?? block.result;
      if(output!==undefined){if(Array.isArray(output))content(output,depth+1,'tool_result');else{preview.append('\n');describe(output,preview);}}
      return;
    }
    if(blockType==='error'){
      kinds.add('error');preview.section('[错误]');preview.append('\n');
      describe(block.error ?? block.message ?? block.text,preview);return;
    }
    if(blockType==='message'){content(block.content,depth+1,context);return;}
    if(['text','input_text','output_text','summary_text','reasoning_text','refusal'].includes(blockType)){
      if(blockType==='reasoning_text')kinds.add('reasoning');
      else kinds.add(context);
      const text=block.text ?? block.refusal;if(typeof text==='string')preview.section(text);return;
    }
    if(blockType || hasFields(block)){
      preview.section('['+clip(firstString(blockType) || '内容',128).text+']');
      const text=firstString(block.text,block.message,block.summary,block.description);
      if(text){preview.append('\n');preview.append(text);}
    }
  }

  if(CALL_TYPES.has(type) || RESULT_TYPES.has(type) || REASON_TYPES.has(type)){
    parsed.role=RESULT_TYPES.has(type) ? 'tool' : 'assistant';content(body);
  }else if(IMAGE_TYPES.has(type) || FILE_TYPES.has(type)){
    parsed.role=role(body.role);content(body);
  }else if(type==='message' || tool==='claude' && ['user','assistant'].includes(type)){
    parsed.role=role(body.role ?? message.role ?? type);content(body.content ?? message.content);
  }else if(['user_message','agent_message'].includes(type)){
    parsed.role=type==='user_message' ? 'user' : 'assistant';content(body.message ?? body.text);
    for(const [field,mediaType] of [['images','image'],['attachments','attachment']]){
      const media=body[field];if(!Array.isArray(media))continue;
      for(let index=0;index<media.length;index++){
        const item=record(media[index]);content({type:mediaType,filename:item.filename,name:item.name,mime_type:item.mime_type,source:item.source});
        if(!preview.remaining || contentNodes>=256){preview.truncated ||= index<media.length-1;break;}
      }
    }
  }else if(type==='error' || body.isApiErrorMessage || body.is_error || body.error!==undefined || type==='result' && /^error/.test(body.subtype ?? '')){
    parsed.role=role(body.role ?? message.role ?? (tool==='claude' && type==='assistant' ? 'assistant' : 'event'));kinds.add('error');
    const error=body.error ?? body.errors ?? body.message ?? body.content ?? body.result;
    preview.section('[错误]');if(error!==undefined){preview.append('\n');describe(error,preview);}
  }else{
    parsed.role=['system','session_meta','turn_context'].includes(root.type) ? 'system' : role(body.role);
    const data=record(body.data),summary=firstString(body.text,body.message,body.summary,body.description,body.result,data.text,data.message,root.summary);
    preview.section('['+clip(type,128).text+']');if(summary){preview.append('\n');preview.append(summary);}
    if(!summary){const status=firstString(body.status,body.subtype,body.name,data.type);if(status){preview.append('\n');preview.append(status);}}
  }
  if(kinds.has('error') || body.isApiErrorMessage || body.is_error)parsed.kind='error';
  else if(kinds.has('tool_call') && !kinds.has('message'))parsed.kind='tool_call';
  else if(kinds.has('tool_result'))parsed.kind='tool_result';
  else if(kinds.has('reasoning') && (REASON_TYPES.has(type) || !kinds.has('message')))parsed.kind='reasoning';
  else if(kinds.has('message'))parsed.kind='message';
  else if(kinds.has('attachment'))parsed.kind='attachment';
  if(parsed.role==='user' && (kinds.has('tool_result') || kinds.has('error')))parsed.role='tool';
  if(!preview.text)preview.append('['+clip(type,128).text+']');
  parsed.text=preview.text;if(preview.truncated || details.truncated)parsed.truncated=true;
  return parsed;
}
