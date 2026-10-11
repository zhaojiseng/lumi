import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,lstat,unlink,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parse as parseToml} from 'smol-toml';
import type {Cipher} from './store';
import type {GatewayCliPreviewDto,GatewayCliResultDto,GatewayInputMap,GatewayOwner} from '../../shared/contracts/gateway';
import {parseGatewayInput,parseGatewayOutput} from '../../shared/gateway-validation';

type Tool='codex'|'claude-code';
type PreviewInput=GatewayInputMap['gateway.cliConfig.preview'];
type CommitInput=GatewayInputMap['gateway.cliConfig.apply'];
type Primitive=string|boolean;
interface Snapshot {name:'config'|'auth';path:string;content:string|null;}
interface FieldValue {present:boolean;value?:Primitive;}
interface FieldPatch {path:string[];before:FieldValue;after:FieldValue;}
interface StoredTransaction {
  version:1;id:string;ownerId:string;generation:number;view:string;
  tool:Tool;input:PreviewInput;expiresAtMs:number;targetFingerprint:string;
  previewFingerprint:string;resultFingerprint:string;state:'preview'|'applying'|'applied'|'restoring'|'restored'|'failed';
  before:Snapshot[];after:Snapshot[];patches:FieldPatch[];envExisted:boolean;conflicts:string[];
}
/** A trusted main-process resolver supplies the fixed route and its local credential. */
export interface GatewayCliTarget {
  baseUrl:string;authToken:string;sessionFingerprint:string;protocol:'openai'|'anthropic';
}
export interface GatewayCliConfigOptions {
  homeDir?:string;
  environment?:()=>{CODEX_HOME?:string;CLAUDE_CONFIG_DIR?:string};
  resolveTarget:(input:PreviewInput,owner:GatewayOwner)=>Promise<GatewayCliTarget>;
  assertContext:(input:PreviewInput,owner:GatewayOwner)=>Promise<void>;
  isToolRunning:(tool:Tool)=>Promise<boolean>;
  /** Inject the existing store.atomicWrite. No renderer-controlled writer or path. */
  atomicWrite:(file:string,content:string)=>Promise<void>;
  now?:()=>number;
}
const MAX_CONFIG_BYTES=8*1024*1024;
const MAX_BACKUP_BYTES=64*1024*1024;
const TTL_MS=5*60*1000;
const own=(object:object,key:string)=>Object.prototype.hasOwnProperty.call(object,key);
const object=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value);
const idPattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentDigest=(value:string|null)=>digest({present:value!==null,content:value});
function field(doc:Record<string,unknown>,parts:string[]):FieldValue {
  let current:unknown=doc;
  for(const key of parts) {
    if(!object(current) || !own(current,key))return {present:false};
    current=current[key];
  }
  if(typeof current!=='string' && typeof current!=='boolean')throw new Error('受管入口或认证字段类型不兼容。');
  return {present:true,value:current};
}
function sameField(a:FieldValue,b:FieldValue) {return a.present===b.present && (!a.present || a.value===b.value);}
function assign(doc:Record<string,unknown>,parts:string[],value:FieldValue) {
  let current=doc;
  for(const key of parts.slice(0,-1)) {
    if(!own(current,key))Object.defineProperty(current,key,{value:{},enumerable:true,configurable:true,writable:true});
    if(!object(current[key]))throw new Error('受管配置结构不兼容。');
    current=current[key] as Record<string,unknown>;
  }
  const key=parts.at(-1)!;
  if(value.present)Object.defineProperty(current,key,{value:value.value,enumerable:true,configurable:true,writable:true});
  else delete current[key];
}
/** JSON.parse validates grammar; this additional scan rejects duplicate keys at every depth. */
function uniqueJsonKeys(text:string) {
  let offset=0;
  const skip=()=>{while(/\s/.test(text[offset]??'') && offset<text.length)offset++;};
  const quoted=()=>{const start=offset++;while(offset<text.length){if(text[offset]==='\\'){offset+=2;continue;}if(text[offset++]==='"')break;}return JSON.parse(text.slice(start,offset)) as string;};
  const value=():void=>{
    skip();
    if(text[offset]==='"'){quoted();return;}
    if(text[offset]==='{'){
      offset++;skip();const keys=new Set<string>();if(text[offset]==='}'){offset++;return;}
      while(offset<text.length){skip();const key=quoted();if(keys.has(key))throw new Error('配置 JSON 包含重复字段。');keys.add(key);skip();offset++;value();skip();if(text[offset++]==='}')return;}
    }else if(text[offset]==='['){
      offset++;skip();if(text[offset]===']'){offset++;return;}
      while(offset<text.length){value();skip();if(text[offset++]===']')return;}
    }else {while(offset<text.length && !/[\s,}\]]/.test(text[offset]))offset++;}
  };
  value();
}
function document(tool:Tool,content:string|null):Record<string,unknown> {
  if(!content?.trim())return {};
  try {
    const result:unknown=tool==='codex'?parseToml(content):JSON.parse(content);
    if(!object(result))throw new Error();
    if(tool==='claude-code')uniqueJsonKeys(content);
    return result;
  }catch {throw new Error('CLI 配置无法安全解析，请先修复 TOML / JSON 语法。');}
}
function probePath(value:unknown,parts:string[]=[]):string[]|null {
  if(!object(value))return null;
  if(own(value,'__lumi_gateway_probe__'))return parts;
  for(const [key,child] of Object.entries(value)){const result=probePath(child,[...parts,key]);if(result)return result;}
  return null;
}
function headerPath(line:string):string[]|null {
  if(!/^\s*\[[^\n]*\]\s*(?:#.*)?$/.test(line))return null;
  try {return probePath(parseToml(line+'\n__lumi_gateway_probe__ = true\n'));}catch{return null;}
}
function commentSuffix(value:string) {
  let quote='',escaped=false;
  for(let n=0;n<value.length;n++){
    const c=value[n];
    if(quote==='"' && escaped){escaped=false;continue;}
    if(quote==='"' && c==='\\'){escaped=true;continue;}
    if(quote){if(c===quote)quote='';continue;}
    if(c==='"'||c==="'"){quote=c;continue;}
    if(c==='#')return ' '+value.slice(n);
  }
  return '';
}
/** Managed Codex fields must have a conventional explicit provider table. Other bytes stay intact. */
function patchToml(content:string,table:string[],patches:FieldPatch[],direction:'before'|'after'):string {
  const newline=content.includes('\r\n')?'\r\n':'\n';
  const ending=content.endsWith('\n');
  let lines=content.split(/\r?\n/);if(ending)lines.pop();
  for(const patch of patches){
    const start=lines.findIndex(line=>JSON.stringify(headerPath(line))===JSON.stringify(table));
    if(start<0)throw new Error('仅支持显式 model_providers 表；未改动已有配置。');
    let end=start+1;while(end<lines.length && headerPath(lines[end])===null)end++;
    const key=patch.path.at(-1)!;
    let index=-1,prefix='',suffix='';
    for(let n=start+1;n<end;n++){
      const match=/^(\s*(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')\s*=\s*)(.*)$/.exec(lines[n]);
      if(!match)continue;
      try {
        const parsed=parseToml(lines[n]);const names=Object.keys(parsed);
        if(names.length!==1 || names[0]!==key)continue;
        if(index>=0)throw new Error();
        index=n;prefix=match[1];suffix=commentSuffix(match[2]);
      }catch {if(lines[n].trimStart().startsWith(key))throw new Error('受管字段必须为单行 TOML 标量。');}
    }
    const desired=patch[direction];
    if(index>=0){if(desired.present)lines[index]=prefix+(typeof desired.value==='boolean'?String(desired.value):JSON.stringify(desired.value))+suffix;else lines.splice(index,1);}
    else if(desired.present){lines.splice(end,0,key+' = '+(typeof desired.value==='boolean'?String(desired.value):JSON.stringify(desired.value)));}
  }
  const result=lines.join(newline)+(ending?newline:'');
  document('codex',result);
  return result;
}
function patchConfig(tool:Tool,current:string|null,patches:FieldPatch[],direction:'before'|'after',envExisted:boolean):string {
  if(tool==='codex')return patchToml(current??'',patches[0].path.slice(0,-1),patches,direction);
  const doc=document(tool,current);
  for(const patch of patches)assign(doc,patch.path,patch[direction]);
  if(direction==='before' && !envExisted && object(doc.env) && Object.keys(doc.env).length===0)delete doc.env;
  return JSON.stringify(doc,null,2)+'\n';
}
function safeBefore(patch:FieldPatch):string {
  if(!patch.before.present)return '未设置';
  const leaf=patch.path.at(-1);
  if(leaf==='base_url' || leaf==='ANTHROPIC_BASE_URL'){
    try {const url=new URL(String(patch.before.value));return url.origin+(url.pathname==='/'?'':url.pathname==='/v1'?'/v1':'/…');}catch{return '已设置（隐藏）';}
  }
  if(leaf==='requires_openai_auth')return patch.before.value===true?'启用':'关闭';
  return '已设置（隐藏）';
}
function differences(patches:FieldPatch[]) {
  return patches.filter(patch=>!sameField(patch.before,patch.after)).map(patch=>{
    const leaf=patch.path.at(-1)!;
    return {label:leaf,before:safeBefore(patch),after:!patch.after.present?'移除':
      leaf==='base_url'||leaf==='ANTHROPIC_BASE_URL'?String(patch.after.value):
      leaf==='requires_openai_auth'?'关闭':'本地认证（隐藏）'};
  });
}
function validateTarget(target:GatewayCliTarget,tool:Tool) {
  let url:URL;try{url=new URL(target.baseUrl);}catch{throw new Error('本地网关入口无效。');}
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const ipv4=/^127(?:\.\d{1,3}){3}$/.test(host)&&host.split('.').every(n=>Number(n)<=255);
  if(url.protocol!=='http:' || !(ipv4||host==='::1') || !url.port || url.username || url.password || url.search || url.hash
    || target.protocol!==(tool==='codex'?'openai':'anthropic') || typeof target.authToken!=='string'
    || target.authToken.length<16 || target.authToken.length>8192 || /[\u0000-\u001f\u007f]/.test(target.authToken)
    || !idPattern.test(target.sessionFingerprint))throw new Error('本地网关入口或认证状态无效。');
}
function snapshotFingerprint(snapshots:Snapshot[],transaction:Pick<StoredTransaction,'ownerId'|'tool'|'input'|'targetFingerprint'>) {
  return digest({ownerId:transaction.ownerId,tool:transaction.tool,input:transaction.input,target:transaction.targetFingerprint,
    files:snapshots.map(file=>({name:file.name,path:file.path,hash:contentDigest(file.content)}))});
}

/** Fixed CLI entry/auth transactions. Never edits models, tiers, profiles, prompts, or auth.json. */
export class GatewayCliConfigService {
  private busy=false;
  private readonly homeDir:string;
  private readonly environment:NonNullable<GatewayCliConfigOptions['environment']>;
  private readonly now:()=>number;
  constructor(private readonly cipher:Cipher,private readonly dataDir:string,private readonly options:GatewayCliConfigOptions) {
    if(!path.isAbsolute(dataDir))throw new Error('网关备份目录必须由主程序提供。');
    this.homeDir=options.homeDir||process.env.LUMI_TEST_HOME||os.homedir();
    this.environment=options.environment??(options.homeDir||process.env.LUMI_TEST_HOME?()=>({}):()=>({CODEX_HOME:process.env.CODEX_HOME,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR}));
    this.now=options.now??Date.now;
  }
  private checkOwner(owner:GatewayOwner) {
    if(!idPattern.test(owner.id) || !Number.isSafeInteger(owner.generation)||owner.generation<0||!owner.view||owner.signal.aborted)throw new Error('插件实例已失效。');
  }
  private requireCipher() {if(!this.cipher.available())throw new Error('系统加密不可用，无法安全备份 CLI 配置。');}
  private paths(tool:Tool):Snapshot[] {
    const env=this.environment();
    const base=tool==='codex'?(env.CODEX_HOME?path.resolve(env.CODEX_HOME):path.join(this.homeDir,'.codex')):
      (env.CLAUDE_CONFIG_DIR?path.resolve(env.CLAUDE_CONFIG_DIR):path.join(this.homeDir,'.claude'));
    return tool==='codex'?[{name:'config',path:path.join(base,'config.toml'),content:null},{name:'auth',path:path.join(base,'auth.json'),content:null}]:
      [{name:'config',path:path.join(base,'settings.json'),content:null}];
  }
  private async readOptional(file:string,max=MAX_CONFIG_BYTES):Promise<string|null> {
    try {const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>max)throw new Error('配置文件类型或大小不受支持。');const text=await readFile(file,'utf8');if(Buffer.byteLength(text,'utf8')>max)throw new Error('配置文件过大。');return text;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('CLI 配置文件无法安全读取。');}
  }
  private async snapshots(tool:Tool):Promise<Snapshot[]> {return Promise.all(this.paths(tool).map(async file=>({...file,content:await this.readOptional(file.path)})));}
  private backupPath(id:string) {if(!idPattern.test(id))throw new Error('无效事务 ID。');return path.join(this.dataDir,'gateway-cli-transactions',id+'.json');}
  private async persist(record:StoredTransaction) {
    this.requireCipher();
    try {
      await mkdir(path.join(this.dataDir,'gateway-cli-transactions'),{recursive:true});
      const encrypted=this.cipher.encrypt(JSON.stringify(record));
      await this.options.atomicWrite(this.backupPath(record.id),JSON.stringify({version:1,encrypted}));
    }catch{throw new Error('加密 CLI 事务无法保存；未使用明文备份。');}
  }
  private async read(id:string):Promise<StoredTransaction> {
    this.requireCipher();
    const text=await this.readOptional(this.backupPath(id),MAX_BACKUP_BYTES);if(text===null)throw new Error('事务不存在，请重新预览。');
    try {
      const envelope=JSON.parse(text);if(envelope.version!==1||typeof envelope.encrypted!=='string')throw new Error();
      const record=JSON.parse(this.cipher.decrypt(envelope.encrypted)) as StoredTransaction;
      if(record.version!==1 || record.id!==id || !idPattern.test(record.ownerId) || !['codex','claude-code'].includes(record.tool)
        || !['preview','applying','applied','restoring','restored','failed'].includes(record.state)
        || !Array.isArray(record.before)||!Array.isArray(record.after)||!Array.isArray(record.patches)||record.patches.length>4
        || record.before.length!==record.after.length || typeof record.envExisted!=='boolean'
        || !Array.isArray(record.conflicts)||!Number.isSafeInteger(record.expiresAtMs)
        || !Number.isSafeInteger(record.generation)||record.generation<0||typeof record.view!=='string'||!record.view
        || record.input?.tool!==record.tool||![record.previewFingerprint,record.resultFingerprint,record.targetFingerprint].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))
        || [...record.before,...record.after].some(file=>file.content!==null&&(typeof file.content!=='string'||Buffer.byteLength(file.content,'utf8')>MAX_CONFIG_BYTES)))throw new Error();
      parseGatewayInput('gateway.cliConfig.preview',record.input);
      const allowed=this.paths(record.tool);
      if(record.before.length!==allowed.length || record.before.some((file,n)=>file.path!==allowed[n].path||file.name!==allowed[n].name||record.after[n].path!==file.path||record.after[n].name!==file.name))throw new Error();
      for(const patch of record.patches){
        const names=record.tool==='codex'?['base_url','experimental_bearer_token','requires_openai_auth','env_key']:
          ['ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN'];
        if(!Array.isArray(patch.path) || !names.includes(patch.path.at(-1)!)
          || (record.tool==='codex'?(patch.path.length!==3||patch.path[0]!=='model_providers'||!idPattern.test(patch.path[1])):(patch.path.length!==2||patch.path[0]!=='env'))
          || ![patch.before,patch.after].every(value=>object(value)&&typeof value.present==='boolean'&&(!value.present||typeof value.value==='string'||typeof value.value==='boolean')))throw new Error();
      }
      if(new Set(record.patches.map(patch=>JSON.stringify(patch.path))).size!==record.patches.length)throw new Error();
      return record;
    }catch{throw new Error('加密事务记录无效或工具目录已变更。');}
  }
  private async ensureFresh(record:StoredTransaction,owner:GatewayOwner) {
    this.checkOwner(owner);
    if(record.ownerId!==owner.id||record.generation!==owner.generation||record.view!==owner.view)throw new Error('预览所属插件实例已变更，请重新预览。');
    if(record.expiresAtMs<this.now())throw new Error('预览已过期，请重新预览。');
    await this.options.assertContext(record.input,owner);
    const target=await this.options.resolveTarget(record.input,owner);validateTarget(target,record.tool);
    if(digest(target)!==record.targetFingerprint)throw new Error('网关会话、入口或认证已变更，请重新预览。');
    if(await this.options.isToolRunning(record.tool))throw new Error('CLI 正在运行，请关闭后重新应用。');
    this.checkOwner(owner);
  }
  private async ensureSnapshots(expected:Snapshot[]) {
    for(const file of expected)if(contentDigest(await this.readOptional(file.path))!==contentDigest(file.content))throw new Error('配置在预览后被其他程序修改，请重新预览。');
  }
  private async writeContent(snapshot:Snapshot) {
    if(snapshot.content===null){await unlink(snapshot.path).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
    else await this.options.atomicWrite(snapshot.path,snapshot.content);
  }
  async preview(raw:unknown,owner:GatewayOwner):Promise<GatewayCliPreviewDto> {
    const input=parseGatewayInput('gateway.cliConfig.preview',raw);this.checkOwner(owner);this.requireCipher();
    if(this.busy)throw new Error('CLI 配置事务正在执行。');
    await this.options.assertContext(input,owner);
    const target=await this.options.resolveTarget(input,owner);validateTarget(target,input.tool);
    const before=await this.snapshots(input.tool),doc=document(input.tool,before[0].content);
    const conflicts:string[]=[];const patches:FieldPatch[]=[];
    const envExisted=own(doc,'env');
    if(input.tool==='codex'){
      const profile=typeof doc.profile==='string'&&object(doc.profiles)&&object(doc.profiles[doc.profile])?doc.profiles[doc.profile] as Record<string,unknown>:undefined;
      const provider=typeof profile?.model_provider==='string'?profile.model_provider:doc.model_provider;
      if(typeof provider!=='string'||provider==='openai'||!idPattern.test(provider)||!object(doc.model_providers)||!object(doc.model_providers[provider]))
        conflicts.push('Codex 需要已有明确自定义 provider；不会切换官方登录或当前 profile。');
      else {
        const prefix=['model_providers',provider];
        for(const [name,after] of [['base_url',{present:true,value:target.baseUrl}],['experimental_bearer_token',{present:true,value:target.authToken}],
          ['requires_openai_auth',{present:true,value:false}],['env_key',{present:false}]] as [string,FieldValue][]){
          patches.push({path:[...prefix,name],before:field(doc,[...prefix,name]),after});
        }
      }
    }else {
      if(doc.env!==undefined&&!object(doc.env))conflicts.push('Claude Code env 配置结构不兼容。');
      else for(const [name,after] of [['ANTHROPIC_BASE_URL',{present:true,value:target.baseUrl}],['ANTHROPIC_API_KEY',{present:true,value:target.authToken}],['ANTHROPIC_AUTH_TOKEN',{present:false}]] as [string,FieldValue][])
        patches.push({path:['env',name],before:field(doc,['env',name]),after});
    }
    let config=before[0].content;
    if(patches.length)try {config=patchConfig(input.tool,config,patches,'after',envExisted);}catch{conflicts.push('配置使用了不支持的内联或多行入口字段；请改为显式 provider 表。');}
    if(await this.options.isToolRunning(input.tool))conflicts.push('CLI 正在运行，请关闭后重新预览。');
    this.checkOwner(owner);
    const after=before.map((file,n)=>n===0?{...file,content:config}:file);
    const record:StoredTransaction={version:1,id:randomUUID(),ownerId:owner.id,generation:owner.generation,view:owner.view,
      tool:input.tool,input,expiresAtMs:this.now()+TTL_MS,targetFingerprint:digest(target),previewFingerprint:'',resultFingerprint:'',state:'preview',
      before,after,patches,envExisted,conflicts};
    record.previewFingerprint=snapshotFingerprint(before,record);record.resultFingerprint=snapshotFingerprint(after,record);
    await this.persist(record);
    return parseGatewayOutput('gateway.cliConfig.preview',{transactionId:record.id,fingerprint:record.previewFingerprint,expiresAtMs:record.expiresAtMs,
      tool:input.tool,differences:differences(patches),conflicts,recoverable:conflicts.length===0});
  }
  async apply(raw:unknown,owner:GatewayOwner):Promise<GatewayCliResultDto> {
    const input=parseGatewayInput('gateway.cliConfig.apply',raw);this.checkOwner(owner);
    if(this.busy)throw new Error('CLI 配置事务正在执行。');this.busy=true;
    try {
      const record=await this.read(input.transactionId);
      if(record.state!=='preview'||record.conflicts.length||input.expectedFingerprint!==record.previewFingerprint)throw new Error('预览不可应用或指纹不匹配，请重新预览。');
      await this.ensureFresh(record,owner);await this.ensureSnapshots(record.before);
      record.state='applying';await this.persist(record);
      await this.ensureFresh(record,owner);await this.ensureSnapshots(record.before);
      let changed=false;
      try {
        if(record.before[0].content!==record.after[0].content){await this.writeContent(record.after[0]);changed=true;}
        await this.ensureFresh(record,owner);
        record.state='applied';await this.persist(record);
      }catch {
        let rollbackFailed=false;
        if(changed)try {await this.ensureSnapshots([record.after[0]]);await this.writeContent(record.before[0]);}catch{rollbackFailed=true;}
        record.state='failed';await this.persist(record).catch(()=>{});
        throw new Error(rollbackFailed?'CLI 写入失败且回滚遇到冲突，请使用加密事务恢复。':'CLI 写入失败，已保留或恢复原配置。');
      }
      return parseGatewayOutput('gateway.cliConfig.apply',{transactionId:record.id,fingerprint:record.resultFingerprint,state:'applied',recoverable:true});
    }finally{this.busy=false;}
  }
  async restore(raw:unknown,owner:GatewayOwner):Promise<GatewayCliResultDto> {
    const input=parseGatewayInput('gateway.cliConfig.restore',raw);this.checkOwner(owner);
    if(this.busy)throw new Error('CLI 配置事务正在执行。');this.busy=true;
    try {
      const record=await this.read(input.transactionId);
      if(record.ownerId!==owner.id)throw new Error('事务不属于当前插件。');
      if(!['applying','applied','restoring','failed'].includes(record.state)||input.expectedFingerprint!==record.resultFingerprint)throw new Error('事务尚未应用、已经恢复或指纹不匹配。');
      if(await this.options.isToolRunning(record.tool))throw new Error('CLI 正在运行，请关闭后恢复。');
      const current=await this.snapshots(record.tool),doc=document(record.tool,current[0].content);
      for(const patch of record.patches){const value=field(doc,patch.path);
        if(!sameField(value,patch.after) && !(record.state!=='applied'&&sameField(value,patch.before)))throw new Error('受管入口或认证已被修改，恢复已停止以保留外部变更。');
      }
      const config=current[0].content===record.after[0].content?record.before[0].content:
        patchConfig(record.tool,current[0].content,record.patches,'before',record.envExisted);
      const restored=current.map((file,n)=>n===0?{...file,content:config}:file);
      record.state='restoring';await this.persist(record);
      this.checkOwner(owner);await this.ensureSnapshots(current);
      let changed=false;
      try {
        if(current[0].content!==config){await this.writeContent(restored[0]);changed=true;}
        this.checkOwner(owner);
        record.resultFingerprint=snapshotFingerprint(restored,record);record.state='restored';await this.persist(record);
      }catch {
        let rollbackFailed=false;
        if(changed)try {await this.ensureSnapshots([restored[0]]);await this.writeContent(current[0]);}catch{rollbackFailed=true;}
        record.state='failed';await this.persist(record).catch(()=>{});
        throw new Error(rollbackFailed?'恢复失败且回滚遇到冲突，原加密事务仍保留。':'恢复失败，已保留或恢复当前配置。');
      }
      return parseGatewayOutput('gateway.cliConfig.restore',{transactionId:record.id,fingerprint:record.resultFingerprint,state:'restored',recoverable:false});
    }finally{this.busy=false;}
  }
  /** Host-owned recovery UI may discover its persisted transactions after restart. */
  async recoveryTransactions(ownerId:string):Promise<GatewayCliResultDto[]> {
    if(!idPattern.test(ownerId))throw new Error('无效插件身份。');
    let files:string[];try{files=await readdir(path.join(this.dataDir,'gateway-cli-transactions'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw new Error('事务目录无法读取。');}
    const result:GatewayCliResultDto[]=[];
    for(const file of files){if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(file))continue;const record=await this.read(file.slice(0,-5));
      if(record.ownerId===ownerId&&['applying','applied','restoring','failed'].includes(record.state))result.push({transactionId:record.id,fingerprint:record.resultFingerprint,state:'applied',recoverable:true});
    }
    return result;
  }
  /** Native host recovery menu only; never expose owner IDs or vault files through SDK. */
  async hostRecoveryTransactions():Promise<{ownerId:string;tool:Tool;transaction:GatewayCliResultDto}[]> {
    let files:string[];try{files=await readdir(path.join(this.dataDir,'gateway-cli-transactions'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw new Error('网关事务目录无法读取。');}
    if(files.length>10000)throw new Error('网关恢复事务过多，请在数据管理中处理。');
    const result:{ownerId:string;tool:Tool;transaction:GatewayCliResultDto}[]=[];
    for(const file of files){
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(file))continue;
      const record=await this.read(file.slice(0,-5));
      if(['applying','applied','restoring','failed'].includes(record.state))result.push({ownerId:record.ownerId,tool:record.tool,transaction:{transactionId:record.id,fingerprint:record.resultFingerprint,state:'applied',recoverable:true}});
    }
    return result;
  }
}
