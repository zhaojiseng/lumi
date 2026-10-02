import {lazy} from 'react';
import type {RendererContribution} from '../../src/host/renderer-registry';
import {localSessionsManifest} from './manifest';
export const localSessionsRenderer:RendererContribution={manifest:localSessionsManifest,settings:{title:'本机会话',description:'只读本机 Codex / Claude 会话；独立管理时间筛选和详情快照。'},usage:[{id:'local',label:'本机会话',order:30,scope:'independent',component:lazy(()=>import('./renderer/Usage'))}]};
