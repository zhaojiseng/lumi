import type {PluginManifest} from '../../shared/contracts/plugins';
export const codexAdapterManifest:PluginManifest={id:'adapter.tool.codex',version:'1.0.0',hostApiVersion:1,configurable:true,defaultEnabled:true,requires:[],optional:[],provides:['toolConfig.build'],settings:{title:'Codex 工具配置',description:'管理 Codex CLI 的模型、渠道和配置文件。停用保留已应用配置及备份。',order:300,group:'tools',views:[]}};
