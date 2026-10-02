import {lazy} from 'react';
import type {RendererContribution} from '../../src/host/renderer-registry';
import {codexProviderManifest} from './manifest';
export const codexProviderRenderer:RendererContribution={manifest:codexProviderManifest,connections:[{id:'plugin:provider.codex:connection',label:'Codex',order:20,component:lazy(()=>import('./renderer/Connection'))}],settings:{title:'Codex 用量接入',description:'通过本机 Codex CLI 读取 ChatGPT 账户的周限额、重置时间和剩余积分。'},workbench:[{id:'codex.subscription',title:'Codex 订阅用量',order:10,scope:'independent',component:lazy(()=>import('./renderer/UsageCard'))}]};
