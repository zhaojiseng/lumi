import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import {parse as parseToml} from 'smol-toml';
import {GatewayCliConfigService,type GatewayCliConfigOptions,type GatewayCliTarget} from '../electron/services/gateway-cli-config';
import type {GatewayOwner} from '../shared/contracts/gateway';

const owner=(generation=1,id='extension.author.gateway'):GatewayOwner=>({id,generation,view:'main',signal:new AbortController().signal});
const fakeCipher=()=>{const key=randomBytes(32);return {
  available:()=>true,
  encrypt(text:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const value=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),value]).toString('base64');},
  decrypt(text:string){const bytes=Buffer.from(text,'base64'),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');}
};};
async function atomicWrite(file:string,content:string){await mkdir(path.dirname(file),{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,content,{mode:0o600});await rename(temporary,file);}
const codexConfig='# preserve this comment\nmodel = "root-model"\nmodel_provider = "custom"\nservice_tier = "flex"\nprofile = "work"\n\n[profiles.work]\nmodel = "profile-model"\nservice_tier = "default"\nmodel_provider = "custom"\n\n[model_providers.custom]\nname = "Existing provider"\nbase_url = "https://upstream.example/v1" # endpoint comment\nexperimental_bearer_token = "fake-original-codex-token"\nrequires_openai_auth'+' = true\nenv_key = "FAKE_PROVIDER_ENV"\nwire_api = "responses"\n\n[mcp_servers.notes]\ncommand = "notes-tool"\n';
const claudeConfig=JSON.stringify({model:'root-claude-model',permissions:{allow:['Read(*)']},env:{ANTHROPIC_BASE_URL:'https://anthropic.example',ANTHROPIC_AUTH_TOKEN:'fake-original-auth-token',ANTHROPIC_API_KEY:'fake-original-api-key',ANTHROPIC_MODEL:'user-model',ANTHROPIC_DEFAULT_SONNET_MODEL:'user-sonnet',SERVICE_TIER:'unchanged-user-setting',UNRELATED:'keep'}},null,2)+'\n';
async function fixture(){
  const directory=await mkdtemp(path.join(os.tmpdir(),'lumi-gateway-cli-fixture-'));
  const home=path.join(directory,'fixture-home'),data=path.join(directory,'app-data');
  await mkdir(path.join(home,'.codex'),{recursive:true});await mkdir(path.join(home,'.claude'),{recursive:true});
  const codex=path.join(home,'.codex','config.toml'),auth=path.join(home,'.codex','auth.json'),claude=path.join(home,'.claude','settings.json');
  await writeFile(codex,codexConfig);await writeFile(auth,'{ "tokens": {"access_token":"fake-login-token"}, "OPENAI_API_KEY":"fake-auth-json-key" }\n');await writeFile(claude,claudeConfig);
  let currentTime=1_000_000,running=false,session='session-fingerprint-1',authToken=('fake-local-'+'gateway-token-12345');
  const cipher=fakeCipher();
  const options:GatewayCliConfigOptions={homeDir:home,atomicWrite,now:()=>currentTime,
    resolveTarget:async input=>({baseUrl:input.tool==='codex'?'http://127.0.0.1:18080/primary/v1':'http://127.0.0.1:18080/primary',
      authToken,sessionFingerprint:session,protocol:input.tool==='codex'?'openai':'anthropic'}),
    assertContext:async input=>{if(input.sessionId!=='paired-session')throw new Error('fixture-session-invalid');},isToolRunning:async()=>running};
  return {directory,home,data,codex,auth,claude,cipher,options,
    service:()=>new GatewayCliConfigService(cipher,data,options),
    setTime:(value:number)=>{currentTime=value;},setRunning:(value:boolean)=>{running=value;},
    setSession:(value:string)=>{session=value;},setAuthToken:(value:string)=>{authToken=value;},
    cleanup:async()=>{const relative=path.relative(os.tmpdir(),directory);if(path.isAbsolute(relative)||relative.startsWith('..')||!path.basename(directory).startsWith('lumi-gateway-cli-fixture-'))throw new Error('fixture cleanup boundary');await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:30});}};
}
const input=(tool:'codex'|'claude-code')=>({sessionId:'paired-session',tool,routeId:'primary'});

