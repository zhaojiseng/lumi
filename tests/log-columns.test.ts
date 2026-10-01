import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ACTIVITY_COLUMN_IDS,ACTIVITY_COLUMN_LABELS,DEFAULT_ACTIVITY_COLUMNS,LOG_COLUMN_LABELS,normalizeActivityColumns,visibleActivityColumns,normalizeLogColumns,visibleLogColumns,migrateLogColumns,requestReasoningEffort} from '../shared/logs';
import {DEFAULT_LOG_COLUMNS,DEFAULT_PREFERENCES,LOG_COLUMN_IDS,type UsageLog} from '../shared/types';
import {selectionValue} from '../shared/selections';
import {SettingsStore} from '../electron/services/store';

const log:UsageLog={id:1,created_at:1,type:2,model_name:'gpt-fixture',token_name:'fixture-token',prompt_tokens:1500,completion_tokens:1200,quota:1,use_time:4,is_stream:true,group:'standard'};

test('reasoning effort reads explicit Chat Completions and Responses fields from real log metadata',()=>{
  const cases:[unknown,string][]=[
    [{reasoning_effort:'high'},'high'],
    [{reasoning:{effort:'medium'}},'medium'],
    [{reasoning_effort:' none '},' none '],
    [{reasoning:{effort:'minimal'}},'minimal'],
    [{request:{reasoning_effort:'low'}},'low'],
    [{request:{reasoning:{effort:'xhigh'}}},'xhigh'],
    [{metadata:{reasoning_effort:'high'}},'high'],
    [{metadata:{reasoning:{effort:'provider-specific'}}},'provider-specific'],
    [{request:{metadata:{reasoning:{effort:'medium'}}}},'medium'],
    [{metadata:{request:{reasoning_effort:'low'}}},'low'],
  ];
  for(const [metadata,expected] of cases){
    const row={...log,other:JSON.stringify(metadata)},before=structuredClone(row);
    assert.equal(requestReasoningEffort(row),expected);
    assert.deepEqual(row,before);
  }
  assert.equal(requestReasoningEffort(Object.assign({},log,{other:{reasoning:{effort:'high'}}})), 'high');
});

test('forwarded top-level request metadata works without changing New API normalization',()=>{
  for(const metadata of [{reasoning_effort:'high'},{reasoning:{effort:'high'}},{request:{reasoning_effort:'high'}},{metadata:{reasoning:{effort:'high'}}}]){
    assert.equal(requestReasoningEffort({...log,...metadata}),'high');
  }
  assert.equal(requestReasoningEffort({...log,reasoning_effort:'low',other:'{"reasoning_effort":"high"}'}),'low');
  assert.equal(requestReasoningEffort({...log,other:'{"reasoning_effort":"medium","reasoning":{"effort":"high"},"request":{"reasoning_effort":"low"}}'}),'medium');
  assert.equal(requestReasoningEffort({...log,other:'{"reasoning_effort":false,"reasoning":{"effort":"high"}}'}),'high');
});

test('unknown reasoning stays unknown instead of coming from model names, prompts, token counts or defaults',()=>{
  const unrelated={model_reasoning_effort:'high',effort:'high',reasoning:'high',reasoning_tokens:1200,completion_tokens_details:{reasoning_tokens:900},defaults:{reasoning_effort:'high'},messages:[{role:'user',content:'reasoning_effort: high'}],prompt:'reasoning.effort = high',model_name:'gpt-fixture-high'};
  for(const other of [undefined,'not-json','null','[]','"high"',JSON.stringify(unrelated),'{"reasoning_effort":" ","reasoning":{"effort":1}}','{"reasoning_effort":false,"reasoning":{"effort":null}}','{"request":"high","metadata":[]}']){
    assert.equal(requestReasoningEffort({...log,model_name:'gpt-fixture-high',other}),null);
  }
  assert.equal(requestReasoningEffort({...log,type:5,other:'{"reasoning":{"effort":"low"}}'}),'low');
});

test('arbitrary reasoning strings are returned unchanged, including case, whitespace and long values',()=>{
  const effort='  <script>"&provider-'+ 'AbC'.repeat(2000) +'\nCUSTOM </script>  ';
  assert.equal(requestReasoningEffort({...log,other:JSON.stringify({reasoning_effort:effort})}),effort);
  assert.equal(requestReasoningEffort({...log,reasoning:{effort}}),effort);
});

