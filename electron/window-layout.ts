import type {BrowserWindowConstructorOptions,MenuItemConstructorOptions} from 'electron';
import type {Page} from '../shared/types';
export function windowLayout(platform:NodeJS.Platform,area:{width:number;height:number}):BrowserWindowConstructorOptions {
  const mac=platform==='darwin',minWidth=Math.min(mac ? 1000 : 1080,area.width),minHeight=Math.min(mac ? 640 : 740,area.height);
  return {width:Math.max(minWidth,Math.min(1480,area.width)),height:Math.max(minHeight,Math.min(990,area.height)),minWidth,minHeight,frame:mac,titleBarStyle:'hidden',...(mac ? {trafficLightPosition:{x:24,y:22}} : {})};
}
export function macMenu(actions?:{navigate(page:Page):void;refresh():void;show():void;checkUpdate():void}):MenuItemConstructorOptions[]{return [
  {label:'Lumi',submenu:[{role:'about'},...(actions ? [{label:'设置…',accelerator:'Command+,',click:()=>actions.navigate('settings')},{label:'检查更新…',click:actions.checkUpdate},{type:'separator' as const}] : []),{role:'services'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
  {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
  {label:'显示',submenu:[...(actions ? [{label:'工作台',accelerator:'Command+1',click:()=>actions.navigate('overview')},{label:'用量分析',accelerator:'Command+2',click:()=>actions.navigate('usage')},{label:'模型广场',accelerator:'Command+3',click:()=>actions.navigate('models')},{type:'separator' as const},{label:'刷新用量',accelerator:'Command+R',click:actions.refresh},{type:'separator' as const}] : []),{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{type:'separator'},{role:'togglefullscreen'}]},
  {label:'窗口',submenu:[{role:'minimize'},{role:'zoom'},{role:'close'},...(actions ? [{type:'separator' as const},{label:'打开 Lumi',click:actions.show}] : []),{type:'separator'},{role:'front'}]},
];}
