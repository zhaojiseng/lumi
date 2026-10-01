
import { spawn } from 'node:child_process';
import path from 'node:path';
const child = spawn(process.execPath, ['node_modules/electron/install.js'], { env: { ...process.env, electron_config_cache: path.resolve('.cache/electron') }, stdio: 'inherit', windowsHide: true });
child.on('exit', code => process.exit(code || 0));
