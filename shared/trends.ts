import {usageSeries} from './utils';
import {resolveRange} from './range';
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
  }
  return [...groups.values()];
}
export function pointGroup(point:QuotaPoint,grouping:Exclude<TrendGrouping,'total'>){
  if(grouping==='model')return {key:point.model_name || '',name:point.model_name || '未标记模型'};
  return {key:point.token_id ? 'id:'+point.token_id : 'name:'+(point.token_name || ''),name:point.token_name || (point.token_id ? '令牌 #'+point.token_id : '未标记令牌')};
}
export const TREND_COLORS=['#4a8b76','#8a73bf','#4d8fbd','#b47b47','#8c9b40','#c26080','#457e8f','#b56150','#656fbd','#987b58','#499686','#a276a7'];
export function groupedTrend(points:QuotaPoint[],days:number,status:SiteStatus,range:RangeQuery|undefined,now:Date,grouping:TrendGrouping,metric:TrendMetric,selected=''){
  const valid=usageSeries(points,days,status,range,now);
  if(grouping==='total')return {rows:valid.map(row=>({...row,values:{} as Record<string,number>})),lines:[],options:[],combined:0};
  const groups=new Map<string,{key:string;name:string;points:QuotaPoint[];}>();
  const window=resolveRange(range || days,now);
  for(const point of points){if(!Number.isFinite(point.created_at) || point.created_at<window.start_timestamp || point.created_at>window.end_timestamp)continue;const g=pointGroup(point,grouping);const group=groups.get(g.key) || {...g,points:[]};group.points.push(point);groups.set(g.key,group);}
  const options=[...groups.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}) || a.key.localeCompare(b.key));
  const names=new Map<string,number>();for(const option of options)names.set(option.name,(names.get(option.name) || 0)+1);
  const series=options.map((group,index)=>({id:'series'+index,key:group.key,name:names.get(group.name)!>1 ? group.name+' (#'+group.key.replace(/^id:/,'' )+')' : group.name,color:TREND_COLORS[index%TREND_COLORS.length],rows:usageSeries(group.points,days,status,range,now)}));
  let shown=selected ? series.filter(s=>s.key===selected) : series;
  let combined=0;
  if(!selected && shown.length>8){
    const ranked=[...shown].sort((a,b)=>b.rows.reduce((n,r)=>n+r[metric],0)-a.rows.reduce((n,r)=>n+r[metric],0));
    const rest=ranked.slice(8);combined=rest.length;
    shown=[...ranked.slice(0,8),{id:'remaining',key:'',name:'其它'+(grouping==='model' ? '模型' : '令牌')+' ('+rest.length+')',color:'#849298',rows:valid.map((row,i)=>({...row,[metric]:rest.reduce((sum,s)=>sum+s.rows[i][metric],0)}))}];
  }
  return {rows:valid.map((row,index)=>({...row,values:Object.fromEntries(shown.map(s=>[s.id,s.rows[index][metric]]))})),lines:shown.map(({id,name,color})=>({id,name,color})),options:series.map(({key,name})=>({key,name})),combined};
}
