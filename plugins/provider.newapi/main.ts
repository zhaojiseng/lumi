import type {TrustedBuiltinPlugin} from '../../shared/contracts/plugins';
import {newApiManifest} from './manifest';
import type {CatalogReadCapability} from '../../shared/contracts/catalog';
import type {SettingsStore} from '../../electron/services/store';
import {NewApiClient} from './services/client';

export function newApiPlugin(store:SettingsStore,catalog?:CatalogReadCapability):TrustedBuiltinPlugin{
  return {manifest:newApiManifest,activate(context){
    const api=new NewApiClient(store);
    context.provide('catalog.read',catalog ?? {read:input=>api.readCatalog(input)});
    context.provide('account.session',{loginInfo:()=>api.loginInfo(),login:input=>api.login(input),verifyLogin:input=>api.verifyLogin(input),logout:id=>api.logout(id),acceptBrowserSession:(...args)=>api.acceptBrowserSession(...args)});
    context.provide('online.usage',{status:()=>api.status(),dashboard:(...args)=>api.dashboard(...args),logs:input=>api.logs(input),allLogs:(...args)=>api.allLogs(...args),tokenUsage:input=>api.tokenUsage(input),usageQuality:input=>api.usageQuality(input),modelHealth:model=>api.modelHealth(model)});
    context.provide('tokens.manage',{createToken:input=>api.createToken(input),toggleToken:(...args)=>api.toggleToken(...args),updateToken:input=>api.updateToken(input),getTokenKey:id=>api.getTokenKey(id)});
    context.provide('toolCredential.provision',{provision:input=>api.ensureToolToken(input)});
    context.provide('desktopUsage.read',{widgetUsage:(...args)=>api.widgetUsage(...args),widgetPricing:()=>api.widgetPricing(),menuBarUsage:(...args)=>api.menuBarUsage(...args),menuBarDetails:(...args)=>api.menuBarDetails(...args)});
    context.onDispose(()=>api.close());
  }};
}
