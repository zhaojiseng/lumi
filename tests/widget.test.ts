import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {WidgetService} from '../electron/services/widget';
import {SettingsStore} from '../electron/services/store';
import {NewApiClient} from '../electron/services/new-api';
import type {SiteStatus,UsageLog} from '../shared/types';
import {
  previousMinute,widgetMinute,formattedWidget,parseWidgetAction,
  type WidgetUsage,
} from '../shared/widget';

const minuteStart=new Date(2026,9,2,12,33).getTime()/1000;
const fetchedAt=new Date(2026,9,2,12,34,15).getTime();
const status:SiteStatus={system_name:'Fixture',quota_per_unit:100};
const view={enabled:true,viewKey:'fixture-account:view-1',theme:'dark' as const};

function log(id:number,overrides:Partial<UsageLog>={}):UsageLog {
  return {
    id,created_at:minuteStart,type:2,model_name:'model-a',token_name:'Fixture token',
    prompt_tokens:120,completion_tokens:30,quota:100,use_time:1,is_stream:true,group:'default',
    other:JSON.stringify({cache_tokens:0,cache_creation_tokens:0}),...overrides,
  };
}

function usage(overrides:Partial<WidgetUsage>={}):WidgetUsage {
  return {
    siteId:'fixture-site',siteName:'Fixture',status,balance:12345,loggedIn:true,
    minute:widgetMinute([log(1)],minuteStart),historical:false,fetchedAt,warnings:[],...overrides,
  };
}

test('previousMinute selects the completed natural minute throughout the current minute',()=>{
  const expected={start_timestamp:minuteStart,end_timestamp:minuteStart+59};
  for(const offset of [0,1,999,30000,59999]) {
    const now=(minuteStart+60)*1000+offset;
    assert.deepEqual(previousMinute(now),expected,`offset ${offset} ms`);
  }
  assert.deepEqual(previousMinute((minuteStart+120)*1000),{
    start_timestamp:minuteStart+60,end_timestamp:minuteStart+119,
  });
});

test('previousMinute crosses midnight, year end and leap day without clipping to today',()=>{
  const cases=[
    [new Date(2026,9,2,0,0,0),new Date(2026,9,1,23,59,0)],
    [new Date(2027,0,1,0,0,0),new Date(2026,11,31,23,59,0)],
    [new Date(2028,2,1,0,0,59,999),new Date(2028,1,29,23,59,0)],
  ];
  for(const [now,start] of cases) {
    assert.deepEqual(previousMinute(now.getTime()),{
      start_timestamp:start.getTime()/1000,end_timestamp:start.getTime()/1000+59,
    },now.toISOString());
  }
  assert.deepEqual(previousMinute(0),{start_timestamp:-60,end_timestamp:-1});
});

test('previousMinute uses the default clock without including the incomplete minute',(t)=>{
  t.mock.timers.enable({apis:['Date'],now:(minuteStart+60)*1000+59999});
  assert.deepEqual(previousMinute(),{start_timestamp:minuteStart,end_timestamp:minuteStart+59});
  t.mock.timers.tick(1);
  assert.deepEqual(previousMinute(),{start_timestamp:minuteStart+60,end_timestamp:minuteStart+119});
});

test('widgetMinute aggregates every model and free request exactly once within its bounds',()=>{
  const rows=[
    log(1,{other:JSON.stringify({cache_tokens:20,cache_creation_tokens:10})}),
    log(2,{created_at:minuteStart+59,model_name:'model-b',quota:300,prompt_tokens:400,completion_tokens:80,
      other:JSON.stringify({cache_tokens:100,cache_creation_tokens:100,cache_creation_tokens_5m:30,cache_creation_tokens_1h:70})}),
    log(3,{created_at:minuteStart+10,quota:50,prompt_tokens:30,completion_tokens:10,
      other:JSON.stringify({billing_tokens:{cr:5,cc:2,cc1h:3}})}),
    log(4,{model_name:'free-model',quota:0,prompt_tokens:7,completion_tokens:0}),
    log(1,{model_name:'duplicate-model',quota:99999}),
    log(5,{created_at:minuteStart-1,quota:99999}),
    log(6,{created_at:minuteStart+60,quota:99999}),
    ...[0,1,3,4,5].map(type=>log(10+type,{type,quota:99999})),
  ];
  const before=structuredClone(rows);
  const result=widgetMinute(rows,minuteStart);
  assert.deepEqual(result,{
    start:minuteStart,end:minuteStart+59,quota:450,requests:4,
    models:[
      {name:'model-b',quota:300,requests:1,inputTokens:400,outputTokens:80,cacheReadTokens:100,cacheWriteTokens:100},
      {name:'model-a',quota:150,requests:2,inputTokens:150,outputTokens:40,cacheReadTokens:25,cacheWriteTokens:15},
      {name:'free-model',quota:0,requests:1,inputTokens:7,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0},
    ],
    latestModel:{name:'model-b',quota:300,requests:1,inputTokens:400,outputTokens:80,cacheReadTokens:100,cacheWriteTokens:100},
  });
  assert.equal(result.models.reduce((total,model)=>total+model.quota,0),result.quota);
  assert.equal(result.models.reduce((total,model)=>total+model.requests,0),result.requests);
  assert.deepEqual(rows,before,'aggregation must not rewrite the source logs');
});

