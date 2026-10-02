import {lazy} from 'react';
import {Boxes} from 'lucide-react';
import {modelsManifest} from './manifest';
import type {RendererContribution} from '../../src/host/renderer-registry';

export const modelsRenderer:RendererContribution={
  manifest:modelsManifest,
  page:{id:'models',component:lazy(()=>import('./renderer/Page'))},
  navigation:{id:'models',label:'模型广场',icon:Boxes,hint:'发现更多可能',section:'workspace'},
  settings:{title:'模型广场',description:'浏览站点发布的模型目录、渠道定价与健康度。停用后不再读取独立模型目录。'},
};
