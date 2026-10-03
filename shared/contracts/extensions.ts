import type {PluginManifest,PluginStatus} from './plugins';
import type {InterfaceStyle,InterfaceDefinition} from './interface';

export const EXTENSION_API_VERSION=1;
export const EXTENSION_PERMISSIONS=['workbench.read','usage.read','codex.usage.read','storage','network.read','secrets'] as const;
export type ExtensionPermission=typeof EXTENSION_PERMISSIONS[number];
export const EXTENSION_SLOTS=['workbench','usage','models','tokens','connection','settingsTab','sidebar'] as const;
export type ExtensionSlot=typeof EXTENSION_SLOTS[number];
export interface ExtensionView {
  id:string;slot:ExtensionSlot;title:string;order:number;scope:'site'|'independent';
  entry:string;switch?:string;section?:'workspace'|'tools'|'settings';
}
/** External packages are data manifests plus sandboxed web assets, never privileged Node entries. */
export interface ExtensionManifest {
  kind?:'feature'|'interface';
  interface?:InterfaceDefinition;
  schemaVersion:1;id:string;name:string;version:string;hostApiVersion:1;description:string;author:string;license:string;
  permissions:ExtensionPermission[];networkOrigins:string[];
  switches:{id:string;title:string;defaultEnabled:boolean}[];
  contributions:ExtensionView[];
}
export interface ExtensionDescriptor {manifest:ExtensionManifest;digest:string;removable?:boolean;}
export interface ExtensionInventory {directory:string;plugins:ExtensionDescriptor[];diagnostics:{package:string;error:string}[];interfaceStyle?:InterfaceStyle;}
export type ExtensionMethod='context.read'|'storage.read'|'storage.write'|'secret.set'|'secret.has'|'network.read'|'workbench.read'|'usage.read'|'codex.usage.read';
export interface ExtensionRequest {id:string;generation:number;view:string;method:ExtensionMethod;input?:unknown;}
export interface ExtensionContext {theme:'light'|'dark';locale:'zh-CN';site:{id:string;name:string;url:string};refreshEpoch?:number;}
export function extensionPluginManifest(manifest:ExtensionManifest):PluginManifest {
  return {id:manifest.id,version:manifest.version,hostApiVersion:1,configurable:true,requires:[],optional:[],provides:[],settings:{title:manifest.name,description:manifest.description,order:200,views:manifest.switches}};
}
export function extensionStatus(manifest:ExtensionManifest,enabled:boolean,generation:number,views:Record<string,boolean>={}):PluginStatus {
  return {manifest:extensionPluginManifest(manifest),state:enabled ? 'active' : 'disabled',generation,views,origin:'external'};
}
