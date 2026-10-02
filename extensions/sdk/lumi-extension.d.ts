/** Portable author types for the sandboxed Lumi extension SDK v1. No host imports required. */
export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export interface Context {theme:'light'|'dark';locale:'zh-CN';site:{id:string;name:string;url:string};refreshEpoch?:number;}
export interface LumiExtensionSdk {
  readonly apiVersion:1;
  readonly context:Context|undefined;
  readonly view:{id:string;slot:'workbench'|'usage'|'models'|'tokens'|'connection'|'settingsTab'|'sidebar'}|undefined;
  readonly ready:Promise<{context:Context;view:NonNullable<LumiExtensionSdk['view']>}>;
  onContext(listener:(context:Context)=>void):()=>void;
  workbench:{read<T=Record<string,unknown>>(input?:{force?:boolean}):Promise<T>};
  usage:{read<T=Record<string,unknown>>(input?:{force?:boolean}):Promise<T>};
  codex:{readUsage<T=Record<string,unknown>>(input?:{force?:boolean}):Promise<T>};
  storage:{read<T extends Json=Json>(key:string):Promise<T|null>;write(key:string,value:Json):Promise<void>};
  secrets:{has(key:string):Promise<boolean>;set(key:string,value:string|null):Promise<void>};
  network:{read(input:{url:string;headers?:Record<string,string>;secret?:{key:string;header:'Authorization'|'X-Api-Key';prefix?:'Bearer '|''}}):Promise<{status:number;body:string}>};
}
declare global {interface Window {readonly lumiExtension:LumiExtensionSdk;}}
