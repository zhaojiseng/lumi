import {DEFAULT_LOG_COLUMNS,LOG_COLUMN_IDS,type UsageLog,type LogColumnId} from './types';
export const LOG_COLUMN_LABELS: Record<LogColumnId,string> = {
  time:'时间',model:'模型',token:'令牌',input:'输入 Tokens',output:'输出 Tokens',cacheRead:'缓存读取',cacheWrite:'缓存写入',cost:'费用',duration:'耗时',speed:'Token 速度',channel:'渠道',status:'状态',firstToken:'首字延迟',group:'路由分组',requestId:'请求 ID',stream:'流式输出',tool:'工具归属',
};
export function normalizeLogColumns(value:unknown):LogColumnId[] {
  if(!Array.isArray(value))return [...DEFAULT_LOG_COLUMNS];
  const columns=[...new Set(value.filter((v):v is LogColumnId => LOG_COLUMN_IDS.includes(v as LogColumnId)))];
  return columns.length ? columns : [...DEFAULT_LOG_COLUMNS];
}
export function visibleLogColumns(value:unknown):LogColumnId[] {
  const columns=normalizeLogColumns(value);
  return columns.includes('input') ? columns.filter(c=>c!=='cacheRead') : columns;
}
export function migrateLogColumns(value:unknown):LogColumnId[] {
  const oldDefault=['time','model','token','input','output','cacheRead','cacheWrite','cost','duration','speed','channel','status'];
  return Array.isArray(value) && value.length===oldDefault.length && value.every((c,i)=>c===oldDefault[i]) ? [...DEFAULT_LOG_COLUMNS] : normalizeLogColumns(value);
}
function record(value:unknown):Record<string,unknown> {return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};}
export function logMetadata(log:UsageLog):Record<string,unknown> {
  try {return record(typeof log.other==='string' ? JSON.parse(log.other) : log.other);}catch{return {};}
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
  return {cacheRead,cacheWrite,speed,firstTokenMs:count(other.frt)};
}
export function upstreamChannel(log:UsageLog) {
  const id=typeof log.channel==='number' && Number.isInteger(log.channel) && log.channel>0 ? '#'+log.channel : '';
  const name=typeof log.channel_name==='string' ? log.channel_name.trim() : '';
  return [name,id].filter(Boolean).join(' ') || null;
}
export function requestTiming(log:UsageLog) {
  const first=logMetrics(log).firstTokenMs,duration=count(log.use_time);
  const valid=log.is_stream && first!==null && duration!==null && duration>0 && first<=duration*1000;
  return {firstMs:valid ? first : null,subsequentMs:valid ? duration*1000-first : null};
}
export function requestStatus(log:UsageLog) {
  const other=logMetadata(log),error=record(other.error),stream=record(other.stream_status);
  const status=(v:unknown)=>typeof v==='number' && Number.isInteger(v) && v>=100 && v<=599 ? v : null;
  const httpStatus=status(log.status_code) ?? status(other.status_code) ?? status(error.status_code);
  const text=(v:unknown)=>typeof v==='string' || typeof v==='number' ? String(v) : null;
  return {httpStatus,errorCode:text(other.error_code) ?? text(error.code),errorType:text(other.error_type) ?? text(error.type),isError:log.type===5 || httpStatus!==null && httpStatus>=400 || stream.status==='error',message:log.content || text(error.message) || text(stream.end_error) || null};
}
