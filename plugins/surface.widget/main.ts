import type {TrustedBuiltinPlugin} from '../../shared/contracts/plugins';
import {widgetManifest} from './manifest';
import type {DesktopSurfaceEnvironment} from '../../shared/contracts/desktop-surface';
export function createWidgetPlugin(environment?:DesktopSurfaceEnvironment):TrustedBuiltinPlugin{return {manifest:widgetManifest,async activate(context){
  const projection={loadWidget:(now?:number)=>context.requireCapability('feature.usage','usage.present').loadWidget(now)};
  context.provide('widget.project',projection);
  if(!environment){context.provide('surface.control',{changed:async()=>{},refresh:async()=>{},smoke:async()=>({})});return;}
  const {WidgetRuntime}=await import('./runtime');const runtime=new WidgetRuntime(environment,projection);
  context.onDispose(()=>runtime.close());context.provide('surface.control',runtime);await runtime.start();
}};}
export const widgetPlugin=createWidgetPlugin();