test('latestModel selects timestamp then ID and formats one request rather than the highest-cost model',()=>{
  const rows=[
    log(999,{created_at:minuteStart+58,model_name:'expensive',quota:900}),
    log(11,{created_at:minuteStart+59,model_name:'latest',quota:1,prompt_tokens:1200,completion_tokens:35,
      other:JSON.stringify({cache_tokens:200,cache_creation_tokens:12})}),
    log(10,{created_at:minuteStart+59,model_name:'latest',quota:20,prompt_tokens:300,completion_tokens:10,
      other:JSON.stringify({cache_tokens:100,cache_creation_tokens:5})}),
    log(1000,{created_at:minuteStart+60,model_name:'outside',quota:9999}),
    log(1001,{created_at:minuteStart+59,type:5,model_name:'error',quota:9999}),
    log(1002,{created_at:minuteStart-1,model_name:'before',quota:9999}),
  ];
  for(const ordered of [rows,[...rows].reverse()]) {
    const minute=widgetMinute(ordered,minuteStart);
    assert.equal(minute.models[0].name,'expensive');assert.equal(minute.quota,921);assert.equal(minute.requests,3);
    assert.deepEqual(minute.latestModel,{name:'latest',quota:1,requests:1,inputTokens:1200,outputTokens:35,cacheReadTokens:200,cacheWriteTokens:12});
    assert.deepEqual(minute.models[1],{name:'latest',quota:21,requests:2,inputTokens:1500,outputTokens:45,cacheReadTokens:300,cacheWriteTokens:17});
    const formatted=formattedWidget('ready',usage({minute}),view);
    assert.equal(formatted.cost,'$9.21');
    assert.deepEqual(formatted.latestModel,{name:'latest',cost:'$0.01',requests:'1',input:'1.2K',output:'35',cacheRead:'200',cacheWrite:'12'});
  }
});

test('latestModel preserves unknown individual tokens and cache even when an earlier request has known counts',()=>{
  const minute=widgetMinute([
    log(1,{other:JSON.stringify({cache_tokens:30,cache_creation_tokens:12})}),
    log(2,{created_at:minuteStart+59,prompt_tokens:NaN,completion_tokens:undefined as unknown as number,other:undefined}),
  ],minuteStart);
  assert.deepEqual(minute.latestModel,{name:'model-a',quota:100,requests:1,inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null});
  assert.deepEqual(formattedWidget('ready',usage({minute}),view).latestModel,{
    name:'model-a',cost:'$1.00',requests:'1',input:'—',output:'—',cacheRead:'—',cacheWrite:'—',
  });
});

test('formattedWidget leaves latestModel absent for empty minutes and older snapshots without the optional field',()=>{
  const {latestModel,...legacyMinute}=widgetMinute([log(1)],minuteStart);
  assert.ok(latestModel);
  for(const data of [undefined,usage({minute:null}),usage({minute:widgetMinute([],minuteStart)}),usage({minute:legacyMinute})]) {
    assert.equal(Object.hasOwn(formattedWidget('ready',data,view),'latestModel'),false);
  }
});

test('excluded rows do not reserve an ID or poison the selected minute',()=>{
  const rows=[
    log(1,{created_at:minuteStart-1,quota:NaN}),log(1),
    log(2,{type:5,quota:NaN}),log(2,{quota:0}),
    log(3,{created_at:minuteStart+60,quota:NaN}),log(3,{quota:50}),
    log(1,{quota:NaN}),
  ];
  const result=widgetMinute(rows,minuteStart);
  assert.equal(result.quota,150);
  assert.equal(result.requests,3);
  assert.equal(result.models[0].requests,3);
});

test('widgetMinute returns an explicit empty minute and keeps distinct free requests',()=>{
  assert.deepEqual(widgetMinute([],minuteStart),{start:minuteStart,end:minuteStart+59,quota:0,requests:0,models:[]});
  const result=widgetMinute([log(0,{quota:0}),log(1,{quota:0}),log(0,{quota:900})],minuteStart);
  assert.equal(result.quota,0);
  assert.equal(result.requests,2);
  assert.equal(result.models[0].inputTokens,240);
});

test('duplicate IDs never charge a second model or add duplicate token counts',()=>{
  const first=log(7,{quota:200,prompt_tokens:10,completion_tokens:5});
  const result=widgetMinute([first,{...first},log(7,{model_name:'other-model',quota:800}),log(8,{quota:0})],minuteStart);
  assert.equal(result.quota,200);
  assert.equal(result.requests,2);
  assert.equal(result.models.length,1);
  assert.equal(result.models[0].inputTokens,130);
  assert.equal(result.models[0].outputTokens,35);
  assert.deepEqual(result.latestModel,{name:'model-a',quota:0,requests:1,inputTokens:120,outputTokens:30,cacheReadTokens:0,cacheWriteTokens:0});
});

test('model totals are independent of row order and equal costs sort consistently',()=>{
  const rows=[log(1,{model_name:'zeta'}),log(2,{model_name:'alpha'}),log(3,{model_name:'largest',quota:200})];
  const result=widgetMinute(rows,minuteStart);
  assert.deepEqual(result.models.map(model=>model.name),['largest','alpha','zeta']);
  assert.deepEqual(widgetMinute([...rows].reverse(),minuteStart),result);
  const unnamed=widgetMinute([log(4,{model_name:''}),log(5,{model_name:''})],minuteStart);
  assert.equal(unnamed.models[0].name,'未知模型');
  assert.equal(unnamed.models[0].requests,2);
});

test('invalid charged quota is rejected rather than represented as a partial valid total',()=>{
  for(const quota of [-1,NaN,Infinity,-Infinity,'100',null,undefined]) {
    const malformed={...log(2),quota} as unknown as UsageLog;
    assert.throws(()=>widgetMinute([log(1),malformed],minuteStart),Error,String(quota));
  }
});

test('absent or malformed cache metadata remains unknown while explicit zeros remain zero',()=>{
  for(const other of [undefined,'not-json','null','[]','{}',JSON.stringify({cache_tokens:-1,cache_creation_tokens:'0'})]) {
    const model=widgetMinute([log(1,{other})],minuteStart).models[0];
    assert.equal(model.cacheReadTokens,null,String(other));
    assert.equal(model.cacheWriteTokens,null,String(other));
  }
  const zero=widgetMinute([log(1,{other:JSON.stringify({cache_tokens:0,cache_creation_tokens:0})})],minuteStart).models[0];
  assert.equal(zero.cacheReadTokens,0);
  assert.equal(zero.cacheWriteTokens,0);
  const billingZero=widgetMinute([log(1,{other:JSON.stringify({billing_tokens:{cr:0,cc:0,cc1h:0}})})],minuteStart).models[0];
  assert.equal(billingZero.cacheReadTokens,0);
  assert.equal(billingZero.cacheWriteTokens,0);
});

