import type {TrustedBuiltinPlugin} from '../../shared/contracts/plugins';
import type {Command} from '../../electron/services/tool-runtime';
import {codexBridgeManifest} from './manifest';
import {CodexBridgeService} from './services/bridge';
export function codexBridgePlugin(options:{resolve:()=>Promise<Command|undefined>;chooseDirectory?:()=>Promise<string|null>}):TrustedBuiltinPlugin {
  return {manifest:codexBridgeManifest,activate(context){const clients=new Set<CodexBridgeService>();const factory={create(){const service=new CodexBridgeService(options);clients.add(service);return service;},release(client:import('../../shared/contracts/codex-bridge').CodexBridgeCapability){client.close();clients.delete(client as CodexBridgeService);},close(){for(const client of clients)client.close();clients.clear();}};context.provide('codexBridge',factory);context.onDispose(()=>factory.close());}};
}
