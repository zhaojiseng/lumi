import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {bridge} from '../bridge';
import {useApp} from '../context';
import {usePluginStatuses,useInterfaceStyle} from './plugins';
import {resolveInterfaceAppearance} from '../../shared/interface-appearance';
import type {ExtensionView,ExtensionContext,ExtensionMethod} from '../../shared/contracts/extensions';
const protocol='lumi-extension/1';
const methods=new Set<ExtensionMethod>(['context.read','storage.read','storage.write','secret.set','secret.has','network.read','workbench.read','usage.read','codex.usage.read','codex.bridge.status','codex.bridge.send','codex.bridge.respond','codex.bridge.subscribe','codex.bridge.unsubscribe','codex.bridge.chooseDirectory']);
/** Opaque sandbox origin: extension scripts cannot reach Lumi's DOM, preload or credentials. */
export function ExtensionFrame({pluginId,view,refreshEpoch=0}:{pluginId:string;view:ExtensionView;refreshEpoch?:number}){
  const status=usePluginStatuses().find(s=>s.manifest.id===pluginId),generation=status?.generation ?? 0;
  const style=useInterfaceStyle();
  const {preferences}=useApp(),frame=useRef<HTMLIFrameElement>(null),[height,setHeight]=useState(240),[error,setError]=useState('');
  const container=useRef<HTMLElement>(null),[fillViewport,setFillViewport]=useState(false);
  useLayoutEffect(()=>{
    if(!fillViewport || view.slot!=='sidebar')return;
    const element=container.current;if(!element)return;
    const scroll=element.closest<HTMLElement>('.content-scroll');
    const measure=()=>{
      const offset=scroll ? element.getBoundingClientRect().top-scroll.getBoundingClientRect().top+scroll.scrollTop : element.getBoundingClientRect().top;
      const available=(scroll?.clientHeight ?? window.innerHeight)-offset;
      setHeight(Math.max(120,Math.min(3000,Math.floor(available))));
    };
    measure();const observer=new ResizeObserver(measure);observer.observe(scroll || element.parentElement || element);
    window.addEventListener('resize',measure);return()=>{observer.disconnect();window.removeEventListener('resize',measure);};
  },[fillViewport,generation,view.slot]);
  const [systemDark,setSystemDark]=useState(()=>matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(()=>{const media=matchMedia('(prefers-color-scheme: dark)'),change=()=>setSystemDark(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
  const site=preferences.sites.find(s=>s.id===preferences.activeSiteId) || preferences.sites[0];
  const context:ExtensionContext={theme:preferences.theme==='system' ? systemDark ? 'dark' : 'light' : preferences.theme,locale:'zh-CN',site:{id:site.id,name:site.name,url:site.url},refreshEpoch};
  const appearance=resolveInterfaceAppearance(style?.appearanceGroups,style && preferences.interfaceSelections?.[style.id]);
  const uiTheme={id:style?.id || 'interface.default',css:style?.css || '',appearance,theme:context.theme,typography:{fontSize:preferences.fontSize,fontFamily:preferences.fontFamily}};
  const latestTheme=useRef(uiTheme);latestTheme.current=uiTheme;
  const latest=useRef(context);latest.current=context;
  const session=useRef({nonce:'',initialized:false});
  useEffect(()=>{
    let active=true,inflight=0,initialContext:ExtensionContext|undefined;const nonce=crypto.randomUUID(),seen=new Set<number>();session.current={nonce,initialized:false};setError('');setFillViewport(false);
    const send=(message:object)=>frame.current?.contentWindow?.postMessage({protocol,nonce,...message},'*');
    const timer=setTimeout(()=>{if(active && !session.current.initialized)setError('扩展界面未连接 SDK，请检查入口文件。');},10000);
    const receive=(event:MessageEvent)=>{
      if(!active || event.source!==frame.current?.contentWindow || event.data?.protocol!==protocol)return;
      const message=event.data;
      if(message.type==='ready'){initialContext ??= latest.current;send({type:'init',view:{id:view.id,slot:view.slot},context:initialContext,uiTheme:latestTheme.current,uiFeatures:{fillViewport:view.slot==='sidebar'}});return;}
      if(message.nonce!==nonce)return;
      if(message.type==='initialized'){session.current.initialized=true;clearTimeout(timer);setError('');if(JSON.stringify(initialContext)!==JSON.stringify(latest.current))send({type:'context',context:latest.current});send({type:'ui-theme',uiTheme:latestTheme.current});return;}
      if(message.type==='resize'){if(message.layout==='fill' && view.slot==='sidebar'){setFillViewport(true);return;}setFillViewport(false);if(Number.isFinite(message.height))setHeight(Math.max(120,Math.min(3000,message.height)));return;}
      if(message.type!=='request' || !Number.isSafeInteger(message.id) || message.id<=0 || seen.has(message.id))return;
      if(!methods.has(message.method) || inflight>=8 || seen.size>=10000){send({type:'response',id:message.id,ok:false,error:'扩展接口无效或请求过于频繁。'});return;}
      try{if(JSON.stringify(message.input ?? null).length>65536)throw new Error();}catch{send({type:'response',id:message.id,ok:false,error:'扩展请求过大。'});return;}
      seen.add(message.id);++inflight;
      void bridge.extensionRequest({id:pluginId,generation,view:view.id,method:message.method,input:message.input}).then(data=>{if(active)send({type:'response',id:message.id,ok:true,data});},e=>{if(active)send({type:'response',id:message.id,ok:false,error:e instanceof Error ? e.message : '扩展请求失败。'});}).finally(()=>--inflight);
    };
    window.addEventListener('message',receive);return()=>{active=false;clearTimeout(timer);window.removeEventListener('message',receive);void bridge.extensionRequest({id:pluginId,generation,view:view.id,method:'codex.bridge.unsubscribe',input:{}}).catch(()=>{});};
  },[pluginId,generation,view.id]);
  useEffect(()=>{const stop=bridge.onExtensionEvent(event=>{if(event.id!==pluginId || event.generation!==generation || event.view!==view.id || !session.current.initialized)return;const frameWindow=frame.current?.contentWindow;if(!frameWindow)return;frameWindow.postMessage({protocol,nonce:session.current.nonce,type:'event',topic:event.topic,payload:event.payload},'*');});return stop;},[pluginId,generation,view.id]);
  useEffect(()=>{const {nonce,initialized}=session.current;if(initialized)frame.current?.contentWindow?.postMessage({protocol,nonce,type:'context',context},'*');},[context.theme,site.id,site.url,refreshEpoch]);
  useEffect(()=>{const {nonce,initialized}=session.current;if(initialized)frame.current?.contentWindow?.postMessage({protocol,nonce,type:'ui-theme',uiTheme},'*');},[style?.id,style?.css,JSON.stringify(appearance),context.theme,preferences.fontSize,preferences.fontFamily]);
  if(status?.state!=='active')return null;
  return <section ref={container} className="extension-view" data-layout={fillViewport ? 'fill' : 'content'} data-extension={pluginId}><iframe key={generation} ref={frame} title={view.title} sandbox="allow-scripts" referrerPolicy="no-referrer" src={`lumi-extension://${pluginId}/${generation}/${view.entry}`} style={{width:'100%',height,border:0,display:'block'}}/>{error && <p role="alert" className="warning-banner">{error}</p>}</section>;
}