async function apply(f:Awaited<ReturnType<typeof fixture>>,tool:'codex'|'claude-code'){
  const service=f.service(),preview=await service.preview(input(tool),owner());
  const result=await service.apply({transactionId:preview.transactionId,expectedFingerprint:preview.fingerprint},owner());
  return {service,preview,result};
}

test('Codex preview is redacted and changes only active explicit provider entry/auth',async()=>{
  const f=await fixture();try{
    const beforeAuth=await readFile(f.auth,'utf8');const {preview,result}=await apply(f,'codex');
    assert.deepEqual(preview.conflicts,[]);assert.equal(result.state,'applied');assert.equal(preview.recoverable,true);
    assert.equal(JSON.stringify(preview).includes('fake-original-codex-token'),false);
    assert.equal(JSON.stringify(preview).includes('fake-local-gateway-token'),false);
    assert.equal(JSON.stringify(preview).includes(f.home),false);
    const text=await readFile(f.codex,'utf8');assert.match(text,/# preserve this comment/);assert.match(text,/# endpoint comment/);
    const doc=parseToml(text) as any;assert.equal(doc.model,'root-model');assert.equal(doc.model_provider,'custom');assert.equal(doc.service_tier,'flex');
    assert.deepEqual({...doc.profiles.work},{model:'profile-model',service_tier:'default',model_provider:'custom'});
    assert.equal(doc.model_providers.custom.base_url,'http://127.0.0.1:18080/primary/v1');
    assert.equal(doc.model_providers.custom.experimental_bearer_token,('fake-local-'+'gateway-token-12345'));
    assert.equal(doc.model_providers.custom.requires_openai_auth,false);assert.equal(doc.model_providers.custom.env_key,undefined);
    assert.equal(doc.mcp_servers.notes.command,'notes-tool');assert.equal(await readFile(f.auth,'utf8'),beforeAuth);
    for(const file of await readdir(path.join(f.data,'gateway-cli-transactions'))){const stored=await readFile(path.join(f.data,'gateway-cli-transactions',file),'utf8');
      assert.equal(stored.includes('fake-original-codex-token'),false);assert.equal(stored.includes('fake-login-token'),false);assert.equal(stored.includes('fake-local-gateway-token'),false);
      assert.deepEqual(Object.keys(JSON.parse(stored)).sort(),['encrypted','version']);}
  }finally{await f.cleanup();}
});

test('Claude transaction preserves model/mapping/tier fields and restores original auth token',async()=>{
  const f=await fixture();try{
    const {service,result}=await apply(f,'claude-code');let doc=JSON.parse(await readFile(f.claude,'utf8'));
    assert.equal(doc.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:18080/primary');assert.equal(doc.env.ANTHROPIC_API_KEY,('fake-local-'+'gateway-token-12345'));
    assert.equal(doc.env.ANTHROPIC_AUTH_TOKEN,undefined);assert.equal(doc.model,'root-claude-model');assert.equal(doc.env.ANTHROPIC_MODEL,'user-model');
    assert.equal(doc.env.ANTHROPIC_DEFAULT_SONNET_MODEL,'user-sonnet');assert.equal(doc.env.SERVICE_TIER,'unchanged-user-setting');assert.deepEqual(doc.permissions,{allow:['Read(*)']});
    const restored=await service.restore({transactionId:result.transactionId,expectedFingerprint:result.fingerprint},owner());
    assert.equal(restored.state,'restored');assert.equal(restored.recoverable,false);
    assert.deepEqual(await service.recoveryTransactions(owner().id),[]);
    assert.deepEqual(await service.hostRecoveryTransactions(),[]);
    assert.equal(await readFile(f.claude,'utf8'),claudeConfig);
  }finally{await f.cleanup();}
});

test('preview expiry, mismatched fingerprint and external file changes block apply',async()=>{
  const f=await fixture();try{
    const service=f.service(),preview=await service.preview(input('codex'),owner());
    await assert.rejects(service.apply({transactionId:preview.transactionId,expectedFingerprint:'wrong-fingerprint'},owner()),/指纹/);
    f.setTime(preview.expiresAtMs+1);await assert.rejects(service.apply({transactionId:preview.transactionId,expectedFingerprint:preview.fingerprint},owner()),/过期/);
    f.setTime(1_000_000);await writeFile(f.codex,codexConfig+'\n# external edit\n');
    await assert.rejects(service.apply({transactionId:preview.transactionId,expectedFingerprint:preview.fingerprint},owner()),/其他程序修改/);
    assert.equal(await readFile(f.codex,'utf8'),codexConfig+'\n# external edit\n');
  }finally{await f.cleanup();}
});

test('session/credential changes, owner generation and running CLI block apply',async()=>{
  const f=await fixture();try{
    const service=f.service(),preview=await service.preview(input('claude-code'),owner());const commit={transactionId:preview.transactionId,expectedFingerprint:preview.fingerprint};
    await assert.rejects(service.apply(commit,owner(2)),/实例已变更/);await assert.rejects(service.apply(commit,owner(1,'another-plugin')),/实例已变更/);
    f.setSession('session-fingerprint-2');await assert.rejects(service.apply(commit,owner()),/会话/);f.setSession('session-fingerprint-1');
    f.setAuthToken('different-local-secret-123456');await assert.rejects(service.apply(commit,owner()),/会话/);f.setAuthToken(('fake-local-'+'gateway-token-12345'));
    f.setRunning(true);await assert.rejects(service.apply(commit,owner()),/正在运行/);f.setRunning(false);
    assert.equal(await readFile(f.claude,'utf8'),claudeConfig);
  }finally{await f.cleanup();}
});

test('encrypted transactions survive host restart and restore with same owner new generation',async()=>{
  const f=await fixture();try{
    const {result}=await apply(f,'codex');const restarted=f.service();
    const pending=await restarted.recoveryTransactions(owner().id);assert.equal(pending.length,1);assert.equal(pending[0].transactionId,result.transactionId);
    await assert.rejects(restarted.restore({transactionId:result.transactionId,expectedFingerprint:result.fingerprint},owner(2,'other-plugin')),/不属于/);
    const restored=await restarted.restore({transactionId:result.transactionId,expectedFingerprint:result.fingerprint},owner(7));assert.equal(restored.state,'restored');
    assert.equal(await readFile(f.codex,'utf8'),codexConfig);assert.deepEqual(await restarted.recoveryTransactions(owner().id),[]);
  }finally{await f.cleanup();}
});

test('field-scoped Codex restore preserves unrelated later profile/model/MCP edits',async()=>{
  const f=await fixture();try{
    const {service,result}=await apply(f,'codex');let text=await readFile(f.codex,'utf8');text=text.replace('model = "root-model"','model = "new-user-root-model"').replace('model = "profile-model"','model = "new-user-profile-model"');text+='\n[user_settings]\nnew_value = "keep-later-change"\n';await writeFile(f.codex,text);
    await service.restore({transactionId:result.transactionId,expectedFingerprint:result.fingerprint},owner(9));
    const doc=parseToml(await readFile(f.codex,'utf8')) as any;assert.equal(doc.model,'new-user-root-model');assert.equal(doc.profiles.work.model,'new-user-profile-model');
    assert.equal(doc.user_settings.new_value,'keep-later-change');assert.equal(doc.service_tier,'flex');assert.equal(doc.model_providers.custom.base_url,'https://upstream.example/v1');
    assert.equal(doc.model_providers.custom.experimental_bearer_token,'fake-original-codex-token');assert.equal(doc.model_providers.custom.env_key,'FAKE_PROVIDER_ENV');assert.equal(doc.model_providers.custom.requires_openai_auth,true);
  }finally{await f.cleanup();}
});

test('field-scoped Claude restore preserves unrelated changes and refuses managed auth conflicts',async()=>{
  const f=await fixture();try{
    const {service,result}=await apply(f,'claude-code');let doc=JSON.parse(await readFile(f.claude,'utf8'));doc.model='new-user-model';doc.env.NEW_SETTING='keep-later';await writeFile(f.claude,JSON.stringify(doc));
    await service.restore({transactionId:result.transactionId,expectedFingerprint:result.fingerprint},owner(2));doc=JSON.parse(await readFile(f.claude,'utf8'));
    assert.equal(doc.model,'new-user-model');assert.equal(doc.env.NEW_SETTING,'keep-later');assert.equal(doc.env.ANTHROPIC_AUTH_TOKEN,'fake-original-auth-token');
    const second=await apply(f,'claude-code');doc=JSON.parse(await readFile(f.claude,'utf8'));doc.env.ANTHROPIC_API_KEY='external-auth-modification';const current=JSON.stringify(doc);await writeFile(f.claude,current);
    await assert.rejects(second.service.restore({transactionId:second.result.transactionId,expectedFingerprint:second.result.fingerprint},owner()),/受管入口或认证已被修改/);
    assert.equal(await readFile(f.claude,'utf8'),current);
  }finally{await f.cleanup();}
});

test('default official Codex provider and inline custom table are not silently rewritten',async()=>{
  const f=await fixture();try{
    for(const text of ['model = "official"\n','model_provider = "openai"\n[model_providers.openai]\nbase_url = "https://example.test/v1"\n','model_provider = "custom"\nmodel_providers = { custom = { base_url = "https://example.test/v1" } }\n']){
      await writeFile(f.codex,text);const service=f.service(),preview=await service.preview(input('codex'),owner());assert.ok(preview.conflicts.length);assert.equal(preview.recoverable,false);
      await assert.rejects(service.apply({transactionId:preview.transactionId,expectedFingerprint:preview.fingerprint},owner()),/不可应用/);assert.equal(await readFile(f.codex,'utf8'),text);
    }
  }finally{await f.cleanup();}
});

test('strict plugin DTO rejects paths/keys and trusted target rejects remote or credential URLs',async()=>{
  const f=await fixture();try{
    const service=f.service();await assert.rejects(service.preview({...input('codex'),path:'C:/actual-cli',key:'must-not-be-accepted'},owner()));
    for(const baseUrl of ['https://example.test/v1',('http://'+'192.168.1.3:18080/v1'),'http://user@127.0.0.1:18080/v1','http://127.0.0.1:18080/v1?secret=x']){
      const broken=f.service();f.options.resolveTarget=async()=>({baseUrl,authToken:('fake-local-'+'gateway-token-12345'),sessionFingerprint:'fixed',protocol:'openai'});
      await assert.rejects(broken.preview(input('codex'),owner()),/入口/);
    }
    assert.equal(await readFile(f.codex,'utf8'),codexConfig);
  }finally{await f.cleanup();}
});

test('encrypted backup failure happens before changing CLI and no cipher has no plaintext fallback',async()=>{
  const f=await fixture();try{
    f.options.atomicWrite=async(file,content)=>{if(file.includes('gateway-cli-transactions'))throw new Error('fake-backup-write-failure');await atomicWrite(file,content);};
    await assert.rejects(f.service().preview(input('codex'),owner()));assert.equal(await readFile(f.codex,'utf8'),codexConfig);
    const unavailable=new GatewayCliConfigService({...f.cipher,available:()=>false},f.data,f.options);
    await assert.rejects(unavailable.preview(input('codex'),owner()),/加密不可用/);assert.equal(await readFile(f.codex,'utf8'),codexConfig);
  }finally{await f.cleanup();}
});

test('failure committing applied state rolls back CLI while leaving encrypted recoverable transaction',async()=>{
  const f=await fixture();try{
    const service=f.service(),preview=await service.preview(input('claude-code'),owner());let backupWrites=0;
    f.options.atomicWrite=async(file,content)=>{if(file.includes('gateway-cli-transactions')&&++backupWrites===2)throw new Error('fake-commit-failure');await atomicWrite(file,content);};
    await assert.rejects(service.apply({transactionId:preview.transactionId,expectedFingerprint:preview.fingerprint},owner()),/已保留或恢复/);
    assert.equal(await readFile(f.claude,'utf8'),claudeConfig);assert.equal((await service.recoveryTransactions(owner().id)).length,1);
  }finally{await f.cleanup();}
});

test('new Claude config can restore without deleting unrelated fields added after apply',async()=>{
  const f=await fixture();try{
    await rm(f.claude);const {service,result}=await apply(f,'claude-code');const doc=JSON.parse(await readFile(f.claude,'utf8'));doc.newSetting='keep';await writeFile(f.claude,JSON.stringify(doc));
    await service.restore({transactionId:result.transactionId,expectedFingerprint:result.fingerprint},owner(4));const restored=JSON.parse(await readFile(f.claude,'utf8'));
    assert.deepEqual(restored,{newSetting:'keep'});
  }finally{await f.cleanup();}
});

test('environment paths come only from the host resolver and changed resolver prevents restoration',async()=>{
  const f=await fixture();try{
    const fixed=path.join(f.directory,'isolated-codex-home');await mkdir(fixed);await writeFile(path.join(fixed,'config.toml'),codexConfig);await writeFile(path.join(fixed,'auth.json'),'{}');
    let codexHome=fixed;f.options.environment=()=>({CODEX_HOME:codexHome});const {service,result}=await apply(f,'codex');assert.equal(await readFile(f.codex,'utf8'),codexConfig);
    assert.match(await readFile(path.join(fixed,'config.toml'),'utf8'),/127\.0\.0\.1/);codexHome=path.join(f.directory,'different-fixed-home');
    await assert.rejects(service.restore({transactionId:result.transactionId,expectedFingerprint:result.fingerprint},owner(5)),/工具目录已变更/);
  }finally{await f.cleanup();}
});

test('duplicate JSON keys and oversized CLI configurations reject instead of overwriting ambiguity',async()=>{
  const f=await fixture();try{
    await writeFile(f.claude,'{"env":{"ANTHROPIC_API_KEY":"first","ANTHROPIC_API_KEY":"second"}}');await assert.rejects(f.service().preview(input('claude-code'),owner()),/安全解析/);
    const text='x'.repeat(8*1024*1024+1);await writeFile(f.codex,text);await assert.rejects(f.service().preview(input('codex'),owner()),/安全读取/);assert.equal((await readFile(f.codex,'utf8')).length,text.length);
  }finally{await f.cleanup();}
});


test('external edit while encrypting the apply backup is rechecked before writing CLI',async()=>{
  const f=await fixture();try{
    const service=f.service(),preview=await service.preview(input('codex'),owner());
    const external=codexConfig+'\n# user edit during backup\n';let first=true;
    f.options.atomicWrite=async(file,content)=>{await atomicWrite(file,content);if(file.includes('gateway-cli-transactions')&&first){first=false;await writeFile(f.codex,external);}};
    await assert.rejects(service.apply({transactionId:preview.transactionId,expectedFingerprint:preview.fingerprint},owner()),/其他程序修改/);
    assert.equal(await readFile(f.codex,'utf8'),external);
  }finally{await f.cleanup();}
});

test('owner revocation during atomic apply rolls back the managed entry instead of committing late',async()=>{
  const f=await fixture();try{
    const controller=new AbortController(),currentOwner={...owner(),signal:controller.signal};
    const service=f.service(),preview=await service.preview(input('claude-code'),currentOwner);
    f.options.atomicWrite=async(file,content)=>{await atomicWrite(file,content);if(file===f.claude)controller.abort();};
    await assert.rejects(service.apply({transactionId:preview.transactionId,expectedFingerprint:preview.fingerprint},currentOwner),/已保留或恢复/);
    assert.equal(await readFile(f.claude,'utf8'),claudeConfig);
  }finally{await f.cleanup();}
});
