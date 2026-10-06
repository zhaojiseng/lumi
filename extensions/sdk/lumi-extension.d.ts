/** Portable author types for the sandboxed Lumi extension SDK v1. No host imports required. */
export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export interface Context {theme:'light'|'dark';locale:'zh-CN';site:{id:string;name:string;url:string};refreshEpoch?:number;}
export type ExtensionSlot='workbench'|'usage'|'models'|'tokens'|'connection'|'settingsTab'|'sidebar';
export type ExtensionPermission='workbench.read'|'usage.read'|'codex.usage.read'|'codex.bridge'|'storage'|'network.read'|'secrets';
export interface ExtensionManifest {
  schemaVersion:1;hostApiVersion:1;id:string;kind?:'feature'|'interface';
  name:string;version:string;description:string;author:string;license:string;
  permissions?:ExtensionPermission[];networkOrigins?:string[];
  switches?:{id:string;title:string;defaultEnabled?:boolean}[];
  contributions?:{id:string;slot:ExtensionSlot;title:string;entry:string;order?:number;scope?:'site'|'independent';switch?:string;section?:'workspace'|'tools'|'settings'}[];
  interface?:{stylesheet:string;preview?:string;appearanceGroups?:{id:string;title:string;defaultOption:string;options:{id:string;title:string}[]}[]};
}
/** Formatted presentation data, not an account/consumption-log API. */
export interface NativeMenuBarState {
  type:'state';schemaVersion:1;phase:string;siteName:string;accountLabel:string;days:number;tool:string;
  contents:('balance'|'totals'|'tokenDetail'|'efficiency'|'chart'|'models')[];
  totalsCaption?:string;viewKey?:string;
  balance:string;cost:string;tokens:string;requests:string;tokenDetail:string;cacheDetail:string;
  cacheHitRate:string;tokenSpeed:string;message:string;updatedLabel:string;canRefresh:boolean;chartCaption:string;
  chart:{label:string;value:number;cost:string;tokens:string;requests:string}[]|null;
  models:{name:string;cost:string;share:number}[];modelsMessage:string;
}
export interface WidgetModel {name:string;cost:string;requests:string;input:string;output:string;cacheRead:string;cacheWrite:string;}
export interface WidgetState {
  phase:'idle'|'loading'|'ready'|'error';enabled:boolean;siteName:string;balance:string;cost:string;minuteLabel:string;historical:boolean;
  models:WidgetModel[];latestModel?:WidgetModel;message:string;updatedAt:number;viewKey:string;dataKey:string;theme:'light'|'dark';
  animation?:'slide-up'|'slide-down'|'blur'|'fade'|'scale'|'none';source?:'api'|'local';
}
export interface SubscriptionWindow {usedPercent:number|null;remainingPercent:number|null;durationMinutes:number|null;resetsAt:number|null;}
export interface CodexBridgeStatus {installed:boolean;state:'starting'|'ready'|'exited';detail?:string;}
export interface CodexBridgeMessage {id?:number|string;method?:string;params?:unknown;result?:unknown;error?:{code?:number;message?:string;data?:unknown};}
export interface CodexBridgeSdk {
  status():Promise<CodexBridgeStatus>;
  send(input:{method:string;params?:unknown;notify?:boolean}):Promise<{result?:unknown;error?:unknown}>;
  respond(input:{id:number|string;result?:unknown;error?:unknown}):Promise<void>;
  chooseDirectory():Promise<{path:string}|null>;
  subscribe(listener:(message:CodexBridgeMessage)=>void):()=>void;
}
export interface SubscriptionCredits {remaining:number|null;unlimited:boolean|null;hasCredits:boolean|null;}
export interface SubscriptionUsageSnapshot {
  sourceId:'provider.codex';account:{id:string;label:string;plan:string|null}|null;
  state:'ready'|'signed-out'|'unsupported';
  windows:{id:string;label:string;primary:SubscriptionWindow|null;secondary:SubscriptionWindow|null;credits:SubscriptionCredits|null}[];
  fetchedAt:number;
}
export interface LumiExtensionSdk {
  readonly apiVersion:1;
  readonly context:Context|undefined;
  readonly view:{id:string;slot:ExtensionSlot}|undefined;
  readonly ready:Promise<{context:Context;view:NonNullable<LumiExtensionSdk['view']>}>;
  onContext(listener:(context:Context)=>void):()=>void;
  onEvent(topic:string,listener:(payload:unknown)=>void):()=>void;
  workbench:{read<T=NativeMenuBarState>(input?:{force?:boolean}):Promise<T>};
  usage:{read<T=WidgetState>(input?:{force?:boolean}):Promise<T>};
  codex:{readUsage<T=SubscriptionUsageSnapshot>(input?:{force?:boolean}):Promise<T>;bridge:CodexBridgeSdk};
  storage:{read<T extends Json=Json>(key:string):Promise<T|null>;write(key:string,value:Json):Promise<void>};
  secrets:{has(key:string):Promise<boolean>;set(key:string,value:string|null):Promise<void>};
  network:{read(input:{url:string;headers?:Record<string,string>;secret?:{key:string;header:'Authorization'|'X-Api-Key';prefix?:'Bearer '|''}}):Promise<{status:number;body:string}>};
}
declare global {interface Window {readonly lumiExtension:LumiExtensionSdk;}}
