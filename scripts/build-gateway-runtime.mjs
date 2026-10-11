import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,readdir,writeFile,copyFile,stat,chmod} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const crate=path.join(root,'native/gateway-runtime');
const target=path.join(root,'.cache/gateway-runtime/target');
const env={...process.env,CARGO_TARGET_DIR:target};
const localCargoHome=path.join(root,'.cache/gateway-cargo');
try{await stat(path.join(localCargoHome,'config.toml'));env.CARGO_HOME=localCargoHome;}catch{}
async function cargo(args,capture=false){
 return new Promise((resolve,reject)=>{
  const child=spawn('cargo',args,{cwd:crate,env,windowsHide:true,shell:false,stdio:['ignore',capture?'pipe':'inherit','inherit']});
  const chunks=[];if(capture)child.stdout.on('data',chunk=>chunks.push(chunk));
  child.once('error',()=>reject(new Error('构建内置网关需要 Rust 1.85+ 与 Cargo。')));
  child.once('exit',code=>code===0?resolve(Buffer.concat(chunks).toString('utf8')):reject(new Error('内置网关构建失败。')));
 });
}
const platform=process.platform==='win32'?'x86_64-pc-windows-msvc':process.platform==='darwin'?'aarch64-apple-darwin':'x86_64-unknown-linux-gnu';
if(process.platform==='darwin' && process.arch!=='arm64')throw new Error('内置网关 macOS 发行构建需要 ARM64 主机。');
await cargo(['build','--release','--locked','--bin','lumi-gateway-runtime']);
const metadata=JSON.parse(await cargo(['metadata','--locked','--format-version','1','--filter-platform',platform],true));
const byId=new Map(metadata.packages.map(pkg=>[pkg.id,pkg]));
const nodes=new Map(metadata.resolve.nodes.map(node=>[node.id,node]));
const used=new Set();
function visit(id){if(used.has(id))return;used.add(id);for(const dep of nodes.get(id)?.deps??[]){if(dep.dep_kinds.some(item=>item.kind!=='dev'))visit(dep.pkg);}}
visit(metadata.resolve.root);
const notices=[];
for(const id of [...used].sort()){
 const pkg=byId.get(id);const dir=path.dirname(pkg.manifest_path);
 const licenses=(await readdir(dir)).filter(name=>/^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(name)).sort();
 if(pkg.license_file && !licenses.includes(pkg.license_file))licenses.push(pkg.license_file);
 if(!licenses.length)throw new Error('网关依赖缺少完整许可文本：'+pkg.name+' '+pkg.version);
 notices.push('\n===== '+pkg.name+' '+pkg.version+' ('+(pkg.license??'license-file')+') =====\n');
 for(const name of licenses){const file=path.join(dir,name);if(!(await stat(file)).isFile())continue;notices.push('\n--- '+name+' ---\n'+await readFile(file,'utf8'));}
 if(pkg.name==='libsqlite3-sys'){
  const sqlite=await readFile(path.join(dir,'sqlite3/sqlite3.c'),'utf8');
  const opening=[...sqlite.slice(0,8192).matchAll(/\/\*[\s\S]*?\*\//g)].map(match=>match[0]).find(value=>value.includes('The author disclaims copyright')&&value.includes('May you do good'));
  if(!opening || !opening.includes('May you do good'))throw new Error('SQLite 完整许可标头缺失。');
  notices.push('\n--- bundled SQLite public domain dedication ---\n'+opening);
 }
}
const binary='lumi-gateway-runtime'+(process.platform==='win32'?'.exe':'');
await mkdir(path.join(root,'dist-native'),{recursive:true});
await copyFile(path.join(target,'release',binary),path.join(root,'dist-native',binary));
if(process.platform!=='win32')await chmod(path.join(root,'dist-native',binary),0o755);
if(process.platform==='darwin')execFileSync('/usr/bin/codesign',['--force','--sign','-',path.join(root,'dist-native',binary)],{stdio:'inherit'});
await mkdir(path.join(root,'dist/third-party'),{recursive:true});
await writeFile(path.join(root,'dist/third-party/gateway-dependencies-LICENSES.txt'),notices.join('\n'),'utf8');
console.log('内置网关核心与 '+used.size+' 个完整许可已构建。');