test('request reasoning is selectable by default and only previous default layouts migrate',()=>{
  assert.ok(LOG_COLUMN_IDS.includes('reasoning'));
  assert.ok(DEFAULT_LOG_COLUMNS.includes('reasoning'));
  assert.equal(LOG_COLUMN_LABELS.reasoning,'思考强度');
  assert.deepEqual(normalizeLogColumns(['reasoning','bad','model','reasoning',null]),['reasoning','model']);
  assert.deepEqual(visibleLogColumns(['reasoning','input','cacheRead','cacheWrite']),['reasoning','input','cacheWrite']);
  const previous=['time','model','token','input','output','cacheRead','cost','duration','speed','channel','status'];
  const older=['time','model','token','input','output','cacheRead','cacheWrite','cost','duration','speed','channel','status'];
  for(const columns of [previous,older]){
    const before=[...columns];assert.deepEqual(migrateLogColumns(columns),DEFAULT_LOG_COLUMNS);assert.deepEqual(columns,before);
  }
  assert.deepEqual(migrateLogColumns(['model','time','cost','status']),['model','time','cost','status']);
  assert.deepEqual(migrateLogColumns(['reasoning','token','input']),['reasoning','token','input']);
});

test('recent activity keeps the current seven visible default columns independently of request columns',()=>{
  assert.deepEqual(visibleActivityColumns(undefined),['model','input','output','cost','speed','timing','status']);
  assert.ok(!DEFAULT_ACTIVITY_COLUMNS.includes('reasoning'));
  for(const value of [undefined,null,{},false,'reasoning',[],['bad',1,null]]){
    const normalized=normalizeActivityColumns(value);
    assert.deepEqual(normalized,DEFAULT_ACTIVITY_COLUMNS);
    assert.notEqual(normalized,DEFAULT_ACTIVITY_COLUMNS);
  }
  for(const id of ['reasoning','token','channel','cacheWrite','time','duration'] as const){
    assert.ok(ACTIVITY_COLUMN_IDS.includes(id));assert.ok(ACTIVITY_COLUMN_LABELS[id]);
  }
});

test('recent column normalization preserves custom order, removes invalid duplicates and merges only overlapping fields',()=>{
  const saved=['status','reasoning','bad','cacheRead','status','token',false],before=[...saved];
  assert.deepEqual(normalizeActivityColumns(saved),['status','reasoning','cacheRead','token']);
  assert.deepEqual(saved,before);
  assert.deepEqual(visibleActivityColumns(['status','cacheRead','input','cacheWrite','firstToken','timing','reasoning']),['status','input','cacheWrite','timing','reasoning']);
  assert.deepEqual(visibleActivityColumns(['cacheRead','firstToken','output']),['cacheRead','firstToken','output']);
  assert.deepEqual(visibleActivityColumns(['reasoning']),['reasoning']);
  assert.deepEqual(visibleActivityColumns(['time','duration','channel']),['time','duration','channel']);
});

test('recent activity columns persist as per-site string arrays without replacing request columns or other selections',async()=>{
  await mkdir('.test-data',{recursive:true});
  const root=await mkdtemp(path.resolve('.test-data/activity-columns-')),cipher={available:()=>true,encrypt:(s:string)=>s,decrypt:(s:string)=>s};
  const store=new SettingsStore(root,cipher);await store.load();
  const siteA=store.activeSite().id,key='overview.activityColumns',columnsA=['reasoning','token','cacheWrite','status'];
  await Promise.all([
    store.update({selection:{siteId:siteA,values:{[key]:columnsA,'overview.metric':'requests'}}}),
    store.update({logColumns:['model','input','output']}),
  ]);
  const second=await store.saveSite({name:'Isolated fixture',url:'https://activity-fixture.invalid',allowHttp:false}),siteB=second.activeSiteId;
  assert.deepEqual(normalizeActivityColumns(selectionValue<string[]>(second,key,DEFAULT_ACTIVITY_COLUMNS,Array.isArray)),DEFAULT_ACTIVITY_COLUMNS);
  const columnsB=['time','duration','channel'];
  await store.update({selection:{siteId:siteB,values:{[key]:columnsB}}});
  const reload=new SettingsStore(root,cipher);await reload.load();
  assert.deepEqual(selectionValue<string[]>(reload.preferences,key,DEFAULT_ACTIVITY_COLUMNS,Array.isArray),columnsB);
  assert.deepEqual(reload.preferences.logColumns,['model','input','output']);
  await reload.update({activeSiteId:siteA});
  assert.deepEqual(selectionValue<string[]>(reload.preferences,key,DEFAULT_ACTIVITY_COLUMNS,Array.isArray),columnsA);
  assert.equal(selectionValue(reload.preferences,'overview.metric','cost'),'requests');
  const persisted=JSON.parse(await readFile(path.join(root,'settings.json'),'utf8')).preferences;
  assert.deepEqual(persisted.viewSelections[siteA][key],columnsA);
  assert.deepEqual(persisted.viewSelections[siteB][key],columnsB);
  assert.ok(!('selection' in persisted));
});

