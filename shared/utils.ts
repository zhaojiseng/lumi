import {logMetrics,upstreamChannel,requestReasoningEffort,requestTiming} from './logs';
import {resolveRange} from './range';
import type { SiteStatus, UsageLog, QuotaPoint, ToolBinding, Tool, ManagedToken, RangeQuery,Preferences,ApiToken } from './types';
export function currency(status: SiteStatus) {
  const type = status.quota_display_type || 'USD';
  const symbol = type === 'CUSTOM' ? status.custom_currency_symbol || '¤' : type === 'CNY' ? '¥' : type === 'TOKEN' ? '' : '$';
  const rate = type === 'CUSTOM' ? status.custom_currency_exchange_rate ?? 1 : type === 'CNY' ? status.usd_exchange_rate ?? 1 : 1;
  const unit = type === 'TOKEN' ? 1 : status.quota_per_unit || 500000;
  return { symbol, rate, unit, type, value: (quota: number) => quota / unit * rate };
}
export function formatMoney(quota: number, status: SiteStatus, digits = 2) {
  const c = currency(status); return c.symbol + c.value(quota).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function compact(n: number) { return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString(); }
export function localDate(ts: number) { return new Date(ts * 1000).toLocaleDateString('sv-SE'); }
export function toolForLog(log: UsageLog, bindings: ToolBinding[], managed: ManagedToken[] = []): Tool | 'other' {
  const matches = [...bindings.filter(b => b.tokenName && b.tokenName === log.token_name), ...managed.filter(t => t.name === log.token_name || t.previousNames?.includes(log.token_name))];
  const tools = new Set(matches.map(m => m.tool)); return tools.size === 1 ? matches[0].tool : 'other';
}
export function trackedToolTokenNames(prefs:Preferences,siteId:string,tokens:ApiToken[]){
  const tracked=[...prefs.managedTokens.filter(t=>t.siteId===siteId).flatMap(t=>[t.name,...(t.previousNames || [])].map(name=>({tool:t.tool,name,id:t.id}))),...prefs.bindings.filter(b=>b.siteId===siteId && b.tokenName).map(b=>({tool:b.tool,name:b.tokenName,id:b.tokenId ?? tokens.find(t=>t.name===b.tokenName)?.id}))];
  return tracked.filter((b,i)=>tracked.findIndex(x=>x.tool===b.tool && x.name===b.name)===i && b.id!==undefined && tokens.some(t=>t.id===b.id) && tokens.filter(t=>t.name===b.name).every(t=>t.id===b.id) && !tracked.some(x=>x.tool!==b.tool && (x.name===b.name || x.id===b.id)));
}
export function dailySeries(points: QuotaPoint[], days: number, status: SiteStatus, range?: RangeQuery, now = new Date()) {
  const resolved=resolveRange(range || days,now);const start=new Date(resolved.start_timestamp * 1000);days=resolved.days;
  const rows = Array.from({ length: days }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return { date: d.toLocaleDateString('sv-SE'), label: `${d.getMonth() + 1}/${d.getDate()}`, cost: 0, tokens: 0, requests: 0, codex: 0, claude: 0 }; });
  const map = new Map(rows.map(r => [r.date, r]));
  for (const p of points) { const r = map.get(localDate(p.created_at)); if (!r) continue; r.cost += currency(status).value(p.quota); r.tokens += p.token_used || 0; r.requests += p.count || 0; }
  return rows;
}
/** Uses the full hourly points from the site, never the paginated recent-request sample. */
export function hourlySeries(points: QuotaPoint[], status: SiteStatus, range?: RangeQuery, now = new Date()) {
  const resolved=resolveRange(range || 1,now);
  if (resolved.days !== 1 && range!=='24h') throw new Error('小时曲线仅适用于单日范围或最近 24 小时。');
  const count=range==='24h' ? 24 : Math.floor((resolved.end_timestamp-resolved.start_timestamp)/3600)+1;
  const c=currency(status);
  const rows=Array.from({length:count},(_,i) => {
    const start=resolved.start_timestamp+i*3600;const end=Math.min(start+3599,resolved.end_timestamp);const d=new Date(start*1000);
    const hour=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
    const endDate=new Date(end*1000);const endLabel=String(endDate.getHours()).padStart(2,'0')+':'+String(endDate.getMinutes()).padStart(2,'0');
    return {date:localDate(start),label:hour,tooltipLabel:localDate(start)+' '+hour+'–'+endLabel,timestamp:start,cost:0,tokens:0,requests:0,codex:0,claude:0};
  });
  for (const point of points) {
    if (!Number.isFinite(point.created_at) || point.created_at<resolved.start_timestamp || point.created_at>resolved.end_timestamp) continue;
    const index=Math.floor((point.created_at-resolved.start_timestamp)/3600);
    const row=rows[range==='24h' ? Math.min(rows.length-1,index) : index];if (!row) continue;
    row.cost+=c.value(point.quota);row.tokens+=point.token_used || 0;row.requests+=point.count || 0;
  }
  return rows;
}
/** Thirty equal elapsed-time intervals, at one-second minimum precision. */
export function usageGranularity(days: number) {
  const seconds=Math.max(1,(Number.isFinite(days) && days>0 ? days : 1/86400)*86400/30);
  const duration=(n:number)=>n.toLocaleString('zh-CN',{maximumFractionDigits:1});
  const label=seconds<60 ? '约每 '+duration(seconds)+' 秒' : seconds<3600 ? '约每 '+duration(seconds/60)+' 分钟' : seconds<86400 ? '约每 '+duration(seconds/3600)+' 小时' : '约每 '+duration(seconds/86400)+' 天';
  return {seconds,hours:seconds/3600,days:seconds/86400,label};
}
/** A grouped chart shares immutable bucket labels and currency conversion across its accumulators. */
export function createUsageSeriesFactory(days: number, status: SiteStatus, range?: RangeQuery, now = new Date()) {
  const resolved=resolveRange(range || days,now),duration=resolved.end_timestamp-resolved.start_timestamp+1,bucketCount=Math.min(30,duration);
  const edges=Array.from({length:bucketCount+1},(_,i)=>resolved.start_timestamp+Math.floor(i*duration/bucketCount));
  const buckets=edges.slice(0,-1).map((start,i)=>({start,end:edges[i+1]-1}));
  const time=(ts:number) => new Date(ts*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',...(duration<1800 ? {second:'2-digit'} : {}),hour12:false});
  const short=(ts:number) => {const d=new Date(ts*1000);return (d.getMonth()+1)+'/'+d.getDate();};
  const template=buckets.map(({start,end}) => ({date:localDate(start),timestamp:start,end_timestamp:end,
    label:duration/bucketCount<86400 ? short(start)+' '+time(start) : short(start),
    tooltipLabel:localDate(start)+' '+time(start)+' – '+localDate(end)+' '+time(end),
    cost:0,tokens:0,requests:0,codex:0,claude:0,cacheInputTokens:0,cacheReadTokens:0,cacheHitRate:null as number|null,outputTokens:0,durationSeconds:0,speedSamples:0,speed:null as number|null,netOutputTokens:0,subsequentDurationSeconds:0,netSpeedSamples:0,netSpeed:null as number|null}));
  const c=currency(status);
  return ()=>{
    const rows=template.map(row=>({...row}));
    const add=(point:QuotaPoint)=>{
      if(!Number.isFinite(point.created_at) || point.created_at<resolved.start_timestamp || point.created_at>resolved.end_timestamp)return false;
      // Binary lookup also respects variable-length local days across daylight saving changes.
      let lo=0,hi=buckets.length-1;
      while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(buckets[mid].start<=point.created_at)lo=mid;else hi=mid-1;}
      const row=rows[lo];if(!row)return false;row.cost+=c.value(point.quota);row.tokens+=point.token_used || 0;row.requests+=point.count || 0;
      if(typeof point.cacheInputTokens==='number' && Number.isFinite(point.cacheInputTokens) && point.cacheInputTokens>0 && typeof point.cacheReadTokens==='number' && Number.isFinite(point.cacheReadTokens) && point.cacheReadTokens>=0 && point.cacheReadTokens<=point.cacheInputTokens){row.cacheInputTokens+=point.cacheInputTokens;row.cacheReadTokens+=point.cacheReadTokens;}
      if(typeof point.outputTokens==='number' && Number.isFinite(point.outputTokens) && point.outputTokens>0 && typeof point.durationSeconds==='number' && Number.isFinite(point.durationSeconds) && point.durationSeconds>0){row.outputTokens+=point.outputTokens;row.durationSeconds+=point.durationSeconds;row.speedSamples+=Number.isSafeInteger(point.speedSamples) && point.speedSamples!>0 ? point.speedSamples! : 0;}
      if(typeof point.netOutputTokens==='number' && Number.isFinite(point.netOutputTokens) && point.netOutputTokens>0 && typeof point.subsequentDurationSeconds==='number' && Number.isFinite(point.subsequentDurationSeconds) && point.subsequentDurationSeconds>0){row.netOutputTokens+=point.netOutputTokens;row.subsequentDurationSeconds+=point.subsequentDurationSeconds;row.netSpeedSamples+=Number.isSafeInteger(point.netSpeedSamples) && point.netSpeedSamples!>0 ? point.netSpeedSamples! : 0;}
      return true;
    };
    const merge=(other:typeof rows)=>{
      for(let i=0;i<rows.length;i++)for(const key of ['cost','tokens','requests','codex','claude','cacheInputTokens','cacheReadTokens','outputTokens','durationSeconds','speedSamples','netOutputTokens','subsequentDurationSeconds','netSpeedSamples'] as const)rows[i][key]+=other[i][key];
    };
    const finish=()=>{
      for(const row of rows){row.cacheHitRate=row.cacheInputTokens>0 ? row.cacheReadTokens/row.cacheInputTokens : null;row.speed=row.durationSeconds>0 ? row.outputTokens/row.durationSeconds : null;row.netSpeed=row.subsequentDurationSeconds>0 ? row.netOutputTokens/row.subsequentDurationSeconds : null;}
      return rows;
    };
    return {add,merge,finish};
  };
}
export function usageSeries(points: QuotaPoint[], days: number, status: SiteStatus, range?: RangeQuery, now = new Date()) {
  const series=createUsageSeriesFactory(days,status,range,now)();
  for(const point of points)series.add(point);
  return series.finish();
}
export function csvEscape(value: unknown) { const s = String(value ?? ''); const safe = /^[=+@\-]/.test(s) ? `'${s}` : s; return `"${safe.replace(/"/g, '""')}"`; }
export function logsToCsv(logs: UsageLog[], status: SiteStatus) {
  const rows = [['时间', '模型', '令牌', '输入 Tokens', '输出 Tokens', `费用 (${currency(status).symbol || '额度'})`, '耗时(s)', '状态', '分组', '请求 ID', '缓存读取 Tokens', '缓存写入 Tokens', 'Token 速度 (t/s)', '首字延迟 (ms)', '上游渠道', '思考强度', '后续耗时 (ms)', '净速率 (t/s)'], ...logs.map(l => [new Date(l.created_at * 1000).toISOString(), l.model_name, l.token_name, l.prompt_tokens, l.completion_tokens, currency(status).value(l.quota), l.use_time, l.type === 2 ? '成功' : l.type === 5 ? '错误' : String(l.type), l.group, l.request_id || '', logMetrics(l).cacheRead ?? '', logMetrics(l).cacheWrite ?? '', logMetrics(l).speed ?? '', logMetrics(l).firstTokenMs ?? '', upstreamChannel(l) || '', requestReasoningEffort(l) || '', requestTiming(l).subsequentMs ?? '', logMetrics(l).netSpeed ?? ''])];
  return '\uFEFF' + rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
}
