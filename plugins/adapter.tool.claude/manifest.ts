import type {PluginManifest} from '../../shared/contracts/plugins';
export const claudeAdapterManifest:PluginManifest={id:'adapter.tool.claude',version:'1.0.0',hostApiVersion:1,configurable:true,defaultEnabled:true,requires:[],optional:[],provides:['toolConfig.build'],settings:{title:'Claude Code 工具配置',description:'管理 Claude Code CLI 的模型、渠道和配置文件。停用保留已应用配置及备份。',order:310,group:'tools',views:[]}};
