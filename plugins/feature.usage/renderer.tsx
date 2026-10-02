import {lazy} from 'react';
import {BarChart3} from 'lucide-react';
import {usageManifest} from './manifest';
import type {RendererContribution} from '../../src/host/renderer-registry';
export const usageRenderer:RendererContribution={manifest:usageManifest,page:{id:'usage',component:lazy(()=>import('./renderer/Page'))},navigation:{id:'usage',label:'用量分析',hint:'消费趋势与明细',icon:BarChart3,section:'workspace'},settings:{title:'用量分析',description:'显示站点消费、请求明细和本机会话。停用页面不影响浮窗的本地用量来源。'}};
