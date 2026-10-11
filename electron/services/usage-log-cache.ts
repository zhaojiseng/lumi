import type {UsageLog} from '../../shared/types';

export interface UsageWindow {start_timestamp:number;end_timestamp:number;}
export interface CachedUsageLogs {rows:UsageLog[];fetchedAt:number;revision:number;endTimestamp:number;}
interface Segment extends UsageWindow {rows:UsageLog[];fetchedAt:number;expires:number;live:boolean;}
interface ScopeCache {streams:Map<number,Segment[]>;pending:Promise<void>|null;revision:number;}
interface Piece extends UsageWindow {segment?:Segment;}
export const USAGE_LIVE_TTL=60000,USAGE_HISTORY_TTL=30*60000,USAGE_LOG_OVERLAP=300;

/** Private, process-local log snapshots. Keep rows once; callers publish only cloned pages or derived DTOs. */
export class UsageLogCache {
  private scopes=new Map<string,ScopeCache>();
  private revision=0;
  constructor(private now:()=>number=()=>Date.now(),private limit=8){}
  invalidate(prefix:string){for(const key of this.scopes.keys())if(key.startsWith(prefix))this.scopes.delete(key);}
  private assertCurrent(key:string,state:ScopeCache){
    if(this.scopes.get(key)!==state)throw new Error('用量缓存已失效，请重新同步。');
  }
  private plan(state:ScopeCache,type:number,window:UsageWindow):Piece[]{
    const now=this.now(),seconds=Math.floor(now/1000);
    const segments=[...(state.streams.get(type) || []),...(type===2 ? state.streams.get(0) || [] : [])]
      .filter(segment=>segment.expires>now).map(segment=>({segment,end:segment.live && segment.end_timestamp>=Math.floor(segment.fetchedAt/1000)-1 && window.end_timestamp>=seconds-1 ? window.end_timestamp : segment.end_timestamp}))
      .filter(({segment,end})=>segment.start_timestamp<=window.end_timestamp && end>=window.start_timestamp);
    const boundaries=[...new Set([window.start_timestamp,window.end_timestamp+1,...segments.flatMap(({segment,end})=>[Math.max(window.start_timestamp,segment.start_timestamp),Math.min(window.end_timestamp,end)+1])])].sort((a,b)=>a-b);
    const pieces:Piece[]=[];
    for(let i=0;i<boundaries.length-1;i++){
      const start=boundaries[i],end=boundaries[i+1]-1;
      const source=segments.filter(candidate=>candidate.segment.start_timestamp<=start && candidate.end>=end).sort((a,b)=>b.segment.fetchedAt-a.segment.fetchedAt)[0]?.segment;
      const previous=pieces.at(-1);
      if(previous && previous.segment===source)previous.end_timestamp=end;
      else pieces.push({start_timestamp:start,end_timestamp:end,segment:source});
    }
    return pieces;
  }
  private replace(segments:Segment[],window:UsageWindow,added:Segment[]):Segment[]{
    const retained:Segment[]=[];
    for(const segment of segments){
      if(segment.end_timestamp<window.start_timestamp || segment.start_timestamp>window.end_timestamp){retained.push(segment);continue;}
      if(segment.start_timestamp<window.start_timestamp)retained.push({...segment,end_timestamp:window.start_timestamp-1,rows:segment.rows.filter(row=>row.created_at<window.start_timestamp)});
      if(segment.end_timestamp>window.end_timestamp)retained.push({...segment,start_timestamp:window.end_timestamp+1,rows:segment.rows.filter(row=>row.created_at>window.end_timestamp)});
    }
    return [...retained,...added].sort((a,b)=>a.start_timestamp-b.start_timestamp);
  }
  private async fill(key:string,state:ScopeCache,type:number,window:UsageWindow,load:(window:UsageWindow)=>Promise<UsageLog[]>){
    // Stage all missing intervals before publishing. Failed pagination never yields a partial snapshot.
    const gaps=this.plan(state,type,window).filter(piece=>!piece.segment),added:Segment[]=[];
    for(const gap of gaps){
      this.assertCurrent(key,state);
      const rows=(await load({start_timestamp:gap.start_timestamp,end_timestamp:gap.end_timestamp})).filter(row=>row.created_at>=gap.start_timestamp && row.created_at<=gap.end_timestamp).sort((a,b)=>b.created_at-a.created_at || b.id-a.id);
      this.assertCurrent(key,state);
      const fetchedAt=this.now(),stableEnd=Math.min(gap.end_timestamp,Math.floor(fetchedAt/1000)-USAGE_LOG_OVERLAP-1);
      if(stableEnd>=gap.start_timestamp)added.push({...gap,end_timestamp:stableEnd,rows:rows.filter(row=>row.created_at<=stableEnd),fetchedAt,expires:fetchedAt+USAGE_HISTORY_TTL,live:false});
      if(stableEnd<gap.end_timestamp)added.push({...gap,start_timestamp:Math.max(gap.start_timestamp,stableEnd+1),rows:rows.filter(row=>row.created_at>stableEnd),fetchedAt,expires:fetchedAt+USAGE_LIVE_TTL,live:true});
    }
    this.assertCurrent(key,state);
    let segments=(state.streams.get(type) || []).filter(segment=>segment.expires>this.now());
    for(const gap of gaps)segments=this.replace(segments,gap,added.filter(segment=>segment.start_timestamp>=gap.start_timestamp && segment.end_timestamp<=gap.end_timestamp));
    state.streams.set(type,segments);
    if(type===0 && state.streams.has(2)){
      let consumed=state.streams.get(2)!;
      for(const gap of gaps)consumed=this.replace(consumed,gap,[]);
      state.streams.set(2,consumed);
    }
    if(gaps.length)state.revision=++this.revision;
  }
  async get(key:string,type:number,window:UsageWindow,load:(window:UsageWindow)=>Promise<UsageLog[]>):Promise<CachedUsageLogs>{
    const now=this.now();
    for(const cached of this.scopes.values())for(const [stream,segments] of cached.streams)cached.streams.set(stream,segments.filter(segment=>segment.expires>now));
    let state=this.scopes.get(key);
    if(!state){state={streams:new Map(),pending:null,revision:++this.revision};this.scopes.set(key,state);}
    this.scopes.delete(key);this.scopes.set(key,state);
    // Serialize range expansion for one account, including consumers of type-0 and type-2 logs.
    while(state.pending && this.plan(state,type,window).some(piece=>!piece.segment)){await state.pending;this.assertCurrent(key,state);}
    if(this.plan(state,type,window).some(piece=>!piece.segment)){
      const job=Promise.resolve().then(()=>this.fill(key,state!,type,window,load));state.pending=job;
      try{await job;}finally{if(state.pending===job)state.pending=null;}
    }
    this.assertCurrent(key,state);
    const pieces=this.plan(state,type,window),rows:UsageLog[]=[],ids=new Set<number>();
    // Newer intervals precede older ones so filtered request pages retain newest-first ordering.
    for(const piece of pieces.toReversed()){
      if(!piece.segment)throw new Error('用量缓存已过期，请重新同步。');
      for(const row of piece.segment.rows)if(row.created_at>=piece.start_timestamp && row.created_at<=piece.end_timestamp && (type!==2 || row.type===2)){
        if(ids.has(row.id))throw new Error('消费日志分页不完整，请重新加载曲线。');
        ids.add(row.id);rows.push(row);
      }
    }
    // Account eviction never truncates a requested series or an active read.
    for(const [scope,cached] of this.scopes){if(this.scopes.size<=this.limit)break;if(scope!==key && !cached.pending)this.scopes.delete(scope);}
    return {rows,revision:state.revision,fetchedAt:Math.max(...pieces.map(piece=>piece.segment!.fetchedAt)),endTimestamp:Math.min(window.end_timestamp,pieces.at(-1)!.segment!.end_timestamp)};
  }
}
