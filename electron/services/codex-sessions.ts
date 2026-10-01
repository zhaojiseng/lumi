import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export async function assertCodexIdle() {
  if(process.platform==='win32') {
    const {stdout}=await execute('tasklist.exe',['/FO','CSV','/NH','/FI','IMAGENAME eq codex.exe'],{windowsHide:true,timeout:10000});
    if(/^"codex\.exe"/im.test(stdout))throw new Error('请先退出 Codex 桌面应用并关闭 Codex CLI 会话，再同步。运行中的对话持有旧设置，会覆盖本次切换。');
  }else{
    try{await execute('pgrep',['-x','codex']);}catch(e:any){if(e.code===1)return;throw new Error('无法检查 Codex 运行状态，请关闭 Codex 后重试。');}
    throw new Error('请先退出 Codex，再同步旧对话。');
  }
}
