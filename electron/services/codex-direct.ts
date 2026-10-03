import {DatabaseSync} from 'node:sqlite';
import {readdir,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'smol-toml';
import {scanSessionFile,type SessionChange} from './codex-session-files';
export type SessionFile=SessionChange;
export interface StateChange {path:string;id:string;before:Record<string,string|null>;after:Record<string,string|null>;}
export interface DirectHistory {files:SessionFile[];rows:StateChange[];}
export function switchSessionDocument(content:string,model:string,contextWindow:number,sources:Set<string>) {
  const lines=content.split(/(?<=\n)/);let provider:string|undefined,id:string|undefined,latest=-1;
  for(let i=0;i<lines.length;i++){let record;try{record=JSON.parse(lines[i]);}catch{continue;}
    if(record.type==='session_meta'){provider=record.payload?.model_provider;id=record.payload?.id;}
    if(record.type==='event_msg' && record.payload?.type==='thread_settings_applied')latest=i;
  }
  if(!id || !provider || !sources.has(provider))return null;
  const replace=(i:number,record:any)=>{const ending=lines[i].endsWith('\r\n') ? '\r\n' : lines[i].endsWith('\n') ? '\n' : '';lines[i]=JSON.stringify(record)+ending;};
  for(let i=0;i<lines.length;i++){let record;try{record=JSON.parse(lines[i]);}catch{continue;}
    if(record.type==='session_meta' && sources.has(record.payload?.model_provider)){record.payload.model_provider='custom';replace(i,record);}
    if(i===latest){const s=record.payload?.thread_settings;if(s && sources.has(s.model_provider_id || provider)){
      s.model=model;s.model_provider_id='custom';
      if(s.collaboration_mode?.settings)s.collaboration_mode.settings.model=model;
      // Only update already-saved context fields, preserving Codex's native snapshot shape.
      if('model_context_window' in s)s.model_context_window=contextWindow;
      replace(i,record);
    }}
  }
  const after=lines.join('');return after===content ? null : {id,after};
}
async function walk(root:string,files:string[],depth=0){
  if(depth>9)return;try{if((await lstat(root)).isSymbolicLink())return;}catch(e:any){if(e.code==='ENOENT')return;throw e;}
  const entries=await readdir(root,{withFileTypes:true});
  for(const e of entries){if(e.isSymbolicLink())continue;const p=path.join(root,e.name);if(e.isDirectory())await walk(p,files,depth+1);else if(e.isFile() && e.name.endsWith('.jsonl'))files.push(p);}
}
export async function planDirectHistory(home:string,config:string|null,model:string,contextWindow:number,environment=false,progress?:(completed:number,total:number)=>void):Promise<DirectHistory>{
  const doc:any=config?.trim() ? parse(config) : {},sources=new Set(['lumi']);
  if(doc.model_provider==='custom' || doc.model_providers?.custom?.name==='Lumi · New API')sources.add('custom');
  const found:string[]=[];await walk(path.join(home,'sessions'),found);await walk(path.join(home,'archived_sessions'),found);
  const files:SessionFile[]=[];
  let completed=0;progress?.(0,found.length);
  for(const p of found){const changed=await scanSessionFile(p,model,contextWindow,sources);if(changed)files.push(changed);progress?.(++completed,found.length);}
  return {files,rows:await planDirectIndexes(home,config,model,environment)};
}
/** SQLite settings are small; capture conflicts during preview without loading JSONL histories. */
export async function planDirectIndexes(home:string,config:string|null,model:string,environment=false):Promise<StateChange[]>{
  const doc:any=config?.trim() ? parse(config) : {},sources=new Set(['lumi']);
  if(doc.model_provider==='custom' || doc.model_providers?.custom?.name==='Lumi · New API')sources.add('custom');
  const locations=[home];const sqliteHome=typeof doc.sqlite_home==='string' ? doc.sqlite_home : environment ? process.env.CODEX_SQLITE_HOME : undefined;
  if(sqliteHome)locations.push(path.resolve(home,sqliteHome));
  const rows:StateChange[]=[];
  for(const base of new Set(locations)){const dbPath=path.join(base,'state_5.sqlite');try{await realpath(dbPath);}catch(e:any){if(e.code==='ENOENT')continue;throw e;}
    const db=new DatabaseSync(dbPath,{readOnly:true});try{
      const columns=new Set((db.prepare('PRAGMA table_info(threads)').all() as any[]).map(c=>c.name));
      if(!columns.has('model_provider') || !columns.has('id'))continue;
      const keys=['model_provider',...(columns.has('model') ? ['model'] : [])];
      const records=db.prepare('SELECT id, '+keys.join(', ')+' FROM threads WHERE model_provider IN ('+[...sources].map(()=>'?').join(',')+')').iterate(...sources) as Iterable<any>;
      for(const record of records){if(!sources.has(record.model_provider))continue;
        const before=Object.fromEntries(keys.map(k=>[k,record[k]])),after={...before,model_provider:'custom',...(columns.has('model') ? {model} : {})};
        if(JSON.stringify(before)!==JSON.stringify(after))rows.push({path:dbPath,id:record.id,before,after});
      }
    }finally{db.close();}
  }
  return rows;
}
export function applyStateChanges(rows:StateChange[],reverse=false){
  const done:StateChange[]=[];
  try{for(const location of new Set(rows.map(r=>r.path))){const db=new DatabaseSync(location);try{
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    for(const row of rows.filter(r=>r.path===location)){
      const before=reverse ? row.after : row.before,after=reverse ? row.before : row.after,keys=Object.keys(before);
      const current=db.prepare('SELECT '+keys.join(', ')+' FROM threads WHERE id=?').get(row.id);
      if(!current || keys.some(k=>current[k]!==before[k]))throw new Error('Codex 会话索引已变更，请重新预览。');
      db.prepare('UPDATE threads SET '+keys.map(k=>k+'=?').join(', ')+' WHERE id=?').run(...keys.map(k=>after[k]),row.id);
    }
    db.exec('COMMIT');done.push(...rows.filter(r=>r.path===location));
  }catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}}}
  catch(e){if(done.length)applyStateChanges(done,!reverse);throw e;}
}
