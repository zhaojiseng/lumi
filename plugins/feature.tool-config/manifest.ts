import type {PluginManifest} from '../../shared/contracts/plugins';
export const toolConfigManifest:PluginManifest={id:'feature.tool-config',version:'1.0.0',hostApiVersion:1,configurable:false,requires:[],optional:[{sourceId:'adapter.tool.codex',capability:'toolConfig.build'},{sourceId:'adapter.tool.claude',capability:'toolConfig.build'}],provides:[]};
