import {useContext,useEffect,useLayoutEffect,useId,useRef,useState,type PointerEvent,type KeyboardEvent} from 'react';
import {ChevronDown,ChevronRight,GripVertical,Palette,Settings2} from 'lucide-react';
import {useApp} from '../context';
import {Modal} from '../components/ui';
import {usePluginSettings} from './plugins';
import {BackgroundSettings,interfaceCandidates} from './background';
import {InterfaceErrorContext} from './interface-settings';
import {BACKGROUND_INTERFACE_ID,preferredInterface} from '../../shared/interface-styles';

interface StyleRow {id:string;title:string;description:string;enabled:boolean;priority:number;version:string;error?:string;author?:string;license?:string;external:boolean;}
function StyleSwitch({row,locked,onToggle}:{row:StyleRow;locked:boolean;onToggle():void}){
  return <button type="button" role="switch" className={'switch'+(row.enabled ? ' on' : '')} aria-label={'启用'+row.title} aria-checked={row.enabled} aria-disabled={locked} onClick={()=>{if(!locked)onToggle();}}><span aria-hidden="true"/></button>;
}
function StyleDetails({row,open,locked,returnFocus,onClose,onToggle}:{row:StyleRow;open:boolean;locked:boolean;returnFocus:HTMLButtonElement|null;onClose():void;onToggle():void}){
  const [visited,setVisited]=useState(open);useEffect(()=>{if(open)setVisited(true);},[open]);
  if(!open && !visited)return null;
  return <Modal className="plugin-details-modal interface-style-modal" title={row.title+' 插件设置'} subtitle={(row.external ? '额外界面风格' : '内置界面风格')+' · v'+row.version} open={open} portal returnFocus={returnFocus} onClose={onClose}>
    <div className="plugin-details-page" data-interface-details={row.id}>
      <div className="plugin-details-heading"><span>启用状态</span><StyleSwitch row={row} locked={locked} onToggle={onToggle}/></div>
      <section className="plugin-details-section"><h3>插件介绍</h3><p>{row.description}</p><p className="muted">{row.id===BACKGROUND_INTERFACE_ID ? '背景独立叠加到当前风格，不参与风格替换。' : '拖动界面风格列表左侧手柄调整顺序，上方风格优先。'}停用保留设置。</p></section>
      {row.id===BACKGROUND_INTERFACE_ID ? <section className="plugin-details-section plugin-own-settings"><h3>背景设置</h3><BackgroundSettings/></section> : <p className="muted">生效风格的外观选项位于“外观”设置中。</p>}
      {row.external && <><section className="plugin-details-section"><h3>声明权限</h3><p className="muted">界面风格仅提供受校验的样式，未声明额外权限。</p></section><dl className="plugin-details-metadata"><div><dt>作者</dt><dd>{row.author || '未提供'}</dd></div><div><dt>许可证</dt><dd>{row.license || '未提供'}</dd></div></dl></>}
      {row.error && <p className="warning-banner error-banner" role="alert">{row.error}</p>}
    </div>
  </Modal>;
}
export function InterfaceStyleSettings(){
  const {preferences,updatePreferences,toast,page}=useApp(),{statuses=[],extensions,setEnabled,refreshInterface,busyId}=usePluginSettings(),failure=useContext(InterfaceErrorContext);
  const [expanded,setExpanded]=useState(true),[selection,setSelection]=useState<{id:string;scope:string}|null>(null),[preview,setPreview]=useState<string[]|null>(null),[saving,setSaving]=useState(false),[announcement,setAnnouncement]=useState('');
  const body=useId(),help=useId(),tree=useRef<HTMLUListElement>(null),returnFocus=useRef<HTMLButtonElement|null>(null),operation=useRef(false);
  const drag=useRef<{id:string;pointer:number;order:string[];scope:string;inventory:string;startY:number;moved:boolean}|null>(null);
  const positions=useRef(new Map<string,number>()),animations=useRef(new Map<string,Animation>());
  const site=preferences.sites.find(value=>value.id===preferences.activeSiteId),scope=JSON.stringify([page,preferences.activeSiteId,site?.url,site?.userId,site?.username,!!site?.accessTokenConfigured,!!site?.sessionAuth]);
  const interfaces=extensions?.plugins.filter(plugin=>plugin.manifest.kind==='interface') || [];
  const candidates=interfaceCandidates(preferences,statuses,interfaces),winner=failure ? 'interface.default' : preferredInterface(candidates,preferences.interfacePriorities);
  const rows:StyleRow[]=candidates.map(candidate=>{
    const extension=interfaces.find(plugin=>plugin.manifest.id===candidate.id)?.manifest,status=statuses.find(value=>value.manifest.id===candidate.id);
    return {...candidate,priority:preferences.interfacePriorities[candidate.id] ?? candidate.priority,title:extension?.name || (candidate.id===BACKGROUND_INTERFACE_ID ? '用户自定义背景' : '默认界面'),description:extension?.description || (candidate.id===BACKGROUND_INTERFACE_ID ? '本地图片背景，可与当前界面风格叠加' : '悬浮侧栏与系统默认布局'),version:extension?.version || status?.manifest.version || '1.0.0',external:!!extension,author:extension?.author,license:extension?.license,error:status?.error};
  }).sort((a,b)=>b.priority-a.priority || a.id.localeCompare(b.id));
  const order=rows.map(row=>row.id),inventory=JSON.stringify([...order].sort()),live=useRef({scope,inventory,order});live.current={scope,inventory,order};
  const shown=preview?.length===rows.length && preview.every(id=>order.includes(id)) ? preview.map(id=>rows.find(row=>row.id===id)!) : rows;
  const locked=!!busyId || saving || !!preview;
  const shownOrder=shown.map(row=>row.id).join('|');
  useLayoutEffect(()=>{
    const nodes=tree.current?.querySelectorAll<HTMLElement>(':scope > [data-interface-style]');if(!nodes)return;
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches,next=new Map<string,number>();
    for(const node of nodes){
      const id=node.dataset.interfaceStyle!,top=node.offsetTop,previous=positions.current.get(id),animation=animations.current.get(id);
      // Continue from the current visual position when another reorder interrupts an animation.
      const transform=getComputedStyle(node).transform,offset=transform==='none' ? 0 : new DOMMatrixReadOnly(transform).m42;
      animation?.cancel();animations.current.delete(id);next.set(id,top);
      const delta=previous===undefined ? 0 : previous+offset-top;
      if(!reduced && Math.abs(delta)>.5){
        const movement=node.animate([{transform:`translateY(${delta}px)`},{transform:'translateY(0)'}],{duration:220,easing:'cubic-bezier(.2,.8,.2,1)'});
        animations.current.set(id,movement);movement.onfinish=()=>{if(animations.current.get(id)===movement)animations.current.delete(id);};
      }
    }
    positions.current=next;
  },[shownOrder,scope,expanded]);
  useEffect(()=>{drag.current=null;setPreview(null);setSelection(null);},[scope,inventory]);
  useEffect(()=>()=>{drag.current=null;for(const animation of animations.current.values())animation.cancel();animations.current.clear();},[]);
  async function saveOrder(next:string[],expectedScope=scope,expectedInventory=inventory){
    if(operation.current || expectedScope!==live.current.scope || expectedInventory!==live.current.inventory)return;
    if(next.join('|')===live.current.order.join('|')){setPreview(null);return;}
    operation.current=true;setSaving(true);
    try{await updatePreferences({interfaceOrder:next});await refreshInterface?.();setAnnouncement('界面风格顺序已保存，上方风格优先。');}
    catch(error){toast((error as Error).message,'error');setAnnouncement('排序保存失败，已恢复原顺序。');}
    finally{operation.current=false;setPreview(null);setSaving(false);}
  }
  async function toggle(row:StyleRow){
    if(locked || operation.current)return;operation.current=true;setSaving(true);
    try{if(row.id==='interface.default'){await updatePreferences({defaultInterfaceEnabled:!row.enabled});await refreshInterface?.();}else await setEnabled(row.id,!row.enabled);}
    catch(error){toast((error as Error).message,'error');}finally{operation.current=false;setSaving(false);}
  }
  function start(id:string,event:PointerEvent<HTMLButtonElement>){
    if(locked || operation.current || event.button!==0 || !event.isPrimary)return;
    event.preventDefault();tree.current?.focus({preventScroll:true});tree.current?.setPointerCapture(event.pointerId);
    drag.current={id,pointer:event.pointerId,order:[...order],scope,inventory,startY:event.clientY,moved:false};
  }
  function move(event:PointerEvent<HTMLUListElement>){
    const current=drag.current;if(!current || current.pointer!==event.pointerId)return;
    if(current.scope!==live.current.scope || current.inventory!==live.current.inventory){cancel();return;}
    if(!current.moved && Math.abs(event.clientY-current.startY)<5)return;
    current.moved=true;
    const others=current.order.filter(id=>id!==current.id),nodes=[...event.currentTarget.querySelectorAll<HTMLElement>(':scope > [data-interface-style]')];
    // Hit testing uses layout positions, so animated rows cannot bounce the insertion target.
    let index=others.findIndex(id=>{const node=nodes.find(node=>node.dataset.interfaceStyle===id)!,rect=node.getBoundingClientRect(),transform=getComputedStyle(node).transform,offset=transform==='none' ? 0 : new DOMMatrixReadOnly(transform).m42;return event.clientY<rect.top-offset+rect.height/2;});if(index<0)index=others.length;
    const next=[...others];next.splice(index,0,current.id);if(next.join('|')!==current.order.join('|') || !preview){current.order=next;setPreview(next);}
    const scroll=tree.current?.closest('.content-scroll');if(scroll){const rect=scroll.getBoundingClientRect();if(event.clientY<rect.top+48)scroll.scrollBy(0,-24);else if(event.clientY>rect.bottom-48)scroll.scrollBy(0,24);}
  }
  function finish(event:PointerEvent<HTMLUListElement>){
    const current=drag.current;if(!current || current.pointer!==event.pointerId)return;
    drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    if(current.moved)void saveOrder(current.order,current.scope,current.inventory).finally(()=>restoreFocus(current.id,current.scope));else {setPreview(null);restoreFocus(current.id,current.scope);}
  }
  function restoreFocus(id:string,expectedScope:string){const node=tree.current;if(!node || expectedScope!==live.current.scope)return;if(node.ownerDocument.activeElement===node || node.ownerDocument.activeElement===node.ownerDocument.body)[...node.querySelectorAll<HTMLElement>('[data-interface-style]')].find(row=>row.dataset.interfaceStyle===id)?.querySelector<HTMLButtonElement>('.interface-sort-handle')?.focus({preventScroll:true});}
  function cancel(){const current=drag.current;drag.current=null;setPreview(null);if(current)restoreFocus(current.id,current.scope);}
  function keyboard(id:string,event:KeyboardEvent<HTMLButtonElement>){
    if(locked || operation.current || !['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    event.preventDefault();const next=[...order],index=next.indexOf(id),target=event.key==='Home' ? 0 : event.key==='End' ? next.length-1 : Math.max(0,Math.min(next.length-1,index+(event.key==='ArrowUp' ? -1 : 1)));
    next.splice(index,1);next.splice(target,0,id);tree.current?.focus({preventScroll:true});void saveOrder(next).finally(()=>restoreFocus(id,scope));
  }
  function open(id:string,trigger:HTMLButtonElement){returnFocus.current=trigger;setSelection({id,scope});}
  return <div className="plugin-settings-branch interface-style-settings" data-plugin-group="interface" onKeyDown={event=>{if(event.key==='Escape' && drag.current){event.preventDefault();cancel();}}}>
    <h3 className="plugin-branch-heading"><button type="button" className="plugin-branch-toggle" aria-expanded={expanded} aria-controls={body} onClick={()=>{cancel();setExpanded(value=>!value);}}><ChevronDown size={17}/><Palette size={17}/><strong>界面风格</strong><span>{rows.filter(row=>row.enabled).length} / {rows.length} 已启用</span></button></h3>
    <div id={body} hidden={!expanded}><p className="muted" id={help}>拖动左侧手柄调整顺序，上方风格优先；也可用方向键、Home 和 End 排序。自定义背景独立叠加，不替换当前风格。全部停用时使用默认布局。</p>
      <ul ref={tree} tabIndex={-1} aria-label="界面风格排序" className="plugin-settings-tree interface-sort-tree" aria-busy={saving} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={()=>{if(drag.current)cancel();}}>{shown.map((row,index)=><li key={row.id} className={'plugin-settings-group interface-style-node'+(drag.current?.id===row.id && preview ? ' sorting' : '')} data-interface-style={row.id}>
        <div className="plugin-group-heading">
          <button type="button" className="icon-button interface-sort-handle" aria-label={'拖动排序'+row.title} aria-describedby={help} aria-disabled={locked} onPointerDown={event=>start(row.id,event)} onKeyDown={event=>keyboard(row.id,event)}><GripVertical size={17}/></button>
          <span className="interface-sort-position" aria-label={'优先级第 '+(index+1)+' 位'}>{index+1}</span>
          <button className="plugin-row-button" type="button" aria-label={row.title+' 插件说明'} onClick={event=>open(row.id,event.currentTarget)}><span><strong>{row.title}</strong><span className="plugin-node-description">{row.description}</span></span><ChevronRight size={15}/></button>
          <div className="plugin-switch-control"><span className="plugin-switch-status">{row.id===BACKGROUND_INTERFACE_ID ? row.enabled ? preferences.background.image ? '叠加生效' : '待选图片' : '已停用' : winner===row.id ? '当前生效' : row.enabled ? '已启用' : '已停用'}</span><StyleSwitch row={row} locked={locked} onToggle={()=>void toggle(row)}/></div>
          <button type="button" className="icon-button plugin-settings-button" aria-label={row.title+' 插件设置'} title="插件说明与设置" onClick={event=>open(row.id,event.currentTarget)}><Settings2 size={17}/></button>
        </div>
        {row.error && <p className="warning-banner error-banner" role="alert">{row.error}</p>}
      </li>)}</ul>
    </div>
    <span className="interface-sort-announcement" role="status" aria-live="polite">{announcement}</span>
    {rows.map(row=><StyleDetails key={scope+':'+row.id} row={row} open={selection?.scope===scope && selection.id===row.id} locked={locked} returnFocus={returnFocus.current} onClose={()=>setSelection(null)} onToggle={()=>void toggle(row)}/>)}
    {failure && <p className="warning-banner error-banner" role="alert">{failure}</p>}
  </div>;
}