test('unknown cache counts propagate per model in either order without hiding known models',()=>{
  const known=log(1,{other:JSON.stringify({cache_tokens:30,cache_creation_tokens:12})});
  const unknown=log(2,{other:undefined});
  const other=log(3,{model_name:'model-b',other:JSON.stringify({cache_tokens:7,cache_creation_tokens:9})});
  for(const rows of [[known,unknown,other],[unknown,known,other]]) {
    const result=widgetMinute(rows,minuteStart);
    assert.equal(result.quota,300);
    assert.equal(result.requests,3);
    assert.deepEqual(result.models.map(model=>[model.name,model.cacheReadTokens,model.cacheWriteTokens]),[
      ['model-a',null,null],['model-b',7,9],
    ]);
  }
});

test('missing input or output counts do not become zero or invalidate unrelated token metrics',()=>{
  for(const field of ['prompt_tokens','completion_tokens'] as const) {
    for(const invalid of [undefined,null,-1,NaN,Infinity,'0']) {
      const missing={...log(2),[field]:invalid} as unknown as UsageLog;
      for(const rows of [[log(1),missing],[missing,log(1)]]) {
        const model=widgetMinute(rows,minuteStart).models[0];
        assert.equal(model[field==='prompt_tokens' ? 'inputTokens' : 'outputTokens'],null);
        assert.equal(model[field==='prompt_tokens' ? 'outputTokens' : 'inputTokens'],field==='prompt_tokens' ? 60 : 240);
        assert.equal(model.cacheReadTokens,0);
        assert.equal(model.quota,200);
        assert.equal(model.requests,2);
      }
    }
  }
});

test('cache aliases and generic/split write totals are alternatives, not additional consumption',()=>{
  const rows=[
    log(1,{other:JSON.stringify({cache_tokens:40,cache_creation_tokens:30,
      cache_creation_tokens_5m:10,cache_creation_tokens_1h:20,billing_tokens:{cr:40,cc:10,cc1h:20}})}),
    log(2,{other:JSON.stringify({billing_tokens:{cr:7,cc:3,cc1h:5}})}),
  ];
  const result=widgetMinute(rows,minuteStart);
  assert.equal(result.quota,200,'cache token categories must not add to the charged quota');
  assert.equal(result.models[0].inputTokens,240,'reported input tokens must not include cache tokens again');
  assert.equal(result.models[0].cacheReadTokens,47);
  assert.equal(result.models[0].cacheWriteTokens,38);
  const explicit=widgetMinute([log(3,{other:JSON.stringify({cache_tokens:0,billing_tokens:{cr:500},cache_creation_tokens:0})})],minuteStart);
  assert.equal(explicit.models[0].cacheReadTokens,0,'an explicit zero must take precedence over a fallback alias');
});

test('formattedWidget shows quota-derived costs and independently formatted token categories',()=>{
  const data=usage({minute:widgetMinute([
    log(1,{prompt_tokens:1200,completion_tokens:35,other:JSON.stringify({cache_tokens:0,cache_creation_tokens:12})}),
    log(2,{model_name:'unknown-cache',quota:50,prompt_tokens:0,completion_tokens:0,other:undefined}),
  ],minuteStart)});
  const result=formattedWidget('ready',data,view);
  assert.equal(result.balance,'$123.45');
  assert.equal(result.cost,'$1.50');
  assert.deepEqual(result.models,[
    {name:'model-a',cost:'$1.00',requests:'1',input:'1.2K',output:'35',cacheRead:'0',cacheWrite:'12'},
    {name:'unknown-cache',cost:'$0.50',requests:'1',input:'0',output:'0',cacheRead:'—',cacheWrite:'—'},
  ]);
  assert.match(result.minuteLabel,/10[/-]02/);
  assert.match(result.minuteLabel,/12:33/);
  assert.equal(result.message,'上一分钟');
  assert.equal(result.updatedAt,fetchedAt);
});

test('minute costs retain small nonzero charges instead of rounding them to zero',()=>{
  const minute=widgetMinute([log(1,{quota:1})],minuteStart);
  const result=formattedWidget('ready',usage({status:{...status,quota_per_unit:500000},minute}),view);
  assert.equal(result.cost,'$0.0000020');
  assert.equal(result.models[0].cost,result.cost);
  assert.equal(result.balance,'$0.02');
});

test('formattedWidget obeys the site currency and conversion rate for totals and models',()=>{
  const cases:[Partial<SiteStatus>,string,string][]=[
    [{quota_display_type:'CNY',usd_exchange_rate:7},'¥864.15','¥7.00'],
    [{quota_display_type:'CUSTOM',custom_currency_symbol:'✾',custom_currency_exchange_rate:2},'✾246.90','✾2.00'],
    [{quota_display_type:'TOKEN'},'12,345.00','100.00'],
  ];
  for(const [currency,balance,cost] of cases) {
    const result=formattedWidget('ready',usage({status:{...status,...currency}}),view);
    assert.equal(result.balance,balance);
    assert.equal(result.cost,cost);
    assert.equal(result.models[0].cost,cost);
  }
});

test('formattedWidget distinguishes no data, unknown balance, zero consumption and historical use',()=>{
  const idle=formattedWidget('idle',undefined,{...view,enabled:false});
  assert.equal(idle.enabled,false);
  assert.equal(idle.balance,'—');
  assert.equal(idle.cost,'—');
  assert.deepEqual(idle.models,[]);
  assert.equal(idle.updatedAt,0);
  const absent=formattedWidget('ready',usage({minute:null,balance:null}),view);
  assert.equal(absent.balance,'—');
  assert.equal(absent.cost,'—');
  assert.deepEqual(absent.models,[]);
  const empty=formattedWidget('ready',usage({balance:0,minute:widgetMinute([],minuteStart)}),view);
  assert.equal(empty.balance,'$0.00');
  assert.equal(empty.cost,'$0.00');
  assert.deepEqual(empty.models,[]);
  const historic=formattedWidget('ready',usage({historical:true}),view);
  assert.equal(historic.historical,true);
  assert.equal(historic.cost,'$1.00');
  assert.equal(historic.message,'最近有消耗的一分钟');
  assert.equal(formattedWidget('ready',usage({loggedIn:false,minute:null,balance:null}),view).message,'登录站点后查看余额和用量');
});

