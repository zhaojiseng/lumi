import {lazy} from 'react';
import {trayManifest} from './manifest';
import type {RendererContribution} from '../../src/host/renderer-registry';
export const trayRenderer:RendererContribution={manifest:trayManifest,settings:{title:'托盘',description:'系统托盘与菜单栏。'},settingsTabs:[{id:'plugin:surface.tray:settings',label:'托盘',order:90,component:lazy(()=>import('./renderer/Settings'))}]};
