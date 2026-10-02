import type {WidgetUsage} from '../../shared/widget';
export interface WidgetSnapshot {phase:'idle'|'loading'|'ready'|'error';usage?:WidgetUsage;error?:string;}
/** One bounded account request per minute; hidden windows do not run a scheduler. */
export class WidgetService {
  private value:WidgetSnapshot={phase:'idle'};private key='';private bucket=-1;private fetched=-Infinity;
  private generation=0;private pending?:{key:string;generation:number;job:Promise<WidgetSnapshot>};
  constructor(private options:{identity():string;load():Promise<WidgetUsage>;changed?():void;now?():number;ttl?:number|(()=>number);minInterval?:number|(()=>number);}){}
  snapshot(){const key=this.options.identity();if(key!==this.key){this.generation++;this.key=key;this.value={phase:'idle'};this.bucket=-1;this.fetched=-Infinity;}return structuredClone(this.value);}
  async refresh(){
    const state=this.snapshot(),key=this.key,now=this.options.now?.() ?? Date.now(),bucket=Math.floor(now/60000);
    if(this.pending?.key===key && this.pending.generation===this.generation)return this.pending.job;
    const ttl=typeof this.options.ttl==='function' ? this.options.ttl() : this.options.ttl ?? 60000;
    const minInterval=typeof this.options.minInterval==='function' ? this.options.minInterval() : this.options.minInterval ?? 0;
    if(now-this.fetched<minInterval)return state;
    if(this.bucket===bucket && now-this.fetched<ttl)return state;
    const generation=++this.generation;this.value={...state,phase:'loading',error:undefined};this.options.changed?.();
    const job=(async()=>{await Promise.resolve();try{const usage=await this.options.load();if(this.options.identity()===key && generation===this.generation){this.value={phase:'ready',usage};this.bucket=bucket;this.fetched=now;}}catch{if(this.options.identity()===key && generation===this.generation){this.value={...state,phase:'error',error:'同步失败，保留上次结果'};this.bucket=bucket;this.fetched=now;}}finally{if(this.pending?.generation===generation)this.pending=undefined;this.options.changed?.();}return this.snapshot();})();
    this.pending={key,generation,job};return job;
  }
}
