import {useContext,useEffect,useId,useState} from 'react';
import {ChevronDown,ChevronRight,Palette} from 'lucide-react';
import {useApp} from '../context';
import {usePluginSettings} from './plugins';
import {BackgroundSettings,interfaceCandidates} from './background';
import {InterfaceErrorContext} from './interface-settings';
import {BACKGROUND_INTERFACE_ID,preferredInterface} from '../../shared/interface-styles';

function StyleNode({id,title,description,enabled,priority,active,onToggle,onPriority,locked}:{id:string;title:string;description:string;enabled:boolean;priority:number;active:boolean;onToggle():Promise<void>;onPriority(value:number):Promise<void>;locked:boolean}){
  const [expanded,setExpanded]=useState(false),[draft,setDraft]=useState(String(priority)),[saving,setSaving]=useState(false),body=useId();
  const {toast}=useApp();
  useEffect(()=>setDraft(String(priority)),[priority]);
  async function save(){
    const value=Number(draft);
    if(!draft.trim() || !Number.isSafeInteger(value) || Math.abs(value)>1000){setDraft(String(priority));toast('优先级应为 -1000 到 1000 的整数。','error');return;}
    if(value===priority)return;
    setSaving(true);try{await onPriority(value);}catch(error){setDraft(String(priority));toast((error as Error).message,'error');}finally{setSaving(false);}
  }
  return <li className="plugin-settings-group interface-style-node" data-interface-style={id}>
    <div className="plugin-group-heading">
      <button className="plugin-row-button" type="button" aria-expanded={expanded} aria-controls={body} onClick={()=>setExpanded(value=>!value)}><span><strong>{title}</strong><span className="plugin-node-description">{description}</span></span>{expanded ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}</button>
      <label className="interface-priority">优先级<input type="number" min={-1000} max={1000} step={1} aria-label={title+' 优先级'} value={draft} disabled={locked || saving} onChange={event=>setDraft(event.target.value)} onBlur={()=>void save()} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();if(event.key==='Escape'){event.preventDefault();setDraft(String(priority));}}}/></label>
      <div className="plugin-switch-control"><span className="plugin-switch-status">{active ? '当前生效' : enabled ? '已启用' : '已停用'}</span><button type="button" role="switch" className={'switch'+(enabled ? ' on' : '')} aria-label={'启用'+title} aria-checked={enabled} disabled={locked || saving} onClick={()=>{setSaving(true);void onToggle().catch(error=>toast(error.message,'error')).finally(()=>setSaving(false));}}><span aria-hidden="true"/></button></div>
    </div>
    <div id={body} hidden={!expanded} className="interface-style-detail">{id===BACKGROUND_INTERFACE_ID ? <BackgroundSettings/> : <p className="muted">{description}。外观选项位于“外观”设置中；停用保留配置。</p>}</div>
  </li>;
}
export function InterfaceStyleSettings(){
  const {preferences,updatePreferences}=useApp(),{statuses=[],extensions,setEnabled,refreshInterface,busyId}=usePluginSettings(),failure=useContext(InterfaceErrorContext);
  const [expanded,setExpanded]=useState(true),body=useId();
  const interfaces=extensions?.plugins.filter(plugin=>plugin.manifest.kind==='interface') || [];
  const candidates=interfaceCandidates(preferences,statuses,interfaces),winner=failure ? 'interface.default' : preferredInterface(candidates,preferences.interfacePriorities);
  const rows=candidates.map(candidate=>({...candidate,priority:preferences.interfacePriorities[candidate.id] ?? candidate.priority,title:candidate.id==='interface.default' ? '默认界面' : candidate.id===BACKGROUND_INTERFACE_ID ? '用户自定义背景' : interfaces.find(plugin=>plugin.manifest.id===candidate.id)!.manifest.name,description:candidate.id==='interface.default' ? '悬浮侧栏与系统默认布局' : candidate.id===BACKGROUND_INTERFACE_ID ? '本地图片背景与默认布局' : interfaces.find(plugin=>plugin.manifest.id===candidate.id)!.manifest.description})).sort((a,b)=>b.priority-a.priority || a.id.localeCompare(b.id));
  async function priority(id:string,value:number){await updatePreferences({interfacePriority:{id,priority:value}});await refreshInterface?.();}
  async function toggle(id:string,enabled:boolean){if(id==='interface.default'){await updatePreferences({defaultInterfaceEnabled:enabled});await refreshInterface?.();}else await setEnabled(id,enabled);}
  return <div className="plugin-settings-branch interface-style-settings" data-plugin-group="interface">
    <h3 className="plugin-branch-heading"><button type="button" className="plugin-branch-toggle" aria-expanded={expanded} aria-controls={body} onClick={()=>setExpanded(value=>!value)}><ChevronDown size={17}/><Palette size={17}/><strong>界面风格</strong><span>{rows.filter(row=>row.enabled).length} / {rows.length} 已启用</span></button></h3>
    <div id={body} hidden={!expanded}><p className="muted">已启用风格中优先级最高者生效；相同优先级按插件 ID 排序。全部停用时使用默认布局。</p><ul className="plugin-settings-tree">{rows.map(row=><StyleNode key={row.id} {...row} active={winner===row.id} locked={!!busyId} onToggle={()=>toggle(row.id,!row.enabled)} onPriority={value=>priority(row.id,value)}/>)}</ul></div>
    {failure && <p className="warning-banner error-banner" role="alert">{failure}</p>}
  </div>;
}
