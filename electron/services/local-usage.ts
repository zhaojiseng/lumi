import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {LocalSessionPages} from './local-session-pages';
import {appendedLines,codexDelta,type Counters} from './local-usage-lines';
export {appendedLines,codexDelta} from './local-usage-lines';
import {resolveRange,statisticsFilters,isRollingRange} from '../../shared/range';
import type { DashboardQuery,LocalUsage, LocalUsageRow, LocalUsagePoint,LocalUsageProgress,LocalSessionSummary,LocalSessionQuery,Tool, SiteStatus } from '../../shared/types';
import type {UsagePriceFacts} from '../../shared/usage-pricing';
import {widgetPeriodWindow,type WidgetPeriod} from '../../shared/widget-period';
import type { WidgetUsage, WidgetMinute, WidgetModelUsage } from '../../shared/widget';
const n = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
function counters(u: any): Counters { return { input: n(u.input_tokens), output: n(u.output_tokens), cache: n(u.cached_input_tokens ?? u.cache_read_input_tokens), write: n(u.cache_creation_input_tokens) }; }
type LocalWidgetModel = WidgetModelUsage & {unknownRequests:number};
type LocalWidgetBucket = {start:number;end:number;quota:number;quotaKnown:boolean;unknownRequests:number;requests:number;models:Map<string,LocalWidgetModel>;latest?:WidgetModelUsage;latestTimestamp?:number;messages:Map<string,{model:string;count:Counters;timestamp:number;session:string;quota:number|null}>};
type LocalWidgetFile = {offset:number;size:number;mtimeMs:number;dev:number;ino:number;previous:Counters;model:string;session:string;lastSignature?:string;partialSize?:number;skipPartial?:boolean;lastCompact?:number;buckets:Map<number,LocalWidgetBucket>;messageMinutes:Map<string,number>};
export type LocalReadProgress=Omit<LocalUsageProgress,'requestId'>;
export interface LocalWidgetOptions {period?:WidgetPeriod;revision?:string;quote?:(tool:Tool,model:string,facts:UsagePriceFacts)=>number|null;}

