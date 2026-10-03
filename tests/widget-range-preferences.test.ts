import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SettingsStore} from '../electron/services/store';
import {DEFAULT_PREFERENCES,type LumiBridge,type PreferencePatch,type Preferences} from '../shared/types';
import {WIDGET_PERIODS} from '../shared/widget-period';

const invalidPeriods=[undefined,null,false,0,59,61,2592001,'60','minute','24h',NaN,Infinity,{},[]];
const invalidInputModes=[undefined,null,false,true,0,1,'','TOTAL','Uncached','cached',{},[],['uncached']];
const cipher={available:()=>false,encrypt:()=>{throw new Error('Fixture must not store credentials');},decrypt:()=>{throw new Error('Fixture must not read credentials');}};
async function isolatedStore(t:TestContext) {
  const parent=path.resolve('.test-data');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(path.join(parent,'widget-range-preferences-'));
  t.after(async()=>{assert.equal(path.dirname(root),parent);await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const store=new SettingsStore(root,cipher);await store.load();
  return {root,store,file:path.join(root,'settings.json')};
}

test('old and invalid desktop widget ranges load as one minute',async(t)=>{
  const {root,store,file}=await isolatedStore(t);assert.equal(store.preferences.widgetPeriod,60);
  for(const widgetPeriod of invalidPeriods){
    await writeFile(file,JSON.stringify({preferences:{widgetPeriod}}));
    const restored=new SettingsStore(root,cipher);await restored.load();
    assert.equal(restored.preferences.widgetPeriod,60,String(widgetPeriod));
  }
});

test('every desktop range survives data-source switches and restart as one shared preference',async(t)=>{
  const {root,store,file}=await isolatedStore(t);
  for(const {value} of WIDGET_PERIODS){
    await store.update({widgetDataSource:'api',widgetPeriod:value});
    await store.update({widgetDataSource:'local'});
    const local=new SettingsStore(root,cipher);await local.load();
    assert.equal(local.preferences.widgetDataSource,'local');assert.equal(local.preferences.widgetPeriod,value);
    await local.update({widgetDataSource:'api',theme:'dark'});
    const api=new SettingsStore(root,cipher);await api.load();
    assert.equal(api.preferences.widgetDataSource,'api');assert.equal(api.preferences.widgetPeriod,value);
    assert.equal(JSON.parse(await readFile(file,'utf8')).preferences.widgetPeriod,value);
  }
});

test('desktop range patches normalize before returning and persisting',async(t)=>{
  const {store,file}=await isolatedStore(t);
  for(const widgetPeriod of invalidPeriods){
    await store.update({widgetPeriod:'latest'});
    const saved=await store.update({widgetPeriod} as unknown as PreferencePatch);
    assert.equal(saved.widgetPeriod,60,String(widgetPeriod));
    assert.equal(JSON.parse(await readFile(file,'utf8')).preferences.widgetPeriod,60);
  }
});

// Load the actual browser bridge into independent JS contexts sharing only fixture storage.
const bridgeBundle=build({entryPoints:['src/bridge.ts'],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'});
async function browser(storage=new Map<string,string>()) {
  const module={exports:{} as {bridge:LumiBridge}},result=await bridgeBundle;
  runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,structuredClone,window:{},
    localStorage:{getItem:(key:string)=>storage.get(key) ?? null,setItem:(key:string,value:string)=>storage.set(key,value)}});
  return {bridge:module.exports.bridge,storage};
}

test('browser ranges survive data-source switches and a fresh bridge instance',async()=>{
  const {bridge,storage}=await browser();assert.equal((await bridge.bootstrap()).preferences.widgetPeriod,60);
  for(const {value} of WIDGET_PERIODS){
    await bridge.updatePreferences({widgetDataSource:'api',widgetPeriod:value});
    await bridge.updatePreferences({widgetDataSource:'local'});
    const local=(await browser(storage)).bridge;
    assert.equal((await local.bootstrap()).preferences.widgetPeriod,value);
    assert.equal((await local.bootstrap()).preferences.widgetDataSource,'local');
    await local.updatePreferences({widgetDataSource:'api'});
    assert.equal((await (await browser(storage)).bridge.bootstrap()).preferences.widgetPeriod,value);
    assert.equal(JSON.parse(storage.get('lumi-ui-preferences')!).widgetPeriod,value);
  }
  const unsubscribe=bridge.onLocalUsageProgress(()=>{assert.fail('browser progress subscription must be empty');});
  assert.equal(typeof unsubscribe,'function');unsubscribe();
});

test('browser migration and invalid patches consistently fall back to one minute',async()=>{
  for(const widgetPeriod of invalidPeriods){
    const storage=new Map([['lumi-ui-preferences',JSON.stringify({widgetPeriod})]]),{bridge}=await browser(storage);
    assert.equal((await bridge.bootstrap()).preferences.widgetPeriod,60,String(widgetPeriod));
    await bridge.updatePreferences({widgetPeriod:'latest'});
    assert.equal((await bridge.updatePreferences({widgetPeriod} as unknown as PreferencePatch)).widgetPeriod,60);
    assert.equal(JSON.parse(storage.get('lumi-ui-preferences')!).widgetPeriod,60);
  }
});

// Bundle the real settings and Select components; replace only app context and its busy hook.
const settingsBundle=build({entryPoints:['src/components/WidgetSettings.tsx'],bundle:true,platform:'node',format:'cjs',write:false,
  external:['react','react/jsx-runtime','lucide-react','../../../src/context'],loader:{'.svg':'text'},logLevel:'silent'});
async function settings(options:{preferences?:Preferences;desktop?:boolean;save?:(patch:PreferencePatch)=>Promise<Preferences>}={}) {
  let busy=false;
  const patches:PreferencePatch[]=[],errors:string[]=[],context={preferences:options.preferences || structuredClone(DEFAULT_PREFERENCES),
    bootstrap:{desktop:options.desktop ?? true},toast:(message:string)=>errors.push(message),
    updatePreferences:async(patch:PreferencePatch)=>{patches.push(patch);context.preferences=options.save ? await options.save(patch) : {...context.preferences,...patch};}};
  const result=await settingsBundle,module={exports:{} as {default:()=>React.ReactElement}},nodeRequire=createRequire(import.meta.url);
  runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require:(name:string)=>name==='../../../src/context' ? {useApp:()=>context} :
    name==='react' ? {...React,useState:()=>[busy,(next:boolean)=>{busy=next;}]} : nodeRequire(name)});
  function tree(){return module.exports.default();}
  function select(label:string){
    let found:React.ReactElement<any>|undefined;
    function walk(node:React.ReactNode){React.Children.forEach(node,child=>{if(React.isValidElement(child)){const element=child as React.ReactElement<any>;if(element.props.label===label)found=element;walk(element.props.children);}});}
    walk(tree());assert.ok(found,label);return found.props;
  }
  return {context,patches,errors,select,html:()=>renderToStaticMarkup(tree())};
}

