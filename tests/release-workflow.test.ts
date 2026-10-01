import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const script=path.resolve('scripts/prepare-release.mjs');
async function fixture(){
  const root=await mkdtemp(path.resolve('.test-data/release-workflow-'));
  await mkdir(path.join(root,'src'));
  await writeFile(path.join(root,'package.json'),JSON.stringify({version:'1.2.3'}));
  await writeFile(path.join(root,'package-lock.json'),JSON.stringify({version:'1.2.3',packages:{'':{version:'1.2.3'}}}));
  for(const file of ['App.tsx','bridge.ts'])await writeFile(path.join(root,'src',file),"export const bootstrap={version:'1.2.3'};\n");
  await writeFile(path.join(root,'CHANGELOG.md'),'# Changes\n\n## 1.2.3 · fixture\n\n- Actual release behavior.\n\n## 1.2.2\n\n- Previous version only.\n');
  await writeFile(path.join(root,'.gitignore'),'release/\n');
  const git=(...args:string[])=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@localhost');
  git('add','.');git('commit','--quiet','-m','release fixture');git('update-ref','refs/remotes/origin/main','HEAD');git('tag','v1.2.3');
  const run=(ref='v1.2.3')=>spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8',windowsHide:true,env:{...process.env,GITHUB_REF_TYPE:'tag',GITHUB_REF_NAME:ref,GITHUB_OUTPUT:path.join(root,'release-output')}});
  return {root,git,run};
}

test('release preparation exports only the tagged public tree and the current changelog section',async()=>{
  const f=await fixture(),result=f.run();assert.equal(result.status,0,result.stderr);
  const notes=await readFile(path.join(f.root,'release/RELEASE_NOTES.md'),'utf8');
  assert.ok(notes.includes('Actual release behavior.'));assert.ok(!notes.includes('Previous version only.'));
  const archive=await readFile(path.join(f.root,'release/Lumi-1.2.3-source.zip'));
  assert.equal(archive.readUInt32LE(0),0x04034b50);assert.ok(!archive.includes(Buffer.from('release-output')));
  assert.equal(await readFile(path.join(f.root,'release-output'),'utf8'),'version=1.2.3\ntag=v1.2.3\n');
});

test('release preparation rejects wrong tags, version drift and commits outside public main',async()=>{
  const f=await fixture();assert.notEqual(f.run('v1.2.4').status,0);
  await writeFile(path.join(f.root,'package-lock.json'),JSON.stringify({version:'1.2.4',packages:{'':{version:'1.2.4'}}}));
  assert.notEqual(f.run().status,0);f.git('checkout','--','package-lock.json');
  await writeFile(path.join(f.root,'src/bridge.ts'),"export const bootstrap={version:'1.2.4'};\n");
  assert.notEqual(f.run().status,0);f.git('checkout','--','src/bridge.ts');
  await writeFile(path.join(f.root,'README.md'),'Unpublished branch.\n');f.git('add','README.md');f.git('commit','--quiet','-m','unpublished fixture');
  assert.notEqual(f.run().status,0);f.git('tag','-f','v1.2.3');assert.notEqual(f.run().status,0);
});
