import type {MenuItemConstructorOptions} from 'electron';
import {MENU_BAR_SECTION_IDS,type MenuBarSectionId,type MenuBarUsage,type Page,type MenuBarDetails} from '../../shared/types';
import {formatMoney} from '../../shared/utils';
import {DEFAULT_MENU_BAR_SELECTION,nativeMenuBarState,normalizeMenuBarContents} from '../../shared/menu-bar';
export interface MenuBarSnapshot {phase:'idle'|'loading'|'ready'|'error';usage?:MenuBarUsage;error?:string;detailsLoading?:boolean;detailsError?:string;}
function withDetails(usage:MenuBarUsage,details:MenuBarDetails):MenuBarUsage {
  const period=usage.period;
  return {...usage,details,...(period && (period.selection.tool!=='all' || period.selection.range==='24h') ? {period:{...period,points:details.points,tokens:details.points.reduce((s,p)=>s+p.token_used,0),requests:details.points.reduce((s,p)=>s+p.count,0)}} : {}),...(usage.chartPeriod && (usage.chartPeriod.selection.tool!=='all' || usage.chartPeriod.selection.range==='24h') ? {chartPeriod:{...usage.chartPeriod,points:details.chartPoints ?? null}} : {})};
}
/** On-demand, account-isolated cache. The native NSMenu supplies the system material. */
export class MenuBarService {
  private value:MenuBarSnapshot={phase:'idle'};private key='';private pending?:{key:string;job:Promise<MenuBarSnapshot>};private detailPending?:{key:string;job:Promise<MenuBarSnapshot>};
  constructor(private options:{identity():string;load(force:boolean):Promise<MenuBarUsage>;loadDetails?():Promise<MenuBarDetails>;changed?():void;now?():number;summaryTtl?():number;}){}
  snapshot(){const key=this.options.identity();if(key!==this.key){this.key=key;this.value={phase:'idle'};}return structuredClone(this.value);}
  async refresh(force=false):Promise<MenuBarSnapshot>{
    const state=this.snapshot(),key=this.key,now=this.options.now?.() ?? Date.now();
    if(this.pending?.key===key)return this.pending.job;
    const configuredTtl=this.options.summaryTtl?.() ?? 60000,summaryTtl=Number.isFinite(configuredTtl) && configuredTtl>0 ? configuredTtl : 60000;
    if(!force && state.usage && now-state.usage.fetchedAt<summaryTtl)return state;
    this.value={...state,phase:'loading',error:undefined};this.options.changed?.();
    const job=(async()=>{
      try{let usage=await this.options.load(force);if(this.options.identity()===key){const details=this.value.usage?.details;if(!force && details && now-details.quality.fetchedAt<300000)usage=withDetails(usage,details);this.value={phase:'ready',usage,detailsLoading:this.value.detailsLoading};}}
      catch{if(this.options.identity()===key)this.value={...state,phase:'error',error:'用量暂不可用，请稍后刷新。'};}
      finally{if(this.pending?.key===key)this.pending=undefined;this.options.changed?.();}
      return this.snapshot();
    })();this.pending={key,job};return job;
  }
  async details(force=false):Promise<MenuBarSnapshot>{
    const state=this.snapshot(),key=this.key,now=this.options.now?.() ?? Date.now();
    if(!this.options.loadDetails || !state.usage?.user || state.phase==='loading')return state;
    if(this.detailPending?.key===key)return this.detailPending.job;
    if(!force && state.usage.details && now-state.usage.details.quality.fetchedAt<300000)return state;
    this.value={...state,detailsLoading:true,detailsError:undefined};this.options.changed?.();
    const job=(async()=>{try{const details=await this.options.loadDetails!();if(this.options.identity()===key && this.value.usage)this.value={...this.value,usage:withDetails(this.value.usage,details),detailsLoading:false};}catch{if(this.options.identity()===key)this.value={...this.value,detailsLoading:false,detailsError:'详细统计暂不可用，请缩小范围或稍后刷新。'};}finally{if(this.detailPending?.key===key)this.detailPending=undefined;this.options.changed?.();}return this.snapshot();})();
    this.detailPending={key,job};return job;
  }
}
export function menuBarTemplate(state:MenuBarSnapshot,actions:{navigate(page:Page):void;refresh():void;quit():void},contents:readonly MenuBarSectionId[]=MENU_BAR_SECTION_IDS):MenuItemConstructorOptions[]{
  const row=(label:string):MenuItemConstructorOptions=>({label,enabled:false});
  const data=state.usage,money=(value:number|null)=>value===null ? '—' : formatMoney(value,data!.status);
  const items:MenuItemConstructorOptions[]=[row('Lumi · '+(data?.siteName || 'AI 工作台'))];
  const period=data?.period;
  const visible=normalizeMenuBarContents(contents),formatted=nativeMenuBarState(state,period?.selection ?? DEFAULT_MENU_BAR_SELECTION,visible);
  const range=formatted.totalsCaption || '本期';
  const section=(labels:string[])=>{if(labels.length)items.push({type:'separator'},...labels.map(row));};
  if(visible.includes('balance'))section(['账户余额　'+formatted.balance]);
  if(visible.includes('totals'))section([range+'消费　'+formatted.cost,range+'请求　'+formatted.requests,range+' Tokens　'+formatted.tokens,...(['codex','claude'] as const).map(tool=>(tool==='codex' ? 'Codex' : 'Claude Code')+' '+range+'　'+(data?.user ? money(data.tools.find(t=>t.tool===tool)?.quota ?? null) : '—'))]);
  if(visible.includes('tokenDetail'))section([formatted.tokenDetail]);
  if(visible.includes('efficiency'))section(['缓存命中率　'+formatted.cacheHitRate,'平均 Token 速率　'+formatted.tokenSpeed]);
  if(visible.includes('chart'))section([formatted.chartCaption+' · 消费趋势',...(formatted.chart?.length ? formatted.chart.slice(-6).map(point=>point.label+'　'+point.cost) : ['消费曲线暂不可用'])]);
  if(visible.includes('models'))section(['主要模型 · 按消费',...(formatted.models.length ? formatted.models.map(model=>model.name+'　'+model.cost) : [formatted.modelsMessage])]);
  const message=state.phase==='loading' ? '正在读取余额与用量…' : state.phase==='error' ? state.error! : data && !data.user ? '登录后查看余额与用量' : data?.warnings.length ? '部分统计暂不可用' : data ? '上次同步　'+new Date(data.fetchedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}) : '点击刷新读取用量';
  items.push({label:message,enabled:!!data && !data.user,click:()=>actions.navigate('settings')});
  items.push({type:'separator'},{label:state.phase==='loading' ? '正在刷新…' : '刷新用量',enabled:state.phase!=='loading',click:actions.refresh},{label:'打开工作台',click:()=>actions.navigate('overview')},{label:'用量分析',click:()=>actions.navigate('usage')},{label:'设置…',click:()=>actions.navigate('settings')},{type:'separator'},{label:'退出 Lumi',click:actions.quit});
  return items;
}
