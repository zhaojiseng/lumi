import type {HealthSummary,ModelHealth,ModelHealthDetails} from './types';
const finite=(value:unknown) => typeof value === 'number' && Number.isFinite(value);
const positive=(value:unknown) => finite(value) && (value as number)>0 ? value as number : 0;
const rate=(value:unknown) => finite(value) && (value as number)>=0 && (value as number)<=100;
/** One slot per hour, including the current (possibly incomplete) hour. */
export function healthSlots(series:ModelHealth['recent_success_series'],windowEnd=Date.now()/1000) {
  const end=Math.floor((positive(windowEnd) || Date.now()/1000)/3600)*3600;
  const slots=Array.from({length:24},(_,i)=>({ts:end-(23-i)*3600,success_rate:null as number|null}));
  for(const sample of series || []) {
    if(!positive(sample.ts) || !rate(sample.success_rate))continue;
    const index=Math.floor(sample.ts/3600)-(end/3600-23);
    if(index>=0 && index<24)slots[index].success_rate=sample.success_rate;
  }
  return slots;
}
export function normalizeHealth(input:any):HealthSummary {
  if (!Array.isArray(input?.models)) throw new Error('站点未提供有效健康度数据。');
  return {window_start:positive(input.window_start),window_end:positive(input.window_end),models:input.models.filter((m:any) => typeof m?.model_name === 'string' && rate(m.success_rate)).map((m:any):ModelHealth => ({model_name:m.model_name,success_rate:m.success_rate,avg_latency_ms:positive(m.avg_latency_ms),avg_tps:positive(m.avg_tps),recent_success_series:Array.isArray(m.recent_success_series) ? m.recent_success_series.filter((p:any) => positive(p?.ts) && rate(p.success_rate)).map((p:any) => ({ts:p.ts,success_rate:p.success_rate})) : []}))};
}
export function normalizeHealthDetails(input:any):ModelHealthDetails {
  if (!Array.isArray(input?.groups)) throw new Error('站点暂未提供该模型的渠道健康度。');
  return {model_name:typeof input.model_name === 'string' ? input.model_name : '',window_start:positive(input.window_start),window_end:positive(input.window_end),groups:input.groups.filter((g:any) => typeof g?.group === 'string' && rate(g.success_rate)).map((g:any) => ({group:g.group,success_rate:g.success_rate,avg_latency_ms:positive(g.avg_latency_ms),avg_ttft_ms:positive(g.avg_ttft_ms),avg_tps:positive(g.avg_tps)}))};
}
