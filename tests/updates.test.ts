import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {newerVersion,UpdateService} from '../electron/services/updates';

const version='0.4.19',tag='v'+version,name='Lumi-'+version+'-x64.exe';
const file=Buffer.from('Isolated update fixture; never executable.');
const hash=createHash('sha256').update(file).digest('hex');
const base='https://github.com/zhaojiseng/lumi/releases/download/'+tag+'/';
function release(){return {tag_name:tag,draft:false,prerelease:false,html_url:'https://github.com/zhaojiseng/lumi/releases/tag/'+tag,assets:[{name,size:file.length,digest:'sha256:'+hash,browser_download_url:base+name},{name:'SHA256SUMS.txt',size:hash.length+name.length+3,browser_download_url:base+'SHA256SUMS.txt'}]};}
async function fixture(options:{badHash?:boolean;badSize?:boolean;redirect?:string;invalidRelease?:boolean;blocking?:boolean;}={}){
  const root=await mkdtemp(path.resolve('.test-data/updates-')),requests:{url:string;headers:Headers;}[]=[];
  const transport:typeof fetch=async(input,init)=>{
    const url=String(input);requests.push({url,headers:new Headers(init?.headers)});
    if(url.includes('api.github.com'))return Response.json(options.invalidRelease ? {...release(),assets:release().assets.map(a=>({...a,browser_download_url:'https://untrusted.invalid/file'}))} : release());
    if(url.endsWith('SHA256SUMS.txt'))return new Response((options.badHash ? '0'.repeat(64) : hash)+'  '+name+'\n');
    if(options.redirect)return new Response(null,{status:302,headers:{location:options.redirect}});
    if(options.blocking)return new Response(new ReadableStream({start(controller){controller.enqueue(file.subarray(0,4));init?.signal?.addEventListener('abort',()=>controller.error(new DOMException('Cancelled','AbortError')),{once:true});}}));
    return new Response(file,{headers:{'content-length':String(options.badSize ? file.length+1 : file.length)}});
  };
  const service=new UpdateService({version:'0.4.18',directory:root,platform:'win32',arch:'x64',fetch:transport});
  return {root,requests,service};
}
test('GitHub updates use numeric stable versions, official assets and no account credentials',async()=>{
  assert.ok(newerVersion('v0.4.19','0.4.18'));assert.ok(newerVersion('0.4.100','0.4.99'));assert.ok(!newerVersion('0.4.18','0.4.18'));assert.ok(!newerVersion('0.3.99','0.4.18'));assert.throws(()=>newerVersion('v0.4.19-beta','0.4.18'));
  const f=await fixture();await Promise.all([f.service.check(),f.service.check()]);assert.equal(f.requests.length,1);assert.equal(f.service.snapshot().phase,'available');
  for(const r of f.requests){assert.equal(r.headers.get('authorization'),null);assert.equal(r.headers.get('cookie'),null);}
  const invalid=await fixture({invalidRelease:true});assert.equal((await invalid.service.check()).phase,'error');
  const disabled=new UpdateService({version:'0.4.18',directory:f.root,enabled:false,fetch:async()=>{throw new Error('Must not contact network');}});assert.equal((await disabled.check()).phase,'unsupported');
});
test('update downloads expose progress, verify SHA-256 and detect changes before revealing the file',async()=>{
  const f=await fixture(),phases:string[]=[];f.service.subscribe(s=>phases.push(s.phase));await f.service.check();
  const [first,second]=await Promise.all([f.service.download(),f.service.download()]);assert.equal(first.phase,'ready');assert.equal(second.phase,'ready');assert.ok(phases.includes('downloading'));assert.ok(phases.includes('verifying'));assert.equal(first.received,file.length);
  assert.equal(f.requests.filter(r=>r.url===base+name).length,1);
  const target=await f.service.readyFile();assert.deepEqual(await readFile(target),file);assert.deepEqual(await readdir(path.join(f.root,version)),[name]);
  await writeFile(target,'Changed fixture.');await assert.rejects(f.service.readyFile(),/已变更/);assert.equal(f.service.snapshot().phase,'error');
});
test('invalid checksums, mismatched sizes and untrusted redirects never produce a usable update',async()=>{
  for(const options of [{badHash:true},{badSize:true},{redirect:'http://github.com/untrusted'},{redirect:'https://untrusted.invalid/update.exe'}]){
    const f=await fixture(options);await f.service.check();const result=await f.service.download();assert.equal(result.phase,'error');await assert.rejects(f.service.readyFile());
    const files=await readdir(path.join(f.root,version)).catch(()=>[]);assert.equal(files.length,0);
  }
});
test('cancelled download cleans partial data and permits a retry without resetting the available release',async()=>{
  const f=await fixture({blocking:true});await f.service.check();
  let cancel!:()=>void;const arrived=new Promise<void>(resolve=>{cancel=resolve;});
  f.service.subscribe(s=>{if(s.received>0 && s.phase==='downloading'){f.service.cancel();cancel();}});
  const job=f.service.download();await arrived;const result=await job;
  assert.equal(result.phase,'available');assert.equal(result.received,0);assert.equal(result.version,version);assert.deepEqual(await readdir(path.join(f.root,version)),[]);
});
