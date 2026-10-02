import {lazy} from 'react';
import {LayoutDashboard} from 'lucide-react';
import {workbenchManifest} from './manifest';
import type {RendererContribution} from '../../src/host/renderer-registry';
export const workbenchRenderer:RendererContribution={manifest:workbenchManifest,page:{id:'overview',component:lazy(()=>import('./renderer/Page'))},navigation:{id:'overview',label:'工作台',hint:'你的 AI 总览',icon:LayoutDashboard,section:'workspace'},settings:{title:'工作台',description:'显示账户摘要、消费趋势、最近活动与开发工具卡片。'}};