test('range Select uses the shared options and saves latest or numeric seconds without changing source',async(t)=>{
  const {store,root}=await isolatedStore(t),ui=await settings({preferences:store.preferences,save:patch=>store.update(patch)});
  for(const source of ['api','local']){
    if(source==='local')await ui.select('浮窗数据源').onChange(source);
    const select=ui.select('浮窗统计范围');assert.equal(select.disabled,false);
    assert.deepEqual(React.Children.toArray(select.children).map(child=>{
      assert.ok(React.isValidElement(child));const props=child.props as {value:string|number;children:string};return {value:props.value,label:props.children};
    }),WIDGET_PERIODS.map(option=>({value:option.value,label:option.value==='latest' ? '最近一次模型调用' : option.label})));
    for(const value of ['latest',180,2592000] as const){
      await ui.select('浮窗统计范围').onChange(String(value));
      assert.deepEqual({...ui.patches.at(-1)},{widgetPeriod:value});
      assert.equal(ui.select('浮窗统计范围').value,value);
      const restored=new SettingsStore(root,cipher);await restored.load();
      assert.equal(restored.preferences.widgetPeriod,value);assert.equal(restored.preferences.widgetDataSource,source);
    }
  }
  assert.equal(ui.errors.length,0);
});

test('range controls disable during saving and report failures while keeping the saved selection',async()=>{
  let reject!:(error:Error)=>void;
  const ui=await settings({save:()=>new Promise((_resolve,no)=>{reject=no;})}),pending=ui.select('浮窗统计范围').onChange('300');
  assert.equal(ui.select('浮窗统计范围').disabled,true);assert.equal(ui.select('浮窗数据源').disabled,true);
  await ui.select('浮窗统计范围').onChange('latest');assert.equal(ui.patches.length,1);
  reject(new Error('Fixture save failure'));await pending;
  assert.equal(ui.select('浮窗统计范围').disabled,false);assert.equal(ui.select('浮窗统计范围').value,60);
  assert.deepEqual(ui.errors,['Fixture save failure']);
  const web=await settings({desktop:false});assert.equal(web.select('浮窗统计范围').disabled,true);
  const legacy=await settings({preferences:{...structuredClone(DEFAULT_PREFERENCES),widgetPeriod:'24h'} as unknown as Preferences});
  assert.equal(legacy.select('浮窗统计范围').value,60);
});