async function walk(root: string, cutoff: number, warnings: string[], files: string[], depth = 0) {
  if (depth > 9 || files.length >= 2000) return;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (e: any) { if (e.code !== 'ENOENT') warnings.push(`无法读取目录：${root}`); return; }
  for (const e of entries) {
    if (files.length >= 2000) break;
    const p = path.join(root, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) await walk(p, cutoff, warnings, files, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try { const s = await stat(p); if (s.mtimeMs >= cutoff) files.push(p); } catch { warnings.push(`无法读取会话：${e.name}`); }
    }
  }
}
export class LocalUsageService {
  private sessionPages=new LocalSessionPages();
  sessionDetails(input:LocalSessionQuery){return this.sessionPages.read(input);}
  private cache = new Map<string, { at: number; data: LocalUsage }>();
  private inFlight = new Map<string, Promise<LocalUsage>>();
  private progress=new Map<string,LocalReadProgress>();
  private progressListeners=new Map<string,Set<(value:LocalReadProgress)=>void>>();
  private widgetFiles = new Map<string, LocalWidgetFile>();
  private widgetRevision:string|undefined;
  private widgetJob:Promise<unknown>=Promise.resolve();
  private home: string;
  private respectEnvironment: boolean;
  constructor(home?: string) { this.home = home || process.env.LUMI_TEST_HOME || os.homedir(); this.respectEnvironment = !home && !process.env.LUMI_TEST_HOME; }
  async scan(query: DashboardQuery,notify?:(value:LocalReadProgress)=>void): Promise<LocalUsage> {
    const key=JSON.stringify([isRollingRange(query) ? ['24h',new Date().toLocaleDateString('sv-SE')] : resolveRange(query).range,statisticsFilters(query)]);
    const cached = this.cache.get(key); if (cached && Date.now() - cached.at < 60000) {notify?.({phase:'complete',filesDone:cached.data.filesScanned,filesTotal:cached.data.filesScanned,bytesRead:0,bytesTotal:0});return cached.data;}
    const listeners=this.progressListeners.get(key) || new Set();if(notify)listeners.add(notify);this.progressListeners.set(key,listeners);
    if(this.progress.has(key))notify?.(this.progress.get(key)!);
    try{
      const existing=this.inFlight.get(key);if(existing)return await existing;
      const report=(value:LocalReadProgress)=>{this.progress.set(key,value);for(const listener of this.progressListeners.get(key) || []){try{listener({...value});}catch{/* Closed renderer. */}}};
      const request=this.read(query,report);this.inFlight.set(key,request);
      try {const data=await request;this.cache.set(key,{at:Date.now(),data});if(this.cache.size>12)this.cache.delete(this.cache.keys().next().value!);return data;}
      finally{this.inFlight.delete(key);this.progress.delete(key);}
    }finally{if(notify)listeners.delete(notify);if(!listeners.size)this.progressListeners.delete(key);}
  }
  /**
   * Incrementally read the completed and current session minutes. Each file
   * keeps an in-memory read cursor and at most thirty days of minute aggregates. The file is opened with flags:'r'; no
   * session file is ever locked for writing or modified by Lumi.
   */
  widgetUsage(now=Date.now(),options:LocalWidgetOptions={}):Promise<WidgetUsage> {
    const job=this.widgetJob.then(()=>this.readWidget(now,options));
    this.widgetJob=job.catch(()=>undefined);return job;
  }
  private async readWidget(now:number,options:LocalWidgetOptions):Promise<WidgetUsage> {
    if(this.widgetRevision!==options.revision){this.widgetFiles.clear();this.widgetRevision=options.revision;}
    const currentStart=Math.floor(now/60000)*60,targetStart=currentStart-60,cutoff=now-30*86400*1000;
    const warnings:string[]=[];
    const status:SiteStatus={system_name:'本地会话',version:'local',quota_per_unit:1,quota_display_type:'TOKEN'};
    const makeBucket=(start:number):LocalWidgetBucket=>({start,end:start+59,quota:0,quotaKnown:true,unknownRequests:0,requests:0,models:new Map(),messages:new Map()});
    const normalizeBuckets=(state:LocalWidgetFile)=>{
      for(const [start,bucket] of state.buckets){if(start<currentStart-30*86400 || start>currentStart)state.buckets.delete(start);else if(start<currentStart-3600)bucket.messages.clear();}
      for(const [key,start] of state.messageMinutes)if(!state.buckets.get(start)?.messages.has(key))state.messageMinutes.delete(key);
    };
    const bucketFor=(state:LocalWidgetFile,timestamp:number)=>{
      const start=Math.floor(timestamp/60)*60;if(start>currentStart)return undefined;
      if(start>(state.lastCompact || 0)+3600){for(const bucket of state.buckets.values())if(bucket.start<start-3600)bucket.messages.clear();state.lastCompact=start;}
      if(start===currentStart || start===targetStart){let bucket=state.buckets.get(start);if(!bucket){bucket=makeBucket(start);state.buckets.set(start,bucket);}return bucket;}
      if(start<currentStart-30*86400)return undefined;
      let bucket=state.buckets.get(start);if(!bucket){bucket=makeBucket(start);state.buckets.set(start,bucket);}return bucket;
    };
    const currentTimestamp=(bucket:LocalWidgetBucket)=>bucket.latestTimestamp || 0;
    const setLatest=(bucket:LocalWidgetBucket,model:string,count:Counters,timestamp:number,quota:number|null)=>{bucket.latestTimestamp=timestamp;bucket.latest={name:model || 'unknown',quota:quota ?? 0,quotaKnown:quota!==null,requests:1,inputTokens:count.input,outputTokens:count.output,cacheReadTokens:count.cache,cacheWriteTokens:count.write};};
    const addModel=(bucket:LocalWidgetBucket,model:string,count:Counters,session:string,sign:1|-1,quota:number|null)=>{
      const name=(typeof model==='string' && model.trim() ? model.trim() : 'unknown').slice(0,200);
      const value=bucket.models.get(name) || {name,quota:0,requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,unknownRequests:0};
      value.quota=Math.max(0,value.quota+sign*(quota ?? 0));value.requests=Math.max(0,value.requests+sign);if(quota===null){value.unknownRequests=Math.max(0,value.unknownRequests+sign);bucket.unknownRequests=Math.max(0,bucket.unknownRequests+sign);}value.quotaKnown=value.unknownRequests===0;bucket.quotaKnown=bucket.unknownRequests===0;
      value.inputTokens=Math.max(0,(value.inputTokens ?? 0)+sign*count.input);value.outputTokens=Math.max(0,(value.outputTokens ?? 0)+sign*count.output);value.cacheReadTokens=Math.max(0,(value.cacheReadTokens ?? 0)+sign*count.cache);value.cacheWriteTokens=Math.max(0,(value.cacheWriteTokens ?? 0)+sign*count.write);
      if(value.requests<=0)bucket.models.delete(name);else bucket.models.set(name,value);
      bucket.quota=Math.max(0,bucket.quota+sign*(quota ?? 0));bucket.requests=Math.max(0,bucket.requests+sign);
    };
    const addDirect=(bucket:LocalWidgetBucket,model:string,count:Counters,session:string,timestamp:number,quota:number|null)=>{if(!(count.input+count.output+count.cache+count.write))return;addModel(bucket,model,count,session,1,quota);if(!bucket.latest || timestamp>=currentTimestamp(bucket))setLatest(bucket,model,count,timestamp,quota);};
    const addClaude=(bucket:LocalWidgetBucket,key:string,model:string,count:Counters,session:string,timestamp:number,quota:number|null)=>{
      if(!(count.input+count.output+count.cache+count.write))return;
      const old=bucket.messages.get(key);if(old && count.output<old.count.output)return;
      if(old)addModel(bucket,old.model,old.count,old.session,-1,old.quota);
      bucket.messages.set(key,{model,count,timestamp,session,quota});addModel(bucket,model,count,session,1,quota);if(!bucket.latest || timestamp>=currentTimestamp(bucket))setLatest(bucket,model,count,timestamp,quota);
    };
    const codexRoot=this.respectEnvironment && process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(this.home,'.codex');
    const claudeRoot=this.respectEnvironment && process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(this.home,'.claude');
    const codexFiles:string[]=[],claudeFiles:string[]=[];
    await Promise.all([walk(path.join(codexRoot,'sessions'),cutoff,warnings,codexFiles),walk(path.join(codexRoot,'archived_sessions'),cutoff,warnings,codexFiles),walk(path.join(claudeRoot,'projects'),cutoff,warnings,claudeFiles)]);
    if(codexFiles.length>=2000 || claudeFiles.length>=2000)warnings.push('本地会话扫描达到 2000 个文件上限，浮窗统计可能不完整。');
    const activeFiles=new Set([...codexFiles,...claudeFiles]);for(const file of this.widgetFiles.keys())if(!activeFiles.has(file))this.widgetFiles.delete(file);
    let filesScanned=0;
    for(const [tool,files] of [['codex',codexFiles],['claude',claudeFiles]] as [Tool,string[]][])for(const file of files){
      let info;try{info=await stat(file);}catch{warnings.push(`无法读取会话：${path.basename(file)}`);continue;}
      let state=this.widgetFiles.get(file);
      const changed=!!state && (state.dev!==info.dev || state.ino!==info.ino || info.size<state.size || info.mtimeMs<state.mtimeMs || info.size===state.size && info.mtimeMs!==state.mtimeMs);
      if(!state || changed){state={offset:0,size:0,mtimeMs:0,dev:info.dev,ino:info.ino,previous:{input:0,output:0,cache:0,write:0},model:'unknown',session:path.basename(file),buckets:new Map(),messageMinutes:new Map()};this.widgetFiles.set(file,state);}
      normalizeBuckets(state);
      if(state.partialSize===info.size && state.offset<info.size){state.size=info.size;state.mtimeMs=info.mtimeMs;filesScanned++;continue;}
      try{
        for await(const item of appendedLines(file,state.offset,info.size,undefined,state.skipPartial)){
          if(item.discarded){state.offset=item.end;state.skipPartial=!item.complete;continue;}
          let event:any;try{event=JSON.parse(item.line);}catch{if(item.complete)state.offset=item.end;else state.partialSize=info.size;continue;}
          state.offset=item.end;state.partialSize=undefined;
          if(tool==='codex'){
            if(event.type==='session_meta')state.session=event.payload?.id || state.session;if(event.type==='turn_context')state.model=event.payload?.model || state.model;
            if(event.type!=='event_msg' || event.payload?.type!=='token_count' || !event.payload.info)continue;
            const tokenInfo=event.payload.info,timestamp=Date.parse(event.timestamp);if(!Number.isFinite(timestamp))continue;
            const current=tokenInfo.total_token_usage ? counters(tokenInfo.total_token_usage):undefined,last=tokenInfo.last_token_usage ? counters(tokenInfo.last_token_usage):undefined;if(!current && !last)continue;
            const delta=current ? codexDelta(current,state.previous,last) : last!;if(current)state.previous=current;
            const bucket=bucketFor(state,timestamp/1000);if(!bucket)continue;
            const signature=`${state.session}|${event.timestamp}|${JSON.stringify(current || last)}`;if(state.lastSignature===signature)continue;state.lastSignature=signature;
            const count={...delta,input:Math.max(0,delta.input-delta.cache)},model=tokenInfo.model || state.model;
            const quota=options.quote ? options.quote(tool,model,{inputTokens:count.input,outputTokens:count.output,cacheReadTokens:count.cache,cacheWriteTokens:count.write,contextTokens:last?.input ?? delta.input,createdAt:timestamp/1000}) : count.input+count.output+count.cache+count.write;
            addDirect(bucket,model,count,state.session,timestamp/1000,quota);
          }else{
            if(event.type!=='assistant' || !event.message?.usage || event.isApiErrorMessage)continue;const message=event.message,id=message.id || event.uuid;if(!id)continue;const timestamp=Date.parse(event.timestamp);if(!Number.isFinite(timestamp))continue;
            const key=`${event.sessionId || state.session}|${id}`,oldStart=state.messageMinutes.get(key),oldBucket=oldStart===undefined ? undefined : state.buckets.get(oldStart),old=oldBucket?.messages.get(key);
            const callTime=old?.timestamp ?? timestamp/1000,bucket=old && oldBucket ? oldBucket : bucketFor(state,callTime);if(!bucket)continue;
            const count=counters(message.usage),model=message.model || 'unknown',creation=message.usage.cache_creation;
            const quota=options.quote ? options.quote(tool,model,{inputTokens:count.input,outputTokens:count.output,cacheReadTokens:count.cache,cacheWriteTokens:count.write,contextTokens:count.input+count.cache+count.write,cacheWriteShortTokens:creation?.ephemeral_5m_input_tokens,cacheWriteLongTokens:creation?.ephemeral_1h_input_tokens,createdAt:callTime}) : count.input+count.output+count.cache+count.write;
            addClaude(bucket,key,model,count,event.sessionId || state.session,callTime,quota);
            state.messageMinutes.delete(key);state.messageMinutes.set(key,bucket.start);
            while(state.messageMinutes.size>512){const first=state.messageMinutes.keys().next().value!,start=state.messageMinutes.get(first)!;state.buckets.get(start)?.messages.delete(first);state.messageMinutes.delete(first);}
          }
        }
        state.size=Math.max(info.size,state.offset);state.mtimeMs=info.mtimeMs;filesScanned++;
      }catch{warnings.push(`会话读取不完整：${path.basename(file)}`);}
      normalizeBuckets(state);
    }
    const aggregate=(bucket:LocalWidgetBucket,source:LocalWidgetBucket)=>{
      bucket.quota+=source.quota;bucket.requests+=source.requests;
      if(!source.quotaKnown)bucket.quotaKnown=false;
      for(const model of source.models.values()){
        const value=bucket.models.get(model.name) || {name:model.name,quota:0,requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,unknownRequests:0};
        value.quota+=model.quota;value.requests+=model.requests;if(model.quotaKnown===false)value.quotaKnown=false;value.inputTokens=(value.inputTokens ?? 0)+(model.inputTokens ?? 0);value.outputTokens=(value.outputTokens ?? 0)+(model.outputTokens ?? 0);value.cacheReadTokens=(value.cacheReadTokens ?? 0)+(model.cacheReadTokens ?? 0);value.cacheWriteTokens=(value.cacheWriteTokens ?? 0)+(model.cacheWriteTokens ?? 0);bucket.models.set(model.name,value);
      }
      if(source.latest && (!bucket.latest || (source.latestTimestamp || 0)>=(bucket.latestTimestamp || 0))){bucket.latest=source.latest;bucket.latestTimestamp=source.latestTimestamp;}
    };
    let fallbackStart=-1;for(const state of this.widgetFiles.values())for(const start of state.buckets.keys())if(start<targetStart && start>fallbackStart)fallbackStart=start;
    let target:LocalWidgetBucket|undefined,fallback:LocalWidgetBucket|undefined;
    for(const state of this.widgetFiles.values()){
      const current=state.buckets.get(targetStart);if(current){target ||= makeBucket(targetStart);aggregate(target,current);}
      const older=state.buckets.get(fallbackStart);if(older){fallback ||= makeBucket(fallbackStart);aggregate(fallback,older);}
    }
    const toMinute=(bucket?:LocalWidgetBucket):WidgetMinute|null=>bucket && bucket.requests>0 ? {start:bucket.start,end:bucket.end,quota:bucket.quota,quotaKnown:bucket.quotaKnown,requests:bucket.requests,models:[...bucket.models.values()].map(({unknownRequests,...model})=>model).sort((a,b)=>b.quota-a.quota || a.name.localeCompare(b.name)),latestModel:bucket.latest ? {...bucket.latest} : undefined} : null;
    const minute=toMinute(target),historicalMinute=toMinute(fallback);
    let selected=minute || historicalMinute,historical=!minute && !!historicalMinute;
    if(options.period!==undefined){
      const window=widgetPeriodWindow(options.period,now),total=makeBucket(window.start_timestamp);total.end=window.end_timestamp;
      for(const state of this.widgetFiles.values())for(const bucket of state.buckets.values())if(bucket.start>=window.start_timestamp && bucket.start<=window.end_timestamp)aggregate(total,bucket);
      if(options.period==='latest' && total.latest){const latest=total.latest;selected={start:Math.floor(total.latestTimestamp || now/1000),end:Math.floor(total.latestTimestamp || now/1000),quota:latest.quota,quotaKnown:latest.quotaKnown,requests:1,models:[{...latest}],latestModel:{...latest}};}
      else selected=toMinute(total);
      historical=false;
      if(options.period===60 && !selected){selected=historicalMinute;historical=!!historicalMinute;}
    }
    // Widget input has one source-independent meaning: uncached input plus cached reads.
    if(options.quote && selected){const normalize=(model:WidgetModelUsage)=>{if(model.inputTokens!==null && model.cacheReadTokens!==null)model.inputTokens+=model.cacheReadTokens;};selected.models.forEach(normalize);if(selected.latestModel)normalize(selected.latestModel);}
    return {siteId:'local',siteName:'本地会话',status,balance:null,loggedIn:true,minute:selected,historical,fetchedAt:Date.now(),warnings:[...new Set(warnings)],source:'local'};
  }
  private async read(query: DashboardQuery,report:(value:LocalReadProgress)=>void): Promise<LocalUsage> {
    const scannedAt=Date.now(),window=resolveRange(query,new Date(scannedAt)),filters=statisticsFilters(query),cutoff=window.start_timestamp*1000;
    const warnings: string[] = []; const rows = new Map<string, LocalUsageRow>();
    const progress:LocalReadProgress={phase:'discover',filesDone:0,filesTotal:0,bytesRead:0,bytesTotal:0};report({...progress});
    if(filters.tokenIds?.length){report({...progress,phase:'complete'});return {rows:[],points:[],filesScanned:0,warnings:['本机会话不包含 API 令牌 ID，无法按令牌筛选。清除令牌筛选后查看本地统计。'],scannedAt:Date.now()};}
    const duration=window.end_timestamp-window.start_timestamp+1,count=Math.min(30,duration);
    const edges=Array.from({length:count+1},(_,index)=>window.start_timestamp+Math.floor(index*duration/count));
    const points=new Map<string,LocalUsagePoint>();
    const summaries=new Map<string,LocalSessionSummary>();let activeFile='';
    const sessions = new Map<string, Set<string>>();
    const codexRoot = this.respectEnvironment && process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(this.home, '.codex');
    const claudeRoot = this.respectEnvironment && process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(this.home, '.claude');
    const codexFiles: string[] = []; const claudeFiles: string[] = [];
    await Promise.all([walk(path.join(codexRoot, 'sessions'), cutoff, warnings, codexFiles), walk(path.join(codexRoot, 'archived_sessions'), cutoff, warnings, codexFiles), walk(path.join(claudeRoot, 'projects'), cutoff, warnings, claudeFiles)]);
    if (codexFiles.length >= 2000 || claudeFiles.length >= 2000) warnings.push('本次扫描达到 2000 个文件上限，统计可能不完整。');
    const sizes=new Map<string,number>();for(const file of [...codexFiles,...claudeFiles]){try{sizes.set(file,(await stat(file)).size);}catch{sizes.set(file,0);}}
    progress.filesTotal=sizes.size;progress.bytesTotal=[...sizes.values()].reduce((sum,size)=>sum+size,0);progress.phase='read';report({...progress});
    let lastProgress=0;const bytes=(amount:number)=>{progress.bytesRead+=amount;const now=Date.now();if(now-lastProgress>=100){lastProgress=now;report({...progress});}};
    const add = (tool: Tool, timestamp: number, model: string, c: Counters, session: string) => {
      if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > window.end_timestamp*1000+999 || filters.models?.length && !filters.models.includes(model) || !(c.input + c.output + c.cache + c.write)) return;
      const date = new Date(timestamp).toLocaleDateString('sv-SE'); const key = `${tool}|${date}|${model}`;
      const r = rows.get(key) || { tool, date, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, sessions: 0 };
      r.inputTokens += c.input; r.outputTokens += c.output; r.cacheReadTokens += c.cache; r.cacheWriteTokens += c.write; r.requests++;
      const ids = sessions.get(key) || new Set<string>(); ids.add(session); sessions.set(key, ids); r.sessions = ids.size; rows.set(key, r);
      const seconds=timestamp/1000;let index=count-1;while(index>0 && seconds<edges[index])index--;
      const pointKey=JSON.stringify([tool,index,model]),point=points.get(pointKey) || {tool,created_at:edges[index],model,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,requests:0};
      point.inputTokens+=c.input;point.outputTokens+=c.output;point.cacheReadTokens+=c.cache;point.cacheWriteTokens+=c.write;point.requests++;points.set(pointKey,point);
      const id=createHash('sha256').update(activeFile).digest('hex');
      const summary=summaries.get(id) || {id,tool,model,startedAt:timestamp/1000,updatedAt:timestamp/1000,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,requests:0};
      summary.startedAt=Math.min(summary.startedAt,timestamp/1000);if(timestamp/1000>=summary.updatedAt){summary.updatedAt=timestamp/1000;summary.model=model;}
      summary.inputTokens+=c.input;summary.outputTokens+=c.output;summary.cacheReadTokens+=c.cache;summary.cacheWriteTokens+=c.write;summary.requests++;summaries.set(id,summary);this.sessionPages.register(id,activeFile,tool);
    };
    let filesScanned = 0;
    for (const [tool, files] of [['codex', codexFiles], ['claude', claudeFiles]] as [Tool, string[]][]) {
      for (const file of files) {
        activeFile=file;
        let previous: Counters = { input: 0, output: 0, cache: 0, write: 0 }; let model = 'unknown'; let session = path.basename(file);
        let codexSignature = '';
        const claudeMessages = new Map<string, { timestamp: number; model: string; count: Counters; session: string }>();
        const size=sizes.get(file) || 0;
        try {
          for await (const item of appendedLines(file,0,size,bytes)) {
            const line=item.line;
            let e: any; try { e = JSON.parse(line); } catch { continue; }
            if (tool === 'codex') {
              if (e.type === 'session_meta') session = e.payload?.id || session;
              if (e.type === 'turn_context') model = e.payload?.model || model;
              if (e.type !== 'event_msg' || e.payload?.type !== 'token_count' || !e.payload.info) continue;
              const info = e.payload.info; const timestamp = Date.parse(e.timestamp);
              const current = info.total_token_usage ? counters(info.total_token_usage) : undefined;
              const last = info.last_token_usage ? counters(info.last_token_usage) : undefined;
              if (!current && !last) continue;
              const delta = current ? codexDelta(current, previous, last) : last!;
              if (current) previous = current;
              const signature = `${session}|${e.timestamp}|${JSON.stringify(current || last)}`;
              if (codexSignature===signature) continue; codexSignature=signature;
              // Codex's input counter includes cached input tokens. Report uncached input separately.
              add(tool, timestamp, info.model || model, { ...delta, input: Math.max(0, delta.input - delta.cache) }, session);
            } else {
              if (e.type !== 'assistant' || !e.message?.usage || e.isApiErrorMessage) continue;
              const msg = e.message; const id = msg.id || e.uuid; if (!id) continue;
              const timestamp = Date.parse(e.timestamp); if (!Number.isFinite(timestamp) || timestamp < cutoff) continue;
              const c = counters(msg.usage); const key = `${e.sessionId || session}|${id}`;
              const old = claudeMessages.get(key);
              // Streamed assistant snapshots reuse message.id; keep the largest completed usage.
              if (!old || c.output >= old.count.output) {
                claudeMessages.delete(key);claudeMessages.set(key, { timestamp, model: msg.model || 'unknown', count: c, session: e.sessionId || session });
                // Only recent streamed snapshots need replacement; never retain the whole file.
                if(claudeMessages.size>512){const first=claudeMessages.keys().next().value!,m=claudeMessages.get(first)!;add('claude',m.timestamp,m.model,m.count,m.session);claudeMessages.delete(first);}
              }
            }
          }
          if (tool === 'claude') for (const m of claudeMessages.values()) add('claude', m.timestamp, m.model, m.count, m.session);
          filesScanned++;
        } catch { warnings.push(`会话读取不完整：${path.basename(file)}`); }
        progress.filesDone++;report({...progress});
      }
    }
    report({...progress,phase:'complete'});
    return { rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)),points:[...points.values()].sort((a,b)=>a.created_at-b.created_at),sessions:[...summaries.values()].sort((a,b)=>b.updatedAt-a.updatedAt), filesScanned, warnings: [...new Set(warnings)], scannedAt };
  }
}
