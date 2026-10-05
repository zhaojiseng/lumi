import {lazy} from 'react';
import {widgetManifest} from './manifest';
import type {RendererContribution} from '../../src/host/renderer-registry';
const Settings=lazy(()=>import('./renderer/Settings'));
export const widgetRenderer:RendererContribution={manifest:widgetManifest,settings:{title:'浮窗',description:'独立浮窗。',sections:[{id:'display',title:'浮窗设置',component:Settings}]},settingsTabs:[{id:'plugin:surface.widget:settings',label:'浮窗',order:100,component:Settings}]};
