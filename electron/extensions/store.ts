import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {atomicWrite,type Cipher} from '../services/store';
import {extensionId} from '../../shared/extension-manifest';
interface ExtensionSettings {enabled:boolean;digest:string;views:Record<string,boolean>;storage:Record<string,unknown>;}
export class ExtensionStore {
  private states:Record<string,ExtensionSettings>={};private secrets:Record<string,Record<string,string>>={};private vaultError=false;
  constructor(private directory:string,private cipher:Cipher){}
  async load(){
    let data:any;try{data=JSON.parse(await readFile(path.join(this.directory,'extension-settings.json'),'utf8'));}catch(error:any){if(error.code==='ENOENT')return;throw new Error('额外插件设置无法读取。');}
    for(const [id,value] of Object.entries(data.plugins || {}))if(extensionId.test(id) && value && typeof value==='object'){
      const v=value as ExtensionSettings;this.states[id]={enabled:v.enabled===true,digest:typeof v.digest==='string' ? v.digest : '',views:Object.fromEntries(Object.entries(v.views || {}).filter(([key,value])=>/^[a-z][a-z0-9.-]{0,79}$/.test(key) && typeof value==='boolean')),storage:v.storage && typeof v.storage==='object' && !Array.isArray(v.storage) ? v.storage : {}};
    }
    if(data.vault)try{this.secrets=JSON.parse(this.cipher.decrypt(data.vault));}catch{this.vaultError=true;}
  }
  get(id:string):ExtensionSettings{return structuredClone(this.states[id] || {enabled:false,digest:'',views:{},storage:{}});}
  hasSecret(id:string,key:string){if(this.vaultError)throw new Error('扩展凭据无法解密。');return !!this.secrets[id]?.[key];}
  secret(id:string,key:string){if(this.vaultError)throw new Error('扩展凭据无法解密。');return this.secrets[id]?.[key];}
  /** Caller serializes writes; failures restore both flags and encrypted credentials. */
  async change(id:string,patch:Partial<ExtensionSettings>,secret?:{key:string;value:string|null}){
    if(this.vaultError)throw new Error('扩展凭据无法解密，请在原系统账户运行。');
    if(secret && !this.cipher.available())throw new Error('系统加密存储不可用。');
    const previous=this.states[id],previousSecrets=structuredClone(this.secrets);
    this.states[id]={...this.get(id),...patch};
    if(secret){const values=this.secrets[id] ??={};if(secret.value===null)delete values[secret.key];else values[secret.key]=secret.value;}
    try{const hasSecrets=Object.values(this.secrets).some(v=>Object.keys(v).length);if(hasSecrets && !this.cipher.available())throw new Error('系统加密存储不可用。');await atomicWrite(path.join(this.directory,'extension-settings.json'),JSON.stringify({version:1,plugins:this.states,vault:hasSecrets ? this.cipher.encrypt(JSON.stringify(this.secrets)) : ''}));}
    catch(error){if(previous)this.states[id]=previous;else delete this.states[id];this.secrets=previousSecrets;throw error;}
  }
}