test('local explanations cover online estimates, account balance, incremental reads and reused minute history',async()=>{
  const ui=await settings({preferences:{...structuredClone(DEFAULT_PREFERENCES),widgetDataSource:'local'}}),html=ui.html();
  assert.match(html,/最近消费按当前站点的线上模型价格估算/);assert.match(html,/余额来自在线账户/);
  assert.match(html,/每秒增量读取会话追加内容/);assert.match(html,/切换范围复用最近 30 天的分钟聚合/);
  assert.match(html,/站点 API 与本地会话共用此范围/);assert.match(html,/切换后自动保存，下次启动会恢复/);
  assert.match(html,/>最近一次模型调用<\/option>/);assert.match(html,/最近一次按模型调用统计/);
  assert.doesNotMatch(html,/只显示\s*Tokens|余额\s*[—-]|<optgroup/);
  assert.match((await settings()).html(),/API 模式按完整分钟同步所选范围的消费/);
  const latest=await settings({preferences:{...structuredClone(DEFAULT_PREFERENCES),widgetPeriod:'latest'}});
  assert.match(latest.html(),/API 模式展示最近一次模型调用的消费/);
});

test('old and invalid desktop input modes load as total input including cache reads',async(t)=>{
  const {root,store,file}=await isolatedStore(t);assert.equal(store.preferences.widgetInputMode,'total');
  assert.equal(DEFAULT_PREFERENCES.widgetInputMode,'total');
  for(const widgetInputMode of invalidInputModes){
    await writeFile(file,JSON.stringify({preferences:{widgetInputMode}}));
    const restored=new SettingsStore(root,cipher);await restored.load();
    assert.equal(restored.preferences.widgetInputMode,'total',String(widgetInputMode));
  }
});

test('both desktop input modes survive source/range changes and restart without changing account preferences',async(t)=>{
  const {root,store,file}=await isolatedStore(t),siteId=store.preferences.activeSiteId;
  await store.update({lowBalanceThreshold:12,selection:{siteId,values:{'models.group':'fixture-group'}}});
  for(const widgetInputMode of ['uncached','total'] as const){
    await store.update({widgetDataSource:'api',widgetPeriod:'latest',widgetInputMode});
    await store.update({widgetDataSource:'local',widgetPeriod:2592000});
    const local=new SettingsStore(root,cipher);await local.load();
    assert.equal(local.preferences.widgetInputMode,widgetInputMode);assert.equal(local.preferences.widgetDataSource,'local');
    await local.update({widgetDataSource:'api',widgetPeriod:60});
    const api=new SettingsStore(root,cipher);await api.load();
    assert.equal(api.preferences.widgetInputMode,widgetInputMode);assert.equal(api.preferences.widgetPeriod,60);
    assert.equal(api.preferences.activeSiteId,siteId);assert.equal(api.preferences.lowBalanceThreshold,12);
    assert.equal(api.preferences.viewSelections[siteId]['models.group'],'fixture-group');
    assert.equal(JSON.parse(await readFile(file,'utf8')).preferences.widgetInputMode,widgetInputMode);
  }
});

test('invalid desktop input mode patches normalize before returning and persisting',async(t)=>{
  const {store,file}=await isolatedStore(t);
  for(const widgetInputMode of invalidInputModes){
    await store.update({widgetInputMode:'uncached'});
    const saved=await store.update({widgetInputMode} as unknown as PreferencePatch);
    assert.equal(saved.widgetInputMode,'total',String(widgetInputMode));
    assert.equal(JSON.parse(await readFile(file,'utf8')).preferences.widgetInputMode,'total');
  }
});

test('browser input modes survive source/range changes and fresh bridge instances',async()=>{
  const {bridge,storage}=await browser();assert.equal((await bridge.bootstrap()).preferences.widgetInputMode,'total');
  for(const widgetInputMode of ['uncached','total'] as const){
    await bridge.updatePreferences({widgetDataSource:'api',widgetPeriod:'latest',widgetInputMode});
    await bridge.updatePreferences({widgetDataSource:'local',widgetPeriod:2592000});
    const local=(await browser(storage)).bridge;
    assert.equal((await local.bootstrap()).preferences.widgetInputMode,widgetInputMode);
    await local.updatePreferences({widgetDataSource:'api',widgetPeriod:60});
    const preferences=(await (await browser(storage)).bridge.bootstrap()).preferences;
    assert.equal(preferences.widgetInputMode,widgetInputMode);assert.equal(preferences.widgetPeriod,60);
    assert.equal(JSON.parse(storage.get('lumi-ui-preferences')!).widgetInputMode,widgetInputMode);
  }
});

