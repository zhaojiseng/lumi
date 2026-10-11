import {lazy} from 'react';
import {RefreshCw} from 'lucide-react';
import {Select} from '../../src/components/Select';
import {useSavedSelection} from '../../src/selections';
import type {ToolConfigView,ToolRuntimeExtrasProps} from '../../src/host/tool-config';
import type {RendererContribution} from '../../src/host/renderer-registry';
import {RuntimeVersions} from '../feature.tool-config/renderer/RuntimeVersions';
import {codexAdapterManifest} from './manifest';
import {publishedServiceTiers} from '../../shared/pricing';

export const codexConfigView:ToolConfigView={
  tool:'codex',label:'Codex',runtimeLabel:'Codex CLI',defaultPath:'~/.codex/config.toml',endpointSuffix:'/v1',tokenSuffix:'Codex',tone:'blue',
  useOptions(binding,state,locked,model){
    const [contextWindow,setContextWindow]=useSavedSelection<number>('codex.context',(binding?.contextWindow ?? state?.contextWindow)===1000000 ? 1000000 : 272000,n=>[272000,1000000].includes(n));
    const tiers=model ? publishedServiceTiers(model) : [];
    const fallback=(binding?.model===model?.model_name ? binding?.serviceTier : undefined) ?? (state?.model===model?.model_name ? state?.serviceTier : undefined) ?? '';
    const supported=(value:string)=>value==='' || tiers.includes(value);
    const [serviceTier,setServiceTier]=useSavedSelection<string>('codex.serviceTier.'+(model?.model_name || ''),supported(fallback) ? fallback : '',supported);
    return {request:{contextWindow,...(serviceTier ? {serviceTier} : {})},fields:<>
      <div className="context-setting"><span>上下文窗口</span><Select disabled={locked} label="Codex 上下文窗口" tone="blue" value={contextWindow} onChange={v=>setContextWindow(Number(v))}><option value="272000">272K · 默认</option><option value="1000000">1M</option></Select></div>
      <div><div className="context-setting"><span>服务等级</span><Select disabled={locked || !model} label="Codex 服务等级" tone="blue" value={serviceTier} onChange={setServiceTier}><option value="">关闭</option>{tiers.map(value=><option key={value} value={value}>{value}</option>)}</Select></div><p className="field-help">{model ? tiers.length ? '选项来自所选模型的定价公式；关闭会删除 service_tier。' : '所选模型未公布服务等级，应用时删除 service_tier。' : '选择模型后显示其定价公式中的服务等级。'}</p></div>
    </>};
  },
  RuntimeExtras:({state,desktop,locked,onDetect}:ToolRuntimeExtrasProps)=><div className="tool-runtime desktop-runtime" title={state?.path}><div><span className={'connection-dot '+(state?.version ? '' : 'inactive')}/><span className="runtime-name">ChatGPT 桌面</span><RuntimeVersions state={state} desktop={desktop}/></div><button type="button" className="icon-button" title="重新检测 ChatGPT 桌面应用" aria-label="ChatGPT 重新检测" disabled={locked || !desktop} onClick={onDetect}><RefreshCw size={14}/></button></div>,
};
const Settings=lazy(async()=>{const {ToolPluginSettings}=await import('../../src/host/ToolPluginSettings');return {default:()=> <ToolPluginSettings definition={codexConfigView}/>};});
export const codexAdapterRenderer:RendererContribution={manifest:codexAdapterManifest,toolConfigs:[codexConfigView],settings:{title:'Codex 工具配置',description:codexAdapterManifest.settings!.description,sections:[{id:'options',title:'Codex 配置选项',component:Settings}]}};
