import type {TrustedBuiltinPlugin} from '../../shared/contracts/plugins';
import {trayManifest} from './manifest';
import type {DesktopSurfaceEnvironment} from '../../shared/contracts/desktop-surface';
export function createTrayPlugin(environment?:DesktopSurfaceEnvironment):TrustedBuiltinPlugin{return {manifest:trayManifest,async activate(context){
  const projection={loadMenu:(force?:boolean)=>context.requireCapability('feature.workbench','workbench.present').loadMenu(force),loadMenuDetails:()=>context.requireCapability('feature.workbench','workbench.present').loadMenuDetails()};
  context.provide('tray.project',projection);
  if(!environment){context.provide('surface.control',{changed:async()=>{},refresh:async()=>{},smoke:async()=>({})});return;}
  const {TrayRuntime}=await import('./runtime');const runtime=new TrayRuntime(environment,projection);
  context.onDispose(()=>runtime.close());context.provide('surface.control',runtime);await runtime.start();
}};}
export const trayPlugin=createTrayPlugin();
