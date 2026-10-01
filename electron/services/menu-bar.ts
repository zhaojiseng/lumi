import type {MenuItemConstructorOptions} from 'electron';
import type {MenuBarUsage,Page} from '../../shared/types';
import {formatMoney,compact} from '../../shared/utils';
export interface MenuBarSnapshot {phase:'idle'|'loading'|'ready'|'error';usage?:MenuBarUsage;error?:string;}
/** On-demand, account-isolated cache. The native NSMenu supplies the system material. */
export class MenuBarService {
  private value:MenuBarSnapshot={phase:'idle'};private key='';private pending?:{key:string;job:Promise<MenuBarSnapshot>};
  constructor(private options:{identity():string;load(force:boolean):Promise<MenuBarUsage>;changed?():void;now?():number;}){}
  snapshot(){const key=this.options.identity();if(key!==this.key){this.key=key;this.value={phase:'idle'};}return structuredClone(this.value);}
  async refresh(force=false):Promise<MenuBarSnapshot>{
    const state=this.snapshot(),key=this.key,now=this.options.now?.() ?? Date.now();
    if(this.pending?.key===key)return this.pending.job;
    if(!force && state.usage && now-state.usage.fetchedAt<60000)return state;
    this.value={...state,phase:'loading',error:undefined};this.options.changed?.();
    const job=(async()=>{
      try{const usage=await this.options.load(force);if(this.options.identity()===key)this.value={phase:'ready',usage};}
      catch{if(this.options.identity()===key)this.value={...state,phase:'error',error:'用量暂不可用，请稍后刷新。'};}
      finally{if(this.pending?.key===key)this.pending=undefined;this.options.changed?.();}
      return this.snapshot();
    })();this.pending={key,job};return job;
  }
}
export function menuBarTemplate(state:MenuBarSnapshot,actions:{navigate(page:Page):void;refresh():void;quit():void}):MenuItemConstructorOptions[]{
  const row=(label:string):MenuItemConstructorOptions=>({label,enabled:false});
  const data=state.usage,money=(value:number|null)=>value===null ? '—' : formatMoney(value,data!.status),count=(value:number|null)=>value===null ? '—' : compact(value);
  const items:MenuItemConstructorOptions[]=[row('Lumi · '+(data?.siteName || 'AI 工作台')),{type:'separator'}];
  items.push(row('账户余额　'+(data?.user ? money(data.user.quota) : '—')),row('今日消费　'+(data?.user ? money(data.today.quota) : '—')),row('今日请求　'+(data?.user ? count(data.today.requests) : '—')),row('今日 Tokens　'+(data?.user ? count(data.today.tokens) : '—')),{type:'separator'});
  for(const tool of ['codex','claude'] as const)items.push(row((tool==='codex' ? 'Codex' : 'Claude Code')+' 今日　'+(data?.user ? money(data.tools.find(t=>t.tool===tool)?.quota ?? null) : '—')));
  const message=state.phase==='loading' ? '正在读取余额与用量…' : state.phase==='error' ? state.error! : data && !data.user ? '登录后查看余额与用量' : data?.warnings.length ? '部分统计暂不可用' : data ? '上次同步　'+new Date(data.fetchedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}) : '点击刷新读取用量';
  items.push({label:message,enabled:!!data && !data.user,click:()=>actions.navigate('settings')});
  items.push({type:'separator'},{label:state.phase==='loading' ? '正在刷新…' : '刷新用量',enabled:state.phase!=='loading',click:actions.refresh},{label:'打开工作台',click:()=>actions.navigate('overview')},{label:'用量分析',click:()=>actions.navigate('usage')},{label:'设置…',click:()=>actions.navigate('settings')},{type:'separator'},{label:'退出 Lumi',click:actions.quit});
  return items;
}
