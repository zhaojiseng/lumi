
import { mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
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
// Leave the publish array on disk: electron-builder treats a programmatic publish override as one provider.
const {publish,...buildOptions}=pkg.build;
const config = { ...buildOptions, files: [...pkg.build.files, '!**/node_modules{,/**/*}'], directories: { output, app: stage }, electronDist: path.join(root, 'node_modules/electron/dist'), electronVersion: JSON.parse(await readFile('node_modules/electron/package.json', 'utf8')).version };
if(process.platform==='darwin'){
  if(process.arch!=='arm64')throw new Error('macOS release packaging requires an Apple Silicon host and ARM64 Electron.');
  // electron-builder removes distribution-root notices on macOS; retain them inside the app bundle.
  config.extraResources=[
    {from:path.join(config.electronDist,'LICENSE'),to:'licenses/LICENSE.electron.txt'},
    {from:path.join(config.electronDist,'LICENSES.chromium.html'),to:'licenses/LICENSES.chromium.html'},
  ];
}
const directory = process.argv.includes('--dir');
await build({ targets: Platform.current().createTarget(directory ? 'dir' : undefined), config, publish:'never' });
console.log('Lumi packaged in '+output+'.');
