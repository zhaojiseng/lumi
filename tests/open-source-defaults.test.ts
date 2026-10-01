import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {DEFAULT_PREFERENCES,DEFAULT_SITE_URL} from '../shared/types';
import {SettingsStore} from '../electron/services/store';
import {NewApiClient} from '../electron/services/new-api';

test('fresh public defaults do not contact any host or fabricate account data',async()=>{
  const root=await mkdtemp(path.resolve('.test-data/public-default-'));
  const store=new SettingsStore(root,{available:()=>true,encrypt:s=>s,decrypt:s=>s});await store.load();
  const originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('No network allowed in this test');};
  try{
    assert.equal(store.activeSite().url,DEFAULT_SITE_URL);
    const api=new NewApiClient(store),dashboard=await api.dashboard(1);
    assert.equal(dashboard.user,null);assert.equal(dashboard.stat,null);
    assert.deepEqual(dashboard.logs.items,[]);assert.deepEqual(dashboard.catalog.models,[]);
    await assert.rejects(api.loginInfo(),/填写你的 New API/);
    await assert.rejects(api.login({username:'fixture',password:'fixture'}),/填写你的 New API/);
    assert.equal(calls,0);
  }finally{globalThis.fetch=originalFetch;}
});

test('saved site identities and addresses survive the change to public defaults',async()=>{
  const root=await mkdtemp(path.resolve('.test-data/public-saved-site-'));
  const cipher={available:()=>true,encrypt:(s:string)=>s,decrypt:(s:string)=>s};
  const store=new SettingsStore(root,cipher);await store.load();
  await store.saveSite({id:DEFAULT_PREFERENCES.activeSiteId,name:'Existing fixture',url:'https://existing.fixture.invalid',allowHttp:false});
  const restored=new SettingsStore(root,cipher);await restored.load();
  assert.equal(restored.activeSite().id,DEFAULT_PREFERENCES.activeSiteId);
  assert.equal(restored.activeSite().name,'Existing fixture');
  assert.equal(restored.activeSite().url,'https://existing.fixture.invalid');
});
