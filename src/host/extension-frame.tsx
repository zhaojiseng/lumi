import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {bridge} from '../bridge';
import {useApp} from '../context';
import {usePluginStatuses,useInterfaceStyle} from './plugins';
import {resolveInterfaceAppearance} from '../../shared/interface-appearance';
import {EXTENSION_METHODS,type ExtensionView,type ExtensionContext,type ExtensionMethod} from '../../shared/contracts/extensions';
import {GATEWAY_MAX_IPC_BYTES,isGatewayMethod} from '../../shared/contracts/gateway';
const protocol='lumi-extension/1';
const methods=new Set<ExtensionMethod>(EXTENSION_METHODS);
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
  const gatewayResources=useRef({sessions:new Set<string>(),subscriptions:new Set<string>()});
  useEffect(()=>{
    let active=true,inflight=0,initialContext:ExtensionContext|undefined;const nonce=crypto.randomUUID(),seen=new Set<number>();session.current={nonce,initialized:false};setError('');setFillViewport(false);
    const resources={sessions:new Set<string>(),subscriptions:new Set<string>()};gatewayResources.current=resources;
    const releaseGateway=()=>{
      for(const subscriptionId of resources.subscriptions){void bridge.extensionRequest({id:pluginId,generation,view:view.id,method:'gateway.events.unsubscribe',input:{subscriptionId}}).catch(()=>{});}
      for(const sessionId of resources.sessions){void bridge.extensionRequest({id:pluginId,generation,view:view.id,method:'gateway.disconnect',input:{sessionId}}).catch(()=>{});}
      resources.subscriptions.clear();resources.sessions.clear();
    };
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
      try{
        const encoded=JSON.stringify(message.input ?? null);
        if(isGatewayMethod(message.method) ? new TextEncoder().encode(encoded).byteLength>GATEWAY_MAX_IPC_BYTES : encoded.length>65536)throw new Error();
      }catch{send({type:'response',id:message.id,ok:false,error:'扩展请求过大。'});return;}
      seen.add(message.id);++inflight;
      void bridge.extensionRequest({id:pluginId,generation,view:view.id,method:message.method,input:message.input}).then(data=>{
        const value=data as {sessionId?:unknown;subscriptionId?:unknown}|null;
        if(message.method==='gateway.connect' && typeof value?.sessionId==='string')resources.sessions.add(value.sessionId);
        if(message.method==='gateway.events.subscribe' && typeof value?.subscriptionId==='string')resources.subscriptions.add(value.subscriptionId);
        if(message.method==='gateway.disconnect')resources.sessions.delete(message.input?.sessionId);
        if(message.method==='gateway.events.unsubscribe')resources.subscriptions.delete(message.input?.subscriptionId);
        if(active)send({type:'response',id:message.id,ok:true,data});else releaseGateway();
      },e=>{if(active)send({type:'response',id:message.id,ok:false,error:e instanceof Error ? e.message : '扩展请求失败。'});}).finally(()=>--inflight);
    };
    window.addEventListener('message',receive);return()=>{active=false;clearTimeout(timer);window.removeEventListener('message',receive);releaseGateway();void bridge.extensionRequest({id:pluginId,generation,view:view.id,method:'codex.bridge.unsubscribe',input:{}}).catch(()=>{});};
  },[pluginId,generation,view.id]);
  useEffect(()=>{const stop=bridge.onExtensionEvent(event=>{if(event.id!==pluginId || event.generation!==generation || event.view!==view.id || !session.current.initialized)return;if(event.topic==='gateway'){const payload=event.payload as {subscriptionId?:unknown}|null;if(!payload || typeof payload.subscriptionId!=='string' || !gatewayResources.current.subscriptions.has(payload.subscriptionId))return;}const frameWindow=frame.current?.contentWindow;if(!frameWindow)return;frameWindow.postMessage({protocol,nonce:session.current.nonce,type:'event',topic:event.topic,payload:event.payload},'*');});return stop;},[pluginId,generation,view.id]);
  useEffect(()=>{const {nonce,initialized}=session.current;if(initialized)frame.current?.contentWindow?.postMessage({protocol,nonce,type:'context',context},'*');},[context.theme,site.id,site.url,refreshEpoch]);
  useEffect(()=>{const {nonce,initialized}=session.current;if(initialized)frame.current?.contentWindow?.postMessage({protocol,nonce,type:'ui-theme',uiTheme},'*');},[style?.id,style?.css,JSON.stringify(appearance),context.theme,preferences.fontSize,preferences.fontFamily]);
  if(status?.state!=='active')return null;
  return <section ref={container} className="extension-view" data-layout={fillViewport ? 'fill' : 'content'} data-extension={pluginId}><iframe key={generation} ref={frame} title={view.title} sandbox="allow-scripts" referrerPolicy="no-referrer" src={`lumi-extension://${pluginId}/${generation}/${view.entry}`} style={{width:'100%',height,border:0,display:'block'}}/>{error && <p role="alert" className="warning-banner">{error}</p>}</section>;
}
