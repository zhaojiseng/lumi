
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(path.resolve('.test-data/desktop-'));
const env = { ...process.env, LUMI_SMOKE: '1', LUMI_TEST_DATA: path.join(directory, 'app'), LUMI_TEST_HOME: path.join(directory, 'home'), LUMI_SMOKE_SCREENSHOT: path.resolve('docs/preview-desktop.png') };
delete env.ELECTRON_RUN_AS_NODE;
const electronPath = (await import('electron')).default;
const child = spawn(electronPath, ['.'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; let error = '';
child.stdout.on('data', b => { out += b; if (b.toString().includes('LUMI_SMOKE')) process.stdout.write(b); });
child.stderr.on('data', b => { error += b; });
const timer = setTimeout(() => { child.kill(); console.error('Desktop smoke exceeded 55 seconds.'); }, 55000);
const code = await new Promise(resolve => { child.on('exit', resolve); child.on('error', e => { console.error(e); resolve(1); }); });
clearTimeout(timer);
if (code !== 0 || !out.includes('LUMI_SMOKE_RESULT=')) { console.error(error); process.exit(1); }
const result = JSON.parse(out.split('LUMI_SMOKE_RESULT=')[1].split('\n')[0]);
if (!result.desktop || !result.contextIsolation || !result.noDemo || !result.loginVisible || !result.ipcValidation || !result.toolIpcValidation || !result.localSessionIpcValid || !result.appCacheValid || !result.secureStorage || !result.nativeUpdaterLoaded || !result.startupLogs || !result.nativeMacControls || !result.nativeStatusMenu || !result.nativeStatusCard || !result.nativeWindowsTray || !result.widgetPanelValid || !result.titlebarGeometry || result.startupWindows!==1) { console.error(result); process.exit(1); }
console.log('Electron smoke passed: logged-out rendering, isolated preload, system encryption availability, IPC validation and removal of demo mode.');
