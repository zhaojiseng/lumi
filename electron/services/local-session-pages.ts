import {createHash,randomUUID} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import type {Tool,LocalSessionQuery,LocalSessionRecord,LocalSessionPage} from '../../shared/types';
import {resolveRange,statisticsFilters} from '../../shared/range';
import {appendedLines,codexDelta,type Counters} from './local-usage-lines';

export const LOCAL_PAGE_BYTES=2*1024*1024,LOCAL_PAGE_RECORDS=50;
type Cursor={sessionId:string;query:string;start:number;end:number;offset:number;dev:number;ino:number;size:number;mtimeMs:number;model:string;reasoning?:string;previous:Counters;signature:string;messages:Map<string,{signature:string;output:number}>;skipPartial:boolean;at:number;};
const count=(value:unknown)=>typeof value==='number' && Number.isFinite(value) && value>=0 ? value : 0;
const counts=(u:any):Counters=>({input:count(u.input_tokens),output:count(u.output_tokens),cache:count(u.cached_input_tokens ?? u.cache_read_input_tokens),write:count(u.cache_creation_input_tokens)});

/** Opaque cursors keep a fixed file/time snapshot; no prompts or file paths reach the renderer. */
export class LocalSessionPages {
  private sessions=new Map<string,{file:string;tool:Tool}>();
  private cursors=new Map<string,Cursor>();
  register(id:string,file:string,tool:Tool){this.sessions.delete(id);this.sessions.set(id,{file,tool});while(this.sessions.size>4000)this.sessions.delete(this.sessions.keys().next().value!);}
  async read(input:LocalSessionQuery):Promise<LocalSessionPage>{
    const entry=this.sessions.get(input.sessionId);if(!entry)throw new Error('会话尚未读取或已失效，请重新扫描。');
    const info=await lstat(entry.file);if(!info.isFile() || info.isSymbolicLink())throw new Error('会话文件已变化，请重新扫描。');
    const filters=statisticsFilters(input.query),query=JSON.stringify(input.query),now=Date.now();
    for(const [id,value] of this.cursors)if(now-value.at>15*60000)this.cursors.delete(id);
    const stored=input.cursor ? this.cursors.get(input.cursor) : undefined;
    if(input.cursor && (!stored || stored.sessionId!==input.sessionId || stored.query!==query))throw new Error('会话详情游标已失效，请重新打开。');
    const window=stored ? null : resolveRange(input.query,new Date(now));
    const cursor:Cursor=stored ? {...stored,previous:{...stored.previous},messages:new Map(stored.messages)} : {sessionId:input.sessionId,query,start:window!.start_timestamp,end:window!.end_timestamp,offset:0,dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,model:'unknown',previous:{input:0,output:0,cache:0,write:0},signature:'',messages:new Map(),skipPartial:false,at:now};
    if(info.dev!==cursor.dev || info.ino!==cursor.ino || info.size<cursor.size || info.size===cursor.size && info.mtimeMs!==cursor.mtimeMs)throw new Error('会话文件已被修改，请重新打开。');
    if(filters.tokenIds?.length)return {items:[],scannedBytes:cursor.size,totalBytes:cursor.size};
    const boundary=Math.min(cursor.size,cursor.offset+LOCAL_PAGE_BYTES),items:LocalSessionRecord[]=[];
    for await(const item of appendedLines(entry.file,cursor.offset,boundary,undefined,cursor.skipPartial)){
      if(item.discarded){cursor.offset=item.end;cursor.skipPartial=!item.complete;continue;}
      let event:any;
      try{event=JSON.parse(item.line);}catch{
        if(item.complete)cursor.offset=item.end;
        // At a page boundary retry a small partial line; at the fixed EOF the scan is done.
        else if(item.end===cursor.size)cursor.offset=item.end;
        else break;
        continue;
      }
      cursor.offset=item.end;
      let tokens:Counters,model:string,signature:string,context:number,recordId=input.sessionId+':'+item.end;
      if(entry.tool==='codex'){
        if(event.type==='turn_context'){
          cursor.model=event.payload?.model || cursor.model;
          cursor.reasoning=event.payload?.effort ?? event.payload?.reasoning_effort;
        }
        if(event.type!=='event_msg' || event.payload?.type!=='token_count' || !event.payload.info)continue;
        const usage=event.payload.info,total=usage.total_token_usage ? counts(usage.total_token_usage) : undefined,last=usage.last_token_usage ? counts(usage.last_token_usage) : undefined;
        if(!total && !last)continue;
        signature=event.timestamp+'|'+JSON.stringify(total || last);tokens=total ? codexDelta(total,cursor.previous,last) : last!;
        if(total)cursor.previous=total;context=last?.input ?? tokens.input;tokens={...tokens,input:Math.max(0,tokens.input-tokens.cache)};model=usage.model || cursor.model;
        if(signature===cursor.signature)continue;cursor.signature=signature;
      }else{
        if(event.type!=='assistant' || !event.message?.usage || event.isApiErrorMessage)continue;
        const key=event.message.id || event.uuid;if(typeof key!=='string')continue;
        tokens=counts(event.message.usage);context=tokens.input+tokens.cache+tokens.write;model=event.message.model || 'unknown';signature=JSON.stringify(tokens);
        const old=cursor.messages.get(key);if(old && (old.signature===signature || old.output>tokens.output))continue;
        cursor.messages.delete(key);cursor.messages.set(key,{signature,output:tokens.output});
        while(cursor.messages.size>256)cursor.messages.delete(cursor.messages.keys().next().value!);
        recordId=input.sessionId+':'+createHash('sha256').update(key).digest('hex');
      }
      const timestamp=Date.parse(event.timestamp)/1000;
      if(!Number.isFinite(timestamp) || timestamp<cursor.start || timestamp>=cursor.end+1 || filters.models?.length && !filters.models.includes(model) || !(tokens.input+tokens.output+tokens.cache+tokens.write))continue;
      const reasoning=event.payload?.info?.reasoning_effort ?? event.message?.reasoning_effort ?? event.reasoning_effort ?? cursor.reasoning;
      items.push({id:recordId,created_at:timestamp,model,inputTokens:tokens.input,outputTokens:tokens.output,cacheReadTokens:tokens.cache,cacheWriteTokens:tokens.write,contextTokens:context,...(typeof reasoning==='string' ? {reasoning:reasoning.slice(0,100)} : {})});
      if(items.length>=LOCAL_PAGE_RECORDS)break;
    }
    cursor.at=now;
    let nextCursor:string|undefined;
    if(cursor.offset<cursor.size){nextCursor=randomUUID();this.cursors.set(nextCursor,cursor);while(this.cursors.size>128)this.cursors.delete(this.cursors.keys().next().value!);}
    return {items,nextCursor,scannedBytes:cursor.offset,totalBytes:cursor.size};
  }
}
