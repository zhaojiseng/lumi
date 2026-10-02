import type {PluginManifest} from '../../shared/contracts/plugins';
export const usageManifest:PluginManifest={id:'feature.usage',version:'1.0.0',hostApiVersion:1,configurable:false,requires:[],optional:[{sourceId:'provider.newapi',capability:'desktopUsage.read'},{sourceId:'source.local-sessions',capability:'localSessions.read'}],provides:['usage.present']};
