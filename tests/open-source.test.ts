import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'vite';

const root=path.resolve(import.meta.dirname,'..');
const licenseFile=path.join(root,'public','third-party','codexbar-LICENSE.txt');
// Upstream LICENSE at 59152732182b4600bb78221da9b6b437d2154608, checked 2026-10-02.
// Keep this offline: normal test runs never fetch upstream or use the ignored research checkout.
const upstreamLicenseSha256='14293556b79940745123d0160c71d27ed0e9fe9b8a848093f3ed78f4853caafe';
const normalized=(text:string)=>text.replaceAll('\r\n','\n');

test('CodexBar attribution retains the complete pinned upstream MIT license',async()=>{
  const license=normalized(await readFile(licenseFile,'utf8'));
  assert.equal(createHash('sha256').update(license).digest('hex'),upstreamLicenseSha256,
    'CodexBar copyright, permission and disclaimer must stay intact; review any upstream license change');
  const notices=await readFile(path.join(root,'THIRD_PARTY_NOTICES.md'),'utf8');
  assert.ok(notices.includes('Copyright (c) 2026 Peter Steinberger'));
  assert.ok(notices.includes('59152732182b4600bb78221da9b6b437d2154608'));
  assert.ok(notices.includes('app.asar/dist/third-party/codexbar-LICENSE.txt'));
});

test('Vite and the notice generator retain CodexBar attribution inside an application archive',{timeout:30000},async t=>{
  const testData=path.join(root,'.test-data');
  await mkdir(testData,{recursive:true});
  const fixture=await mkdtemp(path.join(testData,'open-source-'));
  assert.ok(path.resolve(fixture).startsWith(testData+path.sep));
  t.after(()=>rm(fixture,{recursive:true,force:true}));
  await writeFile(path.join(fixture,'index.html'),'<!doctype html><html><head><title>License fixture</title></head><body>Offline license distribution fixture</body></html>');
  await cp(path.join(root,'public','third-party'),path.join(fixture,'public','third-party'),{recursive:true});
  for(const file of ['LICENSE','THIRD_PARTY_NOTICES.md'])await cp(path.join(root,file),path.join(fixture,file));
  // CodexBar is a referenced source project, not an npm dependency. Its notice must
  // survive even when the dependency collector has no production packages to visit.
  await writeFile(path.join(fixture,'package-lock.json'),JSON.stringify({packages:{}}));
  await build({configFile:false,root:fixture,logLevel:'silent',build:{outDir:'dist'}});
  const generated=spawnSync(process.execPath,[path.join(root,'scripts','generate-notices.mjs')],{
    cwd:fixture,encoding:'utf8',windowsHide:true,timeout:10000,
  });
  assert.equal(generated.status,0,generated.error?.message || generated.stderr);
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  assert.ok(pkg.build.files.includes('dist/**/*'),'The application packaging allowlist must include generated notices');
  assert.ok(pkg.scripts.build.includes('vite build') && pkg.scripts.build.includes('scripts/generate-notices.mjs'),
    'Production builds must copy public notices and generate the attribution document');
  const stage=path.join(fixture,'archive-input');
  await cp(path.join(fixture,'dist'),path.join(stage,'dist'),{recursive:true});
  const archive=path.join(fixture,'app.asar');
  const asar=createRequire(import.meta.url)('@electron/asar');
  await asar.createPackage(stage,archive);
  for(const [source,bundled] of [
    [licenseFile,'codexbar-LICENSE.txt'],
    [path.join(root,'THIRD_PARTY_NOTICES.md'),'THIRD_PARTY_NOTICES.md'],
  ]){
    assert.deepEqual(asar.extractFile(archive,path.join('dist','third-party',bundled)),await readFile(source),
      'The packaged notice must match its source exactly: '+bundled);
  }
});
