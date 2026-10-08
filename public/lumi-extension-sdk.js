/* Lumi external-extension SDK v1. MIT. Served by the host inside isolated extension views. */
(() => {
  const protocol = 'lumi-extension/1', pending = new Map();
  let nonce = '', next = 0, context, view, canFillViewport=false,handshakeTimer,handshakeAttempts=0;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const listeners = new Set();
  let disposeGlass,latestUiTheme,bodyResize,layoutObserver,activePage=true;
  function applyUiTheme(value) {
    if (!value) return;latestUiTheme=value;
    if (!activePage || !document.querySelector?.('link[data-lumi-ui]') || !document.body) return;
    const root=document.body;root.dataset.lumiUi='';root.dataset.lumiView=view?.slot || '';root.dataset.interface=value.id || 'interface.default';root.dataset.theme=value.theme;
    document.documentElement.dataset.theme=value.theme;
    for(const attribute of [...root.attributes])if(attribute.name.startsWith('data-appearance-'))root.removeAttribute(attribute.name);
    for(const [id,option] of Object.entries(value.appearance || {}))root.setAttribute('data-appearance-'+id,option);
    let sheet=document.getElementById('lumi-ui-theme');if(!sheet){sheet=document.createElement('style');sheet.id='lumi-ui-theme';document.head.append(sheet);}
    const css=(value.css ? '@scope (body[data-lumi-ui]) {\n'+value.css+'\n}\n' : '')+'body[data-lumi-ui]{background:transparent}\nbody[data-lumi-view="settingsTab"]{isolation:isolate}body[data-lumi-view="settingsTab"] .surface.panel::before{backdrop-filter:none!important}';
    if(sheet.textContent!==css){disposeGlass?.();disposeGlass=undefined;sheet.textContent=css;}
    if (!value.css) {disposeGlass?.();disposeGlass=undefined;}
    else if (!disposeGlass && typeof LumiGlassRuntime !== 'undefined') disposeGlass=LumiGlassRuntime.installGlassRefraction(root);
    if(typeof LumiGlassRuntime !== 'undefined')LumiGlassRuntime.applyDocumentTypography(document,value.typography);
  }
  const eventListeners = new Map();
  window.addEventListener('pagehide',()=>{activePage=false;clearTimeout(handshakeTimer);disposeGlass?.();disposeGlass=undefined;if(typeof LumiGlassRuntime !== 'undefined')LumiGlassRuntime.disposeDocumentTypography(document);bodyResize?.disconnect();bodyResize=undefined;layoutObserver?.disconnect();layoutObserver=undefined;});
  window.addEventListener('pageshow',()=>{activePage=true;setupDocument();if(!nonce){handshakeAttempts=0;announceReady();}});
  function onEvent(topic, listener) { let set = eventListeners.get(topic); if (!set) { set = new Set(); eventListeners.set(topic, set); if (topic === 'codex.bridge') call('codex.bridge.subscribe', {}).catch(error => emitEvent(topic, {method:'lumi/bridge/exited',params:{detail:error.message}})); } set.add(listener); let active=true; return () => { if (!active) return; active=false; set.delete(listener); if (!set.size && eventListeners.get(topic) === set) { eventListeners.delete(topic); if (topic === 'codex.bridge') call('codex.bridge.unsubscribe', {}).catch(()=>{}); } }; }
  function emitEvent(topic, payload) { const set = eventListeners.get(topic); if (set) for (const listener of [...set]) listener(payload); }
  function send(message) { parent.postMessage({protocol, nonce, ...message}, '*'); }
  // A fast iframe can load before React installs its host listener. Retry only
  // during the initial handshake, with bounded backoff and no connected polling.
  function announceReady(){
    clearTimeout(handshakeTimer);if(nonce || !activePage || handshakeAttempts>=15)return;
    send({type:'ready'});handshakeTimer=setTimeout(announceReady,Math.min(1000,50*2**Math.min(5,handshakeAttempts++)));
  }
  function call(method, input) {
    return ready.then(() => new Promise((resolve, reject) => {
      if (pending.size >= 8) { reject(new Error('Too many extension requests')); return; }
      const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error('Extension request timed out')); }, 120000);
      pending.set(id, {resolve, reject, timer}); send({type:'request', id, method, input});
    }));
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.protocol !== protocol) return;
    const message = event.data;
    if (message.type === 'init' && !nonce) { nonce=message.nonce;clearTimeout(handshakeTimer);context=message.context; view=message.view;canFillViewport=message.uiFeatures?.fillViewport===true && view?.slot==='sidebar'; applyUiTheme(message.uiTheme);resolveReady({context,view}); send({type:'initialized'}); return; }
    if (!nonce || message.nonce !== nonce) return;
    if (message.type === 'context') { context=message.context; listeners.forEach(listener => listener(context)); }
    if (message.type === 'ui-theme') { applyUiTheme(message.uiTheme); }
    if (message.type === 'event') { emitEvent(message.topic, message.payload); }
    if (message.type === 'response') { const request=pending.get(message.id); if (!request) return; clearTimeout(request.timer); pending.delete(message.id); message.ok ? request.resolve(message.data) : request.reject(new Error(message.error || 'Extension request failed')); }
  });
  const sdk = Object.freeze({
    apiVersion:1, ready, get context(){return context;}, get view(){return view;},
    onContext(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    onEvent,
    workbench:Object.freeze({read:(input={})=>call('workbench.read',input)}),
    usage:Object.freeze({read:(input={})=>call('usage.read',input)}),
    codex:Object.freeze({
      readUsage:(input={})=>call('codex.usage.read',input),
      bridge:Object.freeze({
        status:()=>call('codex.bridge.status',{}),
        send:input=>call('codex.bridge.send',input),
        respond:input=>call('codex.bridge.respond',input),
        chooseDirectory:()=>call('codex.bridge.chooseDirectory',{}),
        subscribe:listener=>onEvent('codex.bridge',listener),
      }),
    }),
    storage:Object.freeze({read:key=>call('storage.read',{key}),write:(key,value)=>call('storage.write',{key,value})}),
    secrets:Object.freeze({has:key=>call('secret.has',{key}),set:(key,value)=>call('secret.set',{key,value})}),
    network:Object.freeze({read:input=>call('network.read',input)}),
  });
  Object.defineProperty(window,'lumiExtension',{value:sdk,writable:false,configurable:false});
  const resize=()=>{
    if(!nonce || !activePage)return;
    const root=document.body;
    if(canFillViewport && root?.dataset.lumiLayout==='fill'){
      root.style.setProperty('--lumi-viewport-height',window.innerHeight+'px');
      send({type:'resize',layout:'fill'});
    }else{
      root?.style.removeProperty('--lumi-viewport-height');
      send({type:'resize',height:Math.ceil(root?.getBoundingClientRect().height || 120)+20});
    }
  };
  window.addEventListener('resize',resize);
  function setupDocument(){
    if(!activePage || !document.body)return;
    applyUiTheme(latestUiTheme);
    if(!bodyResize){bodyResize=new ResizeObserver(resize);bodyResize.observe(document.body);}
    if(!layoutObserver){layoutObserver=new MutationObserver(resize);layoutObserver.observe(document.body,{attributes:true,attributeFilter:['data-lumi-layout']});}
    ready.then(resize);
  }
  window.addEventListener('DOMContentLoaded',setupDocument);
  if(typeof document!=='undefined' && document.readyState!=='loading')setupDocument();
  announceReady();
})();
