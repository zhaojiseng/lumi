import {useApp} from '../context';
import {Button} from '../components/ui';
import type {ToolConfigView} from './tool-config';
import {selectionValue} from '../../shared/selections';

/** Adapters own their options; this host only places them in the plugin detail page. */
export function ToolPluginSettings({definition}:{definition:ToolConfigView}){
  const {preferences,bootstrap,dashboard,setPage}=useApp();
  const binding=preferences.bindings.find(value=>value.tool===definition.tool && value.siteId===preferences.activeSiteId);
  const state=bootstrap.configs.find(value=>value.tool===definition.tool);
  const modelName=selectionValue(preferences,definition.tool+'.model',binding?.model || state?.model || '');
  const model=dashboard?.catalog.models.find(value=>value.model_name===modelName);
  const options=definition.useOptions(binding,state,false,model);
  return <div className="plugin-tool-options">
    {options.fields}
    <p className="muted small-text">这些选项用于下一次配置预览。打开工具配置，选择模型和渠道后应用。</p>
    <Button onClick={()=>setPage('tools')}>打开工具配置</Button>
  </div>;
}
