import {createUsageSeriesFactory} from './utils';
import {logMetrics,requestStatus,requestTiming} from './logs';
import type {RangeQuery,QuotaPoint,SiteStatus,TrendGrouping,TrendMetric,UsageLog} from './types';

const count=(value:number)=>Number.isFinite(value) && value>=0 ? value : 0;
export function tokenPoints(logs:UsageLog[],window:{start_timestamp:number;end_timestamp:number}):QuotaPoint[]{
  const groups=new Map<string,QuotaPoint>();
  for(const log of logs){
    if(log.type!==2 || !Number.isFinite(log.created_at) || log.created_at<window.start_timestamp || log.created_at>window.end_timestamp)continue;
    const tokenId=Number.isSafeInteger(log.token_id) && log.token_id!>0 ? log.token_id : undefined;
    const name=typeof log.token_name==='string' ? log.token_name.trim() : '';
    // Use the actual request time. Bucketing is performed once by usageSeries.
    const key=JSON.stringify([log.created_at,log.model_name,tokenId ?? name]);
    const row=groups.get(key) || {created_at:log.created_at,model_name:log.model_name,token_name:name,token_id:tokenId,quota:0,token_used:0,count:0};
    row.quota+=count(log.quota);row.token_used+=count(log.prompt_tokens)+count(log.completion_tokens);row.count++;groups.set(key,row);
    const metrics=logMetrics(log),valid=!requestStatus(log).isError;
    if(valid && Number.isFinite(log.prompt_tokens) && log.prompt_tokens>0 && metrics.cacheRead!==null && metrics.cacheRead<=log.prompt_tokens){row.cacheInputTokens=(row.cacheInputTokens || 0)+log.prompt_tokens;row.cacheReadTokens=(row.cacheReadTokens || 0)+metrics.cacheRead;}
    if(valid && metrics.speed!==null){row.outputTokens=(row.outputTokens || 0)+log.completion_tokens;row.durationSeconds=(row.durationSeconds || 0)+log.use_time;row.speedSamples=(row.speedSamples || 0)+1;}
    if(valid && metrics.netSpeed!==null){row.netOutputTokens=(row.netOutputTokens || 0)+log.completion_tokens;row.subsequentDurationSeconds=(row.subsequentDurationSeconds || 0)+requestTiming(log).subsequentMs!/1000;row.netSpeedSamples=(row.netSpeedSamples || 0)+1;}
  }
  return [...groups.values()];
}
export function pointGroup(point:QuotaPoint,grouping:Exclude<TrendGrouping,'total'>){
  if(grouping==='model')return {key:point.model_name || '',name:point.model_name || '未标记模型'};
  return {key:point.token_id ? 'id:'+point.token_id : 'name:'+(point.token_name || ''),name:point.token_name || (point.token_id ? '令牌 #'+point.token_id : '未标记令牌')};
}
export const TREND_COLORS=['var(--accent)','var(--purple)','var(--blue)','var(--orange)','var(--chart-series-5)','var(--red)','var(--chart-series-7)','var(--chart-series-8)','var(--chart-series-9)','var(--chart-series-10)','var(--chart-series-11)','var(--chart-series-12)'];
export function groupedTrend(points:QuotaPoint[],days:number,status:SiteStatus,range:RangeQuery|undefined,now:Date,grouping:TrendGrouping,metric:TrendMetric,selected=''){
  const createSeries=createUsageSeriesFactory(days,status,range,now),total=createSeries();
  const groups=new Map<string,{key:string;name:string;series:ReturnType<typeof createSeries>|null;}>();
  for(const point of points){
    if(!total.add(point) || grouping==='total')continue;
    const g=pointGroup(point,grouping);
    let group=groups.get(g.key);
    if(!group){group={...g,series:!selected || selected===g.key ? createSeries() : null};groups.set(g.key,group);}
    group.series?.add(point);
  }
  const valid=total.finish();
  if(grouping==='total')return {rows:valid.map(row=>({...row,values:{} as Record<string,number|null>})),lines:[],options:[],combined:0};
  const options=[...groups.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}) || a.key.localeCompare(b.key));
  const names=new Map<string,number>();for(const option of options)names.set(option.name,(names.get(option.name) || 0)+1);
  const series=options.map((group,index)=>({id:'series'+index,key:group.key,name:names.get(group.name)!>1 ? group.name+' (#'+group.key.replace(/^id:/,'' )+')' : group.name,color:TREND_COLORS[index%TREND_COLORS.length],rows:group.series?.finish()}));
  let shown=series.filter((s):s is typeof s & {rows:typeof valid}=>!!s.rows);
  let combined=0;
  if(!selected && shown.length>8){
    const weight=(row:typeof valid[number])=>metric==='cacheHitRate' ? row.cacheInputTokens : metric==='speed' ? row.outputTokens : metric==='netSpeed' ? row.netOutputTokens : row[metric] || 0;
    const ranked=shown.map(series=>({series,weight:series.rows.reduce((n,r)=>n+weight(r),0)})).sort((a,b)=>b.weight-a.weight).map(entry=>entry.series);
    const rest=ranked.slice(8);combined=rest.length;
    const merged=createSeries();for(const series of rest)merged.merge(series.rows);
    shown=[...ranked.slice(0,8),{id:'remaining',key:'',name:'其它'+(grouping==='model' ? '模型' : '令牌')+' ('+rest.length+')',color:'var(--text-muted)',rows:merged.finish()}];
  }
  return {rows:valid.map((row,index)=>({...row,values:Object.fromEntries(shown.map(s=>[s.id,s.rows[index][metric]]))})),lines:shown.map(({id,name,color})=>({id,name,color})),options:series.map(({key,name})=>({key,name})),combined};
}
