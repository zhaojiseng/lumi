import type {TrustedBuiltinPlugin} from '../../shared/contracts/plugins';
import type {Preferences} from '../../shared/types';
import {barPeriods,loadBarPeriods,loadBarPeriodDetails} from '../../shared/menu-bar-periods';
import {menuBarSelection} from '../../shared/menu-bar';
import {workbenchManifest} from './manifest';

/** The system selects display periods; the provider supplies account data. */
export function workbenchPlugin(preferences:()=>Preferences):TrustedBuiltinPlugin {
  return {manifest:workbenchManifest,activate(context){
    const current=()=>{const prefs=structuredClone(preferences());return {prefs,periods:barPeriods(prefs,menuBarSelection(prefs.viewSelections[prefs.activeSiteId]))};};
    context.provide('workbench.present',{
      loadMenu(force=false){const {prefs,periods}=current();return loadBarPeriods(context.requireCapability('provider.newapi','desktopUsage.read'),force,periods.totals,periods.chart,prefs.menuBarContents.includes('chart'));},
      loadMenuDetails(){const {prefs,periods}=current();return loadBarPeriodDetails(context.requireCapability('provider.newapi','desktopUsage.read'),periods.totals,periods.chart,prefs.menuBarContents.includes('chart'));},
    });
  }};
}