test('phase-only polling and timestamps preserve formatted view identity and dataKey',()=>{
  const data=usage();
  const ready=formattedWidget('ready',data,view);
  for(const phase of ['idle','loading','ready','error'] as const) {
    const next=formattedWidget(phase,{...structuredClone(data),fetchedAt:fetchedAt+60000},view);
    assert.equal(next.viewKey,ready.viewKey,phase);
    assert.equal(next.dataKey,ready.dataKey,phase);
    assert.deepEqual(next.models,ready.models,phase);
    assert.equal(next.balance,ready.balance,phase);
    assert.equal(next.cost,ready.cost,phase);
    assert.equal(next.updatedAt,fetchedAt+60000);
  }
  const styled=formattedWidget('ready',data,{...view,theme:'light',enabled:false});
  assert.equal(styled.viewKey,ready.viewKey);
  assert.equal(styled.dataKey,ready.dataKey);
});

test('dataKey changes when the account, balance, minute or a model token count changes',()=>{
  const data=usage(),key=formattedWidget('ready',data,view).dataKey;
  assert.notEqual(formattedWidget('ready',data,{...view,viewKey:'another-account:view-1'}).dataKey,key);
  assert.notEqual(formattedWidget('ready',{...data,balance:data.balance!+100},view).dataKey,key);
  assert.notEqual(formattedWidget('ready',{...data,minute:widgetMinute([log(1,{created_at:minuteStart+60})],minuteStart+60)},view).dataKey,key);
  const changed=structuredClone(data);
  changed.minute!.models[0].cacheReadTokens=1;
  assert.notEqual(formattedWidget('ready',changed,view).dataKey,key);
  assert.notEqual(formattedWidget('ready',{...data,minute:null},view).dataKey,key);
});

test('polling states retain prior formatted values and provide loading, warning and error messages',()=>{
  const data=usage(),ready=formattedWidget('ready',data,view);
  assert.equal(formattedWidget('loading',data,view).message,'正在同步…');
  assert.equal(formattedWidget('ready',{...data,warnings:['Partial fixture data','Secondary warning']},view).message,'Partial fixture data');
  const failed=formattedWidget('error',data,{...view,error:'Fixture unavailable'});
  assert.equal(failed.message,'Fixture unavailable');
  assert.equal(failed.dataKey,ready.dataKey);
  assert.deepEqual(failed.models,ready.models);
  assert.equal(failed.balance,ready.balance);
});

test('aggregation and formatted snapshots exclude private raw log and account fields',()=>{
  const privateValues=['fixture-private-prompt','fixture-private-token','fixture-private-cookie',
    'fixture-private-request','fixture-private-channel','fixture-private-email'];
  const row=log(1,{
    content:privateValues[0],token_name:privateValues[1],request_id:privateValues[3],channel_name:privateValues[4],
    other:JSON.stringify({cache_tokens:4,cache_creation_tokens:6,accessToken:privateValues[1],
      cookies:[{name:'session',value:privateValues[2]}],metadata:{prompt:privateValues[0]}}),
    request:{authorization:privateValues[1]},metadata:{email:privateValues[5]},
  });
  const minute=widgetMinute([row],minuteStart);
  const data={...usage({minute}),accessToken:privateValues[1],cookies:privateValues[2],
    status:{...status,accessToken:privateValues[1],email:privateValues[5],subscription:{cookie:privateValues[2]}}};
  const result=formattedWidget('ready',data,view);
  for(const value of privateValues) {
    assert.ok(!JSON.stringify(minute).includes(value),`aggregate exposed ${value}`);
    assert.ok(!JSON.stringify(result).includes(value),`formatted state exposed ${value}`);
  }
  for(const key of ['status','siteId','accessToken','cookies','quota_per_unit','content','request_id','token_name','metadata']) {
    assert.ok(!Object.hasOwn(result,key),`raw field ${key} reached the view`);
  }
  assert.equal(result.models[0].cacheRead,'4');
  assert.equal(result.models[0].cacheWrite,'6');
});

test('widget actions accept only supported action objects and return independent values',()=>{
  for(const type of ['close','refresh','open'] as const) {
    const input={type};
    const result=parseWidgetAction(input);
    assert.deepEqual(result,{type});
    assert.notEqual(result,input);
    const untrusted=JSON.parse(JSON.stringify(input));
    assert.deepEqual(parseWidgetAction(untrusted),{type});
  }
});

test('widget actions reject malformed, unsupported and parameter-smuggling inputs',()=>{
  const invalid:unknown[]=[
    null,undefined,false,true,0,1,'open','{"type":"open"}',[],[{type:'open'}],{},
    {type:undefined},{type:null},{type:1},{type:['open']},{type:{}},
    {type:'quit'},{type:'OPEN'},{type:' open'},{type:'open '},{type:'navigate'},
    {type:'open',url:'https://fixture.invalid'},{type:'refresh',force:true},
    {type:'close',path:'fixture-file'},{type:'open',command:'fixture-command'},
    {type:'refresh',payload:undefined},JSON.parse('{"type":"open","__proto__":{"path":"fixture-file"}}'),
  ];
  for(const input of invalid)assert.equal(parseWidgetAction(input),null,JSON.stringify(input));
});

test('widget actions cannot obtain their action type through an inherited property',()=>{
  assert.equal(parseWidgetAction(Object.create({type:'open'})),null);
  const disguised=Object.assign(Object.create({type:'refresh'}),{command:'fixture-command'});
  assert.equal(parseWidgetAction(disguised),null,'an unrelated own key must not legitimize a prototype action');
});

