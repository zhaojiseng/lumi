import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';

test('Chromium browses the complete fixed snapshot, isolates late requests, escapes raw chunks, cancels, and fits narrow screens',{timeout:35000},async t=>{
  let electron:string;try{electron=createRequire(import.meta.url)('electron');}catch{return t.skip('Electron runtime unavailable');}
  if(!existsSync(electron))return t.skip('Electron runtime unavailable');
  const base=path.resolve('.test-data');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'local-session-renderer-'));
  t.after(async()=>{const relative=path.relative(base,root);assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));if(process.env.KEEP_TEST_FIXTURE==='1'){console.log('LOCAL_SESSION_FIXTURE '+path.join(root,'manual.html'));return;}await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const renderer=await build({stdin:{contents:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {LocalSessions} from './src/components/LocalSessions';
    import {LocalSessionDetails} from './src/components/LocalSessionDetails';
    import {LocalUsageProgress} from './src/components/LocalUsageProgress';
    const summary={id:'session-a',tool:'codex',model:'gpt-fixture',startedAt:1790816700,updatedAt:1790816760,inputTokens:11,outputTokens:7,cacheReadTokens:5,cacheWriteTokens:3,requests:251,metadata:{title:'摘要标题',project:'fixture project',cwd:'fixture/cwd',sessionKey:'fixture-key'}};
    function Fixture(){
      const [scope,setScope]=useState({session:summary,query:{range:7},accountKey:'a'}),[open,setOpen]=useState(false);
      window.fixture.changeScope=patch=>setScope(previous=>({...previous,...patch}));
      window.fixture.open=()=>setOpen(true);window.fixture.close=()=>setOpen(false);
      return <main><LocalUsageProgress progress={{requestId:'uuid',phase:'read',filesDone:1,filesTotal:100,bytesRead:600,bytesTotal:1000}}/>
        <LocalSessions sessions={Array.from({length:65},(_,i)=>({...summary,id:'summary-'+i,updatedAt:summary.updatedAt+i,metadata:{...summary.metadata,sessionKey:'fixture-key-'+i}}))} tool="all" scope="list" busy={false} stale={false} onOpen={()=>setOpen(true)}/>
        {open && <LocalSessionDetails {...scope} onClose={()=>setOpen(false)}/>}</main>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `,resolveDir:process.cwd(),sourcefile:'local-session-fixture.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(root,'renderer.js'),renderer.outputFiles[0].contents);
  const css=await Promise.all(['src/styles.css','src/workbench.css','src/theme.css','src/local-usage.css'].map(file=>readFile(file,'utf8')));
  await writeFile(path.join(root,'fixture.css'),css.join('\n')+'\nbody{min-width:0;overflow:auto}main{padding:20px;min-width:0}');
  await writeFile(path.join(root,'fixture.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script>
    // Every session, event and response is synthetic. No real session directory or preload is used.
    window.fixture={loads:[],records:[],contents:[],raws:[],releases:[],listeners:new Set(),savedListeners:[],order:[],errors:[]};
    window.addEventListener('error',event=>fixture.errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
    const pending=(queue,input)=>new Promise((resolve,reject)=>queue.push({input,resolve,reject}));
    window.lumi={
      onLocalSessionProgress:listener=>{fixture.order.push('subscribe');fixture.listeners.add(listener);fixture.savedListeners.push(listener);return()=>fixture.listeners.delete(listener);},
      loadLocalSession:input=>{fixture.order.push('load');fixture.listeners.forEach(listener=>listener({requestId:input.requestId,phase:'read',bytesRead:1024,totalBytes:8192,calls:0}));return pending(fixture.loads,input);},
      localSessionRecords:input=>pending(fixture.records,input),localSessionContent:input=>pending(fixture.contents,input),localSessionRaw:input=>pending(fixture.raws,input),
      releaseLocalSession:async input=>{fixture.releases.push(input);},localSessionDetails:()=>{throw new Error('Unexpected legacy scan');}
    };
  </script><script src="renderer.js"></script></body></html>`);
  const manualScript=String.raw`
    // Standalone manual QA: resolve only the synthetic queues used by this fixture.
    const seen=new WeakSet();let nextSnapshot=0;
    const later=(queue,respond)=>queue.forEach(request=>{if(seen.has(request))return;seen.add(request);respond(request);});
    const manualRecord=i=>({id:'r-'+i,created_at:1790816700+i,model:'fixture-model-'+i,inputTokens:1100,outputTokens:700,cacheReadTokens:500,cacheWriteTokens:0,contextTokens:128000,reasoning:'high'});
    const manualEvent=i=>({id:'e-'+i,createdAt:i===1 ? 1e100 : 1790816700+i,role:['user','assistant','tool','system','event'][i%5],kind:i%5===4 ? 'usage / turn_context' : 'message',text:i===0 ? '用户消息 <img src=x onerror="window.sessionXss=1">\n多行中文🙂 预览' : i%5===2 ? '工具输入与返回结果\n{"command":"fixture only"}' : '完整会话内容 '+i,toolName:i%5===2 ? 'fixture_tool' : undefined,toolCallId:i%5===2 ? 'fixture-call-'+i : undefined,details:[{label:'真实字段',value:'fixture value '+i}],truncated:i===0,rawBytes:i===0 ? 196608 : 250});
    setInterval(()=>{
      later(fixture.loads,request=>{
        const snapshotId='manual-snapshot-'+(++nextSnapshot),requestId=request.input.requestId;
        [2048,4096,6144,8192].forEach((bytesRead,i)=>setTimeout(()=>fixture.listeners.forEach(listener=>listener({requestId,phase:i===3 ? 'complete' : 'read',bytesRead,totalBytes:8192,calls:i===3 ? 251 : i*30})),100*(i+1)));
        setTimeout(()=>request.resolve({snapshotId,metadata:{title:'本机会话详情 · 官方标题 fixture',project:'手动 QA 项目',cwd:'fixture/cyg',sessionKey:'manual-fixture-session',gitBranch:'fixture-branch',version:'1.0',source:'synthetic fixture',firstPrompt:'检查分页、消息、工具与原始记录。\n<script>window.sessionXss=1</script>'},total:251,eventTotal:43,totalBytes:8192,warnings:['这些记录全部为合成数据，不会读取真实会话。']}),500);
      });
      later(fixture.records,request=>setTimeout(()=>{const {page,pageSize}=request.input;request.resolve({items:Array.from({length:Math.max(0,Math.min(pageSize,251-(page-1)*pageSize))},(_,i)=>manualRecord(250-(page-1)*pageSize-i)),total:251,page,pageSize});},80));
      later(fixture.contents,request=>setTimeout(()=>{const {page,pageSize,recordId}=request.input,total=recordId ? 23 : 43;request.resolve({items:Array.from({length:Math.max(0,Math.min(pageSize,total-(page-1)*pageSize))},(_,i)=>manualEvent((page-1)*pageSize+i)),total,page,pageSize,association:recordId ? 'turn' : 'session'});},80));
      later(fixture.raws,request=>setTimeout(()=>{const {offset,eventId}=request.input,totalBytes=eventId==='e-0' ? 196608 : 250,nextOffset=Math.min(totalBytes,offset+65536);const prefix='原始记录 · 字节 '+offset+' <script>window.sessionXss=1</script>\n';request.resolve({text:prefix+'x'.repeat(Math.max(0,nextOffset-offset-new TextEncoder().encode(prefix).length)),offset,totalBytes,...nextOffset<totalBytes ? {nextOffset} : {}});},80));
      if(!fixture.manualOpened && fixture.open){fixture.manualOpened=true;fixture.open();}
    },30);
  `;
  await writeFile(path.join(root,'manual.html'),(await readFile(path.join(root,'fixture.html'),'utf8')).replace('</body>','<script>'+manualScript.replaceAll('</script>','<\\/script>')+'</script></body>'));
  await writeFile(path.join(root,'audit.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs');
for(const name of ['userData','sessionData','logs','crashDumps']){const folder=path.join(__dirname,name);fs.mkdirSync(folder,{recursive:true});app.setPath(name,folder);}
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:900,height:720,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  await win.loadFile(path.join(__dirname,'fixture.html'));
  const result=await win.webContents.executeJavaScript('('+async function audit(){
    const check=(value,message)=>{if(!value)throw new Error(message);};
    const until=async(predicate,label='Local UI did not settle')=>{const deadline=performance.now()+4000;while(!predicate()){if(performance.now()>deadline)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,10));}};
    const settle=()=>new Promise(resolve=>setTimeout(resolve,30));
    const click=(label,scope=document)=>{const button=[...scope.querySelectorAll('button')].find(node=>node.textContent===label);check(button,'Missing '+label);check(!button.disabled,'Disabled '+label);button.click();};
    const details=()=>document.querySelector('.local-session-details'),rows=()=>document.querySelectorAll('.local-session-records tbody tr'),events=()=>document.querySelectorAll('.local-session-event');
    const pageNav=()=>document.querySelector('.local-session-pagination');
    const record=i=>({id:'r-'+i,created_at:1790816700+i,model:'model-'+i,inputTokens:11,outputTokens:7,cacheReadTokens:5,cacheWriteTokens:3,contextTokens:128000,reasoning:'high'});
    const snapshot=(id,total=251)=>({snapshotId:id,metadata:{title:'官方索引标题 '+id,project:'fixture project',sessionKey:'fixture-session-key',cwd:'fixture/cwd',gitBranch:'fixture-branch',firstPrompt:'<img src=x onerror="window.sessionXss=1">',version:'1.0',source:'fixture'},total,eventTotal:43,totalBytes:8192,warnings:['<script>window.sessionXss=1</script>']});
    const records=(index,total=251)=>{const request=fixture.records[index],page=request.input.page;request.resolve({items:Array.from({length:Math.max(0,Math.min(50,total-(page-1)*50))},(_,i)=>record(total-1-(page-1)*50-i)),total,page,pageSize:50});};
    const event=i=>({id:'e-'+i,createdAt:i===1 ? 1e100 : 1790816700+i,role:['user','assistant','tool','system','event'][i%5],kind:i%5===4 ? 'usage / turn_context' : 'message',text:i===0 ? '<img src=x onerror="window.sessionXss=1">' : 'event text '+i,toolName:i%5===2 ? 'fixture_tool' : undefined,toolCallId:i%5===2 ? 'fixture-call-'+i : undefined,details:[{label:'<svg onload="window.sessionXss=1">',value:'真实字段 '+i}],truncated:i===0,rawBytes:i===0 ? 131072 : 200});
    const contents=(index,total=43,association='session')=>{const request=fixture.contents[index],page=request.input.page;request.resolve({items:Array.from({length:Math.max(0,Math.min(20,total-(page-1)*20))},(_,i)=>event((page-1)*20+i)),total,page,pageSize:20,association});};
    async function finishLoad(index,id,total=251){const before=fixture.records.length;fixture.loads[index].resolve(snapshot(id,total));await until(()=>fixture.records.length===before+1);records(before,total);await until(()=>!details().textContent.includes('正在读取调用分页'));}
    async function callPage(label){const before=fixture.records.length;click(label,pageNav());await until(()=>fixture.records.length===before+1);records(before);await until(()=>rows().length>0);}
    async function contentPage(label,total=43,association='session'){const before=fixture.contents.length;click(label,pageNav());await until(()=>fixture.contents.length===before+1);contents(before,total,association);await until(()=>!details().textContent.includes('正在读取会话内容'));}
    await until(()=>document.querySelectorAll('.local-sessions tbody tr').length===20);
    const bar=document.querySelector('.local-usage-progress-track'),fill=bar.querySelector('i');check(Math.abs(fill.getBoundingClientRect().width/bar.getBoundingClientRect().width-.6)<.01,'Progress uses bytes');
    click('再显示 20 条');await until(()=>document.querySelectorAll('.local-sessions tbody tr').length===40);
    click('查看详情');await until(()=>fixture.loads.length===1);check(fixture.order.join(',')==='subscribe,load','Subscribe before invoke');check(fixture.records.length===0,'No pages before snapshot');
    check(details().textContent.includes('0 条调用') && details().textContent.includes('12.5%'),'Byte progress can precede parsed calls');
    await finishLoad(0,'snapshot-a');check(rows().length===50,'One initial record page');check(rows()[0].textContent.includes('model-250'),'Records retain backend DESC order');
    const modal=details().getBoundingClientRect();check(modal.left>=0 && modal.right<=innerWidth,'Modal fits viewport');
    check(details().textContent.includes('官方索引标题 snapshot-a') && details().textContent.includes('fixture-session-key'),'Title and identity from snapshot');
    const seen=new Set([...rows()].map(row=>row.querySelector('td:nth-child(2)').textContent));
    for(let page=2;page<=6;page++){await callPage('下一页');check(rows().length===(page===6 ? 1 : 50),'Only current 50-record page');[...rows()].forEach(row=>seen.add(row.querySelector('td:nth-child(2)').textContent));}
    check(seen.size===251 && seen.has('model-0'),'Every record remains reachable beyond 200');check(!details().textContent.includes('继续读取'),'No continuation button');
    const jump=pageNav().querySelector('input');jump.value='3';const beforeJump=fixture.records.length;pageNav().querySelector('form').requestSubmit();await until(()=>fixture.records.length===beforeJump+1);check(fixture.records[beforeJump].input.page===3,'Jump to requested page');records(beforeJump);await until(()=>rows().length===50);
    const fail=fixture.records.length;click('下一页',pageNav());await until(()=>fixture.records.length===fail+1);fixture.records[fail].reject(new Error('records page failed'));await until(()=>details().textContent.includes('records page failed'));
    click('重试',details());await until(()=>fixture.records.length===fail+2);check(fixture.records[fail+1].input.page===4,'Retry same call page');records(fail+1);await until(()=>rows().length===50);
    click('查看相关内容');await until(()=>fixture.contents.length===1);check(fixture.contents[0].input.recordId==='r-100','Selected call association');contents(0,23,'turn');await until(()=>events().length===20);
    check(details().textContent.includes('同轮上下文') && details().textContent.includes('无法精确对应这一次模型请求'),'Turn association is not an exact request');
    await contentPage('下一页',23,'turn');check(events().length===3,'Related content pagination');
    click('调用记录');await until(()=>rows().length===50);check(pageNav().textContent.includes('第 4 / 6 页'),'Returning preserves call page');
    click('完整会话内容');await until(()=>fixture.contents.length===3);check(fixture.contents[2].input.recordId===undefined && fixture.contents[2].input.pageSize===20,'Full session query');contents(2);await until(()=>events().length===20);
    check(events()[0].textContent.includes('用户消息') && events()[1].textContent.includes('助手回复') && events()[2].textContent.includes('fixture_tool') && events()[4].textContent.includes('usage / turn_context'),'Messages/tools/usage events render');
    check(events()[1].textContent.includes('时间未知') && !events()[1].querySelector('time').hasAttribute('datetime'),'Invalid timestamp stays safe');
    check(!details().querySelector('img,[onload],[onerror]') && !window.sessionXss,'Event/metadata/warning text stays escaped');
    const rawStart=fixture.raws.length;click('查看原始记录 · 128 KB',events()[0]);await until(()=>fixture.raws.length===rawStart+1);
    const firstText='<script>window.sessionXss=1</script>原始中文🙂'+'a'.repeat(65400);fixture.raws[rawStart].resolve({text:firstText,offset:0,nextOffset:65536,totalBytes:131072});await until(()=>document.querySelector('.local-session-raw pre'));
    const first=document.querySelector('.local-session-raw pre');check(first.textContent===firstText && !first.querySelector('script'),'Raw UTF8 is preserved and escaped');check(first.textContent.length<=65536,'One bounded raw chunk');
    check(getComputedStyle(first).fontFamily===getComputedStyle(details()).fontFamily,'Raw text uses the unified font');
    click('下一块',details());await until(()=>fixture.raws.length===rawStart+2);check(fixture.raws[rawStart+1].input.offset===65536,'Raw next offset');check(!document.querySelector('.local-session-raw pre'),'Previous chunk is removed while fetching');
    fixture.raws[rawStart+1].reject(new Error('raw page failed'));await until(()=>details().textContent.includes('raw page failed'));click('重试',details());await until(()=>fixture.raws.length===rawStart+3);check(fixture.raws[rawStart+2].input.offset===65536,'Retry raw offset');
    fixture.raws[rawStart+2].resolve({text:'second raw block',offset:65536,totalBytes:131072});await until(()=>document.querySelector('.local-session-raw pre')?.textContent==='second raw block');
    check(!document.querySelector('.local-session-raw').textContent.includes('原始中文'),'Raw chunks replace instead of accumulating');click('上一块',details());await until(()=>fixture.raws.length===rawStart+4);check(fixture.raws[rawStart+3].input.offset===0,'Raw previous offset');
    click('收起原始记录',details());fixture.raws[rawStart+3].resolve({text:'late hidden raw',offset:0,totalBytes:131072});await settle();check(!details().textContent.includes('late hidden raw'),'Hidden raw response ignored');
    await contentPage('下一页');check(events().length===20,'Content second page');const failContent=fixture.contents.length;click('下一页',pageNav());await until(()=>fixture.contents.length===failContent+1);fixture.contents[failContent].reject(new Error('content page failed'));await until(()=>details().textContent.includes('content page failed'));
    click('重试',details());await until(()=>fixture.contents.length===failContent+2);check(fixture.contents[failContent+1].input.page===3,'Retry content page');contents(failContent+1);await until(()=>events().length===3);check(events()[2].textContent.includes('event text 42'),'Content last page reachable');
    check(fixture.loads.length===1,'Paging and view switches do not rescan');
    // Account, query and session each cancel their old owner and isolate pending page work.
    click('调用记录');await until(()=>rows().length===50);const oldRecords=fixture.records.length;click('下一页',pageNav());await until(()=>fixture.records.length===oldRecords+1);
    fixture.changeScope({accountKey:'b'});await until(()=>fixture.loads.length===2);check(rows().length===0,'Account switch clears calls');check(fixture.releases.some(input=>input.snapshotId==='snapshot-a'),'Account switch releases snapshot');
    fixture.records[oldRecords].resolve({items:[record(999)],total:251,page:5,pageSize:50});await finishLoad(1,'snapshot-b');check(!details().textContent.includes('model-999'),'Late record page ignored');
    const staleContent=fixture.contents.length;click('完整会话内容');await until(()=>fixture.contents.length===staleContent+1);fixture.changeScope({query:{range:1}});await until(()=>fixture.loads.length===3);fixture.contents[staleContent].reject(new Error('late content error'));await finishLoad(2,'snapshot-c');check(!details().textContent.includes('late content error'),'Late content error ignored');
    const newContent=fixture.contents.length;click('完整会话内容');await until(()=>fixture.contents.length===newContent+1);contents(newContent);await until(()=>events().length===20);const staleRaw=fixture.raws.length;click('查看原始记录 · 128 KB',events()[0]);await until(()=>fixture.raws.length===staleRaw+1);
    fixture.changeScope({session:{id:'session-b',tool:'claude',model:'claude-fixture',startedAt:1790816700,updatedAt:1790816760,metadata:{firstPrompt:'无调用的会话'}}});await until(()=>fixture.loads.length===4);fixture.raws[staleRaw].resolve({text:'late session raw',offset:0,totalBytes:20});await finishLoad(3,'snapshot-d',0);check(!details().textContent.includes('late session raw'),'Late raw response ignored');
    check(details().textContent.includes('没有模型调用记录'),'Zero filtered calls still have content');const emptyContent=fixture.contents.length;click('完整会话内容');await until(()=>fixture.contents.length===emptyContent+1);contents(emptyContent);await until(()=>events().length===20);
    // Direct unmount releases the loaded snapshot and ignores pending content.
    const unmountedContent=fixture.contents.length;click('下一页',pageNav());await until(()=>fixture.contents.length===unmountedContent+1);fixture.close();await until(()=>!details());check(fixture.releases.some(input=>input.snapshotId==='snapshot-d'),'Unmount releases snapshot');contents(unmountedContent);await settle();check(!details(),'Late unmounted response does not reopen UI');
    fixture.open();await until(()=>fixture.loads.length===5);const canceled=fixture.loads[4];click('取消载入',details());await until(()=>details().textContent.includes('已取消会话载入'));check(fixture.releases.some(input=>input.requestId===canceled.input.requestId),'Cancel releases request');
    const count=fixture.records.length;canceled.resolve(snapshot('canceled-late'));await until(()=>fixture.releases.some(input=>input.snapshotId==='canceled-late'));check(fixture.records.length===count,'Canceled load cannot page');
    click('重新载入');await until(()=>fixture.loads.length===6);const closed=fixture.loads[5];click('关闭',details());await until(()=>!details());closed.resolve(snapshot('closed-late'));await until(()=>fixture.releases.some(input=>input.snapshotId==='closed-late'));check(fixture.listeners.size===0,'All progress subscriptions released');
    fixture.open();await until(()=>fixture.loads.length===7);await finishLoad(6,'responsive-snapshot',0);const responsiveContent=fixture.contents.length;click('完整会话内容');await until(()=>fixture.contents.length===responsiveContent+1);contents(responsiveContent);await until(()=>events().length===20);
    check(fixture.errors.length===0,'Renderer errors: '+fixture.errors.join(', '));check(!window.sessionXss,'No script execution');
    return {reachable:seen.size,loads:fixture.loads.length,rawChunks:fixture.raws.length,modalWidth:modal.width};
  }.toString()+')()');
  win.setContentSize(390,740);
  await new Promise(resolve=>setTimeout(resolve,80));
  const narrow=await win.webContents.executeJavaScript('('+function(){
    const modal=document.querySelector('.local-session-details'),rect=modal.getBoundingClientRect(),elements=[...modal.querySelectorAll('.local-session-identity,.local-session-event,.local-session-pagination')];
    if(rect.left<0 || rect.right>innerWidth+1)throw new Error('Narrow modal overflows viewport');
    if(elements.some(node=>node.getBoundingClientRect().right>rect.right+1 || node.getBoundingClientRect().left<rect.left-1))throw new Error('Narrow content overflows modal');
    const text=modal.querySelector('.local-session-event-text');if(getComputedStyle(text).fontFamily!==getComputedStyle(modal).fontFamily)throw new Error('Content font mismatch');
    return {viewport:innerWidth,width:rect.width,height:rect.height,clientWidth:document.documentElement.clientWidth,devicePixelRatio};
  }.toString()+')()');
  console.log('LOCAL_SESSION_RENDERER_RESULT '+JSON.stringify({...result,narrow}));win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1);});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(root,'audit.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,stderr);
  const line=stdout.split(/\r?\n/).find(line=>line.startsWith('LOCAL_SESSION_RENDERER_RESULT '));assert.ok(line,stdout+stderr);
  const result=JSON.parse(line.slice('LOCAL_SESSION_RENDERER_RESULT '.length));assert.equal(result.reachable,251);assert.equal(result.loads,7);
  // BrowserWindow's DIP size rounds through the Windows display scale. The DOM bounds above
  // are checked against the actual CSS viewport; the requested width can differ by one pixel.
  assert.ok(Math.abs(result.narrow.viewport-390)<=1);assert.ok(result.narrow.width<=result.narrow.viewport);
  t.diagnostic('Viewport measurement '+JSON.stringify(result.narrow));
});
