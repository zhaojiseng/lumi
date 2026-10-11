import {execFile} from 'node:child_process';
import path from 'node:path';
type Tool='codex'|'claude-code';
export type GatewayProcessRunner=(file:string,args:string[])=>Promise<string>;
const execute:GatewayProcessRunner=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,shell:false,timeout:10000,maxBuffer:2*1024*1024},(error,stdout)=>error?reject(new Error('无法检查 CLI 运行状态，请关闭工具后重试。')):resolve(stdout)));
/** Fixed process checks only; no executable, arguments or process IDs come from a plugin. */
export async function gatewayCliToolRunning(tool:Tool,options:{platform?:NodeJS.Platform;run?:GatewayProcessRunner}={}):Promise<boolean>{
 if(!['codex','claude-code'].includes(tool))throw new Error('不支持此 CLI。');
 const rawRun=options.run??execute,platform=options.platform??process.platform;
 const run:GatewayProcessRunner=async(file,args)=>{try{return await rawRun(file,args);}catch{throw new Error('无法检查 CLI 运行状态，请关闭工具后重试。');}};
 if(platform==='win32'){
  const expression=tool==='codex'?"(?i)(?:^|[\\\\/])codex(?:\\.exe)?(?:[\\s\\\"]|$)|@openai[\\\\/]codex(?:[\\\\/]|$)":"(?i)(?:^|[\\\\/])claude(?:\\.exe)?(?:[\\s\\\"]|$)|@anthropic-ai[\\\\/]claude-code(?:[\\\\/]|$)";
  // Return only a count; do not serialize process command lines into application logs.
  const script="$ErrorActionPreference='Stop'; $count=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (($_.Name -eq '"+(tool==='codex'?'codex.exe':'claude.exe')+"') -or ($_.Name -in @('node.exe','node','bash.exe','sh.exe') -and $_.CommandLine -match '"+expression+"')) }).Count; [Console]::Write($count)";
  const result=(await run(path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')])).trim();
  if(!/^\d{1,8}$/.test(result))throw new Error('无法检查 CLI 运行状态，请关闭工具后重试。');
  return Number(result)>0;
 }
 if(platform!=='darwin' && platform!=='linux')throw new Error('此平台不能检查 CLI 运行状态。');
 const output=await run('/bin/ps',['-A','-o','pid=','-o','comm=','-o','args=']);
 const expression=tool==='codex'?/(?:^|[\s/])codex(?:[\s]|$)|@openai\/codex(?:\/|$)/:/(?:^|[\s/])claude(?:[\s]|$)|@anthropic-ai\/claude-code(?:\/|$)/;
 const rows=output.split('\n').filter(line=>line.trim()).map(line=>/^\s*(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line));
 if(!rows.length || rows.some(row=>!row || !Number.isSafeInteger(Number(row[1])) || Number(row[1])<=0))throw new Error('无法检查 CLI 运行状态，请关闭工具后重试。');
 return rows.some(row=>{
  const match=row!,name=path.posix.basename(match[2]),args=match[3]??'';
  if(Number(match[1])===process.pid)return false;
  if(name===(tool==='codex'?'codex':'claude'))return true;
  return ['node','nodejs','bash','sh','zsh'].includes(name) && expression.test(args);
 });
}
