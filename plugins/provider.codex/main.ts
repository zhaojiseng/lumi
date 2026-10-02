import type {TrustedBuiltinPlugin} from '../../shared/contracts/plugins';
import type {Command} from '../../electron/services/tool-runtime';
import {codexProviderManifest} from './manifest';
import {CodexUsageService} from './services/usage';
export function codexProviderPlugin(resolve:()=>Promise<Command|undefined>):TrustedBuiltinPlugin {
  return {manifest:codexProviderManifest,activate(context){const service=new CodexUsageService({resolve});context.provide('subscriptionUsage.read',{read:input=>service.read(input)});context.onDispose(()=>service.close());}};
}
