import {createContext,useContext} from 'react';
import {usePluginSettings} from './plugins';
import {DEFAULT_INTERFACE_ID} from '../../shared/contracts/interface';
export const InterfaceErrorContext=createContext('');
export function InterfaceSettings(){
  const {extensions,busyId,setEnabled,error}=usePluginSettings(),failure=useContext(InterfaceErrorContext),selected=extensions?.interfaceStyle?.id || DEFAULT_INTERFACE_ID;
  const choices=[{id:DEFAULT_INTERFACE_ID,name:'默认界面',description:'悬浮侧栏与系统默认布局'},...(extensions?.plugins || []).filter(p=>p.manifest.kind==='interface').map(p=>({id:p.manifest.id,name:p.manifest.name,description:p.manifest.description}))];
  return <section className="surface panel interface-settings"><div className="section-heading"><div><h2>界面插件</h2><p>选择布局和皮肤，保留当前页面与编辑内容。</p></div></div><div role="radiogroup" aria-label="界面插件" style={{display:'flex',flexWrap:'wrap',gap:8}}>{choices.map(choice=><button type="button" role="radio" aria-checked={choice.id===selected} key={choice.id} disabled={!!busyId} title={choice.description} className={'button'+(choice.id===selected ? ' primary' : '')} onClick={()=>{if(choice.id===selected)return;void setEnabled(choice.id===DEFAULT_INTERFACE_ID ? selected : choice.id,choice.id!==DEFAULT_INTERFACE_ID).catch(()=>{});}}>{choice.name}</button>)}</div>{(failure || error) && <p className="field-help" role="alert">{failure || error}</p>}</section>;
}
