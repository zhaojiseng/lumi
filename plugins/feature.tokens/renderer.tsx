import {lazy} from 'react';
import {KeyRound} from 'lucide-react';
import {tokensManifest} from './manifest';
import type {RendererContribution} from '../../src/host/renderer-registry';
export const tokensRenderer:RendererContribution={manifest:tokensManifest,page:{id:'tokens',component:lazy(()=>import('./renderer/Page'))},navigation:{id:'tokens',label:'API 令牌',hint:'管理各来源的访问令牌与额度',icon:KeyRound,section:'tools'},settings:{title:'令牌管理',description:'统一管理界面，由接入插件提供令牌列表、控制与密钥操作。'}};
