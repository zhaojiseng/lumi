import {lazy} from 'react';
import {TerminalSquare} from 'lucide-react';
import {toolConfigManifest} from './manifest';
import type {RendererContribution} from '../../src/host/renderer-registry';
export const toolConfigRenderer:RendererContribution={manifest:toolConfigManifest,page:{id:'tools',component:lazy(()=>import('./renderer/Page'))},navigation:{id:'tools',label:'工具配置',hint:'Codex / Claude Code',icon:TerminalSquare,section:'tools'},settings:{title:'工具配置',description:'预览、应用与恢复 CLI 配置。停用会清除待应用预览，保留已应用配置和备份。'}};
