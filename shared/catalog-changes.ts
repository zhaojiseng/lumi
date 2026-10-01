import type {ModelCatalog,ModelInfo,SiteStatus} from './types';

export const CATALOG_CHANGES_KEY = 'lumi.models.catalog-changes.v1';
export const CATALOG_CHANGES_EVENT = 'lumi:catalog-changes';
export const CATALOG_CHANGE_LABELS = {
  quota_type:'计费单位',model_ratio:'输入倍率',model_price:'按次价格',completion_ratio:'输出倍率',
  cache_ratio:'缓存读取倍率',create_cache_ratio:'缓存写入倍率',image_ratio:'图片倍率',
  audio_ratio:'音频输入倍率',audio_completion_ratio:'音频输出倍率',
  billing_mode:'计算方式',billing_expr:'计价表达式',billing_usage_schema:'计费用量定义',
  billing_plugin_variants:'插件计价规则',enable_groups:'可用渠道',group_ratio:'模型渠道倍率',
  groupRatio:'站点渠道倍率',usableGroups:'站点可用渠道',autoGroups:'自动路由渠道',
  quota_per_unit:'额度换算单位',currency:'价格币种与换算倍率',
} as const;
export type CatalogChangeField = keyof typeof CATALOG_CHANGE_LABELS;
const modelFields = ['quota_type','model_ratio','model_price','completion_ratio','cache_ratio','create_cache_ratio',
  'image_ratio','audio_ratio','audio_completion_ratio','billing_mode','billing_expr','billing_usage_schema',
  'billing_plugin_variants','enable_groups','group_ratio'] as const satisfies readonly CatalogChangeField[];
const catalogFields = ['groupRatio','usableGroups','autoGroups','quota_per_unit','currency'] as const satisfies readonly CatalogChangeField[];
type Fingerprints = Partial<Record<CatalogChangeField,string>>;
export interface CatalogSnapshot {
  fingerprint:string;
  models:{name:string;fingerprint:string;fields:Fingerprints}[];
  fields:Fingerprints;
}
export interface CatalogChange {
  kind:'added'|'removed'|'pricing'|'catalog';
  modelName?:string;
  fields:CatalogChangeField[];
}
export interface CatalogChangeEvent {id:string;detectedAt:number;read:boolean;changes:CatalogChange[];}
export interface CatalogChangeState {version:1;revision:number;baseline:CatalogSnapshot;events:CatalogChangeEvent[];}
export interface CatalogChangeStorage {getItem(key:string):string|null;setItem(key:string,value:string):void;}
export interface CatalogChangeSite {id:string;url:string;}
export interface CatalogChangeView {key:string;state:CatalogChangeState|null;persisted:boolean;pendingCount:number;}
export interface CatalogObserveOptions {
  storage?:CatalogChangeStorage|null;
  detectedAt?:number;
  /** Pass dashboard warnings so a failed pricing fetch cannot look like model removals. */
  warnings?:readonly string[];
}
const MAX_MODELS = 10000, MAX_EVENTS = 20, MAX_BYTES = 8 * 1024 * 1024;
const sessionViews=new Map<string,CatalogChangeView>();

