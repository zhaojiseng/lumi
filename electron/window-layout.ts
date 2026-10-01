import type {BrowserWindowConstructorOptions,MenuItemConstructorOptions} from 'electron';
export function windowLayout(platform:NodeJS.Platform,area:{width:number;height:number}):BrowserWindowConstructorOptions {
  const mac=platform==='darwin',minWidth=Math.min(mac ? 1000 : 1080,area.width),minHeight=Math.min(mac ? 640 : 740,area.height);
  return {width:Math.max(minWidth,Math.min(1480,area.width)),height:Math.max(minHeight,Math.min(990,area.height)),minWidth,minHeight,frame:mac,titleBarStyle:'hidden',...(mac ? {trafficLightPosition:{x:24,y:22}} : {})};
}
export function macMenu():MenuItemConstructorOptions[]{return [
  {label:'Lumi',submenu:[{role:'about'},{type:'separator'},{role:'services'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
  {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
  {label:'显示',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{type:'separator'},{role:'togglefullscreen'}]},
  {label:'窗口',submenu:[{role:'minimize'},{role:'zoom'},{role:'close'},{type:'separator'},{role:'front'}]},
];}