test('request and recent activity render escaped raw reasoning with full titles, unknown placeholders and error details buttons',async()=>{
  await mkdir('.test-data',{recursive:true});
  const root=await mkdtemp(path.resolve('.test-data/log-columns-render-')),outfile=path.join(root,'components.mjs'),require=createRequire(import.meta.url);
  await build({
    stdin:{contents:"export {AppContext} from './src/context'; export {RequestLogTable,RequestDetail} from './src/components/RequestLogs'; export {RecentActivity} from './src/components/RecentActivity';",resolveDir:path.resolve('.')},
    outfile,bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},
    plugins:[{name:'fixture-svg-text',setup(builder){
      builder.onResolve({filter:/\.svg\?raw$/},args=>({path:require.resolve(args.path.slice(0,-4)),namespace:'fixture-svg-text'}));
      builder.onLoad({filter:/.*/,namespace:'fixture-svg-text'},async args=>({contents:await readFile(args.path,'utf8'),loader:'text'}));
    }}],
  });
  const {AppContext,RequestLogTable,RequestDetail,RecentActivity}=await import(pathToFileURL(outfile).href);
  const effort='<script>"&provider-'+ 'AbC'.repeat(1000) +'</script>',row={...log,type:5,other:JSON.stringify({reasoning_effort:effort,status_code:429})};
  const escaped=effort.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const preferences={...structuredClone(DEFAULT_PREFERENCES),logColumns:['reasoning']},status={system_name:'Fixture',quota_per_unit:500000},catalog={models:[],groupRatio:{},usableGroups:{},autoGroups:[],vendors:[]};
  const render=(component:any,props:object)=>renderToStaticMarkup(createElement(AppContext.Provider,{value:{preferences}},createElement(component,props)));
  const request=render(RequestLogTable,{logs:{items:[row],total:1,page:1,pageSize:15},busy:false,page:1,onPage:()=>{},onDetail:()=>{},status,catalog});
  const recent=render(RecentActivity,{logs:[row],status,catalog,columns:['reasoning','status']});
  const detail=render(RequestDetail,{log:row,status,onClose:()=>{}});
  for(const html of [request,recent,detail]){
    assert.ok(html.includes('思考强度'));assert.ok(html.includes('title="'+escaped+'"'));assert.ok(html.includes('>'+escaped+'<'));
    assert.ok(!html.includes('<script>'));assert.ok(!html.includes('推理强度'));
  }
  assert.match(request,/class="log-text-cell"/);
  assert.match(recent,/class="activity-text-cell"/);
  assert.match(detail,/class="request-reasoning-value"/);
  assert.match(recent,/<button[^>]+aria-label="查看请求 1 错误详情"[^>]*>429 · 错误<\/button>/);
  const missing=render(RecentActivity,{logs:[log],status,catalog,columns:['reasoning']});
  assert.match(missing,/<span class="activity-text-cell">—<\/span>/);
  const defaultView=render(RecentActivity,{logs:[log],status,catalog});
  assert.equal((defaultView.match(/<th(?:\s|>)/g) || []).length,7);
  assert.ok(defaultView.includes('输入 / 缓存命中'));assert.ok(defaultView.includes('首字 / 后续'));assert.ok(defaultView.includes('图标'));
  const cacheOnly=render(RecentActivity,{logs:[{...log,other:'{"cache_tokens":0}'}],status,catalog,columns:['cacheRead']});
  assert.ok(cacheOnly.includes('缓存读取'));assert.match(cacheOnly,/<td>0<\/td>/);
});
