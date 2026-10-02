import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import type {LocalSessionMetadata} from '../../shared/types';
import {appendedLines} from './local-usage-lines';

const text=(value:unknown,limit=320)=>typeof value==='string' ? value.replace(/\s+/g,' ').trim().slice(0,limit) : undefined;
const sessionKey=(file:string)=>path.basename(file,'.jsonl').match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)?.[0] || path.basename(file,'.jsonl');
/** Read official title indexes, bounded to only the files in the current scan. */
export async function sessionTitles(codexRoot:string,codexFiles:string[],claudeFiles:string[]):Promise<Map<string,LocalSessionMetadata>>{
  const result=new Map<string,LocalSessionMetadata>(),codexIds=new Map(codexFiles.map(file=>[sessionKey(file),file]));
  if(codexFiles.length)try{
    const file=path.join(codexRoot,'session_index.jsonl'),info=await lstat(file);
    if(info.isFile() && !info.isSymbolicLink())for await(const line of appendedLines(file,0,info.size)){
      try{const event=JSON.parse(line.line),target=codexIds.get(event.id);if(target){const title=text(event.thread_name ?? event.title ?? event.name);if(title)result.set(target,{title});}}catch{/* Damaged title entries don't prevent usage scanning. */}
    }
  }catch{/* Optional index. */}
  const byDirectory=new Map<string,Map<string,string>>();
  for(const file of claudeFiles){const dir=path.dirname(file),ids=byDirectory.get(dir) || new Map();ids.set(sessionKey(file),file);byDirectory.set(dir,ids);}
  for(const [dir,ids] of byDirectory)try{
    const file=path.join(dir,'sessions-index.json'),info=await lstat(file);
    if(!info.isFile() || info.isSymbolicLink() || info.size>8*1024*1024)continue;
    const data=JSON.parse(await readFile(file,'utf8'));
    for(const entry of Array.isArray(data.entries) ? data.entries : []){
      const target=ids.get(entry.sessionId);if(!target)continue;
      const title=text(entry.customTitle ?? entry.summary ?? entry.title),firstPrompt=text(entry.firstPrompt),cwd=text(entry.projectPath,2000),gitBranch=text(entry.gitBranch,200);
      result.set(target,{...title ? {title} : {},...firstPrompt ? {firstPrompt} : {},...cwd ? {cwd} : {},...gitBranch ? {gitBranch} : {}});
    }
  }catch{/* Optional index. */}
  return result;
}
