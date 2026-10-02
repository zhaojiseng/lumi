import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {SettingsStore} from '../electron/services/store';
import {NewApiClient} from '../electron/services/new-api';
import {previousMinute,formattedWidget} from '../shared/widget';
import type {UsageLog} from '../shared/types';
const now=new Date(2026,9,2,13,25,21).getTime(),window=previousMinute(now);
const log=(id:number,time:number,quota=100,model='fixture-model'):UsageLog=>({id,created_at:time,type:2,model_name:model,token_name:'test',prompt_tokens:1000,completion_tokens:120,quota,use_time:2,is_stream:false,group:'test',other:JSON.stringify({cache_tokens:200,cache_creation_tokens:30})});
async function fixture(t:TestContext,rows:UsageLog[],options:{fail?:boolean;anonymous?:boolean;array?:boolean}={}){
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/widget-api-')),seen:URL[]=[];
  const store=new SettingsStore(root,{available:()=>true,encrypt:s=>Buffer.from(s).toString('base64'),decrypt:s=>Buffer.from(s,'base64').toString()});await store.load();
  const server=createServer((req,res)=>{const url=new URL(req.url!,'http://127.0.0.1');seen.push(url);res.setHeader('Content-Type','application/json');const send=(data:unknown,extra:object={})=>res.end(JSON.stringify({success:true,data,...extra}));
    if(url.pathname==='/api/status')return send({system_name:'Fixture',quota_per_unit:500000});
    if(url.pathname==='/api/user/self')return send({quota:5000000,username:'private-fixture'});
    if(url.pathname==='/api/log/self'){
      if(options.fail){res.statusCode=403;return res.end(JSON.stringify({success:false,message:'Fixture failure'}));}
      const start=Number(url.searchParams.get('start_timestamp')),end=Number(url.searchParams.get('end_timestamp')),page=Number(url.searchParams.get('p')),size=Number(url.searchParams.get('page_size'));
      const matching=rows.filter(r=>r.type===2 && r.created_at>=start && r.created_at<=end).sort((a,b)=>b.created_at-a.created_at || b.id-a.id),items=matching.slice((page-1)*size,page*size);
      return options.array ? send(items,{total:matching.length}) : send({items,total:matching.length});
    }res.statusCode=404;res.end('{}');
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};await store.saveSite({id:store.activeSite().id,name:'Fixture',url:'http://127.0.0.1:'+address.port,allowHttp:true,...(!options.anonymous ? {accessToken:'fixture-key'} : {})});
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));const relative=path.relative(path.resolve('.test-data'),root);assert.ok(relative && !relative.startsWith('..'));await rm(root,{recursive:true,force:true});});
  return {api:new NewApiClient(store),seen,store};
}
test('widget uses only the completed minute and shares cached account/log requests',async t=>{
  const f=await fixture(t,[log(1,window.start_timestamp+1,100,'model-a'),log(2,window.end_timestamp,200,'model-b'),log(3,window.end_timestamp+1,900,'current-model'),{...log(4,window.start_timestamp+3),type:5}]);
  const [a,b]=await Promise.all([f.api.widgetUsage(now),f.api.widgetUsage(now)]);
  assert.equal(a.balance,5000000);assert.equal(a.minute?.quota,300);assert.equal(a.historical,false);assert.deepEqual(a.minute?.models.map(m=>m.name),['model-b','model-a']);assert.deepEqual(a,b);
  assert.equal(f.seen.filter(u=>u.pathname==='/api/user/self').length,1);assert.equal(f.seen.filter(u=>u.pathname==='/api/log/self').length,1);
  assert.ok(f.seen.every(u=>!['/api/data/self','/api/token/','/api/pricing'].includes(u.pathname)));
  const publicState=JSON.stringify(formattedWidget('ready',a,{enabled:true,viewKey:'scope',theme:'light'}));assert.ok(!publicState.includes('fixture-key') && !publicState.includes('private-fixture') && !publicState.includes('other'));
});
test('empty preceding minute falls back to a prior-day paid minute and loads all models/pages in that minute',async t=>{
  const older=window.start_timestamp-86400,rows=Array.from({length:135},(_,i)=>log(i+1,older+i%60,i%2 ? 1 : 0,i%2 ? 'paid-model' : 'free-model'));
  rows.push(log(200,window.start_timestamp-120,0),log(201,window.start_timestamp+5,0));
  const f=await fixture(t,rows,{array:true}),data=await f.api.widgetUsage(now);
  assert.equal(data.historical,true);assert.equal(data.minute?.start,older);assert.equal(data.minute?.requests,135);assert.equal(data.minute?.quota,67);assert.equal(data.minute?.models.length,2);
  assert.ok(f.seen.some(u=>u.searchParams.get('p')==='2' && u.searchParams.get('start_timestamp')===String(older)));
  assert.ok(formattedWidget('ready',data,{enabled:true,viewKey:'scope',theme:'light'}).message.includes('最近'));
});
test('only free consumption remains distinct from a paid-minute result and empty history retains unknown cost',async t=>{
  const f=await fixture(t,[log(1,window.start_timestamp+10,0)]),data=await f.api.widgetUsage(now);
  assert.equal(data.minute,null);assert.equal(data.historical,false);assert.deepEqual(data.warnings,[]);assert.equal(data.balance,5000000);
  const state=formattedWidget('ready',data,{enabled:true,viewKey:'scope',theme:'light'});assert.equal(state.cost,'—');assert.deepEqual(state.models,[]);
});
test('bounded fallback never publishes an invented zero when deeper paid history is unscanned',async t=>{
  const rows=Array.from({length:2005},(_,i)=>log(i+1,window.start_timestamp-120-i*60,0));rows.push(log(3000,window.start_timestamp-864000,100));
  const f=await fixture(t,rows),data=await f.api.widgetUsage(now);
  assert.equal(data.minute,null);assert.match(data.warnings[0],/2,000/);assert.equal(f.seen.filter(u=>u.pathname==='/api/log/self' && u.searchParams.get('start_timestamp')==='0').length,20);
});
test('log permission errors reject refresh and logged-out widget never requests account data',async t=>{
  const denied=await fixture(t,[],{fail:true});await assert.rejects(denied.api.widgetUsage(now),/无权/);
  const anonymous=await fixture(t,[],{anonymous:true}),data=await anonymous.api.widgetUsage(now);assert.equal(data.loggedIn,false);assert.equal(data.balance,null);assert.equal(data.minute,null);assert.deepEqual(anonymous.seen.map(u=>u.pathname),['/api/status']);
});


