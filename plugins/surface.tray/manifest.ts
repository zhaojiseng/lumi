import type {PluginManifest} from '../../shared/contracts/plugins';
export const trayManifest:PluginManifest={id:'surface.tray',version:'1.0.0',hostApiVersion:1,configurable:true,requires:[],optional:[{sourceId:'feature.workbench',capability:'workbench.present'}],provides:['tray.project','surface.control'],settings:{title:'托盘',description:'系统托盘与菜单栏用量面板。',order:40,views:[]}};