/** Stable metadata checksum, not a secret store or a cryptographic signature. */
function fingerprint(value:unknown):string {
  const text=JSON.stringify(value);
  let a=0x811c9dc5,b=0x9e3779b9;
  for(let i=0;i<text.length;i++) {const c=text.charCodeAt(i);a=Math.imul(a^c,0x01000193);b=Math.imul(b^c,0x85ebca6b);}
  return (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');
}
function record(value:unknown):value is Record<string,unknown> {return !!value && typeof value==='object' && !Array.isArray(value);}
function scalar(value:unknown):string|number|boolean|null {
  return typeof value==='string' || typeof value==='boolean' ? value : typeof value==='number' && Number.isFinite(value) ? value : null;
}
function strings(value:unknown):string[] {
  return Array.isArray(value) ? [...new Set(value.filter((v):v is string=>typeof v==='string'))].sort() : [];
}
function ratios(value:unknown):[string,number][] {
  return record(value) ? Object.entries(value).filter((entry):entry is [string,number]=>typeof entry[1]==='number' && Number.isFinite(entry[1]) && entry[1]>=0).sort(([a],[b])=>a.localeCompare(b)) : [];
}
function schema(value:unknown):unknown {
  // Labels, descriptions and examples do not change how usage is billed.
  return record(value) ? Object.keys(value).sort().map(key=>{
    const field=record(value[key]) ? value[key] : {};
    return [key,scalar(field.type),scalar(field.unit),strings(field.enum)];
  }) : [];
}
function variants(value:unknown):unknown {
  return Array.isArray(value) ? value.filter(record).map(v=>({
    key:scalar(v.plugin_key),mode:scalar(v.billing_mode) || 'tiered_expr',
    expression:typeof v.billing_expr==='string' ? v.billing_expr.trim() : null,schema:schema(v.billing_usage_schema),
  })).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))) : [];
}
function modelValues(model:ModelInfo):Record<typeof modelFields[number],unknown> {
  return {
    quota_type:scalar(model.quota_type),model_ratio:scalar(model.model_ratio),model_price:scalar(model.model_price),
    completion_ratio:scalar(model.completion_ratio),cache_ratio:scalar(model.cache_ratio),
    create_cache_ratio:scalar(model.create_cache_ratio ?? model.cache_creation_ratio),image_ratio:scalar(model.image_ratio),
    audio_ratio:scalar(model.audio_ratio),audio_completion_ratio:scalar(model.audio_completion_ratio),
    billing_mode:scalar(model.billing_mode),billing_expr:typeof model.billing_expr==='string' ? model.billing_expr.trim() : null,
    billing_usage_schema:schema(model.billing_usage_schema),billing_plugin_variants:variants(model.billing_plugin_variants),
    enable_groups:strings(model.enable_groups),group_ratio:ratios(model.group_ratio),
  };
}
function fieldFingerprints(values:Partial<Record<CatalogChangeField,unknown>>,keys:readonly CatalogChangeField[]):Fingerprints {
  return Object.fromEntries(keys.map(key=>[key,fingerprint(values[key])]));
}
function modelFingerprint(name:string,fields:Fingerprints):string {return fingerprint([name,modelFields.map(key=>fields[key])]);}
function snapshotFingerprint(models:CatalogSnapshot['models'],fields:Fingerprints):string {
  return fingerprint([models.map(m=>[m.name,m.fingerprint]),catalogFields.map(key=>fields[key])]);
}

