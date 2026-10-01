import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {newerVersion,validateUpdate,UpdateService,type NativeUpdateInfo,type UpdateEngine} from '../electron/services/updates';
import {releaseNotesText,shouldPromptUpdate} from '../shared/updates';

const version='0.4.21',name='Lumi-'+version+'-x64.exe',bytes=Buffer.from('Isolated updater fixture; never executable.'),hash=createHash('sha512').update(bytes).digest('base64');
function info():NativeUpdateInfo{return {version,tag:'v'+version,files:[{url:name,sha512:hash,size:bytes.length}]};}
async function fixture(options:{info?:NativeUpdateInfo;blocking?:boolean;badHash?:boolean;badSize?:boolean;installFailure?:boolean;}={}){
  const root=await mkdtemp(path.resolve('.test-data/updates-')),file=path.join(root,name);let checks=0,downloads=0,installs=0,errorListener=(e:Error)=>{};
  const engine:UpdateEngine={
    check:async()=>{checks++;return options.info || info();},
    download:async(signal,progress)=>{downloads++;progress(4,bytes.length);if(options.blocking)await new Promise<void>((_,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});if(signal.aborted)reject(new DOMException('Cancelled','AbortError'));});await writeFile(file,options.badSize ? 'short' : options.badHash ? Buffer.alloc(bytes.length) : bytes);progress(bytes.length,bytes.length);return file;},
    install:()=>{installs++;if(options.installFailure)throw new Error('Failed to spawn');},onError:listener=>{errorListener=listener;return()=>{};},
  };
  const service=new UpdateService({version:'0.4.20',enabled:true,engine});
  return {file,service,error:(e:Error)=>errorListener(e),get checks(){return checks;},get downloads(){return downloads;},get installs(){return installs;}};
}
test('NSIS metadata accepts only stable Lumi installer, bounded size and complete SHA-512',async()=>{
  assert.ok(newerVersion('v0.4.21','0.4.20'));assert.ok(newerVersion('0.4.100','0.4.99'));assert.ok(!newerVersion('0.4.20','0.4.20'));assert.throws(()=>newerVersion('0.4.21-beta','0.4.20'));
  assert.equal(validateUpdate(info()).size,bytes.length);
  for(const invalid of [{...info(),tag:'v0.4.22'},{...info(),packages:{}},{...info(),version:'0.4.21-beta'},{...info(),files:[]},{...info(),files:[{...info().files[0],url:'https://untrusted.invalid/app.exe'}]},{...info(),files:[{...info().files[0],sha512:'invalid'}]},{...info(),files:[{...info().files[0],size:0}]},{...info(),files:[{...info().files[0],size:1024*1024*1024}]}])assert.throws(()=>validateUpdate(invalid));
  const disabled=new UpdateService({version:'0.4.20',enabled:false});assert.equal((await disabled.check()).phase,'unsupported');await assert.rejects(disabled.restart());
  const f=await fixture();await Promise.all([f.service.check(),f.service.check()]);assert.equal(f.checks,1);assert.equal(f.service.snapshot().phase,'available');
});
test('download progress, verification and restart use one task and never install on download or check',async()=>{
  const f=await fixture(),phases:string[]=[];f.service.subscribe(s=>phases.push(s.phase));await f.service.check();
  const [a,b]=await Promise.all([f.service.download(),f.service.download()]);assert.equal(a.phase,'ready');assert.equal(b.phase,'ready');assert.equal(f.downloads,1);assert.equal(f.installs,0);assert.ok(phases.includes('verifying'));
  assert.deepEqual(await readFile(await f.service.readyFile()),bytes);await f.service.check();assert.equal(f.checks,1);
  await Promise.all([f.service.restart(),f.service.restart()]);assert.equal(f.installs,1);assert.equal(f.service.snapshot().phase,'installing');f.service.close();
});
test('changed, partial or corrupted installer is rejected again before restart',async()=>{
  for(const option of [{badSize:true},{badHash:true}]){const f=await fixture(option);await f.service.check();assert.equal((await f.service.download()).phase,'error');await assert.rejects(f.service.restart());assert.equal(f.installs,0);}
  const f=await fixture();await f.service.check();await f.service.download();await writeFile(f.file,'changed');await assert.rejects(f.service.restart(),/已变更/);assert.equal(f.installs,0);
});
test('cancellation returns to available and install errors keep the UI actionable',async()=>{
  const f=await fixture({blocking:true});await f.service.check();const stop=f.service.subscribe(s=>{if(s.received>0 && s.phase==='downloading')f.service.cancel();});assert.equal((await f.service.download()).phase,'available');stop();assert.equal(f.installs,0);
  const failed=await fixture({installFailure:true});await failed.service.check();await failed.service.download();await assert.rejects(failed.service.restart(),/未能启动/);assert.equal(failed.service.snapshot().phase,'error');
  const asyncFailure=await fixture();await asyncFailure.service.check();await asyncFailure.service.download();await asyncFailure.service.restart();asyncFailure.error(new Error('spawn failed'));assert.equal(asyncFailure.service.snapshot().phase,'error');
});
test('release notes are bounded plain text and only the target version is displayed',async()=>{
  const raw='<h2>改进</h2><ul><li>更流畅 &amp; 更清晰</li></ul><script>untrusted()</script><style>body{display:none}</style>\r后续';
  assert.equal(releaseNotesText(raw),'改进\n\n- 更流畅 & 更清晰\n\n后续');
  assert.equal(releaseNotesText([{version,note:'当前说明'},{version:'0.4.22',note:'其他版本'}],version),'当前说明');assert.equal(releaseNotesText({html:'anything'}),'');assert.equal(releaseNotesText('x'.repeat(80000)).length,32000);
  const f=await fixture({info:{...info(),releaseNotes:raw}});await f.service.check();assert.equal(f.service.snapshot().releaseNotes,releaseNotesText(raw));assert.equal(f.downloads,0);
});
test('skipped, hidden or already reviewed versions do not reprompt, while the next version does',()=>{
  const state={phase:'available' as const,currentVersion:'0.4.20',version,received:0,total:100};
  assert.ok(shouldPromptUpdate(state,'','',''));assert.ok(!shouldPromptUpdate(state,version,'',''));assert.ok(!shouldPromptUpdate(state,'',version,''));assert.ok(!shouldPromptUpdate(state,'','',version));assert.ok(shouldPromptUpdate({...state,version:'0.4.22'},version,'',version));assert.ok(!shouldPromptUpdate({...state,phase:'downloading'},'','',''));
});
test('differential transfer bytes remain separate from verified installer size, including full-download fallback',async()=>{
  const root=await mkdtemp(path.resolve('.test-data/differential-update-')),file=path.join(root,name),observed:{phase:string;received:number;total:number;packageSize?:number}[]=[];
  const engine:UpdateEngine={check:async()=>info(),download:async(_signal,progress)=>{progress(2,10);progress(10,10);await writeFile(file,bytes);return file;},install:()=>{},onError:()=>()=>{}};
  const service=new UpdateService({version:'0.4.20',enabled:true,engine});service.subscribe(s=>observed.push(s));await service.check();await service.download();
  assert.ok(observed.some(s=>s.phase==='downloading' && s.received===2 && s.total===10 && s.packageSize===bytes.length));
  assert.ok(observed.some(s=>s.phase==='verifying' && s.received===10 && s.total===10));assert.equal(service.snapshot().packageSize,bytes.length);assert.equal(service.snapshot().phase,'ready');
  engine.download=async(_signal,progress)=>{progress(4,8);progress(5,bytes.length);progress(bytes.length,bytes.length);await writeFile(file,bytes);return file;};
  const fallback=new UpdateService({version:'0.4.20',enabled:true,engine});await fallback.check();await fallback.download();assert.equal(fallback.snapshot().received,bytes.length);assert.equal(fallback.snapshot().total,bytes.length);
  engine.download=async(_signal,progress)=>{progress(bytes.length+10,bytes.length+10);await writeFile(file,bytes);return file;};
  const overhead=new UpdateService({version:'0.4.20',enabled:true,engine});await overhead.check();await overhead.download();assert.equal(overhead.snapshot().received,bytes.length+10);assert.equal(overhead.snapshot().total,bytes.length+10);assert.equal(overhead.snapshot().packageSize,bytes.length,'network transfer must not be clamped to installer size');
});
test('cache maintenance blocks new update operations and exposes in-flight/ready package protection',async()=>{
  const f=await fixture();await f.service.check();let release!:()=>void;
  const maintenance=f.service.withCacheMaintenance(()=>new Promise<void>(resolve=>{release=resolve;}));
  assert.equal((await f.service.check()).phase,'available');await assert.rejects(f.service.download(),/缓存/);await assert.rejects(f.service.restart(),/缓存/);
  release();await maintenance;await f.service.download();assert.deepEqual(f.service.cacheProtection().files,[f.file]);
  await f.service.withCacheMaintenance(async()=>{await assert.rejects(f.service.restart(),/缓存/);});
  await f.service.restart();assert.equal(f.service.cacheProtection().busy,true);f.service.close();
  const downloading=await fixture({blocking:true});await downloading.service.check();const job=downloading.service.download();assert.equal(downloading.service.cacheProtection().busy,true);downloading.service.cancel();await job;
});
