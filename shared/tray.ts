import type {NativeMenuBarState} from './menu-bar';
import type {MenuBarSelection,Page} from './types';
export type TrayAction={type:'close'}|{type:'refresh'|'quit'}|{type:'navigate';page:Page}|{type:'select';selection:MenuBarSelection};
export interface TrayPanelState {usage:NativeMenuBarState;theme:'light'|'dark';}
export interface TrayPanelBridge {snapshot():Promise<TrayPanelState>;action(event:TrayAction):Promise<void>;onState(listener:(state:TrayPanelState)=>void):()=>void;}

/** Keep the whole popup inside the selected display, including side/top taskbars. */
export function trayPanelBounds(anchor:{x:number;y:number;width:number;height:number},area:{x:number;y:number;width:number;height:number},size={width:396,height:648}){
  const gap=10,width=Math.min(size.width,Math.max(1,area.width-gap*2)),height=Math.min(size.height,Math.max(1,area.height-gap*2));
  const clamp=(n:number,min:number,max:number)=>Math.round(Math.min(Math.max(n,min),Math.max(min,max)));
  let x=anchor.x+anchor.width/2-width/2,y=anchor.y-height-gap;
  if(anchor.y+anchor.height<=area.y)y=area.y+gap;
  if(anchor.x+anchor.width<=area.x){x=area.x+gap;y=anchor.y;}
  if(anchor.x>=area.x+area.width){x=area.x+area.width-width-gap;y=anchor.y;}
  return {x:clamp(x,area.x+gap,area.x+area.width-width-gap),y:clamp(y,area.y+gap,area.y+area.height-height-gap),width,height};
}
export function trustedTrayUrl(url:string|undefined,expected:string){return !!url && url.split('#')[0]===expected;}
export function parseTrayAction(value:unknown):TrayAction|null {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const e=value as Record<string,unknown>,keys=Object.keys(e);
  if(['refresh','close','quit'].includes(e.type as string) && keys.length===1)return {type:e.type as 'refresh'|'close'|'quit'};
  if(e.type==='navigate' && keys.length===2 && ['overview','usage','settings'].includes(e.page as string))return {type:'navigate',page:e.page as Page};
  if(e.type==='select' && keys.length===2 && e.selection && typeof e.selection==='object' && !Array.isArray(e.selection)){
    const s=e.selection as Record<string,unknown>;if(Object.keys(s).length===2 && [1,7,30].includes(s.days as number) && ['all','codex','claude'].includes(s.tool as string))return {type:'select',selection:{days:s.days as MenuBarSelection['days'],tool:s.tool as MenuBarSelection['tool']}};
  }
  return null;
}
