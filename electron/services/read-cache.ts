export class ReadCache {
  private values=new Map<string,{value:unknown;expires:number;}>();
  private pending=new Map<string,Promise<unknown>>();
  constructor(private now:()=>number=Date.now,private limit=256){}
  async get<T>(key:string,ttl:number,load:()=>Promise<T>):Promise<T>{
    const cached=this.values.get(key);
    if(cached && cached.expires>this.now()){this.values.delete(key);this.values.set(key,cached);return structuredClone(cached.value) as T;}
    if(cached)this.values.delete(key);
    const existing=this.pending.get(key);if(existing)return structuredClone(await existing) as T;
    const job=Promise.resolve().then(load);this.pending.set(key,job);
    try{
      const value=await job;
      if(this.pending.get(key)===job){this.values.set(key,{value:structuredClone(value),expires:this.now()+ttl});while(this.values.size>this.limit)this.values.delete(this.values.keys().next().value!);}
      return structuredClone(value);
    }finally{if(this.pending.get(key)===job)this.pending.delete(key);}
  }
  invalidate(prefix:string){for(const key of this.values.keys())if(key.startsWith(prefix))this.values.delete(key);for(const key of this.pending.keys())if(key.startsWith(prefix))this.pending.delete(key);}
}
