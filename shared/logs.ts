import {DEFAULT_LOG_COLUMNS,LOG_COLUMN_IDS,type UsageLog,type LogColumnId} from './types';
export const LOG_COLUMN_LABELS: Record<LogColumnId,string> = {
  time:'时间',model:'模型',reasoning:'思考强度',token:'令牌',input:'输入 Tokens',output:'输出 Tokens',cacheRead:'缓存读取',cacheWrite:'缓存写入',cost:'费用',duration:'首字 / 后续',speed:'Token 速度',netSpeed:'净速率',channel:'渠道',status:'状态',firstToken:'首字延迟',group:'路由分组',requestId:'请求 ID',stream:'流式输出',tool:'工具归属',
};
function normalizeColumns<T extends string>(value:unknown,ids:readonly T[],defaults:readonly T[]):T[] {
  if(!Array.isArray(value))return [...defaults];
  const columns=[...new Set(value.filter((v):v is T => typeof v==='string' && ids.includes(v as T)))];
  return columns.length ? columns : [...defaults];
}
export function normalizeLogColumns(value:unknown):LogColumnId[] {
  return normalizeColumns(value,LOG_COLUMN_IDS,DEFAULT_LOG_COLUMNS);
}
export function visibleLogColumns(value:unknown):LogColumnId[] {
  const columns=normalizeLogColumns(value);
  return columns.filter(id=>!(id==='cacheRead' && columns.includes('input')) && !(id==='firstToken' && columns.includes('duration')));
}
export function migrateLogColumns(value:unknown):LogColumnId[] {
  const oldDefault=['time','model','token','input','output','cacheRead','cacheWrite','cost','duration','speed','channel','status'];
  const previousDefault=oldDefault.filter(c=>c!=='cacheWrite');
  return Array.isArray(value) && [oldDefault,previousDefault].some(columns=>value.length===columns.length && value.every((c,i)=>c===columns[i])) ? [...DEFAULT_LOG_COLUMNS] : normalizeLogColumns(value);
}
export const ACTIVITY_COLUMN_IDS = ['model','time','reasoning','token','input','cacheRead','cacheWrite','output','cost','speed','netSpeed','timing','duration','firstToken','channel','group','requestId','stream','tool','status'] as const satisfies readonly (LogColumnId|'timing')[];
export type ActivityColumnId = typeof ACTIVITY_COLUMN_IDS[number];
export const DEFAULT_ACTIVITY_COLUMNS: ActivityColumnId[] = ['model','input','cacheRead','output','cost','speed','timing','status'];
export const ACTIVITY_COLUMN_LABELS: Record<ActivityColumnId,string> = {
  ...LOG_COLUMN_LABELS,input:'输入',output:'输出',speed:'速率',duration:'总耗时',timing:'首字 / 后续',status:'状态码',
};
export function normalizeActivityColumns(value:unknown):ActivityColumnId[] {
  return normalizeColumns(value,ACTIVITY_COLUMN_IDS,DEFAULT_ACTIVITY_COLUMNS);
}
export function visibleActivityColumns(value:unknown):ActivityColumnId[] {
  const columns=normalizeActivityColumns(value);
  return columns.filter(id=>!(id==='cacheRead' && columns.includes('input')) && !(id==='firstToken' && columns.includes('timing')));
}
function record(value:unknown):Record<string,unknown> {return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};}
export function logMetadata(log:UsageLog):Record<string,unknown> {
  try {return record(typeof log.other==='string' ? JSON.parse(log.other) : log.other);}catch{return {};}
}
export function requestReasoningEffort(log:UsageLog):string|null {
  const root=record(log),other=logMetadata(log);
  // New API GenerateTextOtherInfo publishes other.reasoning_effort from RelayInfo.ReasoningEffort.
  // Read only explicit logged request fields, never model names, prompts or configuration defaults.
  const sources=[root,other];
  for(const source of [root,other]) {
    const request=record(source.request),metadata=record(source.metadata);
    sources.push(request,metadata,record(request.metadata),record(metadata.request));
  }
  for(const source of sources) {
    for(const value of [source.reasoning_effort,record(source.reasoning).effort]) {
      if(typeof value==='string' && value.trim())return value;
    }
  }
  return null;
}
const count=(value:unknown):number|null => typeof value==='number' && Number.isFinite(value) && value>=0 ? value : null;
export function logMetrics(log:UsageLog) {
  const other=logMetadata(log),tokens=record(other.billing_tokens);
  const cacheRead=count(other.cache_tokens) ?? count(tokens.cr);
  const genericWrite=count(other.cache_creation_tokens);
  const short=count(other.cache_creation_tokens_5m) ?? count(tokens.cc),long=count(other.cache_creation_tokens_1h) ?? count(tokens.cc1h);
  const splitWrite=(short ?? 0)+(long ?? 0);
  const cacheWrite=splitWrite>0 ? splitWrite : genericWrite ?? (short!==null || long!==null ? splitWrite : null);
  const duration=count(log.use_time),output=count(log.completion_tokens);
  const speed=[2,5].includes(log.type) && duration!==null && duration>0 && output!==null && output>0 ? output/duration : null;
  const firstTokenMs=count(other.frt),timing=streamTiming(log,duration,firstTokenMs);
  const net=speed!==null && timing.subsequentMs!==null && timing.subsequentMs>0 ? output!/(timing.subsequentMs/1000) : null;
  const netSpeed=net!==null && Number.isFinite(net) ? net : null;
  return {cacheRead,cacheWrite,speed,netSpeed,firstTokenMs};
}
export function upstreamChannel(log:UsageLog) {
  const id=typeof log.channel==='number' && Number.isInteger(log.channel) && log.channel>0 ? '#'+log.channel : '';
  const name=typeof log.channel_name==='string' ? log.channel_name.trim() : '';
  return [name,id].filter(Boolean).join(' ') || null;
}
export function requestTiming(log:UsageLog) {
  const first=count(logMetadata(log).frt),duration=count(log.use_time);
  return streamTiming(log,duration,first);
}
function streamTiming(log:UsageLog,duration:number|null,first:number|null) {
  const durationMs=duration===null ? null : duration*1000;
  const valid=log.is_stream===true && first!==null && durationMs!==null && Number.isFinite(durationMs) && durationMs>0 && first<=durationMs;
  return {firstMs:valid ? first : null,subsequentMs:valid ? durationMs-first : null};
}
export function requestStatus(log:UsageLog) {
  const other=logMetadata(log),error=record(other.error),stream=record(other.stream_status);
  const status=(v:unknown)=>typeof v==='number' && Number.isInteger(v) && v>=100 && v<=599 ? v : null;
  const httpStatus=status(log.status_code) ?? status(other.status_code) ?? status(error.status_code);
  const text=(v:unknown)=>typeof v==='string' || typeof v==='number' ? String(v) : null;
  return {httpStatus,errorCode:text(other.error_code) ?? text(error.code),errorType:text(other.error_type) ?? text(error.type),isError:log.type===5 || httpStatus!==null && httpStatus>=400 || stream.status==='error',message:log.content || text(error.message) || text(stream.end_error) || null};
}
