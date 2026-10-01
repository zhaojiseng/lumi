import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
await import('./build-electron.mjs');
const children = [];
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit', windowsHide: true });
children.push(vite);
for (let i = 0; i < 80; i++) {
  try { const r = await fetch('http://127.0.0.1:5173'); if (r.ok) break; } catch {}
  if (i === 79) throw new Error('Vite did not start.');
  await setTimeout(250);
}
const electronPath = (await import('electron')).default;
const env = { ...process.env, LUMI_DEV_URL: 'http://127.0.0.1:5173', ELECTRON_CACHE: fileURLToPath(new URL('../.cache/electron', import.meta.url)) };
delete env.ELECTRON_RUN_AS_NODE;
const desktop = spawn(electronPath, ['.'], { stdio: 'inherit', env, windowsHide: true });
children.push(desktop);
function stop() { for (const c of children) c.kill(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
desktop.on('exit', () => { stop(); process.exit(0); });
