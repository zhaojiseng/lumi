import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdtemp,open,rm,type FileHandle} from 'node:fs/promises';
import {rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {resolveRange,statisticsFilters} from '../../shared/range';
import type {Tool,LocalSessionLoad,LocalSessionSnapshot,LocalSessionProgress,LocalSessionRecordsQuery,LocalSessionRecordsPage,LocalSessionContentQuery,LocalSessionContentPage,LocalSessionRawQuery,LocalSessionRawPage,LocalSessionRecord,LocalSessionMetadata} from '../../shared/types';
import {codexDelta,type Counters} from './local-usage-lines';
import {updateSessionMetadata,parseSessionEvent} from './local-session-parser';

const BLOCK=64*1024,PREVIEW_RECORD=8*1024*1024;
const changed=()=>new Error('会话文件已被修改，请重新打开。');
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const number=(value:unknown)=>typeof value==='number' && Number.isFinite(value) ? Math.max(0,value) : 0;
const counters=(u:any):Counters=>({input:number(u.input_tokens),output:number(u.output_tokens),cache:number(u.cached_input_tokens ?? u.cache_read_input_tokens),write:number(u.cache_creation_input_tokens)});
type Line={start:number;end:number;line?:string;complete:boolean;};
type Snapshot={id:string;dir:string;db:DatabaseSync;handle:FileHandle;file:string;tool:Tool;dev:number;ino:number;size:number;mtimeMs:number;metadata:LocalSessionMetadata;warnings:string[];total:number;eventTotal:number;at:number;busy:number;released:boolean;disposed?:boolean;};

/** Only one bounded record is decoded; arbitrarily large records still get an offset index. */
async function* indexedLines(handle:FileHandle,size:number,db:DatabaseSync,signal:AbortSignal,onBytes:(bytes:number)=>void):AsyncGenerator<Line>{
  const blockInsert=db.prepare('INSERT INTO blocks VALUES (?, ?, ?)');
  let start=0,offset=0,length=0,parts:Buffer[]=[];
    while(offset<size){
      if(signal.aborted)throw new Error('会话读取已取消。');
      const chunk=Buffer.alloc(Math.min(BLOCK,size-offset));let done=0;
      while(done<chunk.length){const read=await handle.read(chunk,done,chunk.length-done,offset+done);if(!read.bytesRead)throw changed();done+=read.bytesRead;}
      blockInsert.run(offset,chunk.length,hash(chunk));
      onBytes(offset+chunk.length);
      let from=0,index:number;
      while((index=chunk.indexOf(10,from))>=0){
        const piece=chunk.subarray(from,index);length+=piece.length;
        if(length<=PREVIEW_RECORD)parts.push(piece);else parts=[];
        const end=offset+index+1;
        yield {start,end,line:length<=PREVIEW_RECORD ? Buffer.concat(parts,length).toString('utf8') : undefined,complete:true};
        start=end;length=0;parts=[];from=index+1;
      }
      const piece=chunk.subarray(from);length+=piece.length;
      if(length<=PREVIEW_RECORD)parts.push(piece);else parts=[];
      offset+=chunk.length;
    }
    if(length)yield {start,end:size,line:length<=PREVIEW_RECORD ? Buffer.concat(parts,length).toString('utf8') : undefined,complete:false};
}

/** Disk stores usage and byte offsets only. Prompts/replies stay in the original read-only file. */
export class LocalSessionStore {
  private sessions=new Map<string,{file:string;tool:Tool;metadata:LocalSessionMetadata}>();
  private snapshots=new Map<string,Snapshot>();
  private jobs=new Map<string,AbortController>();
  private cancelled=new Set<string>();
  private closed=false;
  register(id:string,file:string,tool:Tool,metadata:LocalSessionMetadata={}){this.sessions.delete(id);this.sessions.set(id,{file,tool,metadata:{...metadata}});while(this.sessions.size>4000)this.sessions.delete(this.sessions.keys().next().value!);}
  async load(input:LocalSessionLoad,notify?:(value:LocalSessionProgress)=>void):Promise<LocalSessionSnapshot>{
    if(this.closed || this.cancelled.delete(input.requestId))throw new Error('会话读取已取消。');
    if(this.jobs.has(input.requestId))throw new Error('会话正在读取。');
    if(this.jobs.size>=2)throw new Error('正在读取其他会话，请稍后再试。');
    const entry=this.sessions.get(input.sessionId);if(!entry)throw new Error('会话尚未读取或已失效，请重新扫描。');
    const controller=new AbortController();this.jobs.set(input.requestId,controller);
    let snapshot:Snapshot|undefined,dir:string|undefined,handle:FileHandle|undefined,db:DatabaseSync|undefined;
    try{
      for(const [id,s] of this.snapshots)if(Date.now()-s.at>15*60000)this.releaseSnapshot(id);
      while(this.snapshots.size>=4)this.releaseSnapshot(this.snapshots.keys().next().value!);
      const info=await lstat(entry.file);if(!info.isFile() || info.isSymbolicLink())throw changed();
      handle=await open(entry.file,'r');const actual=await handle.stat();if(actual.dev!==info.dev || actual.ino!==info.ino || actual.size!==info.size)throw changed();
      dir=await mkdtemp(path.join(os.tmpdir(),'lumi-session-index-'));
      db=new DatabaseSync(path.join(dir,'index.sqlite'));db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;
        CREATE TABLE blocks (start INTEGER PRIMARY KEY, length INTEGER, digest TEXT);
        CREATE TABLE events (seq INTEGER PRIMARY KEY, start INTEGER, end INTEGER, kind TEXT, turnKey TEXT, messageKey TEXT, visible INTEGER DEFAULT 1);
        CREATE INDEX events_turn ON events(turnKey,seq); CREATE INDEX events_message ON events(messageKey,seq);
        CREATE TABLE calls (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, ts REAL, record TEXT, turnKey TEXT, messageKey TEXT, userSeq INTEGER, eventSeq INTEGER, output REAL, matched INTEGER);
        CREATE INDEX calls_match ON calls(matched,ts DESC,seq DESC);
        CREATE TABLE tools (id TEXT PRIMARY KEY, messageKey TEXT);
        CREATE TABLE links (seq INTEGER, messageKey TEXT, UNIQUE(seq,messageKey)); CREATE INDEX links_message ON links(messageKey,seq);
        CREATE TABLE content_blocks (messageKey TEXT, slot TEXT, seq INTEGER, blockIndex INTEGER, PRIMARY KEY(messageKey,slot)); CREATE INDEX blocks_event ON content_blocks(seq);`);
      snapshot={id:randomUUID(),dir,db,handle,file:entry.file,tool:entry.tool,dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,metadata:{...entry.metadata},warnings:[],total:0,eventTotal:0,at:Date.now(),busy:0,released:false};
      const window=resolveRange(input.query,new Date()),filters=statisticsFilters(input.query);
      const eventInsert=db.prepare('INSERT INTO events(seq,start,end,kind,turnKey,messageKey) VALUES (?,?,?,?,?,?)');
      const insert=db.prepare('INSERT INTO calls(id,ts,record,turnKey,messageKey,userSeq,eventSeq,output,matched) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record,output=excluded.output,matched=excluded.matched WHERE excluded.output>=calls.output');
      const find=db.prepare('SELECT record,matched FROM calls WHERE id=?');
      const link=db.prepare('INSERT OR IGNORE INTO links VALUES (?,?)'),toolPut=db.prepare('INSERT OR REPLACE INTO tools VALUES (?,?)'),toolGet=db.prepare('SELECT messageKey FROM tools WHERE id=?');
      const blockGet=db.prepare('SELECT seq FROM content_blocks WHERE messageKey=? AND slot=?'),blockPut=db.prepare('INSERT OR REPLACE INTO content_blocks VALUES (?,?,?,?)');
      let previous:Counters={input:0,output:0,cache:0,write:0},model='unknown',reasoning:string|undefined,signature='',turn='0',turnNumber=0,awaitingContext=false,userSeq=0,seq=0,bytesRead=0,lastReport=0,calls=0,malformed=0,oversized=0;
      let lastText:{seq:number;type:string;text:string;role:string;turn:string}|undefined;
      const report=(phase:'read'|'complete')=>{try{notify?.({requestId:input.requestId,phase,bytesRead,totalBytes:info.size,calls});}catch{/* Closed renderer. */}};
      report('read');
      db.exec('BEGIN');
      for await(const line of indexedLines(handle,info.size,db,controller.signal,read=>{bytesRead=read;if(Date.now()-lastReport>100){lastReport=Date.now();report('read');}})){
        if(controller.signal.aborted)throw new Error('会话读取已取消。');
        seq++;
        let event:any;
        try{if(line.line!==undefined)event=JSON.parse(line.line);}catch{malformed++;}
        if(!line.complete && !event)snapshot.warnings.push('文件末尾有尚未写完的记录，本次快照未解析，可查看原始内容。');
        const kind=typeof event?.type==='string' ? event.type.slice(0,120) : line.line===undefined ? 'oversized_record' : 'unparsed_record';
        let messageKey='';
        if(event){
          snapshot.metadata=updateSessionMetadata(entry.tool,event,snapshot.metadata);
          if(entry.tool==='codex'){
            if(event.type==='event_msg' && event.payload?.type==='task_started'){turn=String(event.payload.turn_id || 'implicit:'+ ++turnNumber).slice(0,200);awaitingContext=true;}
            if(event.type==='turn_context'){
              turn=typeof event.payload?.turn_id==='string' ? event.payload.turn_id.slice(0,200) : awaitingContext ? turn : 'implicit:'+ ++turnNumber;awaitingContext=false;
              model=typeof event.payload?.model==='string' ? event.payload.model.slice(0,200) : model;
              reasoning=event.payload?.effort ?? event.payload?.reasoning_effort;
            }
          }else{const messageId=event.message?.id ?? event.uuid;if(typeof messageId==='string' && event.type==='assistant')messageKey=hash(messageId);}
        }else if(line.line===undefined)oversized++;
        eventInsert.run(seq,line.start,line.end,kind,turn,messageKey);
        if(event){
          const parsed=parseSessionEvent(entry.tool,event,String(seq));
          // Canonical message and mirrored UI event often contain exactly the same text.
          if(entry.tool==='codex' && ['user','assistant'].includes(parsed.role) && parsed.text && !parsed.truncated && !parsed.toolCallId && !parsed.kind.includes('attachment')){
            const text=hash(parsed.text);
            if(lastText && seq-lastText.seq<8 && lastText.turn===turn && lastText.type!==kind && lastText.role===parsed.role && lastText.text===text){db.prepare('UPDATE events SET visible=0 WHERE seq=?').run(kind==='response_item' ? lastText.seq : seq);}
            lastText={seq,type:kind,text,role:parsed.role,turn};
          }
          if(parsed.role==='user' && !parsed.toolCallId)userSeq=seq;
          if(entry.tool==='claude'){
            const blocks=Array.isArray(event.message?.content) ? event.message.content : [];
            for(const block of blocks){
              if(block?.type==='tool_use' && typeof block.id==='string')toolPut.run(hash(block.id),messageKey);
              if(block?.type==='tool_result' && typeof block.tool_use_id==='string'){
                const owner=toolGet.get(hash(block.tool_use_id)) as {messageKey:string}|undefined;if(owner)link.run(seq,owner.messageKey);
              }
            }
            // A message ID can span independent thinking/text/tool blocks; dedupe each block separately.
            if(messageKey && event.type==='assistant'){
              const key=input.sessionId+':'+messageKey,old=find.get(key) as {record:string}|undefined;
              const previousOutput=old ? JSON.parse(old.record).outputTokens : 0,output=event.message?.usage ? number(event.message.usage.output_tokens) : previousOutput;
              const content=Array.isArray(event.message?.content) ? event.message.content : typeof event.message?.content==='string' ? [{type:'text',text:event.message.content}] : [];
              for(let index=0;index<content.length;index++){
                const block=content[index];
                // Missing producer identity is ambiguous: keep distinct content fragments, dedupe exact copies only.
                const identity=typeof block?.id==='string' ? 'id:'+hash(block.id) : typeof block?.index==='number' ? 'index:'+block.index : 'content:'+hash(JSON.stringify(block) ?? 'null');
                const slot=String(block?.type || 'unknown')+':'+identity;
                const older=blockGet.get(messageKey,slot) as {seq:number}|undefined;
                if(older && output<previousOutput)continue;
                blockPut.run(messageKey,slot,seq,index);
                if(older)db.prepare('UPDATE events SET visible=0 WHERE seq=? AND NOT EXISTS (SELECT 1 FROM content_blocks WHERE seq=?)').run(older.seq,older.seq);
              }
              if(content.length && !db.prepare('SELECT 1 FROM content_blocks WHERE seq=? LIMIT 1').get(seq))db.prepare('UPDATE events SET visible=0 WHERE seq=?').run(seq);
            }
          }
          let tokens:Counters|undefined,context=0,id=input.sessionId+':'+line.end,timestamp=Date.parse(event.timestamp)/1000,priorCall:{record:string;matched:number}|undefined;
          if(entry.tool==='codex' && event.type==='event_msg' && event.payload?.type==='token_count' && event.payload.info){
            const u=event.payload.info,total=u.total_token_usage ? counters(u.total_token_usage) : undefined,last=u.last_token_usage ? counters(u.last_token_usage) : undefined;
            if(total || last){
              const next=event.timestamp+'|'+JSON.stringify(total || last),delta=total ? codexDelta(total,previous,last) : last!;if(total)previous=total;
              if(next!==signature){tokens={...delta,input:Math.max(0,delta.input-delta.cache)};context=last?.input ?? delta.input;signature=next;model=typeof u.model==='string' ? u.model.slice(0,200) : model;reasoning=u.reasoning_effort ?? reasoning;}
            }
          }else if(entry.tool==='claude' && event.type==='assistant' && event.message?.usage && messageKey && !event.isApiErrorMessage){
            tokens=counters(event.message.usage);context=tokens.input+tokens.cache+tokens.write;model=typeof event.message.model==='string' ? event.message.model.slice(0,200) : 'unknown';id=input.sessionId+':'+messageKey;reasoning=event.message.reasoning_effort ?? event.reasoning_effort;
            priorCall=find.get(id) as {record:string;matched:number}|undefined;if(priorCall)timestamp=JSON.parse(priorCall.record).created_at;
          }
          if(tokens && Number.isFinite(timestamp) && tokens.input+tokens.output+tokens.cache+tokens.write>0){
            const record:LocalSessionRecord={id,created_at:timestamp,model,inputTokens:tokens.input,outputTokens:tokens.output,cacheReadTokens:tokens.cache,cacheWriteTokens:tokens.write,contextTokens:context,...typeof reasoning==='string' ? {reasoning:reasoning.slice(0,100)} : {}};
            const matched=timestamp>=window.start_timestamp && timestamp<window.end_timestamp+1 && !filters.tokenIds?.length && (!filters.models?.length || filters.models.includes(model));
            const result=insert.run(id,timestamp,JSON.stringify(record),turn,messageKey,userSeq,seq,tokens.output,matched ? 1 : 0);
            if(result.changes)calls+=(matched ? 1 : 0)-(priorCall?.matched || 0);
          }
        }
        if(seq%256===0 || Date.now()-lastReport>100){db.exec('COMMIT; BEGIN');lastReport=Date.now();report('read');await new Promise<void>(resolve=>setImmediate(resolve));}
      }
      db.exec('COMMIT');
      if(controller.signal.aborted || this.closed)throw new Error('会话读取已取消。');
      await this.validate(snapshot);
      if(malformed)snapshot.warnings.push(`${malformed} 条记录无法解析，可在会话内容中查看原始记录。`);
      if(oversized)snapshot.warnings.push(`${oversized} 条记录超过 8 MiB，保留完整字节索引，可分块查看原始内容。`);
      if(filters.tokenIds?.length)snapshot.warnings.push('本机会话没有 API 令牌标识，当前令牌筛选没有匹配调用。');
      calls=Number((db.prepare('SELECT count(*) AS n FROM calls WHERE matched=1').get() as {n:number}).n);
      const eventTotal=Number((db.prepare('SELECT count(*) AS n FROM events WHERE visible=1').get() as {n:number}).n);
      snapshot.total=calls;snapshot.eventTotal=eventTotal;
      bytesRead=info.size;this.snapshots.set(snapshot.id,snapshot);report('complete');
      return {snapshotId:snapshot.id,metadata:snapshot.metadata,total:calls,eventTotal,totalBytes:info.size,warnings:snapshot.warnings};
    }catch(error){
      db?.close();await handle?.close();if(dir)await this.removeDirectory(dir);throw error;
    }finally{this.jobs.delete(input.requestId);}
  }
  private async removeDirectory(dir:string){if(path.dirname(dir)!==os.tmpdir() || !path.basename(dir).startsWith('lumi-session-index-'))throw new Error('会话索引目录无效。');await rm(dir,{recursive:true,force:true});}
  private get(id:string){const snapshot=this.snapshots.get(id);if(!snapshot || snapshot.released || Date.now()-snapshot.at>15*60000){if(snapshot)this.releaseSnapshot(id);throw new Error('会话详情已失效，请重新打开。');}snapshot.at=Date.now();return snapshot;}
  private async checked<T>(id:string,action:(s:Snapshot)=>Promise<T>):Promise<T>{const s=this.get(id);s.busy++;try{await this.validate(s);return await action(s);}finally{s.busy--;if(s.released && !s.busy)this.dispose(s);}}
  private async readBytes(s:Snapshot,start:number,end:number){
    const buffer=Buffer.alloc(Math.max(0,end-start));let done=0;
    while(done<buffer.length){const result=await s.handle.read(buffer,done,buffer.length-done,start+done);if(!result.bytesRead)throw changed();done+=result.bytesRead;}return buffer;
  }
  private async validateBlocks(s:Snapshot,start:number,end:number){
    const rows=s.db.prepare('SELECT start,length,digest FROM blocks WHERE start<? AND start+length>? ORDER BY start').all(end,start) as {start:number;length:number;digest:string}[];
    for(const row of rows)if(hash(await this.readBytes(s,row.start,row.start+row.length))!==row.digest)throw changed();
  }
  private async validate(s:Snapshot){
    const info=await lstat(s.file),held=await s.handle.stat();
    if(info.isSymbolicLink() || !info.isFile() || info.dev!==s.dev || info.ino!==s.ino || held.dev!==s.dev || held.ino!==s.ino || info.size<s.size || info.size===s.size && info.mtimeMs!==s.mtimeMs)throw changed();
    await this.validateBlocks(s,0,Math.min(BLOCK,s.size));if(s.size>BLOCK)await this.validateBlocks(s,s.size-BLOCK,s.size);
  }
  records(input:LocalSessionRecordsQuery):Promise<LocalSessionRecordsPage>{return this.checked(input.snapshotId,async s=>{
    const total=s.total,pageSize=Math.min(50,Math.max(1,input.pageSize)),page=Math.max(1,input.page);
    const rows=s.db.prepare('SELECT c.record,e.start,e.end FROM calls c JOIN events e ON e.seq=c.eventSeq WHERE c.matched=1 ORDER BY c.ts DESC,c.seq DESC LIMIT ? OFFSET ?').all(pageSize,(page-1)*pageSize) as {record:string;start:number;end:number}[];
    const ranges=rows.slice().sort((a,b)=>a.start-b.start);let start=-1,end=-1;
    for(const row of ranges){if(start<0){start=row.start;end=row.end;}else if(row.start<=end+BLOCK)end=Math.max(end,row.end);else{await this.validateBlocks(s,start,end);start=row.start;end=row.end;}}if(start>=0)await this.validateBlocks(s,start,end);
    return {items:rows.map(row=>JSON.parse(row.record)),total,page,pageSize};
  });}
  content(input:LocalSessionContentQuery):Promise<LocalSessionContentPage>{return this.checked(input.snapshotId,async s=>{
    let where='visible=1',args:(string|number)[]=[],association:LocalSessionContentPage['association']='session';
    if(input.recordId){
      const call=s.db.prepare('SELECT turnKey,messageKey,userSeq,eventSeq FROM calls WHERE id=? AND matched=1').get(input.recordId) as {turnKey:string;messageKey:string;userSeq:number;eventSeq:number}|undefined;
      if(!call)throw new Error('调用记录已失效。');
      association=s.tool==='codex' ? call.turnKey==='0' ? 'unavailable' : 'turn' : 'message';
      if(association==='unavailable')where+=' AND 0';
      else if(s.tool==='codex'){where+=' AND (turnKey=? OR seq=?)';args=[call.turnKey,call.userSeq];}
      else{where+=' AND (messageKey=? OR seq=? OR seq IN (SELECT seq FROM links WHERE messageKey=?) OR (seq>? AND seq<? AND seq IN (SELECT seq FROM links)))';args=[call.messageKey,call.userSeq,call.messageKey,call.userSeq,call.eventSeq];}
    }
    const total=input.recordId ? Number((s.db.prepare('SELECT count(*) AS n FROM events WHERE '+where).get(...args) as {n:number}).n) : s.eventTotal,pageSize=Math.min(20,Math.max(1,input.pageSize)),page=Math.max(1,input.page);
    const rows=s.db.prepare('SELECT seq,start,end,kind FROM events WHERE '+where+' ORDER BY seq LIMIT ? OFFSET ?').all(...args,pageSize,(page-1)*pageSize) as {seq:number;start:number;end:number;kind:string}[];
    const items=[];
    for(const row of rows){
      const id=String(row.seq),rawBytes=row.end-row.start;
      if(rawBytes>PREVIEW_RECORD+1){items.push({id,role:'event' as const,kind:row.kind,text:'此记录较大，请分块查看原始内容。',details:[],truncated:true,rawBytes});continue;}
      await this.validateBlocks(s,row.start,row.end);const raw=(await this.readBytes(s,row.start,row.end)).toString('utf8');
      try{
        const event=JSON.parse(raw);
        if(s.tool==='claude' && event.type==='assistant' && event.message?.content){
          const active=s.db.prepare('SELECT blockIndex FROM content_blocks WHERE seq=?').all(row.seq) as {blockIndex:number}[];
          if(Array.isArray(event.message.content))event.message.content=active.map(block=>event.message.content[block.blockIndex]);
        }
        items.push({...parseSessionEvent(s.tool,event,id),rawBytes});
      }catch{
        const preview=Buffer.from(raw.slice(0,32768));let end=Math.min(32768,preview.length);while(end>0 && end<preview.length && (preview[end]&0xc0)===0x80)end--;
        items.push({id,role:'event' as const,kind:row.kind,text:preview.subarray(0,end).toString('utf8'),details:[],truncated:rawBytes>32768,rawBytes});
      }
    }
    return {items,total,page,pageSize,association};
  });}
  raw(input:LocalSessionRawQuery):Promise<LocalSessionRawPage>{return this.checked(input.snapshotId,async s=>{
    const row=s.db.prepare('SELECT start,end FROM events WHERE seq=?').get(input.eventId) as {start:number;end:number}|undefined;if(!row)throw new Error('会话记录不存在。');
    const totalBytes=row.end-row.start,offset=Math.max(0,input.offset);if(offset>totalBytes)throw new Error('原始记录位置无效。');
    const end=Math.min(row.end,row.start+offset+BLOCK);await this.validateBlocks(s,row.start+offset,end);
    let buffer=await this.readBytes(s,row.start+offset,end);
    // Keep a multi-byte UTF-8 character whole across raw pages.
    if(end<row.end && buffer.length){let lead=buffer.length-1;while(lead>=0 && (buffer[lead]&0xc0)===0x80)lead--;if(lead>=0){const byte=buffer[lead],width=byte>=0xf0 ? 4 : byte>=0xe0 ? 3 : byte>=0xc0 ? 2 : 1;if(buffer.length-lead<width)buffer=buffer.subarray(0,lead);}}
    const next=offset+buffer.length;return {text:buffer.toString('utf8'),offset,totalBytes,...next<totalBytes ? {nextOffset:next} : {}};
  });}
  release(input:{requestId?:string;snapshotId?:string}){
    if(input.requestId){const job=this.jobs.get(input.requestId);if(job)job.abort();else{this.cancelled.add(input.requestId);while(this.cancelled.size>128)this.cancelled.delete(this.cancelled.values().next().value!);}}
    if(input.snapshotId)this.releaseSnapshot(input.snapshotId);
  }
  private releaseSnapshot(id:string){const s=this.snapshots.get(id);if(!s)return;this.snapshots.delete(id);s.released=true;if(!s.busy)this.dispose(s);}
  private dispose(s:Snapshot){if(s.disposed)return;s.disposed=true;s.db.close();void s.handle.close().catch(()=>undefined);if(path.dirname(s.dir)===os.tmpdir() && path.basename(s.dir).startsWith('lumi-session-index-'))try{rmSync(s.dir,{recursive:true,force:true});}catch{void this.removeDirectory(s.dir).catch(()=>undefined);}}
  close(){this.closed=true;for(const job of this.jobs.values())job.abort();for(const id of this.snapshots.keys())this.releaseSnapshot(id);}
}
