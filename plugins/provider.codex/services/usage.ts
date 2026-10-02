import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type {Command} from '../../../electron/services/tool-runtime';
import type {SubscriptionUsageSnapshot} from '../../../shared/contracts/subscription-usage';
import {normalizeCodexUsage} from './normalize';
import {CodexAccountRpc} from './rpc';

export function codexHome(){
  // Smoke/fixtures must never fall through to the user's CLI home.
  const fixture=process.env.LUMI_TEST_HOME || process.env.LUMI_TEST_DATA;
  return fixture ? path.join(fixture,'.codex') : process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
}
export async function codexAuthScope(home:string){
  let file;
  try{
    file=await open(path.join(home,'auth.json'),'r');
    if((await file.stat()).size>1024*1024)throw new Error('Codex 登录文件超出读取限制。');
    const buffer=Buffer.alloc(1024*1024+1),{bytesRead}=await file.read(buffer,0,buffer.length,0);
    if(bytesRead>1024*1024)throw new Error('Codex 登录文件超出读取限制。');
    return createHash('sha256').update(home).update(buffer.subarray(0,bytesRead)).digest('hex');
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'unverified:'+createHash('sha256').update(home+'\0keychain-or-signed-out').digest('hex');throw new Error('无法读取 Codex 登录状态。');}
  finally{await file?.close();}
}
interface Options {resolve:()=>Promise<Command|undefined>;home?:string;scope?:()=>Promise<string>;connect?:(command:Command)=>Pick<CodexAccountRpc,'read'|'close'>;now?:()=>number;}
export class CodexUsageService {
  private closed=false;private generation=0;
  private cached?:{scope:string;value:SubscriptionUsageSnapshot};
  private pending?:{scope:string;promise:Promise<SubscriptionUsageSnapshot>};
  private clients=new Set<Pick<CodexAccountRpc,'read'|'close'>>();
  constructor(private options:Options){}
  async read(input:{force?:boolean}={}){
    if(this.closed)throw new Error('Codex 接入插件已停用。');
    const home=this.options.home || codexHome(),scope=await (this.options.scope?.() || codexAuthScope(home));
    if(this.closed)throw new Error('Codex 接入插件已停用。');
    const now=this.options.now?.() ?? Date.now();
    if(!scope.startsWith('unverified:') && !input.force && this.cached?.scope===scope && now-this.cached.value.fetchedAt<60000)return structuredClone(this.cached.value);
    if(this.pending?.scope===scope)return this.pending.promise.then(value=>structuredClone(value));
    for(const client of this.clients)client.close();this.clients.clear();
    const generation=++this.generation;this.cached=undefined;
    const promise=(async()=>{
      const command=await this.options.resolve();
      if(this.closed || generation!==this.generation)throw new Error('Codex 账户读取已失效。');
      if(!command)throw new Error('未发现 Codex CLI，请在工具配置中安装，并使用 ChatGPT 账户登录。');
      const env:NodeJS.ProcessEnv={...process.env,...command.env,CODEX_HOME:home};
      for(const key of Object.keys(env))if(/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/i.test(key))delete env[key];
      const client=this.options.connect?.({...command,env}) || new CodexAccountRpc({...command,env});this.clients.add(client);
      try{
        const {account,limits}=await client.read();
        const current=await (this.options.scope?.() || codexAuthScope(home));
        if(this.closed || generation!==this.generation || current!==scope)throw new Error('Codex 账户已切换或插件已停用，请重新读取。');
        const value=normalizeCodexUsage(account,limits,scope,this.options.now?.() ?? Date.now());
        this.cached={scope,value};return structuredClone(value);
      }finally{client.close();this.clients.delete(client);}
    })();
    this.pending={scope,promise};
    try{return await promise;}finally{if(this.pending?.promise===promise)this.pending=undefined;}
  }
  close(){this.closed=true;this.generation++;this.cached=undefined;for(const client of this.clients)client.close();this.clients.clear();}
}
