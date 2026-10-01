import {format} from 'node:util';
import type {AppLogEntry,AppLogLevel,AppLogSnapshot} from '../../shared/types';
export const APP_LOG_LIMIT=10000;
export function redactLog(value:string):string {
  return value.replace(/\x1b\[[0-9;]*m/g,'')
    .replace(/\b(?:Bearer\s+\S+|(?:sk-|sess-)[\w-]{8,})/gi,'[已隐藏]')
    .replace(/\b(Authorization|Set-Cookie|Cookie)\s*:[^\r\n]*/gi,'$1: [已隐藏]')
    .replace(/((?:password|passwd|access[_-]?token|refresh[_-]?token|api[_-]?key|auth[_-]?token|x-auth-session|authorization|set-cookie|cookie|secret)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,'$1[已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/g,raw=>{try{const url=new URL(raw);url.username='';url.password='';url.search='';url.hash='';return url.href;}catch{return '[链接]';}})
    .slice(0,4000);
}
/** Process memory only. Never writes a file or changes the console destination. */
export class AppLogStore {
  readonly startedAt=Date.now();private entries:AppLogEntry[]=[];private sequence=0;private dropped=0;
  private listeners=new Set<(entry:AppLogEntry)=>void>();
  constructor(private limit=APP_LOG_LIMIT){}
  write(level:AppLogLevel,source:string,message:string){
    const entry:AppLogEntry={id:++this.sequence,timestamp:Date.now(),level,source:redactLog(source).slice(0,80),message:redactLog(message)};
    this.entries.push(entry);if(this.entries.length>this.limit){this.entries.shift();this.dropped++;}
    for(const listener of this.listeners)listener({...entry});return {...entry};
  }
  snapshot():AppLogSnapshot{return {startedAt:this.startedAt,entries:structuredClone(this.entries),dropped:this.dropped};}
  subscribe(listener:(entry:AppLogEntry)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
}
export const appLogs=new AppLogStore();
export function captureConsole(store=appLogs){
  const methods=['debug','info','log','warn','error'] as const;
  const original=methods.map(method=>console[method]);
  methods.forEach((method,index)=>{console[method]=(...args:unknown[])=>{store.write(method==='log' ? 'info' : method,'主进程',format(...args));original[index](...args);};});
  const exception=(error:Error)=>store.write('error','进程',error.stack || error.message);
  process.on('uncaughtExceptionMonitor',exception);
  return()=>{methods.forEach((method,index)=>{console[method]=original[index];});process.removeListener('uncaughtExceptionMonitor',exception);};
}
