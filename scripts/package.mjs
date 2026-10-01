
import { mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {portableBuild} from './portable-build.mjs';
const root = path.resolve('.');
const stage = path.join(root, '.cache/package-app');
// This is an intermediate staging directory, never the checkout or release directory.
if (path.resolve(stage) !== path.resolve(root,'.cache','package-app') || !path.resolve(stage).startsWith(path.resolve(root,'.cache') + path.sep)) throw new Error('Invalid package staging path.');
await rm(stage,{recursive:true,force:true});
await mkdir(stage, { recursive: true });
const pkg = JSON.parse((await readFile('package.json', 'utf8')).replace(/^\uFEFF/, ''));
for (const name of ['dist', 'dist-electron', 'public']) await cp(path.join(root, name), path.join(stage, name), { recursive: true });
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, author: pkg.author, license: pkg.license, main: pkg.main }, null, 2));
process.env.ELECTRON_BUILDER_CACHE = path.join(root, '.cache/electron-builder');
const { build, Platform } = await import('electron-builder');
// Electron/preload and renderer dependencies are bundled; exclude source dependency trees.
const output=process.env.LUMI_RELEASE_DIR ? path.resolve(process.env.LUMI_RELEASE_DIR) : path.join(root,'release');
const config = { ...pkg.build, files: [...pkg.build.files, '!**/node_modules{,/**/*}'], directories: { output, app: stage }, electronDist: path.join(root, 'node_modules/electron/dist'), electronVersion: JSON.parse(await readFile('node_modules/electron/package.json', 'utf8')).version };
const directory = process.argv.includes('--dir');
let portable;
if(process.platform==='win32' && !directory){
  const splash=path.join(root,'.cache','startup.bmp');
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/splash.ps1'),'-OutputPath',splash],{windowsHide:true,encoding:'utf8'});
  if(result.status!==0)throw new Error(result.stderr || 'Failed to create native splash.');
  portable=await portableBuild(root,splash);config.portable={...config.portable,...portable.options};
}
try{await build({ targets: Platform.current().createTarget(directory ? 'dir' : undefined), config });}finally{portable?.restore();}
console.log('Lumi packaged in '+output+'.');
