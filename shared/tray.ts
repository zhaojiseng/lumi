import type {SurfacePalette} from './surface-theme';
import type {NativeMenuBarState} from './menu-bar';
import type {MenuBarSelection,Page} from './types';
export const TRAY_PANEL_WIDTH=396,TRAY_PANEL_MIN_HEIGHT=160,TRAY_PANEL_MAX_HEIGHT=648,TRAY_RESIZE_DURATION=230,TRAY_CLOSE_DURATION=150;
export type TrayAction={type:'close'}|{type:'refresh'|'quit'}|{type:'navigate';page:Page}|{type:'select';selection:MenuBarSelection}
  |{type:'layout';height:number;reducedMotion:boolean}|{type:'closeComplete';id:number};
export interface TrayPanelState {palette?:SurfacePalette;usage:NativeMenuBarState;theme:'light'|'dark';motion?:{id:number;phase:'hidden'|'visible'|'closing'};}
export interface TrayPanelBridge {snapshot():Promise<TrayPanelState>;action(event:TrayAction):Promise<void>;onState(listener:(state:TrayPanelState)=>void):()=>void;}

type Rectangle={x:number;y:number;width:number;height:number};
/** Intrinsic chrome + rows, independent of the current viewport and its scrolling/clipping. */
export function trayPanelContentHeight(chromeHeight:number,sectionContentHeight=0){
  return Math.min(TRAY_PANEL_MAX_HEIGHT,Math.max(TRAY_PANEL_MIN_HEIGHT,Math.ceil(chromeHeight+sectionContentHeight+8)));
}
/** Keep the whole popup inside the selected display, including side/top taskbars. */
export function trayPanelBounds(anchor:Rectangle,area:Rectangle,size={width:TRAY_PANEL_WIDTH,height:TRAY_PANEL_MAX_HEIGHT}){
  const gap=10,width=Math.min(size.width,Math.max(1,area.width-gap*2)),height=Math.min(size.height,Math.max(1,area.height-gap*2));
  const clamp=(n:number,min:number,max:number)=>Math.round(Math.min(Math.max(n,min),Math.max(min,max)));
  let x=anchor.x+anchor.width/2-width/2,y=anchor.y-height-gap;
  if(anchor.y+anchor.height<=area.y)y=area.y+gap;
  if(anchor.x+anchor.width<=area.x){x=area.x+gap;y=anchor.y;}
  if(anchor.x>=area.x+area.width){x=area.x+area.width-width-gap;y=anchor.y;}
  // A bottom taskbar's icon can sit below its top edge; anchor to the work area, not the icon.
  if(anchor.y+anchor.height>=area.y+area.height)y=area.y+area.height-height;
  return {x:clamp(x,area.x+gap,area.x+area.width-width-gap),y:clamp(y,area.y+gap,area.y+area.height-height),width,height};
}
/** Interpolate the bottom edge separately so integer rounding never opens a taskbar gap. */
export function trayPanelBoundsAt(from:Rectangle,to:Rectangle,progress:number):Rectangle {
  const t=1-(1-Math.max(0,Math.min(1,progress)))**3,lerp=(a:number,b:number)=>Math.round(a+(b-a)*t);
  const height=lerp(from.height,to.height);
  return {x:lerp(from.x,to.x),y:lerp(from.y+from.height,to.y+to.height)-height,width:lerp(from.width,to.width),height};
}
export function trustedTrayUrl(url:string|undefined,expected:string){return !!url && url.split('#')[0]===expected;}
export function parseTrayAction(value:unknown):TrayAction|null {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const e=value as Record<string,unknown>,keys=Object.keys(e);
  if(e.type==='layout' && keys.length===3 && Number.isInteger(e.height) && (e.height as number)>=TRAY_PANEL_MIN_HEIGHT && (e.height as number)<=TRAY_PANEL_MAX_HEIGHT && typeof e.reducedMotion==='boolean')return {type:'layout',height:e.height as number,reducedMotion:e.reducedMotion};
  if(e.type==='closeComplete' && keys.length===2 && Number.isSafeInteger(e.id) && (e.id as number)>0)return {type:'closeComplete',id:e.id as number};
  if(['refresh','close','quit'].includes(e.type as string) && keys.length===1)return {type:e.type as 'refresh'|'close'|'quit'};
  if(e.type==='navigate' && keys.length===2 && ['overview','usage','settings'].includes(e.page as string))return {type:'navigate',page:e.page as Page};
  if(e.type==='select' && keys.length===2 && e.selection && typeof e.selection==='object' && !Array.isArray(e.selection)){
    const s=e.selection as Record<string,unknown>;if(Object.keys(s).length===2 && [1,7,30].includes(s.days as number) && ['all','codex','claude'].includes(s.tool as string))return {type:'select',selection:{days:s.days as MenuBarSelection['days'],tool:s.tool as MenuBarSelection['tool']}};
  }
  return null;
}
