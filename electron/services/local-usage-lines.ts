import {createReadStream} from 'node:fs';

export interface Counters {input:number;output:number;cache:number;write:number;}
export type AppendedLine={line:string;end:number;complete:boolean;discarded?:boolean};
export const LOCAL_RECORD_LIMIT=1024*1024;

/** Fixed byte snapshot, read-only, with bounded buffering even for huge non-usage lines. */
export async function* appendedLines(file:string,start:number,size?:number,bytes?:(count:number)=>void,skipPartial=false):AsyncGenerator<AppendedLine>{
  if(size!==undefined && start>=size)return;
  const stream=createReadStream(file,{flags:'r',start,...(size===undefined ? {} : {end:size-1}),highWaterMark:64*1024});
  let pending=Buffer.alloc(0),pendingStart=start,discarding=skipPartial;
  try{
    for await(const raw of stream){
      const chunk=Buffer.isBuffer(raw) ? raw : Buffer.from(raw);bytes?.(chunk.length);
      let data=pending.length ? Buffer.concat([pending,chunk]) : chunk;
      if(discarding){
        const end=data.indexOf(0x0a);
        if(end<0){pendingStart+=data.length;continue;}
        yield {line:'',end:pendingStart+end+1,complete:true,discarded:true};
        pendingStart+=end+1;data=data.subarray(end+1);discarding=false;
      }
      let from=0,index:number;
      while((index=data.indexOf(0x0a,from))>=0){
        const discarded=index-from>LOCAL_RECORD_LIMIT;
        yield {line:discarded ? '' : data.subarray(from,index).toString('utf8'),end:pendingStart+index+1,complete:true,...(discarded ? {discarded:true} : {})};
        from=index+1;
      }
      pending=data.subarray(from);pendingStart+=from;
      if(pending.length>LOCAL_RECORD_LIMIT){pendingStart+=pending.length;pending=Buffer.alloc(0);discarding=true;}
    }
    if(discarding)yield {line:'',end:pendingStart,complete:false,discarded:true};
    else if(pending.length)yield {line:pending.toString('utf8'),end:pendingStart+pending.length,complete:false};
  }finally{stream.destroy();}
}

export function codexDelta(current:Counters,previous:Counters,last?:Counters):Counters {
  if(current.input<previous.input || current.output<previous.output)return last || current;
  return {input:current.input-previous.input,output:current.output-previous.output,cache:Math.max(0,current.cache-previous.cache),write:Math.max(0,current.write-previous.write)};
}
