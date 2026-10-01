import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const pkg=JSON.parse(await readFile('package.json','utf8'));
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const version=pkg.version,tag='v'+version;
assert.match(version,/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,'Release version must be a stable semantic version');
assert.equal(lock.version,version,'Lockfile version must match package.json');
assert.equal(lock.packages[''].version,version,'Lockfile root version must match package.json');
for(const file of ['src/App.tsx','src/bridge.ts']){
  const source=await readFile(file,'utf8');
  assert.equal(source.match(/\bversion\s*:\s*['"]([^'"]+)['"]/)?.[1],version,'Renderer version must match package.json: '+file);
}
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',windowsHide:true}).trim();
git('diff','--exit-code','HEAD','--');
if(process.env.GITHUB_REF_TYPE==='tag'){
  assert.equal(process.env.GITHUB_REF_NAME,tag,'Release tag must exactly match package.json');
  assert.equal(git('rev-parse','refs/tags/'+tag+'^{commit}'),git('rev-parse','HEAD'),'Tag must point to the build commit');
  git('merge-base','--is-ancestor','HEAD','refs/remotes/origin/main');
}
const changelog=(await readFile('CHANGELOG.md','utf8')).replaceAll('\r\n','\n');
const lines=changelog.split('\n'),start=lines.findIndex(line=>new RegExp('^## '+version.replaceAll('.','\\.')+'(?:\\s|$)').test(line));
assert.ok(start>=0,'CHANGELOG.md must describe the release version');
let end=lines.findIndex((line,index)=>index>start && /^## /.test(line));
if(end<0)end=lines.length;
const changes=lines.slice(start+1,end).join('\n').trim();
assert.ok(changes.length>0,'Release notes must not be empty');
await mkdir('release',{recursive:true});
git('archive','--format=zip','--prefix=Lumi-'+version+'/','-o',path.join('release','Lumi-'+version+'-source.zip'),'HEAD');
const notes='# Lumi '+version+'\n\n'+changes+'\n\n'+
  '## 下载与使用\n\n'+
  '- `Lumi-'+version+'-x64.exe`：Windows x64 安装包，首次下载后安装；以后在软件内下载更新并点击“重启更新”。\n'+
  '- `Lumi-'+version+'-arm64.dmg`：macOS Apple Silicon 安装包，打开后将 Lumi 拖入 Applications；更新需下载新版替换应用。\n'+
  '- `Lumi-'+version+'-source.zip`：当前标签的公开源码。\n'+
  '- `latest.yml` 与 `.blockmap`：软件内更新所需的版本元数据与差量信息。\n'+
  '- `SHA256SUMS.txt`：上述发行文件的 SHA-256 校验值。\n\n'+
  '首次运行请在设置中填写你的 New API 站点地址后登录。Windows 包尚未签名；macOS 使用临时签名，未进行 Apple 公证，首次打开可能需要通过系统的“隐私与安全性”允许。本次未提供 Linux 安装包。\n';
await writeFile('release/RELEASE_NOTES.md',notes);
if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,'version='+version+'\ntag='+tag+'\n');
console.log(JSON.stringify({version,tag,sourceArchive:'Lumi-'+version+'-source.zip'}));
