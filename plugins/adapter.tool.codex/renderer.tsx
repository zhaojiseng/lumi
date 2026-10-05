import {lazy} from 'react';
import {RefreshCw} from 'lucide-react';
import {Select} from '../../src/components/Select';
import {useSavedSelection} from '../../src/selections';
import type {ToolConfigView,ToolRuntimeExtrasProps} from '../../src/host/tool-config';
import type {RendererContribution} from '../../src/host/renderer-registry';
import {RuntimeVersions} from '../feature.tool-config/renderer/RuntimeVersions';
import {codexAdapterManifest} from './manifest';

export const codexConfigView:ToolConfigView={
  tool:'codex',label:'Codex',runtimeLabel:'Codex CLI',defaultPath:'~/.codex/config.toml',endpointSuffix:'/v1',tokenSuffix:'Codex',tone:'blue',
  useOptions(binding,state,locked){
    const [contextWindow,setContextWindow]=useSavedSelection<number>('codex.context',(binding?.contextWindow ?? state?.contextWindow)===1000000 ? 1000000 : 272000,n=>[272000,1000000].includes(n));
    return {request:{contextWindow},fields:<div className="context-setting"><span>上下文窗口</span><Select disabled={locked} label="Codex 上下文窗口" tone="blue" value={contextWindow} onChange={v=>setContextWindow(Number(v))}><option value="272000">272K · 默认</option><option value="1000000">1M</option></Select></div>};
  },
  RuntimeExtras:({state,desktop,locked,onDetect}:ToolRuntimeExtrasProps)=><div className="tool-runtime desktop-runtime" title={state?.path}><div><span className={'connection-dot '+(state?.version ? '' : 'inactive')}/><span className="runtime-name">ChatGPT 桌面</span><RuntimeVersions state={state} desktop={desktop}/></div><button type="button" className="icon-button" title="重新检测 ChatGPT 桌面应用" aria-label="ChatGPT 重新检测" disabled={locked || !desktop} onClick={onDetect}><RefreshCw size={14}/></button></div>,
};
const Settings=lazy(async()=>{const {ToolPluginSettings}=await import('../../src/host/ToolPluginSettings');return {default:()=> <ToolPluginSettings definition={codexConfigView}/>};});
export const codexAdapterRenderer:RendererContribution={manifest:codexAdapterManifest,toolConfigs:[codexConfigView],settings:{title:'Codex 工具配置',description:codexAdapterManifest.settings!.description,sections:[{id:'options',title:'Codex 配置选项',component:Settings}]}};
