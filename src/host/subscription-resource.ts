import type {SubscriptionUsageSnapshot} from '../../shared/contracts/subscription-usage';
export class SubscriptionResource {
  private state:{snapshot:SubscriptionUsageSnapshot|null;loading:boolean;error:string}={snapshot:null,loading:false,error:''};
  private listeners=new Set<()=>void>();private generation=0;private pending?:{force:boolean;promise:Promise<void>};private active=false;
  constructor(private read:(input:{force?:boolean})=>Promise<SubscriptionUsageSnapshot>){}
  getState=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(state:typeof this.state){
    if(state.snapshot===this.state.snapshot && state.loading===this.state.loading && state.error===this.state.error)return;
    this.state=state;for(const listener of this.listeners)listener();
  }
  configure(active:boolean){if(this.active===active)return;this.active=active;this.generation++;this.pending=undefined;this.publish({snapshot:null,loading:false,error:''});}
  refresh=(force=false):Promise<void>=>{
    if(!this.active)return Promise.resolve();if(this.pending && (!force || this.pending.force))return this.pending.promise;
    const generation=++this.generation;this.publish({...this.state,loading:true,error:''});
    const request=Promise.resolve().then(()=>generation===this.generation && this.active ? this.read({force}) : null).then(snapshot=>{if(snapshot && generation===this.generation && this.active)this.publish({snapshot,loading:false,error:''});},()=>{if(generation===this.generation && this.active)this.publish({snapshot:null,loading:false,error:'无法读取 Codex 用量，请检查 CLI 安装、ChatGPT 登录和网络。'});}).finally(()=>{if(this.pending?.promise===request)this.pending=undefined;});
    this.pending={force,promise:request};return request;
  };
}