function deferred<T>() {
  let resolve!:(value:T)=>void;
  let reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((accept,fail)=>{resolve=accept;reject=fail;});
  return {promise,resolve,reject};
}

test('WidgetService deduplicates pending refreshes and publishes loading and ready snapshots',async()=>{
  const pending=deferred<WidgetUsage>(),phases:string[]=[];
  let calls=0;
  const service=new WidgetService({
    identity:()=>view.viewKey,now:()=>fetchedAt,
    load:()=>{calls++;return pending.promise;},
    changed:()=>phases.push(service.snapshot().phase),
  });
  assert.deepEqual(service.snapshot(),{phase:'idle'});
  assert.equal(calls,0);
  const jobs=[service.refresh(),service.refresh(),service.refresh()];
  assert.equal(service.snapshot().phase,'loading');
  await Promise.resolve();
  assert.equal(calls,1);
  pending.resolve(usage());
  const results=await Promise.all(jobs);
  assert.ok(results.every(result=>result.phase==='ready' && result.usage?.balance===12345));
  assert.equal(calls,1);
  assert.deepEqual(phases,['loading','ready']);
});

test('WidgetService caches a completed read for 60 seconds and reloads at exact expiry',async()=>{
  let now=(minuteStart+60)*1000,calls=0,changes=0;
  const service=new WidgetService({identity:()=>view.viewKey,now:()=>now,
    load:async()=>{calls++;return usage({fetchedAt:now,balance:calls*100});},changed:()=>{changes++;}});
  await service.refresh();
  assert.equal(service.snapshot().usage?.balance,100);
  now+=59999;
  const cached=await service.refresh();
  assert.equal(cached.usage?.balance,100);
  assert.equal(calls,1);
  assert.equal(changes,2,'a cache hit must not publish a loading transition');
  now++;
  await service.refresh();
  assert.equal(calls,2);
  assert.equal(service.snapshot().usage?.balance,200);
  assert.equal(changes,4);
});

test('WidgetService refreshes at a natural minute boundary even with a younger cache',async()=>{
  let now=(minuteStart+60)*1000+45000,calls=0;
  const service=new WidgetService({identity:()=>view.viewKey,now:()=>now,
    load:async()=>{calls++;return usage({fetchedAt:now,balance:calls*100});}});
  await service.refresh();
  now+=14999;
  await service.refresh();
  assert.equal(calls,1);
  now++;
  await service.refresh();
  assert.equal(calls,2,'the next completed minute must be fetched after only 15 seconds');
  assert.equal(service.snapshot().usage?.balance,200);
  await service.refresh();
  assert.equal(calls,2);
});

test('WidgetService keeps one pending load across a boundary, then reads the new minute',async()=>{
  let now=(minuteStart+60)*1000+59999,calls=0;
  const pending=deferred<WidgetUsage>();
  const service=new WidgetService({identity:()=>view.viewKey,now:()=>now,load:()=>{
    calls++;
    return calls===1 ? pending.promise : Promise.resolve(usage({balance:200,fetchedAt:now}));
  }});
  const first=service.refresh();
  await Promise.resolve();
  assert.equal(calls,1);
  now++;
  const second=service.refresh();
  await Promise.resolve();
  assert.equal(calls,1);
  pending.resolve(usage({balance:100}));
  await Promise.all([first,second]);
  assert.equal(service.snapshot().usage?.balance,100);
  await service.refresh();
  assert.equal(calls,2,'finishing the old bucket must not mark the new bucket as cached');
  assert.equal(service.snapshot().usage?.balance,200);
});

test('WidgetService honors a custom TTL and keeps an expired in-flight load deduplicated',async()=>{
  let now=(minuteStart+60)*1000,calls=0;
  const pending=deferred<WidgetUsage>();
  const service=new WidgetService({identity:()=>view.viewKey,now:()=>now,ttl:1500,
    load:async()=>{calls++;return calls===1 ? usage({fetchedAt:now}) : pending.promise;}});
  await service.refresh();
  now+=1499;
  await service.refresh();
  assert.equal(calls,1);
  now++;
  const first=service.refresh();
  await Promise.resolve();
  assert.equal(calls,2);
  now+=120000;
  const second=service.refresh();
  await Promise.resolve();
  assert.equal(calls,2,'TTL expiry cannot start a second request while the first is pending');
  pending.resolve(usage({balance:20000,fetchedAt:now}));
  await Promise.all([first,second]);
  assert.equal(service.snapshot().usage?.balance,20000);
});

test('WidgetService enforces a minimum interval across minute boundaries for local files',async()=>{
  let now=(minuteStart+60)*1000+59999,calls=0;
  const service=new WidgetService({identity:()=>view.viewKey,now:()=>now,ttl:1000,minInterval:1000,
    load:async()=>{calls++;return usage({fetchedAt:now,balance:calls});}});
  await service.refresh();
  now++;
  await service.refresh();
  assert.equal(calls,1,'a natural minute boundary must not cause a second file read immediately');
  now+=999;
  await service.refresh();
  assert.equal(calls,2,'the local source may read again after one second');
});

test('WidgetService snapshots isolate nested models, warnings and status from caller mutations',async()=>{
  const service=new WidgetService({identity:()=>view.viewKey,load:async()=>usage()});
  await service.refresh();
  const snapshot=service.snapshot();
  snapshot.phase='error';
  snapshot.usage!.siteName='Mutated';
  snapshot.usage!.warnings.push('Injected warning');
  snapshot.usage!.status.quota_per_unit=1;
  snapshot.usage!.minute!.models[0].quota=99999;
  snapshot.usage!.minute!.latestModel!.quota=99999;
  snapshot.usage!.minute!.models.push({...snapshot.usage!.minute!.models[0],name:'Injected model'});
  assert.deepEqual(service.snapshot(),{phase:'ready',usage:usage()});
});

