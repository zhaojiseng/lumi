import type {TrustedBuiltinPlugin} from '../../shared/contracts/plugins';
import type {Preferences} from '../../shared/types';
import {localWidgetPricing,combineLocalWidget} from '../../electron/services/local-widget-pricing';
import {usageManifest} from './manifest';

/** Display aggregation runs headlessly, sharing pricing/range semantics with the system. */
export function usagePlugin(preferences:()=>Preferences):TrustedBuiltinPlugin {
  return {manifest:usageManifest,activate(context){
    context.provide('usage.present',{
      async loadWidget(now=Date.now()){
        const prefs=structuredClone(preferences()),period=prefs.widgetPeriod;
        const online=context.requireCapability('provider.newapi','desktopUsage.read');
        if(prefs.widgetDataSource!=='local')return online.widgetUsage(now,period);
        const pricing=await online.widgetPricing(),local=context.requireCapability('source.local-sessions','localSessions.read');
        return combineLocalWidget(await local.widgetUsage(now,{...localWidgetPricing(pricing,prefs.bindings),period}),pricing,period);
      },
    });
  }};
}
