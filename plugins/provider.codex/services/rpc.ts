import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import path from 'node:path';
import type {Command} from '../../../electron/services/tool-runtime';

/** Only account reads are sent. No thread, turn, login, logout or credit redemption. */
export class CodexAccountRpc {
  private child:ChildProcessWithoutNullStreams;
  private next=0;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
  private buffer='';private size=0;private closed=false;private timer:ReturnType<typeof setTimeout>;
  constructor(command:Command,timeout=20000){
    this.child=spawn(command.file,command.args,{env:command.env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.timer=setTimeout(()=>this.close(new Error('Codex 用量读取超时，请检查登录状态和网络。')),timeout);
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',(chunk:string)=>{
      this.size+=Buffer.byteLength(chunk);
      if(this.size>1024*1024)return this.close(new Error('Codex 用量响应超出限制。'));
      this.buffer+=chunk;let end:number;
      while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);if(line.trim())this.receive(line);}
    });
    // Drain stderr without retaining CLI output, tokens or local paths.
    this.child.stderr.resume();
    this.child.stdin.on('error',()=>this.close(new Error('Codex 通信已中断。')));
    this.child.on('error',()=>this.close(new Error('无法启动 Codex CLI，请检查工具安装。')));
    this.child.on('close',()=>this.close(new Error('Codex CLI 已退出；请更新 CLI 后重试。')));
  }
  private receive(line:string){
    let message:Record<string,unknown>;
    try{message=JSON.parse(line);}catch{return this.close(new Error('Codex CLI 返回了无效的用量响应。'));}
    if(!message || typeof message!=='object')return;
    if(typeof message.method==='string'){
      // Do not service unexpected approval/token-refresh requests from the CLI.
      if(message.id!==undefined)this.send({id:message.id,error:{code:-32601,message:'Account reads only'}});
      return;
    }
    const pending=this.pending.get(message.id as number);if(!pending)return;
    this.pending.delete(message.id as number);
    if(message.error)pending.reject(new Error('Codex 用量读取失败，请检查 ChatGPT 登录或更新 CLI。'));
    else pending.resolve(message.result);
  }
  private send(message:object){if(this.closed)throw new Error('Codex 通信已关闭。');this.child.stdin.write(JSON.stringify(message)+'\n');}
  private request(method:string,params:object={}){
    if(this.closed)return Promise.reject(new Error('Codex 通信已关闭。'));
    const id=++this.next;
    return new Promise<unknown>((resolve,reject)=>{this.pending.set(id,{resolve,reject});try{this.send({id,method,params});}catch{this.pending.delete(id);reject(new Error('Codex 通信已中断。'));}});
  }
  async read(){
    await this.request('initialize',{clientInfo:{name:'lumi_usage',title:'Lumi',version:'1.0.0'}});
    this.send({method:'initialized',params:{}});
    const account=await this.request('account/read',{refreshToken:false});
    const type=(account as {account?:{type?:string}})?.account?.type;
    if(type!=='chatgpt')return {account,limits:null};
    const limits=await this.request('account/rateLimits/read');
    const current=await this.request('account/read',{refreshToken:false});
    if(JSON.stringify(current)!==JSON.stringify(account))throw new Error('Codex 账户已切换，请重新读取用量。');
    return {account,limits};
  }
  close(error=new Error('Codex 用量读取已取消。')){
    if(this.closed)return;this.closed=true;clearTimeout(this.timer);
    for(const request of this.pending.values())request.reject(error);this.pending.clear();this.buffer='';
    this.child.stdin.end();
    if(this.child.exitCode===null){
      if(process.platform==='win32' && this.child.pid){
        const killer=spawn(path.join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe'),['/PID',String(this.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        killer.on('error',()=>this.child.kill());
      }else {this.child.kill();const kill=setTimeout(()=>{if(this.child.exitCode===null)this.child.kill('SIGKILL');},1000);kill.unref();}
    }
  }
}
