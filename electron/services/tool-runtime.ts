import {spawn} from 'node:child_process';
import {access,mkdir,readFile,realpath,stat,writeFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import type {Tool,ToolRuntimeState} from '../../shared/types';
import {appLogs} from './app-logs';

export function shellPath(output:string){return output.match(/\x1eLUMI_PATH\x1f([^\x1e]*)\x1e/)?.[1] || '';}

export interface Command {file:string;args:string[];env?:NodeJS.ProcessEnv;timeout?:number;}
export interface CommandResult {code:number;stdout:string;stderr:string;}
export type CommandRunner=(command:Command)=>Promise<CommandResult>;
const packages={codex:'@openai/codex',claude:'@anthropic-ai/claude-code'} as const;
export function versionFromOutput(text:string){return text.match(/\bv?(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/)?.[1];}
const latestVersionPattern=/^\d+\.\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?$/;
export function chatGPTStoreVersion(data:unknown,architecture:'x64'|'arm64'=process.arch==='arm64' ? 'arm64' : 'x64'):string|undefined {
  const product=(data as {Product?:{DisplaySkuAvailabilities?:unknown}})?.Product;
  const skus=product?.DisplaySkuAvailabilities;
  if(!Array.isArray(skus))return undefined;
  const versions=skus.flatMap(sku=>Array.isArray(sku?.Sku?.Properties?.Packages) ? sku.Sku.Properties.Packages : [])
    .filter(pkg=>pkg?.PackageFamilyName==='OpenAI.Codex_2p2nqsd0c76g0' && typeof pkg.PackageFullName==='string')
    .map(pkg=>pkg.PackageFullName.match(/^OpenAI\.Codex_(\d+\.\d+\.\d+\.\d+)_(x64|arm64)__2p2nqsd0c76g0$/))
    .filter(match=>match?.[2]===architecture)
    .map(match=>match?.[1])
    .filter((v):v is string=>!!v);
  return versions.sort((a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<4;i++)if(x[i]!==y[i])return y[i]-x[i];return 0;})[0];
}
const chatGPTWindowsScript=[
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $apps=@();',
  "Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '(^|[.])ChatGPT([.-]|$)' -or ($_.Name -in @('OpenAI.Codex','OpenAI.CodexBeta') -and (Test-Path -LiteralPath (Join-Path $_.InstallLocation 'app\\ChatGPT.exe') -PathType Leaf)) } | Sort-Object { if ($_.Name -eq 'OpenAI.Codex') { 0 } elseif ($_.Name -eq 'OpenAI.CodexBeta') { 2 } else { 1 } } | ForEach-Object { $apps += @{version=$_.Version.ToString();path=$_.InstallLocation} };",
  "if (!$apps.Count) { Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^ChatGPT(?:$|\\s)' } | ForEach-Object { $apps += @{version=$_.DisplayVersion;path=$_.InstallLocation} } };",
  "if (!$apps.Count) { @((Join-Path $env:LOCALAPPDATA 'Programs\\ChatGPT\\ChatGPT.exe'),(Join-Path $env:LOCALAPPDATA 'ChatGPT\\ChatGPT.exe'),(Join-Path $env:ProgramFiles 'ChatGPT\\ChatGPT.exe')) | ForEach-Object { if (Test-Path -LiteralPath $_ -PathType Leaf) { $item=Get-Item -LiteralPath $_; $apps += @{version=$item.VersionInfo.ProductVersion;path=$item.FullName} } } };",
  'ConvertTo-Json -InputObject @($apps) -Compress'
].join(' ');
const psLiteral=(s:string)=>"'"+s.replaceAll("'","''")+"'";
function invocation(file:string,args:string[],platform=process.platform):Command {
  if(platform==='win32' && /\.(?:cmd|bat|ps1)$/i.test(file)) {
    const script=`$ErrorActionPreference='Stop'; & ${psLiteral(file)} ${args.map(psLiteral).join(' ')}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`;
    return {file:path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]};
  }
  return {file,args};
}
function safeMessage(text:string){return text.replace(/\b(?:sk-|sess-)[\w-]{8,}/gi,'[已隐藏]').replace(/(Bearer\s+)\S+/gi,'$1[已隐藏]').replace(/https?:\/\/[^\s]+/g,'[链接]').replace(/\x1b\[[0-9;]*m/g,'').trim().slice(-1200);}
interface RuntimeOptions {
  directory:string;platform?:NodeJS.Platform;home?:string;env?:NodeJS.ProcessEnv;run?:CommandRunner;
  find?:(name:string)=>Promise<string|undefined>;
  download?:(url:string,target:string)=>Promise<void>;
  latest?:(tool:Tool|'chatgpt')=>Promise<string|undefined>;
}
/** Fixed vendor commands only; the renderer cannot submit commands, paths or install packages. */
export class ToolRuntimeService {
  private states=new Map<Tool|'chatgpt',ToolRuntimeState>();private pending=new Map<Tool|'chatgpt',Promise<ToolRuntimeState>>();
  private latestCache=new Map<Tool|'chatgpt',{version?:string;checkedAt:number}>();
  private installs=new Map<Tool,Promise<ToolRuntimeState>>();
  private listeners=new Set<(state:ToolRuntimeState)=>void>();private children=new Set<ReturnType<typeof spawn>>();
  private abort=new AbortController();private platform:NodeJS.Platform;private home:string;private env:NodeJS.ProcessEnv;private run:CommandRunner;
  private shellDirs?:Promise<string[]>;private inheritedPath:string;
  constructor(private options:RuntimeOptions) {this.platform=options.platform || process.platform;this.home=options.home || os.homedir();this.env={...process.env,...options.env};this.inheritedPath=this.env.PATH || this.env.Path || '';this.run=command=>options.run ? options.run(this.platform==='darwin' ? {...command,env:{PATH:this.env.PATH,...command.env}} : command) : this.execute(command);}
  subscribe(listener:(state:ToolRuntimeState)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  /** Host-only launch description for the fixed account-read protocol. */
  async resolveCodexUsageCommand():Promise<Command|undefined>{
    const dirs=await this.searchDirs(),file=await this.find('codex',dirs);
    if(!file)return undefined;
    const args=['-s','read-only','-a','never','app-server'];
    if(this.platform==='win32' && /\.(?:cmd|bat|ps1)$/i.test(file)){
      const script=path.join(path.dirname(file),'node_modules','@openai','codex','bin','codex.js');
      try{await access(script);const node=await this.find('node',dirs);if(node)return {file:node,args:[script,...args],env:{...this.env}};}catch{}
    }
    return {...invocation(file,args,this.platform),env:{...this.env}};
  }
  /** Interactive app-server for the extension bridge; no sandbox/approval overrides so Codex's own settings apply. */
  async resolveCodexAppServerCommand():Promise<Command|undefined>{
    const dirs=await this.searchDirs(),file=await this.find('codex',dirs);
    if(!file)return undefined;
    const args=['app-server'];
    if(this.platform==='win32' && /\.(?:cmd|bat|ps1)$/i.test(file)){
      const script=path.join(path.dirname(file),'node_modules','@openai','codex','bin','codex.js');
      try{await access(script);const node=await this.find('node',dirs);if(node)return {file:node,args:[script,...args],env:{...this.env}};}catch{}
    }
    return {...invocation(file,args,this.platform),env:{...this.env}};
  }
  private emit(state:ToolRuntimeState){const latest=this.latestCache.get(state.tool);if(latest && state.latestCheckedAt===undefined)state={...state,latestVersion:latest.version,latestCheckedAt:latest.checkedAt};this.states.set(state.tool,state);for(const listener of this.listeners)listener(structuredClone(state));return state;}
  private async execute(command:Command):Promise<CommandResult> {
    if(this.abort.signal.aborted)throw new Error('操作已取消。');
    const env={...this.env,...command.env};for(const key of Object.keys(env))if(/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/i.test(key))delete env[key];
    return new Promise((resolve,reject)=>{
      const child=spawn(command.file,command.args,{shell:false,windowsHide:true,env,stdio:['ignore','pipe','pipe'],signal:this.abort.signal});this.children.add(child);
      let stdout='',stderr='';const timer=setTimeout(()=>{this.stopChild(child);reject(new Error('工具操作超时，请检查网络或工具安装。'));},command.timeout || 10000);
      child.stdout?.on('data',b=>{stdout=(stdout+b.toString()).slice(-65536);});child.stderr?.on('data',b=>{stderr=(stderr+b.toString()).slice(-65536);});
      child.once('error',e=>{clearTimeout(timer);this.children.delete(child);reject(new Error(safeMessage(e.message)));});
      child.once('close',code=>{clearTimeout(timer);this.children.delete(child);resolve({code:code ?? 1,stdout,stderr});});
    });
  }
  private stopChild(child:ReturnType<typeof spawn>){if(child.exitCode!==null)return;if(this.platform==='win32' && child.pid){const taskkill=spawn(path.join(this.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});taskkill.on('error',()=>child.kill());}else child.kill();}
  close(){for(const child of this.children)this.stopChild(child);this.abort.abort();}
  private async searchDirs() {
    let registry:string[]=[];
    if(this.platform==='win32')try {
      const script="[Console]::OutputEncoding=[Text.Encoding]::UTF8; @([Environment]::GetEnvironmentVariable('Path','User'),[Environment]::GetEnvironmentVariable('Path','Machine')) | ConvertTo-Json -Compress";
      const r=await this.run({file:path.join(this.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]});
      if(r.code===0)registry=(JSON.parse(r.stdout.replace(/^\uFEFF/,'')) as (string|null)[]).filter((x):x is string=>typeof x==='string');
    } catch { /* Common locations remain available if registry reads are denied. */ }
    const sep=this.platform==='win32' ? ';' : ':';
    const raw=[this.platform==='darwin' ? this.inheritedPath : this.env.PATH || this.env.Path || '',...registry].join(sep).replace(/%([\w]+)%/g,(all,key)=>this.env[key] || all);
    const dirs=raw.split(sep).map(x=>x.trim().replace(/^"|"$/g,'')).filter(x=>x && path.isAbsolute(x));
    if(this.platform==='darwin'){
      this.shellDirs ||= (async()=>{try{
        const file=this.env.SHELL && ['/bin/zsh','/bin/bash','/bin/sh'].includes(this.env.SHELL) ? this.env.SHELL : '/bin/zsh';
        const result=await this.run({file,args:['-ilc',`printf '\\036LUMI_PATH\\037%s\\036' "$PATH"`],timeout:5000});
        const value=result.code===0 ? shellPath(result.stdout) : '';
        if(!value)appLogs.write('warn','工具环境','无法读取登录 Shell 的 PATH，继续检查 Homebrew 和版本管理器。');
        return value.split(':').filter(x=>path.isAbsolute(x));
      }catch{appLogs.write('warn','工具环境','登录 Shell 检测失败，使用常见安装路径。');return [];}})();
      dirs.push(...await this.shellDirs);
      dirs.push(path.join(this.home,'.volta','bin'),path.join(this.home,'.asdf','shims'),path.join(this.home,'.local','share','mise','shims'),path.join(this.home,'.fnm','aliases','default','bin'),path.join(this.home,'Library','Application Support','fnm','aliases','default','bin'),path.join(this.home,'.n','bin'));
      for(const directory of [path.join(this.env.NVM_DIR || path.join(this.home,'.nvm'),'versions','node'),path.join(this.home,'.local','share','mise','installs','node')])try{
        const versions=(await readdir(directory,{withFileTypes:true})).filter(entry=>entry.isDirectory() && /^v?\d+\.\d+\.\d+$/.test(entry.name)).sort((a,b)=>b.name.localeCompare(a.name,undefined,{numeric:true}));
        dirs.push(...versions.map(entry=>path.join(directory,entry.name,'bin')));
      }catch{}
    }
    dirs.push(path.join(this.home,'.local','bin'),path.join(this.home,'.codex','bin'));
    if(this.platform==='win32')dirs.push(path.join(this.env.APPDATA || path.join(this.home,'AppData','Roaming'),'npm'),path.join(this.env.LOCALAPPDATA || path.join(this.home,'AppData','Local'),'Programs','OpenAI','Codex','bin'),path.join(this.env.LOCALAPPDATA || path.join(this.home,'AppData','Local'),'Programs','claude'),path.join(this.env.ProgramFiles || 'C:\\Program Files','nodejs'));
    else dirs.push('/opt/homebrew/bin','/usr/local/bin','/usr/bin',path.join(this.home,'.npm-global','bin'));
    const unique=[...new Set(dirs)];if(this.platform==='darwin')this.env.PATH=unique.join(':');return unique;
  }
  private async find(name:string,dirs:string[]) {
    if(this.options.find)return this.options.find(name);
    const suffixes=this.platform==='win32' ? ['.exe','.cmd','.bat',''] : [''];
    for(const dir of dirs)for(const suffix of suffixes){const file=path.join(dir,name+suffix);if(this.platform==='win32' && /[\\/]WindowsApps[\\/]/i.test(file))continue;try{if((await stat(file)).isFile()){await access(file);return file;}}catch{}}
    return undefined;
  }
  private async npmPrefix(tool:Tool,file:string) {
    if(this.platform==='win32' && /\.(cmd|bat)$/i.test(file)){
      const shim=await readFile(file,'utf8');if(shim.includes(packages[tool].replaceAll('/','\\')) || shim.includes(packages[tool]))return path.dirname(file);
    }
    const actual=await realpath(file).catch(()=>file),marker=path.sep+'node_modules'+path.sep+packages[tool].split('/').join(path.sep)+path.sep,index=actual.lastIndexOf(marker);
    if(index>=0){const root=actual.slice(0,index);return this.platform!=='win32' && path.basename(root)==='lib' ? path.dirname(root) : root;}
    return undefined;
  }
  private async detect(tool:Tool):Promise<ToolRuntimeState> {
    const dirs=await this.searchDirs();const [file,node,npm]=await Promise.all([this.find(tool,dirs),this.find('node',dirs),this.find('npm',dirs)]);
    if(this.platform==='darwin' && node)this.env.PATH=[path.dirname(node),...dirs.filter(dir=>dir!==path.dirname(node))].join(':');
    let nodeVersion:string|undefined;if(node)try{const r=await this.run(invocation(node,['--version'],this.platform));if(r.code===0)nodeVersion=versionFromOutput(r.stdout);}catch{}
    const base:ToolRuntimeState={tool,installed:!!file,path:file,checkedAt:Date.now(),npmAvailable:!!npm,nodeVersion,phase:'idle'};
    if(!file){appLogs.write('info','工具检测',tool+' 未安装'+(nodeVersion ? ' · Node '+nodeVersion : ''));return this.emit(base);}
    try{const r=await this.run(invocation(file,['--version'],this.platform)),version=r.code===0 ? versionFromOutput(r.stdout || r.stderr) : undefined;if(!version)throw new Error(safeMessage(r.stderr || r.stdout) || '已发现工具，但无法读取版本。');appLogs.write('info','工具检测',`${tool} ${version} · ${file}${nodeVersion ? ' · Node '+nodeVersion : ''}`);return this.emit({...base,version});}
    catch(e){appLogs.write('error','工具检测',tool+'：'+(e instanceof Error ? e.message : '版本检测失败。'));return this.emit({...base,phase:'error',message:e instanceof Error ? e.message : '版本检测失败。'});}
  }
  private async detectChatGPT():Promise<ToolRuntimeState>{
    const base:ToolRuntimeState={tool:'chatgpt',installed:false,checkedAt:Date.now(),npmAvailable:false,phase:'idle'};
    try{
      if(this.platform==='win32'){
        // Query registration and executable metadata; never launch a desktop app with --version.
        const r=await this.run({file:path.join(this.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(chatGPTWindowsScript,'utf16le').toString('base64')],timeout:15000});
        if(r.code!==0)throw new Error('无法读取 ChatGPT 桌面应用安装信息。');
        const apps:unknown=JSON.parse(r.stdout.replace(/^\uFEFF/,''));if(!Array.isArray(apps))throw new Error('桌面应用检测结果无效。');
        const app=apps.find(a=>a && typeof a.version==='string' && /^\d+(?:\.\d+){2,3}(?:[-+][\w.-]+)?$/.test(a.version));
        if(app)return this.emit({...base,installed:true,version:app.version,path:typeof app.path==='string' ? app.path : undefined});
        if(apps.length)return this.emit({...base,installed:true,phase:'error',message:'已发现 ChatGPT 桌面应用，但未能读取版本。'});
      }else if(this.platform==='darwin'){
        for(const directory of [path.join(this.home,'Applications','ChatGPT.app'),'/Applications/ChatGPT.app'])try{
          const r=await this.run({file:'/usr/bin/plutil',args:['-extract','CFBundleShortVersionString','raw','-o','-',path.join(directory,'Contents','Info.plist')]});
          if(r.code===0 && /^\d+(?:\.\d+){2,3}$/.test(r.stdout.trim()))return this.emit({...base,installed:true,version:r.stdout.trim(),path:directory});
        }catch{}
      }
      return this.emit(base);
    }catch{return this.emit({...base,phase:'error',message:'ChatGPT 桌面应用版本检测失败，请重新检测。'});}
  }
  private async latestVersion(tool:Tool|'chatgpt',force:boolean){
    const cached=this.latestCache.get(tool);
    if(!force && cached && Date.now()-cached.checkedAt<(cached.version ? 30*60_000 : 5*60_000))return cached;
    let version:string|undefined;
    try{
      if(this.options.latest)version=await this.options.latest(tool);
      else if(tool==='chatgpt'){
        if(this.platform==='win32'){
          const response=await fetch('https://displaycatalog.mp.microsoft.com/v7.0/products/9PLM9XGG6VKS?market=CN&languages=zh-cn&MS-CV=DGU1mcuYo0WMMp+F.1',{signal:AbortSignal.timeout(8000)});
          if(response.ok)version=chatGPTStoreVersion(await response.json());
        }
      }else{
        const response=await fetch('https://registry.npmjs.org/'+encodeURIComponent(packages[tool])+'/latest',{signal:AbortSignal.timeout(8000)});
        if(response.ok){const data:unknown=await response.json();const value=(data as {version?:unknown})?.version;if(typeof value==='string' && latestVersionPattern.test(value))version=value;}
      }
    }catch{appLogs.write('warn','工具版本',tool+' 最新版查询失败，本机检测结果保留。');}
    const result={version:version && latestVersionPattern.test(version) ? version : undefined,checkedAt:Date.now()};
    this.latestCache.set(tool,result);return result;
  }
  async inspect(force=false,tools:readonly Tool[]=['codex','claude']):Promise<ToolRuntimeState[]> {
    if(!tools.length)return [];
    if(force)this.shellDirs=undefined;
    const allowed=([...new Set(tools)] as (Tool|'chatgpt')[]);
    if(tools.includes('codex'))allowed.push('chatgpt');
    return Promise.all(allowed.map(tool=>this.inspectOne(tool,force)));
  }
  private async inspectOne(tool:Tool|'chatgpt',force:boolean) {
    const job=this.pending.get(tool);if(job)return job;
    const cached=this.states.get(tool);if(!force && cached && Date.now()-cached.checkedAt<30000)return structuredClone(cached);
    const task=(async()=>{const local=tool==='chatgpt' ? await this.detectChatGPT() : await this.detect(tool);const latest=await this.latestVersion(tool,force);return this.emit({...local,latestVersion:latest.version,latestCheckedAt:latest.checkedAt});})();this.pending.set(tool,task);try{return await task;}finally{if(this.pending.get(tool)===task)this.pending.delete(tool);}
  }
  install(tool:Tool):Promise<ToolRuntimeState> {
    const installing=this.installs.get(tool);if(installing)return installing;
    const existing=this.pending.get(tool);
    const task=(async()=>{
      if(existing)await existing;
      let before=this.states.get(tool) || await this.detect(tool);
      this.emit({...before,phase:'installing',message:'正在准备官方安装程序…'});
      try {
        let command:Command;
        const prefix=before.path ? await this.npmPrefix(tool,before.path) : undefined;
        if(prefix) {
          const npm=await this.find('npm',await this.searchDirs());if(!npm)throw new Error('此工具通过 npm 安装，需要先安装 Node.js（含 npm）后更新。');
          command=invocation(npm,['install','--global','--prefix',prefix,packages[tool]+'@latest','--no-audit','--no-fund'],this.platform);
        } else if(tool==='claude' && before.path && /\.exe$/i.test(before.path))command=invocation(before.path,['install','latest'],this.platform);
        else {
          await mkdir(this.options.directory,{recursive:true});
          const extension=this.platform==='win32' ? 'ps1' : 'sh',script=path.join(this.options.directory,tool+'-'+randomUUID()+'.'+extension);
          const url=(tool==='codex' ? 'https://chatgpt.com/codex/install.' : 'https://claude.ai/install.')+extension;
          this.emit({...before,phase:'installing',message:'正在下载官方安装程序…'});
          try {
            if(this.options.download)await this.options.download(url,script);
            else {const response=await fetch(url,{signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(60000)])});if(!response.ok || new URL(response.url).protocol!=='https:')throw new Error('官方安装程序下载失败。');const source=await response.text();if(!source || Buffer.byteLength(source)>2*1024*1024 || /^\s*(?:<!doctype|<html)/i.test(source))throw new Error('官方安装程序格式无效。');await writeFile(script,source,'utf8');}
            command=this.platform==='win32' ? invocation(script,tool==='claude' ? ['latest'] : [],this.platform) : {file:tool==='claude' ? '/bin/bash' : '/bin/sh',args:[script,...(tool==='claude' ? ['latest'] : [])]};
            if(tool==='codex')command.env={CODEX_NON_INTERACTIVE:'1',...(before.path && /\.exe$/i.test(before.path) ? {CODEX_INSTALL_DIR:path.dirname(before.path)} : {})};
            this.emit({...before,phase:'installing',message:'正在安装，完成后自动检测版本…'});
            const result=await this.run({...command,timeout:600000});if(result.code!==0)throw new Error(safeMessage(result.stderr || result.stdout) || '安装程序返回失败，请检查网络。');
          }finally{await rm(script,{force:true});}
          const installed=await this.detect(tool);if(!installed.version)throw new Error(installed.message || '安装程序已结束，但尚未发现可用工具。请重新检测或查看官方安装说明。');return installed;
        }
        const result=await this.run({...command,timeout:600000});if(result.code!==0)throw new Error(safeMessage(result.stderr || result.stdout) || '工具更新失败。');
        const installed=await this.detect(tool);if(!installed.version)throw new Error(installed.message || '安装后无法读取版本，请重新检测。');return installed;
      }catch(e){before=this.states.get(tool) || before;return this.emit({...before,phase:'error',checkedAt:Date.now(),message:e instanceof Error ? safeMessage(e.message) : '安装失败。'});}
    })();this.pending.set(tool,task);this.installs.set(tool,task);void task.finally(()=>{if(this.pending.get(tool)===task)this.pending.delete(tool);this.installs.delete(tool);});return task;
  }
}