test('WidgetService clears cached account data immediately when its identity changes',async()=>{
  let identity='old-account',calls=0;
  const service=new WidgetService({identity:()=>identity,now:()=>fetchedAt,
    load:async()=>{calls++;return usage({siteId:identity,siteName:identity});}});
  await service.refresh();
  assert.equal(service.snapshot().usage?.siteId,'old-account');
  identity='new-account';
  assert.deepEqual(service.snapshot(),{phase:'idle'});
  await service.refresh();
  assert.equal(calls,2,'the previous account cache must not delay the new account read');
  assert.equal(service.snapshot().usage?.siteId,'new-account');
});

test('WidgetService discards stale success while a new identity has its own pending load',async()=>{
  let identity='old-account',calls=0;
  const old=deferred<WidgetUsage>(),current=deferred<WidgetUsage>();
  const service=new WidgetService({identity:()=>identity,load:()=>{calls++;return calls===1 ? old.promise : current.promise;}});
  const first=service.refresh();
  await Promise.resolve();
  identity='new-account';
  assert.deepEqual(service.snapshot(),{phase:'idle'});
  const second=service.refresh();
  await Promise.resolve();
  assert.equal(calls,2);
  old.resolve(usage({siteId:'old-account',siteName:'Private old account'}));
  await first;
  assert.equal(service.snapshot().phase,'loading');
  assert.equal(service.snapshot().usage,undefined);
  const third=service.refresh();
  await Promise.resolve();
  assert.equal(calls,2,'old completion must not remove the new pending request');
  current.resolve(usage({siteId:'new-account',siteName:'New account'}));
  await Promise.all([second,third]);
  assert.equal(service.snapshot().usage?.siteId,'new-account');
  assert.ok(!JSON.stringify(service.snapshot()).includes('Private old account'));
});

test('WidgetService stale failures and late success cannot overwrite a newer ready account',async()=>{
  for(const failure of [false,true]) {
    let identity='old-account',calls=0;
    const old=deferred<WidgetUsage>();
    const service=new WidgetService({identity:()=>identity,
      load:()=>{calls++;return calls===1 ? old.promise : Promise.resolve(usage({siteId:'new-account'}));}});
    const first=service.refresh();
    await Promise.resolve();
    identity='new-account';
    await service.refresh();
    assert.equal(service.snapshot().usage?.siteId,'new-account');
    if(failure)old.reject(new Error('Private old account failure'));
    else old.resolve(usage({siteId:'old-account'}));
    await first;
    assert.equal(service.snapshot().phase,'ready');
    assert.equal(service.snapshot().usage?.siteId,'new-account');
    assert.equal(service.snapshot().error,undefined);
  }
});

test('WidgetService returning to an account does not reuse or accept its older in-flight request',async()=>{
  let identity='account-a',calls=0;
  const old=deferred<WidgetUsage>(),latest=deferred<WidgetUsage>();
  const service=new WidgetService({identity:()=>identity,load:()=>{calls++;return calls===1 ? old.promise : calls===2 ? Promise.resolve(usage({siteId:'account-b'})) : latest.promise;}});
  const first=service.refresh();await Promise.resolve();
  identity='account-b';await service.refresh();identity='account-a';
  const current=service.refresh();await Promise.resolve();assert.equal(calls,3);
  old.resolve(usage({balance:999}));await first;
  assert.equal(service.snapshot().phase,'loading');assert.equal(service.snapshot().usage,undefined);
  const duplicate=service.refresh();await Promise.resolve();assert.equal(calls,3);
  latest.resolve(usage({balance:100}));await Promise.all([current,duplicate]);
  assert.equal(service.snapshot().usage?.balance,100);
});

test('WidgetService retains last good data on error, redacts failure details and recovers after expiry',async()=>{
  let now=(minuteStart+60)*1000,calls=0;
  const privateError='fixture-private-token fixture-private-cookie https://fixture.invalid/private';
  const service=new WidgetService({identity:()=>view.viewKey,now:()=>now,load:async()=>{
    calls++;
    if(calls===2)throw new Error(privateError);
    return usage({balance:calls*100,fetchedAt:now});
  }});
  await service.refresh();
  const ready=service.snapshot();
  now+=60000;
  const failed=await service.refresh();
  assert.equal(failed.phase,'error');
  assert.deepEqual(failed.usage,ready.usage);
  assert.ok(failed.error);
  assert.ok(!JSON.stringify(failed).includes('fixture-private'));
  assert.ok(!failed.error.includes('https://fixture.invalid'));
  now+=60000;
  await service.refresh();
  assert.equal(calls,3);
  assert.equal(service.snapshot().phase,'ready');
  assert.equal(service.snapshot().usage?.balance,300);
  assert.equal(service.snapshot().error,undefined);
});

test('WidgetService first-load failure has no invented usage and does not leak into another account',async()=>{
  let identity='old-account';
  const service=new WidgetService({identity:()=>identity,load:async()=>{throw new Error('fixture-private-token');}});
  const failed=await service.refresh();
  assert.equal(failed.phase,'error');
  assert.equal(failed.usage,undefined);
  assert.ok(failed.error);
  assert.ok(!failed.error.includes('fixture-private-token'));
  identity='logged-out-account';
  assert.deepEqual(service.snapshot(),{phase:'idle'});
});

test('WidgetService rate-limits failed refreshes within a minute and retries at the next boundary',async()=>{
  let now=(minuteStart+60)*1000+45000,calls=0,changes=0;
  const service=new WidgetService({identity:()=>view.viewKey,now:()=>now,changed:()=>{changes++;},load:async()=>{
    calls++;
    if(calls===2)throw new Error('Transient fixture failure');
    return usage({balance:calls*100,fetchedAt:now});
  }});
  await service.refresh();
  now+=60000;
  const failed=await service.refresh();
  assert.equal(failed.phase,'error');
  assert.equal(failed.usage?.balance,100);
  const changesAfterFailure=changes;
  for(const offset of [0,1,14999]) {
    now=(minuteStart+120)*1000+45000+offset;
    assert.deepEqual(await service.refresh(),failed);
    assert.equal(calls,2);
    assert.equal(changes,changesAfterFailure,'rate-limited polling must not publish another loading state');
  }
  now++;
  await service.refresh();
  assert.equal(calls,3,'failure must not hold back the next natural minute');
  assert.equal(service.snapshot().phase,'ready');
  assert.equal(service.snapshot().usage?.balance,300);
  assert.equal(service.snapshot().error,undefined);
});

