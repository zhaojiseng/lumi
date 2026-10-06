import type {CodexBridgeCapability,CodexBridgeFactory} from '../../shared/contracts/codex-bridge';
import type {ExtensionEventMessage} from '../../shared/types';
export interface BridgeOwner {id:string;generation:number;view:string;signal:AbortSignal;}
/** Privileged clients follow the owning extension view, never a global shared RPC connection. */
export function createExtensionCodexBridge(factory:()=>CodexBridgeFactory,emit:(event:ExtensionEventMessage)=>void){
  const clients=new Map<string,{service:CodexBridgeCapability;stop?:()=>void;dispose:()=>void}>();
  return {
    drop(id?:string){for(const [key,client] of [...clients])if(!id || key.startsWith(id+':'))client.dispose();},
    async call(method:string,input:unknown,owner:BridgeOwner){
      const key=owner.id+':'+owner.generation+':'+owner.view;
      if(method==='codex.bridge.unsubscribe'){clients.get(key)?.dispose();return {};}
      if(owner.signal.aborted)throw new Error('扩展界面已撤回。');
      const provider=factory();let client=clients.get(key);
      if(!client){
        const service=provider.create();
        const created:{service:CodexBridgeCapability;stop?:()=>void;dispose:()=>void}={service,dispose:()=>{if(clients.get(key)!==created)return;clients.delete(key);owner.signal.removeEventListener('abort',created.dispose);provider.release(service);created.stop?.();}};
        clients.set(key,created);owner.signal.addEventListener('abort',created.dispose,{once:true});client=created;
      }
      const service=client.service;
      if(method==='codex.bridge.status')return service.status();
      if(method==='codex.bridge.chooseDirectory')return service.chooseDirectory();
      if(method==='codex.bridge.send')return service.send(input as Parameters<typeof service.send>[0]);
      if(method==='codex.bridge.respond')return service.respond(input as Parameters<typeof service.respond>[0]);
      if(method==='codex.bridge.subscribe'){client.stop ||= service.subscribe(message=>emit({id:owner.id,generation:owner.generation,view:owner.view,topic:'codex.bridge',payload:message}));return {};}
      throw new Error('无效扩展接口。');
    },
  };
}