test('latest widget period selects one actual call including the current minute, excluding future records',async t=>{
  const f=await fixture(t,[log(1,window.start_timestamp,2),log(2,Math.floor(now/1000)-1,7,'latest-model'),log(3,Math.floor(now/1000)+1,9)]);
  const result=await f.api.widgetUsage(now,'latest');assert.equal(result.minute?.requests,1);assert.equal(result.minute?.quota,7);assert.equal(result.minute?.latestModel?.name,'latest-model');assert.equal(result.minute?.start,Math.floor(now/1000)-1);assert.equal(result.periodLabel,'最近一次');
});
test('long widget periods include complete paginated history, all models and exactly the requested range',async t=>{
  const start=window.end_timestamp-1800+1;
  const rows=Array.from({length:135},(_,i)=>log(i+1,start+i,1,i%2 ? 'a' : 'b'));rows.push(log(200,start-1,100),log(201,window.end_timestamp+1,100));
  const f=await fixture(t,rows),result=await f.api.widgetUsage(now,1800);assert.equal(result.minute?.quota,135);assert.equal(result.minute?.requests,135);assert.equal(result.minute?.models.length,2);assert.equal(result.minute?.start,start);assert.equal(result.minute?.end,window.end_timestamp);assert.equal(result.minute?.latestModel?.name,'b');assert.ok(f.seen.some(u=>u.searchParams.get('p')==='2'));assert.equal(result.historical,false);
  const empty=await f.api.widgetUsage(now,180);assert.equal(empty.minute,null);
});