test('WidgetService also rate-limits an initial failure without inventing cached usage',async()=>{
  let now=(minuteStart+60)*1000+59999,calls=0;
  const service=new WidgetService({identity:()=>view.viewKey,now:()=>now,load:async()=>{
    calls++;
    throw new Error('Unavailable fixture');
  }});
  const first=await service.refresh();
  assert.equal(first.phase,'error');
  assert.equal(first.usage,undefined);
  const results=await Promise.all([service.refresh(),service.refresh(),service.refresh()]);
  assert.ok(results.every(result=>result.phase==='error' && result.usage===undefined));
  assert.equal(calls,1);
  now++;
  await service.refresh();
  assert.equal(calls,2);
});

async function apiFixture(t:TestContext,rows:UsageLog[],options:{loggedIn?:boolean;legacy?:boolean;historyPages?:UsageLog[][]}={}) {
  // All persistence is temporary, and all HTTP traffic stays on loopback.
  const fixtureParent=path.resolve('.test-data');
  await mkdir(fixtureParent,{recursive:true});
  const root=await mkdtemp(path.join(fixtureParent,'widget-'));
  const seen:URL[]=[];
  const server=createServer((req,res)=>{
    const url=new URL(req.url!,'http://fixture.invalid');
    seen.push(url);
    let data:unknown;
    if(url.pathname==='/api/status')data={...status,accessToken:'fixture-key',email:'fixture-private-email'};
    else if(url.pathname==='/api/user/self')data={id:42,username:'Fixture user',quota:12345,email:'fixture-private-email'};
    else if(url.pathname==='/api/log/self') {
      const start=Number(url.searchParams.get('start_timestamp'));
      const end=Number(url.searchParams.get('end_timestamp'));
      const page=Number(url.searchParams.get('p'));
      const size=Number(url.searchParams.get('page_size'));
      if(start===0 && options.historyPages) {
        data={items:options.historyPages[page-1] || []};
      } else {
        const matching=rows.filter(row=>row.created_at>=start && row.created_at<=end && row.type===2)
          .sort((a,b)=>b.created_at-a.created_at || b.id-a.id);
        const items=matching.slice((page-1)*size,page*size);
        data=options.legacy ? items : {items,total:matching.length};
      }
    } else {
      res.statusCode=500;
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({success:false,message:'Unexpected fixture endpoint'}));
      return;
    }
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({success:true,data}));
  });
  t.after(async()=>{
    if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()));
    assert.equal(path.dirname(root),fixtureParent,'only the isolated fixture directory may be removed');
    await rm(root,{recursive:true,force:true});
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  const address=server.address() as {port:number};
  const store=new SettingsStore(root,{available:()=>true,encrypt:value=>value,decrypt:value=>value});
  await store.load();
  await store.saveSite({id:store.activeSite().id,name:'Fixture',url:`http://127.0.0.1:${address.port}`,
    allowHttp:true,...(options.loggedIn===false ? {} : {userId:42,accessToken:'fixture-key'})});
  return {api:new NewApiClient(store),store,seen};
}

test('widgetUsage selects the previous completed minute and ignores saved model/token filters',async(t)=>{
  const rows=[
    log(1,{token_id:1,quota:100,prompt_tokens:10,completion_tokens:3}),
    log(2,{created_at:minuteStart+59,model_name:'model-b',token_id:2,quota:200,prompt_tokens:20,completion_tokens:4}),
    log(3,{created_at:minuteStart+30,model_name:'free-model',quota:0,prompt_tokens:7,completion_tokens:0}),
    log(4,{created_at:minuteStart-1,quota:800}),
    log(5,{created_at:minuteStart+60,quota:900}),
    log(6,{created_at:minuteStart+10,type:5,quota:1000}),
  ];
  const f=await apiFixture(t,rows);
  await f.store.update({selection:{siteId:f.store.activeSite().id,values:{'statistics.models':['model-a'],'statistics.tokens':['1']}}});
  const result=await f.api.widgetUsage(fetchedAt);
  assert.equal(result.loggedIn,true);
  assert.equal(result.balance,12345);
  assert.equal(result.historical,false);
  assert.equal(result.minute?.start,minuteStart);
  assert.equal(result.minute?.end,minuteStart+59);
  assert.equal(result.minute?.quota,300);
  assert.equal(result.minute?.requests,3);
  assert.deepEqual(result.minute?.models.map(model=>[model.name,model.quota,model.inputTokens,model.outputTokens]),[
    ['model-b',200,20,4],['model-a',100,10,3],['free-model',0,7,0],
  ]);
  const requests=f.seen.filter(url=>url.pathname==='/api/log/self');
  assert.equal(requests.length,1);
  assert.equal(requests[0].searchParams.get('start_timestamp'),String(minuteStart));
  assert.equal(requests[0].searchParams.get('end_timestamp'),String(minuteStart+59));
  assert.equal(requests[0].searchParams.get('type'),'2');
  assert.equal(requests[0].searchParams.get('model_name'),null);
  assert.equal(requests[0].searchParams.get('token_name'),null);
  const formatted=formattedWidget('ready',result,view);
  assert.equal(formatted.cost,'$3.00');
  assert.ok(!JSON.stringify(formatted).includes('fixture-private') && !JSON.stringify(formatted).includes('fixture-key'));
});

