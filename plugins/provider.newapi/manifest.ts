import type {PluginManifest} from '../../shared/contracts/plugins';

export const newApiManifest:PluginManifest={
  id:'provider.newapi',version:'1.0.0',hostApiVersion:1,requires:[],optional:[],
  provides:['catalog.read','account.session','online.usage','tokens.manage','toolCredential.provision','desktopUsage.read'],configurable:true,
  settings:{title:'NewAPI',description:'接入站点账户、用量、模型和令牌。',order:10,views:[{id:'workbench',title:'工作台'},{id:'usage',title:'用量分析'},{id:'models',title:'模型广场'},{id:'tokens',title:'API令牌'}]},
};
