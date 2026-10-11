import {spawn} from 'node:child_process';
import path from 'node:path';

const MAX_LINE = 6 * 1024 * 1024;
const MAX_PENDING = 128;

/** The runtime is a fixed child process, never a remotely supplied command. */
export async function startEngine({dataDir, timeoutMs = 30_000, testBinary} = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('需要独立数据目录的绝对路径');
  // The Electron host supplies its fixed bundled executable. There is no
  // standalone command, PATH lookup or renderer-selected fallback.
  if (typeof testBinary !== 'string' || !path.isAbsolute(testBinary)) throw new Error('invalid-runtime-binary');
  const binary = testBinary;
  const child = spawn(binary, ['serve-engine', dataDir], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false});
  let nextId = 1;
  let output = Buffer.alloc(0);
  let failed = false;
  let closing = false;
  let closed = false;
  let closePromise;
  const pending = new Map();
  const fail = () => {
    if (failed) return;
    failed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('网关核心连接已中断')); }
    pending.clear();
    child.kill();
  };
  child.on('error', fail);
  // A write callback does not consume the pipe's separate error event. Treat
  // EOF/EPIPE and read failures like core exit, without exposing RPC contents.
  for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.on('error', fail);
  child.on('exit', () => { if (!closing || pending.size) fail(); });
  child.on('close', () => { closed = true; });
  // Core error output is deliberately not forwarded: diagnostics may never leak pipe input.
  child.stderr.resume();
  child.stdout.on('data', chunk => {
    if (failed) return;
    output = Buffer.concat([output, chunk]);
    while (true) {
      const newline = output.indexOf(10);
      if (newline < 0) { if (output.length > MAX_LINE) fail(); break; }
      if (newline > MAX_LINE) { fail(); break; }
      const line = output.subarray(0, newline);
      output = output.subarray(newline + 1);
      let message;
      try { message = JSON.parse(line.toString('utf8')); } catch { fail(); break; }
      if (message === null || typeof message !== 'object' || Array.isArray(message) || !Number.isSafeInteger(message.id)) { fail(); break; }
      const item = pending.get(message.id);
      if (!item) { fail(); break; }
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) {
        const code = typeof message.error.code === 'string' && /^[a-z0-9-]{1,64}$/.test(message.error.code) ? message.error.code : 'engine-error';
        const error = new Error(code); error.code = code; item.reject(error);
      } else if (Object.hasOwn(message, 'result')) item.resolve(message.result);
      else { item.reject(new Error('网关核心响应无效')); fail(); break; }
    }
  });
  async function request(method, input = {}) {
    if (failed || closing || pending.size >= MAX_PENDING) throw new Error('网关核心不可用或队列已满');
    const id = nextId++;
    const line = JSON.stringify({id, method, input}) + '\n';
    if (Buffer.byteLength(line) > MAX_LINE) throw new Error('网关管理消息超过限制');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { fail(); }, timeoutMs);
      pending.set(id, {resolve, reject, timer});
      child.stdin.write(line, error => { if (error) fail(); });
    });
  }
  async function close() {
        if (closePromise) return closePromise;
        closing = true;
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('网关核心已关闭')); }
        pending.clear();
        child.stdin.end();
        closePromise = new Promise((resolve,reject) => {
          if (closed) return resolve();
          let killTimer;
          const timer = setTimeout(() => {
            child.kill();
            // A successful kill request is not proof that the engine has exited.
            // Private configuration may begin only after all child pipes close.
            killTimer=setTimeout(()=>{
              child.off('close',finish);
              reject(Object.assign(new Error('engine-shutdown-failed'),{code:'engine-shutdown-failed'}));
            },2000);
          },2000);
          const finish=()=>{clearTimeout(timer);clearTimeout(killTimer);resolve();};
          child.once('close',finish);
        });
        return closePromise;
  }
  try {
    const bootstrap = await request('bootstrap');
    return {request,bootstrap,close};
  } catch (error) {
    fail();
    // No caller receives a child handle when bootstrap fails. Finish shutdown
    // here so a later configuration command cannot overlap the failed core.
    await close();
    throw error;
  }
}
