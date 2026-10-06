/* Lumi external-extension SDK v1. MIT. Served by the host inside isolated extension views. */
(() => {
  const protocol = 'lumi-extension/1', pending = new Map();
  let nonce = '', next = 0, context, view;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const listeners = new Set();
  const eventListeners = new Map();
  function onEvent(topic, listener) { let set = eventListeners.get(topic); if (!set) { set = new Set(); eventListeners.set(topic, set); if (topic === 'codex.bridge') call('codex.bridge.subscribe', {}).catch(error => emitEvent(topic, {method:'lumi/bridge/exited',params:{detail:error.message}})); } set.add(listener); let active=true; return () => { if (!active) return; active=false; set.delete(listener); if (!set.size && eventListeners.get(topic) === set) { eventListeners.delete(topic); if (topic === 'codex.bridge') call('codex.bridge.unsubscribe', {}).catch(()=>{}); } }; }
  function emitEvent(topic, payload) { const set = eventListeners.get(topic); if (set) for (const listener of [...set]) listener(payload); }
  function send(message) { parent.postMessage({protocol, nonce, ...message}, '*'); }
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
    if (message.type === 'init' && !nonce) { nonce=message.nonce; context=message.context; view=message.view; resolveReady({context,view}); send({type:'initialized'}); return; }
    if (!nonce || message.nonce !== nonce) return;
    if (message.type === 'context') { context=message.context; listeners.forEach(listener => listener(context)); }
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
  const resize=()=>{if(nonce)send({type:'resize',height:Math.ceil(document.body?.getBoundingClientRect().height || 120)+20});};
  window.addEventListener('DOMContentLoaded',()=>{new ResizeObserver(resize).observe(document.body);ready.then(resize);});
  send({type:'ready'});
})();
