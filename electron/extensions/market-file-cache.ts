import {createHash} from 'node:crypto';

/** Process-local, bounded cache of bytes verified against immutable Git blob identities. */
export class MarketFileCache {
  private values=new Map<string,Buffer>();
  private pending=new Map<string,Promise<Buffer>>();
  private bytes=0;
  private closed=false;
  constructor(private byteLimit=16*1024*1024,private entryLimit=256){}
  async get(file:{sha:string;size:number},load:()=>Promise<Buffer>):Promise<Buffer>{
    if(this.closed)throw new Error('插件市场正在退出。');
    const key=file.sha+':'+file.size,cached=this.values.get(key);
    if(cached){this.values.delete(key);this.values.set(key,cached);return Buffer.from(cached);}
    const existing=this.pending.get(key);if(existing)return Buffer.from(await existing);
    const job=Promise.resolve().then(async()=>{
      if(this.closed)throw new Error('插件市场正在退出。');
      const value=Buffer.from(await load());
      if(this.closed)throw new Error('插件市场正在退出。');
      const digest=createHash('sha1').update('blob '+value.length+'\0').update(value).digest('hex');
      if(value.length!==file.size || digest!==file.sha)throw new Error('插件文件校验失败，请刷新市场后重试。');
      return value;
    });
    this.pending.set(key,job);
    try{
      const value=await job;
      if(!this.closed && value.length<=this.byteLimit && this.entryLimit>0){
        this.values.set(key,value);this.bytes+=value.length;
        while(this.bytes>this.byteLimit || this.values.size>this.entryLimit){
          const oldest=this.values.keys().next().value!;
          this.bytes-=this.values.get(oldest)!.length;this.values.delete(oldest);
        }
      }
      return Buffer.from(value);
    }finally{if(this.pending.get(key)===job)this.pending.delete(key);}
  }
  dispose(){this.closed=true;this.values.clear();this.pending.clear();this.bytes=0;}
}
