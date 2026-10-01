import {createReadStream} from 'node:fs';
import {lstat,open,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as waitForFile} from 'node:timers/promises';

const CHUNK=256*1024, MAX_RECORD=2*1024*1024, MAX_PATCHES=8*1024*1024;
export interface SessionPatch {offset:number;before:string;after:string;}
export interface SessionChange {path:string;id:string;beforeHash:string;afterHash?:string;patches:SessionPatch[];}
export interface PreparedSession {change:SessionChange;temporary:string;identity:string;}
const identity=(s:{dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number})=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');

/** Bounded JSONL records: large request/response bodies pass through without ever becoming strings. */
async function* records(file:string,digest:ReturnType<typeof createHash>){
  let offset=0,size=0,parts:Buffer[]=[],prefix:Buffer=Buffer.alloc(0),oversized=false;
  for await(const chunk of createReadStream(file,{highWaterMark:CHUNK})){
    const bytes=chunk as Buffer;digest.update(bytes);let start=0;
    while(start<bytes.length){const end=bytes.indexOf(10,start),stop=end<0 ? bytes.length : end+1,part=bytes.subarray(start,stop);
      if(prefix.length<4096)prefix=Buffer.concat([prefix,part.subarray(0,4096-prefix.length)]);
      size+=part.length;
      if(size<=MAX_RECORD)parts.push(part);else{oversized=true;parts=[];}
      if(end>=0){yield {offset,bytes:oversized ? null : Buffer.concat(parts,size),prefix};offset+=size;size=0;parts=[];prefix=Buffer.alloc(0);oversized=false;}
      start=stop;
    }
  }
  if(size)yield {offset,bytes:oversized ? null : Buffer.concat(parts,size),prefix};
}
function changedRecord(before:string,record:any,change:(record:any)=>void){
  change(record);const ending=before.endsWith('\r\n') ? '\r\n' : before.endsWith('\n') ? '\n' : '';
  const after=JSON.stringify(record)+ending;return after===before ? null : {before,after};
}
export async function scanSessionFile(file:string,model:string,contextWindow:number,sources:Set<string>):Promise<SessionChange|null>{
  const stat=await lstat(file);if(!stat.isFile() || stat.isSymbolicLink())return null;
  const digest=createHash('sha256'),patches:SessionPatch[]=[];let id:string|undefined,provider:string|undefined,latest:{offset:number;before:string;record:any}|undefined,patchBytes=0;
  for await(const line of records(file,digest)){
    const sample=(line.bytes || line.prefix).toString('utf8');
    if(!sample.includes('"session_meta"') && !sample.includes('"thread_settings_applied"'))continue;
    if(!line.bytes)throw new Error('Codex 会话配置记录过大，已停止同步；历史请求内容未修改。');
    let record:any;try{record=JSON.parse(sample);}catch{continue;}
    if(record.type==='session_meta'){
      provider=record.payload?.model_provider;id=record.payload?.id;
      // Other providers never need a full history scan.
      if(!sources.has(provider || ''))return null;
      const changed=changedRecord(sample,record,r=>{r.payload.model_provider='custom';});
      if(changed){patches.push({offset:line.offset,...changed});patchBytes+=Buffer.byteLength(changed.before)+Buffer.byteLength(changed.after);}
    }
    if(record.type==='event_msg' && record.payload?.type==='thread_settings_applied')latest={offset:line.offset,before:sample,record};
    if(patchBytes>MAX_PATCHES)throw new Error('Codex 会话配置变更超出安全大小，已停止同步。');
  }
  if(!id || !provider || !sources.has(provider))return null;
  if(latest){const s=latest.record.payload?.thread_settings;
    if(s && sources.has(s.model_provider_id || provider)){
      const changed=changedRecord(latest.before,latest.record,()=>{s.model=model;s.model_provider_id='custom';if(s.collaboration_mode?.settings)s.collaboration_mode.settings.model=model;if('model_context_window' in s)s.model_context_window=contextWindow;});
      if(changed)patches.push({offset:latest.offset,...changed});
    }
  }
  if(!patches.length)return null;
  if(patches.reduce((n,p)=>n+Buffer.byteLength(p.before)+Buffer.byteLength(p.after),0)>MAX_PATCHES)throw new Error('Codex 会话配置变更超出安全大小，已停止同步。');
  if(identity(await lstat(file))!==identity(stat))throw new Error('Codex 会话扫描期间发生变化，请关闭 Codex 后重试。');
  return {path:file,id,beforeHash:digest.digest('hex'),patches:patches.sort((a,b)=>a.offset-b.offset)};
}
export function reverseSession(change:SessionChange):SessionChange{
  let delta=0;return {path:change.path,id:change.id,beforeHash:change.afterHash!,afterHash:change.beforeHash,patches:change.patches.map(p=>{const next={offset:p.offset+delta,before:p.after,after:p.before};delta+=Buffer.byteLength(p.after)-Buffer.byteLength(p.before);return next;})};
}
/** Stage a byte-for-byte copy with only the planned records replaced; hashes guard every untouched byte. */
export async function prepareSession(change:SessionChange):Promise<PreparedSession>{
  const temporary=change.path+'.'+randomUUID()+'.lumi-tmp';const source=await open(change.path,'r');let target:Awaited<ReturnType<typeof open>>|undefined;
  try{
    const stat=await source.stat();if(!stat.isFile() || (await lstat(change.path)).isSymbolicLink())throw new Error('Codex 会话路径已变更。');
    target=await open(temporary,'wx',0o600);const before=createHash('sha256'),after=createHash('sha256'),buffer=Buffer.allocUnsafe(CHUNK);let offset=0;
    const write=async(bytes:Buffer)=>{after.update(bytes);let done=0;while(done<bytes.length){const result=await target!.write(bytes,done,bytes.length-done);if(!result.bytesWritten)throw new Error('会话写入失败。');done+=result.bytesWritten;}};
    const copy=async(end:number)=>{while(offset<end){const result=await source.read(buffer,0,Math.min(CHUNK,end-offset),offset);if(!result.bytesRead)throw new Error('Codex 会话已变更，请重新应用。');const bytes=buffer.subarray(0,result.bytesRead);before.update(bytes);await write(bytes);offset+=result.bytesRead;}};
    for(const patch of change.patches){
      if(!Number.isSafeInteger(patch.offset) || patch.offset<offset || patch.offset>stat.size)throw new Error('无效会话备份记录。');
      await copy(patch.offset);const expected=Buffer.from(patch.before),actual=Buffer.alloc(expected.length);let read=0;
      while(read<actual.length){const result=await source.read(actual,read,actual.length-read,offset+read);if(!result.bytesRead)throw new Error('Codex 会话已变更，请重新应用。');read+=result.bytesRead;}
      if(!actual.equals(expected))throw new Error('Codex 会话已变更，请重新应用。');before.update(actual);offset+=actual.length;await write(Buffer.from(patch.after));
    }
    await copy(stat.size);const beforeHash=before.digest('hex'),afterHash=after.digest('hex');
    if(beforeHash!==change.beforeHash || change.afterHash && afterHash!==change.afterHash || identity(await source.stat())!==identity(stat) || identity(await lstat(change.path))!==identity(stat))throw new Error('Codex 会话已变更，请重新应用。');
    return {change:{...change,afterHash},temporary,identity:identity(stat)};
  }catch(e){await target?.close();target=undefined;await unlink(temporary).catch(()=>{});throw e;}finally{await source.close();await target?.close();}
}
export async function discardSessions(prepared:PreparedSession[]){await Promise.all(prepared.map(p=>unlink(p.temporary).catch(()=>{})));}
export async function commitSession(prepared:PreparedSession){
  // Windows readers and antivirus scanners can briefly deny replacement after the writer closes.
  const delays=[40,80,160];
  for(let attempt=0;;attempt++){
    if(identity(await lstat(prepared.change.path))!==prepared.identity)throw new Error('Codex 会话已变更，请重新应用。');
    try{await rename(prepared.temporary,prepared.change.path);return;}
    catch(e:any){
      if(process.platform!=='win32' || !['EPERM','EACCES','EBUSY'].includes(e.code))throw e;
      if(attempt===delays.length)throw new Error('Codex 会话文件仍被占用，请关闭相关工具后重试。',{cause:e});
      await waitForFile(delays[attempt]);
    }
  }
}
export async function rollbackSessions(changes:SessionChange[]){const failures:string[]=[],causes:unknown[]=[];for(const change of [...changes].reverse()){try{const prepared=await prepareSession(reverseSession(change));try{await commitSession(prepared);}finally{await discardSessions([prepared]);}}catch(e){failures.push(change.path);causes.push(e);}}if(failures.length)throw new AggregateError(causes,'以下会话未能回滚：'+failures.join('、'));}
