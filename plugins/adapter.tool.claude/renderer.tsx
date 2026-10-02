import {useEffect,useState} from 'react';
import {useSavedSelection} from '../../src/selections';
import type {ToolConfigView} from '../../src/host/tool-config';
import type {RendererContribution} from '../../src/host/renderer-registry';
import {claudeAdapterManifest} from './manifest';

export const claudeConfigView:ToolConfigView={
  tool:'claude',label:'Claude Code',runtimeLabel:'Claude Code CLI',defaultPath:'~/.claude/settings.json',endpointSuffix:'',tokenSuffix:'Claude',tone:'peach',
  useOptions(binding,state,locked){
    const valid=(n:number)=>Number.isInteger(n) && n>=4096 && n<=10000000;
    const [contextWindow,setContextWindow]=useSavedSelection<number>('claude.context',binding?.contextWindow ?? state?.contextWindow ?? 256000,valid);
    const [disableAttributionHeader,setDisableAttributionHeader]=useSavedSelection<boolean>('claude.disableAttributionHeader',binding?.disableAttributionHeader ?? true,v=>typeof v==='boolean');
    const [draft,setDraft]=useState(String(contextWindow));useEffect(()=>setDraft(String(contextWindow)),[contextWindow]);
    return {request:{contextWindow:Number(draft),disableAttributionHeader},fields:<>
      <div><label className="field-label" htmlFor="claude-context-window">上下文窗口 · Tokens</label><input id="claude-context-window" className="text-input" type="number" min={4096} max={10000000} step={1} required disabled={locked} value={draft} onChange={event=>setDraft(event.target.value)} onBlur={()=>{const value=Number(draft);if(valid(value))setContextWindow(value);}}/><p className="field-help">默认 256K（256000 Tokens），按模型实际支持的长度设置；应用时写入 CLAUDE_CODE_MAX_CONTEXT_TOKENS。</p></div>
      <div><label className="checkbox-label"><input type="checkbox" disabled={locked} checked={disableAttributionHeader} onChange={event=>setDisableAttributionHeader(event.target.checked)}/>禁用归属标头</label><p className="field-help">默认开启，应用时写入 CLAUDE_CODE_ATTRIBUTION_HEADER="false"；关闭后移除此配置。</p></div>
    </>};
  },
};
export const claudeAdapterRenderer:RendererContribution={manifest:claudeAdapterManifest,toolConfigs:[claudeConfigView],settings:{title:'Claude Code 配置适配器',description:'提供 Claude Code 的配置选项和文件规则。'}};