test('browser migration and invalid input mode patches fall back to total',async()=>{
  for(const widgetInputMode of invalidInputModes){
    const storage=new Map([['lumi-ui-preferences',JSON.stringify({widgetInputMode})]]),{bridge}=await browser(storage);
    assert.equal((await bridge.bootstrap()).preferences.widgetInputMode,'total',String(widgetInputMode));
    await bridge.updatePreferences({widgetInputMode:'uncached'});
    assert.equal((await bridge.updatePreferences({widgetInputMode} as unknown as PreferencePatch)).widgetInputMode,'total');
    assert.equal(JSON.parse(storage.get('lumi-ui-preferences')!).widgetInputMode,'total');
  }
});

test('input mode Select saves only the display preference for API and local modes and restores after restart',async(t)=>{
  const {store,root}=await isolatedStore(t);
  await store.update({widgetPeriod:180,lowBalanceThreshold:25});
  const ui=await settings({preferences:store.preferences,save:patch=>store.update(patch)});
  for(const widgetDataSource of ['api','local'] as const){
    if(widgetDataSource==='local')await ui.select('浮窗数据源').onChange(widgetDataSource);
    const select=ui.select('浮窗输入计算口径');assert.equal(select.disabled,false);
    assert.deepEqual(React.Children.toArray(select.children).map(child=>{
      assert.ok(React.isValidElement(child));const props=child.props as {value:string;children:string};return {value:props.value,label:props.children};
    }),[{value:'total',label:'包含缓存读取'},{value:'uncached',label:'仅未命中输入'}]);
    for(const widgetInputMode of ['uncached','total'] as const){
      await ui.select('浮窗输入计算口径').onChange(widgetInputMode);
      assert.deepEqual({...ui.patches.at(-1)},{widgetInputMode});
      assert.equal(ui.select('浮窗输入计算口径').value,widgetInputMode);
      const restored=new SettingsStore(root,cipher);await restored.load();
      assert.equal(restored.preferences.widgetInputMode,widgetInputMode);assert.equal(restored.preferences.widgetDataSource,widgetDataSource);
      assert.equal(restored.preferences.widgetPeriod,180);assert.equal(restored.preferences.lowBalanceThreshold,25);
    }
  }
  assert.equal(ui.errors.length,0);
});

test('input mode saving disables widget controls, reports failures and retains the saved mode',async()=>{
  let reject!:(error:Error)=>void;
  const ui=await settings({save:()=>new Promise((_resolve,no)=>{reject=no;})}),pending=ui.select('浮窗输入计算口径').onChange('uncached');
  for(const label of ['浮窗输入计算口径','浮窗统计范围','浮窗数据源'])assert.equal(ui.select(label).disabled,true);
  await ui.select('浮窗输入计算口径').onChange('total');await ui.select('浮窗统计范围').onChange('latest');
  await ui.select('浮窗数据源').onChange('local');assert.equal(ui.patches.length,1);
  reject(new Error('Fixture input mode save failure'));await pending;
  assert.equal(ui.select('浮窗输入计算口径').disabled,false);assert.equal(ui.select('浮窗输入计算口径').value,'total');
  assert.deepEqual(ui.errors,['Fixture input mode save failure']);
  const web=await settings({desktop:false});assert.equal(web.select('浮窗输入计算口径').disabled,true);
  for(const widgetInputMode of [undefined,'invalid']){
    const legacy=await settings({preferences:{...structuredClone(DEFAULT_PREFERENCES),widgetInputMode} as unknown as Preferences});
    assert.equal(legacy.select('浮窗输入计算口径').value,'total');
  }
});

test('input mode descriptions explain cache-read inclusion, cache-write exclusion and unchanged billing for both sources',async()=>{
  for(const widgetDataSource of ['api','local'] as const){
    const html=(await settings({preferences:{...structuredClone(DEFAULT_PREFERENCES),widgetDataSource}})).html();
    assert.match(html,/包含缓存读取/);assert.match(html,/仅未命中输入/);assert.match(html,/仅未命中输入会扣除缓存读取/);
    assert.match(html,/两种口径均不含缓存写入/);assert.match(html,/API 与本地共用，仅改变浮窗输入显示，不改变计费/);
    assert.match(html,/选择后自动保存，下次启动会恢复/);
  }
});
