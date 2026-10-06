import {CodexBridgeService} from './codex-bridge';
import type {Command} from './tool-runtime';
import type {CodexBridgeCapability,CodexBridgeFactory} from '../../shared/contracts/codex-bridge';
/** Host-owned, lazy clients: availability does not launch a CLI process. */
export function createCodexBridgeFactory(options:{resolve:()=>Promise<Command|undefined>;chooseDirectory?:()=>Promise<string|null>}):CodexBridgeFactory {
  const clients=new Set<CodexBridgeCapability>();let closed=false;
  return {
    create(){if(closed)throw new Error('Codex 桥接正在退出。');const client=new CodexBridgeService(options);clients.add(client);return client;},
    release(client){client.close();clients.delete(client);},
    close(){closed=true;for(const client of clients)client.close();clients.clear();},
  };
}
