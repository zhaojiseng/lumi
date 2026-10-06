import { build } from 'esbuild';
import { mkdir,rm,writeFile } from 'node:fs/promises';
import {extensionUiCss,extensionSdkRuntime} from './extension-ui.mjs';
import path from 'node:path';
await mkdir('dist-electron', { recursive: true });
await writeFile('dist-electron/extension-ui.css',await extensionUiCss());
await writeFile('dist-electron/lumi-extension-sdk.js',await extensionSdkRuntime());
await Promise.all([
  build({ entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], sourcemap: false }),
  build({ entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], sourcemap: false }),
  build({ entryPoints: ['electron/tray-preload.ts'], outfile: 'dist-electron/tray-preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], sourcemap: false }),
  build({ entryPoints: ['electron/widget-preload.ts'], outfile: 'dist-electron/widget-preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], sourcemap: false }),
]);
// Remove the previous build's obsolete template assets before packaging.
const obsolete=path.resolve('dist-electron/vendor/codex-0.159.1');
if(!obsolete.startsWith(path.resolve('dist-electron')+path.sep))throw new Error('Invalid obsolete asset path.');
await rm(obsolete,{recursive:true,force:true});
console.log('Electron main and preload built.');
await import('./build-native-menu-bar.mjs');
await import('./build-native-widget-glass.mjs');
