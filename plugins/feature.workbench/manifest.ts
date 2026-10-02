import type {PluginManifest} from '../../shared/contracts/plugins';
export const workbenchManifest:PluginManifest={id:'feature.workbench',version:'1.0.0',hostApiVersion:1,configurable:false,requires:[],optional:[{sourceId:'provider.newapi',capability:'desktopUsage.read'}],provides:['workbench.present']};
