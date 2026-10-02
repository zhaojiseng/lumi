import type {TrustedBuiltinPlugin} from '../../shared/contracts/plugins';
import {LocalUsageService} from '../../electron/services/local-usage';
import {localSessionsManifest} from './manifest';

export function localSessionsPlugin(home?:string):TrustedBuiltinPlugin {
  return {manifest:localSessionsManifest,activate(context){
    const usage=new LocalUsageService(home);
    context.provide('localSessions.read',{
      scan:(...args)=>usage.scan(...args),
      localSessionDetails:input=>usage.sessionDetails(input),loadLocalSession:(...args)=>usage.sessionStore.load(...args),
      localSessionRecords:input=>usage.sessionStore.records(input),localSessionContent:input=>usage.sessionStore.content(input),
      localSessionRaw:input=>usage.sessionStore.raw(input),releaseLocalSession:async input=>{usage.sessionStore.release(input);},widgetUsage:(...args)=>usage.widgetUsage(...args),
    });
    context.onDispose(()=>usage.close());
  }};
}
