import type {PluginManifest} from '../../shared/contracts/plugins';
export const codexProviderManifest:PluginManifest={id:'provider.codex',version:'1.0.0',hostApiVersion:1,configurable:true,defaultEnabled:false,requires:[],optional:[],provides:['subscriptionUsage.read'],settings:{title:'Codex',description:'读取 Codex 账户的订阅限额和剩余积分。',order:20,views:[{id:'workbench',title:'工作台'}]}};
