import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';

const scanner=path.resolve('scripts/check-staged-secrets.mjs');
async function repository(){
  const root=await mkdtemp(path.resolve('.test-data/repository-check-'));
  const git=(...args:string[])=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,'Isolated Git operation failed');return r.stdout;};
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@localhost');
  const run=(...args:string[])=>spawnSync(process.execPath,[scanner,...args],{cwd:root,encoding:'utf8',windowsHide:true});
  return {root,git,run};
}

test('secret scanner inspects the staged blob and never prints the credential',async()=>{
  const f=await repository(),key='sk-proj-'+randomBytes(24).toString('hex');
  await writeFile(path.join(f.root,'source.ts'),'export const key='+JSON.stringify(key)+';\n');f.git('add','source.ts');
  await writeFile(path.join(f.root,'source.ts'),'export const safe=true;\n');
  const result=f.run();assert.equal(result.status,1);assert.ok(result.stderr.includes('source.ts:1'));assert.ok(!result.stderr.includes(key));
});

test('full index scan excludes unstaged edits while history scan finds removed credentials',async()=>{
  const f=await repository(),value=randomBytes(32).toString('base64url');
  await writeFile(path.join(f.root,'source.ts'),'const '+'access'+'Token='+JSON.stringify(value)+';\n');f.git('add','source.ts');f.git('commit','--quiet','-m','synthetic fixture');
  await writeFile(path.join(f.root,'source.ts'),'export const safe=true;\n');f.git('add','source.ts');f.git('commit','--quiet','-m','remove synthetic fixture');
  assert.equal(f.run('--all').status,0);
  const result=f.run('--history=HEAD');assert.equal(result.status,1);assert.ok(result.stderr.includes('possible literal credential'));assert.ok(!result.stderr.includes(value));
});

test('repository scan blocks forced credential files and real numeric site addresses',async()=>{
  const f=await repository();await writeFile(path.join(f.root,'.env'),'SAFE_PLACEHOLDER=1\n');f.git('add','.env');
  assert.equal(f.run().status,1);f.git('rm','--cached','.env');
  const site='https://'+[8,8,8,8].join('.');await writeFile(path.join(f.root,'source.ts'),'const site='+JSON.stringify(site)+';\n');f.git('add','source.ts');
  const result=f.run();assert.equal(result.status,1);assert.ok(result.stderr.includes('numeric site URL'));assert.ok(!result.stderr.includes(site));
  f.git('rm','--cached','source.ts');
  await writeFile(path.join(f.root,'opaque.bin'),Buffer.from([0,1,2,3]));f.git('add','opaque.bin');
  assert.ok(f.run('--all').stderr.includes('unreviewed binary file'));
  f.git('rm','--cached','opaque.bin');
  const oid=f.git('hash-object','-w','source.ts').trim();f.git('update-index','--add','--cacheinfo','120000,'+oid+',link');
  assert.ok(f.run().stderr.includes('symlink'));assert.ok(f.run('--all').stderr.includes('symlink'));
});
