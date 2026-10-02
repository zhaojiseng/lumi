import {lazy} from 'react';
import {widgetManifest} from './manifest';
import type {RendererContribution} from '../../src/host/renderer-registry';
export const widgetRenderer:RendererContribution={manifest:widgetManifest,settings:{title:'浮窗',description:'独立浮窗。'},settingsTabs:[{id:'plugin:surface.widget:settings',label:'浮窗',order:100,component:lazy(()=>import('./renderer/Settings'))}]};
