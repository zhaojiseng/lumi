import {compact,currency,formatMoney,dailySeries,hourlySeries} from './utils';
import type {MenuBarSelection,MenuBarUsage} from './types';

export const DEFAULT_MENU_BAR_SELECTION:MenuBarSelection={days:1,tool:'all'};
export function menuBarSelection(values:Record<string,unknown>={}):MenuBarSelection {
  return {days:values['menuBar.days']===7 ? 7 : values['menuBar.days']===30 ? 30 : 1,tool:values['menuBar.tool']==='codex' ? 'codex' : values['menuBar.tool']==='claude' ? 'claude' : 'all'};
}
export interface NativeMenuBarState {
  type:'state';schemaVersion:1;phase:string;siteName:string;accountLabel:string;days:number;tool:string;
  balance:string;cost:string;tokens:string;requests:string;tokenDetail:string;cacheDetail:string;
  cacheHitRate:string;tokenSpeed:string;message:string;updatedLabel:string;canRefresh:boolean;chartCaption:string;
  chart:{label:string;value:number;cost:string;tokens:string;requests:string}[]|null;
  models:{name:string;cost:string;share:number}[];modelsMessage:string;
}
type Snapshot={phase:'idle'|'loading'|'ready'|'error';usage?:MenuBarUsage;error?:string;detailsLoading?:boolean;detailsError?:string};
const text=(s:string,n=100)=>s.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,n);
/** Only formatted usage and bounded chart data cross the native helper boundary. */
export function nativeMenuBarState(state:Snapshot,selection:MenuBarSelection):NativeMenuBarState {
  const data=state.usage,period=data?.period,details=data?.details;
  const money=(n:number|null|undefined)=>data && typeof n==='number' && Number.isFinite(n) && n>=0 ? formatMoney(n,data.status) : '—';
  const count=(n:number|null|undefined)=>typeof n==='number' && Number.isFinite(n) && n>=0 ? compact(n) : '—';
  const quality=details?.quality,points=period?.points,models=new Map<string,number>();
  for(const p of points || [])if(Number.isFinite(p.quota) && p.quota>=0)models.set(p.model_name,(models.get(p.model_name)||0)+p.quota);
  const total=[...models.values()].reduce((a,b)=>a+b,0),rows=points && data ? selection.days===1 ? hourlySeries(points,data.status,undefined,new Date(data.fetchedAt)) : dailySeries(points,selection.days,data.status,undefined,new Date(data.fetchedAt)) : null;
  const scope=selection.tool==='all' ? '全部请求' : selection.tool==='codex' ? 'Codex 专用令牌' : 'Claude 专用令牌';
  const message=state.phase==='loading' ? '正在刷新用量…' : state.phase==='error' ? state.error || '用量暂不可用' : data && !data.user ? '登录站点后查看用量' : state.detailsLoading ? '正在读取效率统计…' : state.detailsError ? '详细统计暂不可用' : data?.warnings.length ? '部分统计暂不可用' : scope+' · New API';
  return {type:'state',schemaVersion:1,phase:state.phase,siteName:text(data?.siteName || 'Lumi'),accountLabel:text(data?.user?.display_name || data?.user?.username || '尚未登录'),days:selection.days,tool:selection.tool,
    balance:money(data?.user?.quota),cost:money(period ? period.quota : data?.today.quota),tokens:count(period ? period.tokens : data?.today.tokens),requests:count(period ? period.requests : data?.today.requests),
    tokenDetail:details ? '输入 '+count(details.inputTokens)+' · 输出 '+count(details.outputTokens) : '输入 / 输出明细暂不可用',
    cacheDetail:details ? '缓存读取 '+count(details.cacheReadTokens)+' · 写入 '+count(details.cacheWriteTokens)+'；命中率 = 缓存读取 ÷ 输入' : '缓存明细暂不可用',
    cacheHitRate:quality?.cacheHitRate!==null && quality?.cacheHitRate!==undefined ? (quality.cacheHitRate*100).toFixed(1)+'%' : '—',tokenSpeed:quality?.averageTokenSpeed!==null && quality?.averageTokenSpeed!==undefined ? quality.averageTokenSpeed.toFixed(1)+' t/s' : '—',
    message:text(message),updatedLabel:data ? '更新于 '+new Date(data.fetchedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}) : '等待同步',canRefresh:state.phase!=='loading',chartCaption:selection.days===1 ? '今日 · 按小时' : '最近 '+selection.days+' 天 · 按天',
    chart:rows?.slice(0,60).map(r=>({label:r.label,value:Number.isFinite(r.cost) && r.cost>=0 ? r.cost : 0,cost:currency(data!.status).symbol+r.cost.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}),tokens:count(r.tokens),requests:count(r.requests)})) ?? null,
    models:[...models].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,3).map(([name,quota])=>({name:text(name,200),cost:money(quota),share:total>0 ? quota/total : 0})),modelsMessage:points ? models.size ? '' : '本期暂无模型调用' : state.detailsLoading ? '正在读取模型统计…' : '模型统计暂不可用'};
}
