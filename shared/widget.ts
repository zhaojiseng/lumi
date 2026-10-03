import type {SurfacePalette} from './surface-theme';
import type {SiteStatus,UsageLog} from './types';
import type {DataRefreshAnimation} from './motion';
import {logMetrics} from './logs';
import {compact,currency,formatMoney} from './utils';

export interface WidgetModelUsage {name:string;quota:number;quotaKnown?:boolean;requests:number;inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheWriteTokens:number|null;}
export interface WidgetMinute {start:number;end:number;quota:number;quotaKnown?:boolean;requests:number;models:WidgetModelUsage[];latestModel?:WidgetModelUsage;}
export interface WidgetUsage {siteId:string;siteName:string;status:SiteStatus;balance:number|null;loggedIn:boolean;minute:WidgetMinute|null;historical:boolean;fetchedAt:number;warnings:string[];source?:'api'|'local';periodLabel?:string;}
export interface WidgetModel {name:string;cost:string;requests:string;input:string;output:string;cacheRead:string;cacheWrite:string;}
export interface WidgetState {material?:'acrylic';palette?:SurfacePalette;phase:'idle'|'loading'|'ready'|'error';enabled:boolean;siteName:string;balance:string;cost:string;minuteLabel:string;historical:boolean;models:WidgetModel[];latestModel?:WidgetModel;message:string;updatedAt:number;viewKey:string;dataKey:string;theme:'light'|'dark';animation?:DataRefreshAnimation;source?:'api'|'local';}
export type WidgetAction={type:'close'|'refresh'|'open'};
export interface WidgetBridge {snapshot():Promise<WidgetState>;action(event:WidgetAction):Promise<void>;onState(listener:(state:WidgetState)=>void):()=>void;}
export const WIDGET_WIDTH=244,WIDGET_HEIGHT=64;
export function previousMinute(now=Date.now()){const end=Math.floor(now/60000)*60-1;return {start_timestamp:end-59,end_timestamp:end};}
export function parseWidgetAction(value:unknown):WidgetAction|null {if(!value || typeof value!=='object' || Array.isArray(value))return null;const e=value as Record<string,unknown>;return Object.keys(e).length===1 && Object.hasOwn(e,'type') && ['close','refresh','open'].includes(e.type as string) ? {type:e.type as WidgetAction['type']} : null;}
const valid=(n:unknown):n is number=>typeof n==='number' && Number.isFinite(n) && n>=0;
const sum=(a:number|null,b:unknown)=>a!==null && valid(b) ? a+b : null;
export function widgetMinute(rows:UsageLog[],start:number):WidgetMinute {
  const byModel=new Map<string,WidgetModelUsage>(),ids=new Set<number>();let quota=0,requests=0,latest:UsageLog|undefined;
  for(const row of rows){if(row.type!==2 || row.created_at<start || row.created_at>=start+60 || ids.has(row.id))continue;ids.add(row.id);if(!valid(row.quota))throw new Error('分钟消费记录包含无效额度。');
    const name=typeof row.model_name==='string' && row.model_name ? row.model_name.slice(0,200) : '未知模型';
    if(!latest || row.created_at>latest.created_at || row.created_at===latest.created_at && row.id>latest.id)latest=row;
    const model=byModel.get(name) || {name,quota:0,requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0},metrics=logMetrics(row);
    model.quota+=row.quota;model.requests++;model.inputTokens=sum(model.inputTokens,row.prompt_tokens);model.outputTokens=sum(model.outputTokens,row.completion_tokens);model.cacheReadTokens=sum(model.cacheReadTokens,metrics.cacheRead);model.cacheWriteTokens=sum(model.cacheWriteTokens,metrics.cacheWrite);byModel.set(name,model);quota+=row.quota;requests++;
  }
  const metrics=latest ? logMetrics(latest) : null;
  return {start,end:start+59,quota,requests,models:[...byModel.values()].sort((a,b)=>b.quota-a.quota || a.name.localeCompare(b.name)),...(latest && metrics ? {latestModel:{name:latest.model_name?.slice(0,200) || '未知模型',quota:latest.quota,requests:1,inputTokens:valid(latest.prompt_tokens) ? latest.prompt_tokens : null,outputTokens:valid(latest.completion_tokens) ? latest.completion_tokens : null,cacheReadTokens:metrics.cacheRead,cacheWriteTokens:metrics.cacheWrite}} : {})};
}
export function formattedWidget(phase:WidgetState['phase'],data:WidgetUsage|undefined,options:{enabled:boolean;viewKey:string;theme:WidgetState['theme'];animation?:DataRefreshAnimation;inputMode?:'total'|'uncached';error?:string}):WidgetState {
  const count=(n:number|null)=>valid(n) ? compact(n) : '—';
  const money=(n:number|null,minute=false)=>{
    if(!data || typeof n!=='number' || !Number.isFinite(n))return '—';
    const amount=Math.abs(currency(data.status).value(n)),digits=minute && amount>0 && amount<.01 ? Math.min(8,Math.max(2,Math.ceil(-Math.log10(amount))+1)) : 2;
    return formatMoney(n,data.status,digits);
  };
  const minute=data?.minute,date=minute ? new Date(minute.start*1000) : null,time=date ? date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '暂无消费分钟';
  const input=(m:WidgetModelUsage)=>options.inputMode!=='uncached' ? m.inputTokens : m.inputTokens!==null && m.cacheReadTokens!==null ? Math.max(0,m.inputTokens-m.cacheReadTokens) : null;
  const formatModel=(m:WidgetModelUsage)=>({name:m.name,cost:money(m.quotaKnown===false ? null : m.quota,true),requests:count(m.requests),input:count(input(m)),output:count(m.outputTokens),cacheRead:count(m.cacheReadTokens),cacheWrite:count(m.cacheWriteTokens)});
  const models=minute?.models.map(formatModel) || [],latestModel=minute?.latestModel ? formatModel(minute.latestModel) : undefined;
  const source=data?.source || 'api';
  return {...options,phase,source,siteName:(data?.siteName || (source==='local' ? '本地会话' : 'Lumi')).slice(0,100),balance:money(data?.balance ?? null),cost:minute ? money(minute.quotaKnown===false ? null : minute.quota,true) : '—',minuteLabel:data?.periodLabel ? data.periodLabel+' · '+time : time,historical:!!data?.historical,models,...(latestModel ? {latestModel} : {}),
    message:phase==='error' ? options.error || '用量暂不可用，保留上次结果' : data && !data.loggedIn && source!=='local' ? '登录站点后查看余额和用量' : data?.warnings[0] || (phase==='loading' ? '正在同步…' : minute ? source==='local' ? '本地会话用量' : data?.historical ? '最近有消耗的一分钟' : '上一分钟' : source==='local' ? '暂无本地会话用量' : '尚无额度消耗'),updatedAt:data?.fetchedAt || 0,
    dataKey:JSON.stringify([options.viewKey,source,options.inputMode,data?.balance,minute])};
}