/** Compare published rules only: never evaluate a time-dependent expression here. */
export function createCatalogSnapshot(catalog:ModelCatalog,status:SiteStatus):CatalogSnapshot {
  const models=catalog.models.map(model=>{
    const fields=fieldFingerprints(modelValues(model),modelFields);
    return {name:model.model_name,fingerprint:modelFingerprint(model.model_name,fields),fields};
  }).sort((a,b)=>a.name.localeCompare(b.name));
  const type=status.quota_display_type || 'USD';
  const fields=fieldFingerprints({
    groupRatio:ratios(catalog.groupRatio),usableGroups:Object.keys(catalog.usableGroups).sort(),autoGroups:strings(catalog.autoGroups),
    quota_per_unit:scalar(status.quota_per_unit || 500000),
    currency:[type,type==='CUSTOM' ? scalar(status.custom_currency_exchange_rate ?? 1) : type==='CNY' ? scalar(status.usd_exchange_rate ?? 1) : 1,
      type==='CUSTOM' ? status.custom_currency_symbol || '¤' : null],
  },catalogFields);
  return {fingerprint:snapshotFingerprint(models,fields),models,fields};
}
function changedFields(before:Fingerprints,after:Fingerprints,keys:readonly CatalogChangeField[]):CatalogChangeField[] {
  return keys.filter(key=>before[key]!==after[key]);
}
export function diffCatalogSnapshots(before:CatalogSnapshot,after:CatalogSnapshot):CatalogChange[] {
  if(before.fingerprint===after.fingerprint)return [];
  const previous=new Map(before.models.map(model=>[model.name,model])),next=new Map(after.models.map(model=>[model.name,model]));
  const changes:CatalogChange[]=[];
  for(const model of after.models) {
    const old=previous.get(model.name);
    if(!old)changes.push({kind:'added',modelName:model.name,fields:[]});
    else if(old.fingerprint!==model.fingerprint)changes.push({kind:'pricing',modelName:model.name,fields:changedFields(old.fields,model.fields,modelFields)});
  }
  for(const model of before.models)if(!next.has(model.name))changes.push({kind:'removed',modelName:model.name,fields:[]});
  const fields=changedFields(before.fields,after.fields,catalogFields);
  if(fields.length)changes.push({kind:'catalog',fields});
  return changes;
}
export function advanceCatalogChanges(state:CatalogChangeState|null,snapshot:CatalogSnapshot,detectedAt=Date.now()):CatalogChangeState {
  if(!state)return {version:1,revision:0,baseline:snapshot,events:[]};
  const changes=diffCatalogSnapshots(state.baseline,snapshot);
  if(!changes.length)return state;
  const revision=state.revision+1;
  const event:CatalogChangeEvent={id:revision+':'+snapshot.fingerprint,detectedAt,read:false,changes};
  return {version:1,revision,baseline:snapshot,events:[event,...state.events].slice(0,MAX_EVENTS)};
}
export function markCatalogChangesRead(state:CatalogChangeState,eventIds=state.events.map(event=>event.id)):CatalogChangeState {
  const ids=new Set(eventIds);
  if(!state.events.some(event=>!event.read && ids.has(event.id)))return state;
  return {...state,events:state.events.map(event=>ids.has(event.id) ? {...event,read:true} : event)};
}
export function catalogChangesStorageKey(site:CatalogChangeSite):string {
  let url=site.url.trim();
  try {url=new URL(url).href;} catch {/* Invalid URLs still get their own isolated scope. */}
  // The key contains neither the URL (which may contain credentials) nor account data.
  return CATALOG_CHANGES_KEY+':'+fingerprint([site.id,url.replace(/\/+$/,'')]);
}
function hash(value:unknown):value is string {return typeof value==='string' && /^[a-f0-9]{16}$/.test(value);}
function readFields(value:unknown,keys:readonly CatalogChangeField[]):Fingerprints|null {
  if(!record(value) || Object.keys(value).length!==keys.length || !keys.every(key=>hash(value[key])))return null;
  return Object.fromEntries(keys.map(key=>[key,value[key]]));
}
function readSnapshot(value:unknown):CatalogSnapshot|null {
  if(!record(value) || !hash(value.fingerprint) || !Array.isArray(value.models) || value.models.length>MAX_MODELS)return null;
  const fields=readFields(value.fields,catalogFields);
  if(!fields)return null;
  const models:CatalogSnapshot['models']=[],names=new Set<string>();
  for(const model of value.models) {
    if(!record(model) || typeof model.name!=='string' || !model.name || model.name.length>500 || names.has(model.name))return null;
    const rules=readFields(model.fields,modelFields);
    if(!rules || model.fingerprint!==modelFingerprint(model.name,rules))return null;
    names.add(model.name);models.push({name:model.name,fingerprint:model.fingerprint as string,fields:rules});
  }
  models.sort((a,b)=>a.name.localeCompare(b.name));
  return value.fingerprint===snapshotFingerprint(models,fields) ? {fingerprint:value.fingerprint,models,fields} : null;
}
function readState(value:unknown):CatalogChangeState|null {
  if(!record(value) || value.version!==1 || !Number.isSafeInteger(value.revision) || (value.revision as number)<0 || !Array.isArray(value.events) || value.events.length>MAX_EVENTS)return null;
  const baseline=readSnapshot(value.baseline);
  if(!baseline)return null;
  const events:CatalogChangeEvent[]=[],ids=new Set<string>();
  for(const event of value.events) {
    if(!record(event) || typeof event.id!=='string' || !/^\d+:[a-f0-9]{16}$/.test(event.id) || ids.has(event.id)
      || typeof event.detectedAt!=='number' || !Number.isFinite(event.detectedAt) || event.detectedAt<0 || event.detectedAt>8640000000000000 || typeof event.read!=='boolean'
      || !Array.isArray(event.changes) || !event.changes.length || event.changes.length>MAX_MODELS*2+1)return null;
    const revision=Number(event.id.split(':')[0]);
    if(!Number.isSafeInteger(revision) || revision<=0 || revision>(value.revision as number))return null;
    const changes:CatalogChange[]=[];
    for(const change of event.changes) {
      if(!record(change) || !['added','removed','pricing','catalog'].includes(change.kind as string) || !Array.isArray(change.fields))return null;
      const kind=change.kind as CatalogChange['kind'],keys=kind==='catalog' ? catalogFields : modelFields;
      if(change.fields.some(key=>!(keys as readonly unknown[]).includes(key)) || new Set(change.fields).size!==change.fields.length)return null;
      if((kind==='added' || kind==='removed') ? change.fields.length!==0 : change.fields.length===0)return null;
      if(kind!=='catalog' && (typeof change.modelName!=='string' || !change.modelName || change.modelName.length>500))return null;
      changes.push({kind,...(kind==='catalog' ? {} : {modelName:change.modelName as string}),fields:change.fields as CatalogChangeField[]});
    }
    ids.add(event.id);events.push({id:event.id,detectedAt:event.detectedAt,read:event.read,changes});
  }
  // Reconstruct only our schema, dropping unexpected persisted properties.
  return {version:1,revision:value.revision as number,baseline,events};
}
export function readCatalogChanges(storage:CatalogChangeStorage|null,key:string):CatalogChangeState|null {
  try {
    const raw=storage?.getItem(key);
    return raw && raw.length<=MAX_BYTES ? readState(JSON.parse(raw)) : null;
  } catch {return null;}
}
export function writeCatalogChanges(storage:CatalogChangeStorage|null,key:string,state:CatalogChangeState):boolean {
  try {
    if(!storage)return false;
    const safe=readState(state);
    if(!safe)return false;
    const raw=JSON.stringify(safe);
    if(raw.length>MAX_BYTES)return false;
    storage.setItem(key,raw);return true;
  } catch {return false;}
}

