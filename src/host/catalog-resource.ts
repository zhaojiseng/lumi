import type {CatalogSnapshot} from '../../shared/contracts/catalog';

export interface CatalogScope {accountKey:string;siteId:string;siteUrl:string}
export interface CatalogState {scopeKey:string;snapshot:CatalogSnapshot|null;loading:boolean;error:string}
export type CatalogReader=(input:{siteId:string;siteUrl:string;force?:boolean})=>Promise<CatalogSnapshot>;
export const catalogScopeKey=(scope:CatalogScope)=>JSON.stringify([scope.accountKey,scope.siteId,scope.siteUrl]);
const emptyState=():CatalogState=>({scopeKey:'',snapshot:null,loading:false,error:''});

/** One visible capability consumer; scope/version changes revoke ownership of pending reads. */
export class CatalogResource {
  private scope:CatalogScope|null=null;
  private version=0;
  private state=emptyState();
  private pending:{version:number;force:boolean;promise:Promise<void>}|null=null;
  private listeners=new Set<()=>void>();
  constructor(private readonly read:CatalogReader) {}
  getState=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(state:CatalogState){this.state=state;this.listeners.forEach(listener=>listener());}
  configure(scope:CatalogScope|null){
    const key=scope ? catalogScopeKey(scope) : '';
    if(key===this.state.scopeKey)return;
    this.scope=scope;this.version++;this.pending=null;
    this.publish({...emptyState(),scopeKey:key});
  }
  refresh=(force=false):Promise<void>=>{
    const scope=this.scope;
    if(!scope)return Promise.resolve();
    if(this.pending && (!force || this.pending.force))return this.pending.promise;
    const version=++this.version,key=catalogScopeKey(scope);
    this.publish({...this.state,loading:true,error:''});
    const promise=Promise.resolve().then(()=>{
      if(version!==this.version || key!==this.state.scopeKey)return null;
      return this.read({siteId:scope.siteId,siteUrl:scope.siteUrl,...force ? {force:true} : {}});
    }).then(snapshot=>{
      if(!snapshot || version!==this.version || key!==this.state.scopeKey)return;
      if(snapshot.siteId!==scope.siteId || snapshot.siteUrl!==scope.siteUrl)throw new Error('模型目录返回了不同的站点范围。');
      this.publish({scopeKey:key,snapshot,loading:false,error:''});
    }).catch((error:unknown)=>{
      if(version===this.version && key===this.state.scopeKey)this.publish({...this.state,loading:false,error:error instanceof Error ? error.message : String(error)});
    }).finally(()=>{if(this.pending?.version===version)this.pending=null;});
    this.pending={version,force,promise};return promise;
  };
}
