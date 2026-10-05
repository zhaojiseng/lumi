import type {Dashboard,StatisticsQuery} from '../../shared/types';

export interface DashboardScope {accountKey:string;query:StatisticsQuery;}
export interface DashboardState {scopeKey:string;queryKey:string;dashboard:Dashboard|null;loading:boolean;error:string;}
type DashboardReader=(query:StatisticsQuery,force:boolean)=>Promise<Dashboard>;
const emptyState=():DashboardState=>({scopeKey:'',queryKey:'',dashboard:null,loading:false,error:''});

/** Coalesce visible reads; account changes revoke data while range changes retain the last snapshot. */
export class DashboardResource {
  private scope:DashboardScope|null=null;
  private state=emptyState();
  private version=0;
  private pending:{version:number;force:boolean;promise:Promise<void>}|null=null;
  private listeners=new Set<()=>void>();
  constructor(private readonly read:DashboardReader) {}
  getState=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(state:DashboardState){
    if(Object.keys(state).every(key=>Object.is(state[key as keyof DashboardState],this.state[key as keyof DashboardState])))return;
    this.state=state;this.listeners.forEach(listener=>listener());
  }
  configure(scope:DashboardScope|null){
    const scopeKey=scope?.accountKey || '',queryKey=scope ? JSON.stringify(scope.query) : '';
    this.scope=scope;
    if(scopeKey===this.state.scopeKey && queryKey===this.state.queryKey)return;
    ++this.version;this.pending=null;
    this.publish({...emptyState(),scopeKey,queryKey,dashboard:scopeKey && scopeKey===this.state.scopeKey ? this.state.dashboard : null});
  }
  refresh=(force=false):Promise<void>=>{
    const scope=this.scope;
    if(!scope)return Promise.resolve();
    if(this.pending && (!force || this.pending.force))return this.pending.promise;
    const version=++this.version;
    this.publish({...this.state,loading:true,error:''});
    const promise=Promise.resolve().then(()=>version===this.version ? this.read(scope.query,force) : null).then(dashboard=>{
      if(dashboard && version===this.version)this.publish({...this.state,dashboard,loading:false,error:''});
    }).catch((error:unknown)=>{
      if(version===this.version)this.publish({...this.state,loading:false,error:error instanceof Error ? error.message : String(error)});
    }).finally(()=>{if(this.pending?.version===version)this.pending=null;});
    this.pending={version,force,promise};return promise;
  };
}