function browserStorage():CatalogChangeStorage|null {try{return typeof window==='undefined' ? null : window.localStorage;}catch{return null;}}
function resolveStorage(options:CatalogObserveOptions):CatalogChangeStorage|null {
  return options.storage===undefined ? browserStorage() : options.storage;
}
function viewFor(key:string,state:CatalogChangeState|null,persisted:boolean):CatalogChangeView {
  return {key,state,persisted,pendingCount:state?.events.reduce((sum,event)=>sum+(event.read ? 0 : event.changes.length),0) || 0};
}
function remember(view:CatalogChangeView):void {
  sessionViews.delete(view.key);sessionViews.set(view.key,view);
  if(sessionViews.size>100)sessionViews.delete(sessionViews.keys().next().value!);
}
function notify(key:string):void {
  if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(CATALOG_CHANGES_EVENT,{detail:{key}}));
}
/** Read pending changes without observing a catalog or creating a baseline. */
export function getCatalogChanges(site:CatalogChangeSite,options:CatalogObserveOptions={}):CatalogChangeView {
  const key=catalogChangesStorageKey(site),storage=resolveStorage(options),cached=sessionViews.get(key),saved=readCatalogChanges(storage,key);
  const view=saved && (!cached || cached.persisted) ? viewFor(key,saved,true) : cached || viewFor(key,null,!!storage);
  if(view.state)remember(view);
  return view;
}
/** App-level entry: call for every successful catalog refresh, independent of the active page. */
export function observeCatalogChanges(site:CatalogChangeSite,catalog:ModelCatalog,status:SiteStatus,options:CatalogObserveOptions={}):CatalogChangeView {
  const previous=getCatalogChanges(site,options);
  if(options.warnings?.some(w=>w.startsWith('模型广场')))return previous;
  const state=advanceCatalogChanges(previous.state,createCatalogSnapshot(catalog,status),options.detectedAt);
  if(state===previous.state && previous.persisted)return previous;
  const view=viewFor(previous.key,state,writeCatalogChanges(resolveStorage(options),previous.key,state));
  remember(view);notify(view.key);
  return view;
}
/** Persist read status and notify Models/sidebar consumers; this never makes network requests. */
export function acknowledgeCatalogChanges(site:CatalogChangeSite,eventIds?:string[],options:CatalogObserveOptions={}):CatalogChangeView {
  const previous=getCatalogChanges(site,options);
  if(!previous.state)return previous;
  const state=markCatalogChangesRead(previous.state,eventIds);
  if(state===previous.state && previous.persisted)return previous;
  const view=viewFor(previous.key,state,writeCatalogChanges(resolveStorage(options),previous.key,state));
  remember(view);notify(view.key);
  return view;
}
/** Local CustomEvent updates plus localStorage updates from another renderer/window. */
export function subscribeCatalogChanges(site:CatalogChangeSite,listener:()=>void):()=>void {
  if(typeof window==='undefined')return()=>{};
  const key=catalogChangesStorageKey(site);
  const local=(event:Event)=>{if((event as CustomEvent<{key:string}>).detail?.key===key)listener();};
  const external=(event:StorageEvent)=>{
    if(event.storageArea!==browserStorage() || (event.key!==key && event.key!==null))return;
    sessionViews.delete(key);listener();
  };
  window.addEventListener(CATALOG_CHANGES_EVENT,local);window.addEventListener('storage',external);
  return()=>{window.removeEventListener(CATALOG_CHANGES_EVENT,local);window.removeEventListener('storage',external);};
}