test('widgetUsage falls back across midnight to the latest charged minute with all its models',async(t)=>{
  const now=new Date(2026,9,2,0,0,15).getTime();
  const historicalStart=new Date(2026,9,1,23,57).getTime()/1000;
  const completedStart=new Date(2026,9,1,23,59).getTime()/1000;
  const rows=[
    log(1,{created_at:completedStart+59,quota:0}),
    log(2,{created_at:historicalStart+48,model_name:'model-a',quota:200}),
    log(3,{created_at:historicalStart,model_name:'model-b',quota:300}),
    log(4,{created_at:historicalStart+59,model_name:'free-model',quota:0}),
    log(5,{created_at:historicalStart-1,quota:700}),
    log(6,{created_at:now/1000,quota:900}),
  ];
  const f=await apiFixture(t,rows);
  const result=await f.api.widgetUsage(now);
  assert.equal(result.historical,true);
  assert.equal(result.minute?.start,historicalStart);
  assert.equal(result.minute?.end,historicalStart+59);
  assert.equal(result.minute?.quota,500);
  assert.equal(result.minute?.requests,3);
  assert.deepEqual(result.minute?.models.map(model=>model.name),['model-b','model-a','free-model']);
  assert.deepEqual(result.minute?.latestModel,{name:'free-model',quota:0,requests:1,inputTokens:120,outputTokens:30,cacheReadTokens:0,cacheWriteTokens:0});
  assert.equal(formattedWidget('ready',result,view).latestModel?.cost,'$0.00');
  const requests=f.seen.filter(url=>url.pathname==='/api/log/self');
  assert.deepEqual(requests.map(url=>[
    Number(url.searchParams.get('start_timestamp')),Number(url.searchParams.get('end_timestamp')),
  ]),[[completedStart,completedStart+59],[0,completedStart+59],[historicalStart,historicalStart+59]]);
});

test('widgetUsage skips a full page of free history before selecting a charged minute',async(t)=>{
  const historicalStart=minuteStart-3600;
  const free=Array.from({length:100},(_,i)=>log(i+1,{created_at:minuteStart-i,quota:0}));
  const paid=[log(101,{created_at:historicalStart+10,quota:200}),
    log(102,{created_at:historicalStart+20,model_name:'model-b',quota:300})];
  const f=await apiFixture(t,[...free,...paid]);
  const result=await f.api.widgetUsage(fetchedAt);
  assert.equal(result.historical,true);
  assert.equal(result.minute?.start,historicalStart);
  assert.equal(result.minute?.quota,500);
  assert.equal(result.minute?.requests,2);
  assert.deepEqual(f.seen.filter(url=>url.pathname==='/api/log/self' && url.searchParams.get('start_timestamp')==='0')
    .map(url=>url.searchParams.get('p')),['1','2']);
});

test('widgetUsage reads every page of the selected minute without multiplying cached requests',async(t)=>{
  const rows=Array.from({length:150},(_,i)=>log(i+1,{created_at:minuteStart+i%60,
    model_name:i%2 ? 'model-a' : 'model-b',quota:2,prompt_tokens:10,completion_tokens:5}));
  const f=await apiFixture(t,rows);
  const result=await f.api.widgetUsage(fetchedAt);
  assert.equal(result.minute?.quota,300);
  assert.equal(result.minute?.requests,150);
  assert.deepEqual(result.minute?.models.map(model=>[model.quota,model.requests,model.inputTokens,model.outputTokens]),[
    [150,75,750,375],[150,75,750,375],
  ]);
  assert.deepEqual(result.minute?.latestModel,{name:'model-a',quota:2,requests:1,inputTokens:10,outputTokens:5,cacheReadTokens:0,cacheWriteTokens:0});
  const again=await f.api.widgetUsage(fetchedAt);
  assert.deepEqual(again.minute,result.minute);
  assert.deepEqual(f.seen.filter(url=>url.pathname==='/api/log/self').map(url=>url.searchParams.get('p')),['1','2']);
});

test('widgetUsage supports legacy log arrays without dropping another model',async(t)=>{
  const f=await apiFixture(t,[log(1),log(2,{model_name:'model-b',quota:200})],{legacy:true});
  const result=await f.api.widgetUsage(fetchedAt);
  assert.equal(result.minute?.quota,300);
  assert.equal(result.minute?.requests,2);
  assert.deepEqual(result.minute?.models.map(model=>model.name),['model-b','model-a']);
});

test('widgetUsage reports no charged minute after exhausting free history',async(t)=>{
  const f=await apiFixture(t,[log(1,{quota:0}),log(2,{created_at:minuteStart-60,quota:0})]);
  const result=await f.api.widgetUsage(fetchedAt);
  assert.equal(result.loggedIn,true);
  assert.equal(result.balance,12345);
  assert.equal(result.minute,null);
  assert.equal(result.historical,false);
  assert.deepEqual(result.warnings,[]);
  assert.equal(f.seen.filter(url=>url.pathname==='/api/log/self').length,2);
});

test('widgetUsage bounds history search and warns instead of claiming complete empty history',async(t)=>{
  const historyPages=Array.from({length:20},(_,page)=>Array.from({length:100},(_,i)=>
    log(page*100+i+1,{created_at:minuteStart-page*100-i,quota:0})));
  const f=await apiFixture(t,[],{historyPages});
  const result=await f.api.widgetUsage(fetchedAt);
  assert.equal(result.minute,null);
  assert.equal(result.historical,false);
  assert.equal(result.warnings.length,1);
  assert.match(result.warnings[0],/2,000/);
  const requests=f.seen.filter(url=>url.pathname==='/api/log/self' && url.searchParams.get('start_timestamp')==='0');
  assert.equal(requests.length,20);
  assert.equal(requests.at(-1)?.searchParams.get('p'),'20');
});

test('widgetUsage without login only reads public status and exposes unknown balance and minute',async(t)=>{
  const f=await apiFixture(t,[log(1)],{loggedIn:false});
  const result=await f.api.widgetUsage(fetchedAt);
  assert.equal(result.loggedIn,false);
  assert.equal(result.balance,null);
  assert.equal(result.minute,null);
  assert.equal(result.historical,false);
  assert.deepEqual(f.seen.map(url=>url.pathname),['/api/status']);
  const formatted=formattedWidget('ready',result,view);
  assert.equal(formatted.balance,'—');
  assert.equal(formatted.cost,'—');
  assert.ok(!JSON.stringify(formatted).includes('fixture-private') && !JSON.stringify(formatted).includes('fixture-key'));
});
