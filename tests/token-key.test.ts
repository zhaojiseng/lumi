import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {SettingsStore} from '../electron/services/store';
import {NewApiClient} from '../electron/services/new-api';
test('explicit token retrieval verifies ownership, normalizes keys, honors denied access, and uses legacy fallback only for missing endpoints',async()=>{
  const root=await mkdtemp(path.resolve('.test-data/token-key-'));
  const store=new SettingsStore(root,{available:()=>true,encrypt:s=>s,decrypt:s=>s});await store.load();
  let endpointStatus=200,returnedKey='isolated-fake-key',keyReads=0,legacyReads=0,hold=false;
  let keyStarted!:()=>void,releaseKey!:()=>void;
  const started=new Promise<void>(r=>keyStarted=r),release=new Promise<void>(r=>releaseKey=r);
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    const send=(data:unknown)=>res.end(JSON.stringify({success:true,data}));
    if(req.url?.startsWith('/api/token/?'))return send({items:[{id:7,name:'fixture',status:1,group:'standard',key:returnedKey}],total:1});
    if(req.url==='/api/token/7/key' && req.method==='POST'){keyReads++;if(hold){keyStarted();await release;}if(endpointStatus!==200){res.statusCode=endpointStatus;return res.end(JSON.stringify({success:false,message:'Fixture denied'}));}return send(returnedKey);}
    if(req.url==='/api/token/7' && req.method==='GET'){legacyReads++;return send({key:returnedKey});}
    res.statusCode=404;res.end(JSON.stringify({success:false,message:'missing'}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{
    const url='http://127.0.0.1:'+(server.address() as any).port;
    await store.saveSite({id:store.activeSite().id,name:'Fixture',url,allowHttp:true,accessToken:'isolated-account'});
    const api=new NewApiClient(store);
    assert.ok(!('key' in (await api.tokens())[0]));
    await assert.rejects(api.getTokenKey(8),/不属于/);assert.equal(keyReads,0);
    assert.equal(await api.getTokenKey(7),'sk-isolated-fake-key');
    endpointStatus=403;await assert.rejects(api.getTokenKey(7),/无权/);assert.equal(legacyReads,0);
    endpointStatus=404;assert.equal(await api.getTokenKey(7),'sk-isolated-fake-key');assert.equal(legacyReads,1);
    endpointStatus=200;returnedKey='sk-already-prefixed';assert.equal(await api.getTokenKey(7),returnedKey);
    for(const key of ['masked*****','', 'bad key']){returnedKey=key;await assert.rejects(api.getTokenKey(7),/完整令牌/);}
    assert.equal(store.toolKey('codex'),'');assert.equal(store.preferences.viewSelections[store.activeSite().id],undefined);
    returnedKey='sk-isolated';hold=true;
    const pending=api.getTokenKey(7),rejected=assert.rejects(pending,/登录状态/);
    await started;await store.clearSession(store.activeSite().id);releaseKey();await rejected;
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
