import type {PluginManifest} from '../../shared/contracts/plugins';
export const widgetManifest:PluginManifest={id:'surface.widget',version:'1.0.0',hostApiVersion:1,configurable:true,requires:[],optional:[{sourceId:'feature.usage',capability:'usage.present'}],provides:['widget.project','surface.control'],settings:{title:'浮窗',description:'独立浮窗，从系统展示服务读取内容。',order:30,views:[]}};
