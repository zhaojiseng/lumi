import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import path from 'node:path';
import {z} from 'zod';
import type {Command} from './tool-runtime';
import type {CodexBridgeStatus,CodexBridgeMessage} from '../../shared/contracts/codex-bridge';

/** Conversation-only surface. Process/fs/config/account-write methods stay unreachable from extensions. */
export const CODEX_BRIDGE_METHODS=Object.freeze(['initialize','initialized','thread/start','thread/resume','thread/read','thread/list','thread/fork','thread/unarchive','thread/name/set','thread/archive','thread/delete','thread/loaded/list','thread/turns/list','thread/items/list','turn/start','turn/steer','turn/interrupt','model/list','skills/list','account/read','account/rateLimits/read']);
const allowed=new Set<string>(CODEX_BRIDGE_METHODS);
const MAX_LINE=2*1024*1024;
const REQUEST_TIMEOUT=120000;
const APPROVAL_TIMEOUT=10*60*1000;

export interface CodexBridgeTransport {
  write(message:object):void;
  onMessage(listener:(message:CodexBridgeMessage)=>void):void;
  onExit(listener:(error?:Error)=>void):void;
  close():void;
}

/** Newline-delimited JSON over the CLI's stdio; nothing is interpreted or persisted here. */
export function childTransport(command:Command):CodexBridgeTransport {
  const child:ChildProcessWithoutNullStreams=spawn(command.file,command.args,{env:command.env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  const messageListeners=new Set<(message:CodexBridgeMessage)=>void>(),exitListeners=new Set<(error?:Error)=>void>();
  let buffer='',size=0,closed=false,disposed=false;
  const notifyExit=(error?:Error)=>{if(closed)return;closed=true;close();for(const listener of exitListeners)listener(error);exitListeners.clear();};
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{
    if(closed)return;
    size+=Buffer.byteLength(chunk);
    if(size>MAX_LINE*4){notifyExit(new Error('Codex app-server 输出超出限制。'));close();return;}
    buffer+=chunk;let end:number;
    while((end=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);size=Buffer.byteLength(buffer);
      if(!line.trim()||line.length>MAX_LINE)continue;
      let message:CodexBridgeMessage;
      try{message=JSON.parse(line) as CodexBridgeMessage;}catch{continue;}
      if(!message || typeof message!=='object')continue;
      if(closed)return;
      for(const listener of messageListeners)listener(message);
    }
  });
  // Drain stderr without retaining CLI output, prompts or local paths.
  child.stderr.resume();
  child.stdin.on('error',()=>notifyExit(new Error('Codex 通信已中断。')));
  child.on('error',()=>notifyExit(new Error('无法启动 Codex CLI，请检查工具安装。')));
  child.on('close',()=>notifyExit(new Error('Codex CLI 已退出。')));
  function close(){
    if(disposed)return;disposed=true;closed=true;buffer='';size=0;messageListeners.clear();
    child.stdin.end();
    if(child.exitCode===null){
      if(process.platform==='win32' && child.pid){
        const killer=spawn(path.join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        killer.on('error',()=>child.kill());
      }else if(child.pid){const pid=child.pid;try{process.kill(-pid,'SIGTERM');}catch{child.kill();}const kill=setTimeout(()=>{try{process.kill(-pid,'SIGKILL');}catch{/* Group already exited. */}},1000);kill.unref();}
    }
  }
  return {
    write(message){if(closed)throw new Error('Codex 通信已关闭。');child.stdin.write(JSON.stringify(message)+'\n');},
    onMessage(listener){messageListeners.add(listener);},
    onExit(listener){if(!closed)exitListeners.add(listener);},
    close,
  };
}

interface PendingRequest {resolve:(value:{result?:unknown;error?:unknown})=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;}
interface Options {
  resolve:()=>Promise<Command|undefined>;
  chooseDirectory?:()=>Promise<string|null>;
  requestTimeout?:number;
  approvalTimeout?:number;
  connect?:(command:Command)=>CodexBridgeTransport;
}

/** Thin passthrough: Lumi never parses thread/turn semantics or approval decisions. */
export class CodexBridgeService {
  private transport?:CodexBridgeTransport;
  private listeners=new Set<(message:CodexBridgeMessage)=>void>();
  private pending=new Map<number,PendingRequest>();
  private approvals=new Map<number|string,ReturnType<typeof setTimeout>>();
  private starting?:Promise<void>;
  private state:CodexBridgeStatus['state']='exited';
  private detail?:string;
  private next=1;
  private closed=false;
  constructor(private options:Options){}

  subscribe(listener:(message:CodexBridgeMessage)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}

  async status():Promise<CodexBridgeStatus>{
    const command=await this.options.resolve().catch(()=>undefined);
    return {installed:!!command,state:this.state,...this.detail ? {detail:this.detail} : {}};
  }

  async send(input:{method:string;params?:unknown;notify?:boolean}):Promise<{result?:unknown;error?:unknown}>{
    input=z.object({method:z.string().max(100),params:z.unknown().optional(),notify:z.boolean().optional()}).strict().parse(input);
    if(this.closed)throw new Error('Codex 桥接已停用。');
    if(!allowed.has(input.method))throw new Error('不支持的 Codex 方法：'+input.method);
    await this.ensure();
    const params=input.params===undefined ? {} : input.params;
    if(input.notify){this.transport!.write({method:input.method,params});return {};}
    const id=this.next++;
    return await new Promise<{result?:unknown;error?:unknown}>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex 请求超时。'));},this.options.requestTimeout ?? REQUEST_TIMEOUT);
      this.pending.set(id,{resolve,reject,timer});
      try{this.transport!.write({id,method:input.method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error instanceof Error ? error : new Error('Codex 通信已中断。'));}
    });
  }

  async respond(input:{id:number|string;result?:unknown;error?:unknown}):Promise<void>{
    input=z.object({id:z.union([z.number().int().safe(),z.string().min(1).max(200)]),result:z.unknown().optional(),error:z.unknown().optional()}).strict().parse(input);
    if(this.closed)throw new Error('Codex 桥接已停用。');
    if(!this.transport || !this.approvals.has(input.id))throw new Error('Codex 请求已结束或不属于当前连接。');
    this.transport!.write(input.error ? {id:input.id,error:input.error} : {id:input.id,result:input.result ?? null});
    this.clearApproval(input.id);
  }

  async chooseDirectory():Promise<{path:string}|null>{
    if(!this.options.chooseDirectory)return null;
    const selected=await this.options.chooseDirectory();
    return selected ? {path:selected} : null;
  }

  close(){if(this.closed)return;this.closed=true;this.shutdown(new Error('Codex 桥接已停用。'));}

  private async ensure():Promise<void>{
    if(this.closed)throw new Error('Codex 桥接已停用。');
    if(this.transport)return;
    this.starting ||= this.start();
    try{await this.starting;}finally{this.starting=undefined;}
    if(this.closed || !this.transport)throw new Error('Codex 桥接已停用。');
  }

  private async start():Promise<void>{
    const command=await this.options.resolve();
    if(!command)throw new Error('未发现 Codex CLI，请在工具配置中安装并使用 codex login 登录。');
    if(this.closed)throw new Error('Codex 桥接已停用。');
    this.state='starting';this.detail=undefined;
    const env:NodeJS.ProcessEnv={...process.env,...command.env};
    for(const key of Object.keys(env))if(/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/i.test(key))delete env[key];
    const transport=this.options.connect?.({...command,env}) ?? childTransport({...command,env});
    transport.onMessage(message=>this.receive(message));
    transport.onExit(error=>this.fail(error));
    this.transport=transport;this.state='ready';
  }

  private receive(message:CodexBridgeMessage){
    if(this.closed)return;
    if(message.method!==undefined){
      // Server-initiated request (has id) or notification (no id): forwarded verbatim.
      if(message.id!==undefined)this.armApproval(message.id);
      for(const listener of this.listeners)listener(message);
      return;
    }
    if(message.id===undefined)return;
    const request=this.pending.get(Number(message.id));
    if(!request)return;
    clearTimeout(request.timer);this.pending.delete(Number(message.id));
    request.resolve(message.error ? {error:message.error} : {result:message.result});
  }

  private armApproval(id:number|string){
    this.clearApproval(id);
    const timer=setTimeout(()=>{this.approvals.delete(id);if(this.transport && !this.closed){try{this.transport.write({id,error:{code:-32000,message:'Lumi: approval timed out'}});for(const listener of this.listeners)listener({method:'serverRequest/resolved',params:{requestId:id}});}catch{this.fail(new Error('Codex 通信已中断。'));}}},this.options.approvalTimeout ?? APPROVAL_TIMEOUT);
    this.approvals.set(id,timer);
  }

  private clearApproval(id:number|string){const timer=this.approvals.get(id);if(timer){clearTimeout(timer);this.approvals.delete(id);}}

  private fail(error?:Error){if(this.closed)return;this.shutdown(error);}

  private shutdown(error?:Error){
    this.state='exited';this.detail=error?.message;
    const transport=this.transport;this.transport=undefined;
    try{transport?.close();}catch{/* Already gone. */}
    for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error ?? new Error('Codex 通信已关闭。'));}
    this.pending.clear();
    for(const timer of this.approvals.values())clearTimeout(timer);
    this.approvals.clear();
    for(const listener of this.listeners)listener({method:'lumi/bridge/exited',params:{detail:this.detail}});
    if(this.closed)this.listeners.clear();
  }
}
