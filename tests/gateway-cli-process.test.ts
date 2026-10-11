import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayCliToolRunning,type GatewayProcessRunner} from '../electron/services/gateway-cli-process';

type Tool='codex'|'claude-code';
type FakeProcess={pid:number;name:string;command:string};
const secret='fixture-command-private-credential';
function windowsRunner(tool:Tool,rows:FakeProcess[]):GatewayProcessRunner{
 return async(file,args)=>{
  assert.match(file.replaceAll('\\','/'),/\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe$/i);
  assert.deepEqual(args.slice(0,3),['-NoProfile','-NonInteractive','-EncodedCommand']);assert.equal(args.length,4);
  const script=Buffer.from(args[3],'base64').toString('utf16le');
  assert.match(script,/\$ErrorActionPreference='Stop'/);assert.match(script,/Get-CimInstance Win32_Process/);
  assert.match(script,/\$_.ProcessId -ne \$PID/);assert.match(script,/\[Console\]::Write\(\$count\)$/);
  assert.equal(script.includes(secret),false);assert.equal(/ConvertTo-Json|Out-File|Select-Object/.test(script),false);
  const literal=/CommandLine -match '([^']+)'/.exec(script)?.[1];assert.ok(literal);assert.equal(literal.startsWith('(?i)'),true);
  const pattern=new RegExp(literal.slice(4),'i');
  // Evaluate captured fixed filtering over fake rows, never execute PowerShell or inspect real processes.
  const native=tool==='codex'?'codex.exe':'claude.exe';
  const count=rows.filter(row=>row.pid!==process.pid && (row.name.toLowerCase()===native
   || ['node.exe','node','bash.exe','sh.exe'].includes(row.name.toLowerCase())&&pattern.test(row.command))).length;
  return String(count);
 };
}

for(const tool of ['codex','claude-code'] as const){
 const binary=tool==='codex'?'codex':'claude',scope=tool==='codex'?'@openai/codex':'@anthropic-ai/claude-code';
 test('Windows '+tool+' encoded check recognizes exact native and installed Node paths',async()=>{
  const commands=[
   '"C:\\Program Files\\nodejs\\node.exe" "C:\\fixture\\node_modules\\'+scope.replaceAll('/','\\')+'\\bin\\'+binary+'.js"',
   'node /opt/fixture/node_modules/'+scope+'/bin/'+binary+'.js',
   'node.exe "C:\\tools\\'+binary+'"',
  ];
  for(const command of commands)assert.equal(await gatewayCliToolRunning(tool,{platform:'win32',run:windowsRunner(tool,[{pid:12345,name:'node.exe',command}])}),true,command);
  assert.equal(await gatewayCliToolRunning(tool,{platform:'win32',run:windowsRunner(tool,[{pid:12345,name:binary.toUpperCase()+'.EXE',command:secret}])}),true);
 });
 test('Windows '+tool+' check ignores unrelated process names, lookalike paths and its own PID',async()=>{
  const commands=['node.exe C:\\tools\\'+binary+'-helper.exe','node /opt/'+binary+'x',
   'node /opt/node_modules/'+scope+'-helper/bin/run.js','node /opt/fixture/not-'+binary+'.js'];
  const rows=commands.map(command=>({pid:12345,name:'node.exe',command}));
  rows.push({pid:12346,name:'chrome.exe',command:'node /node_modules/'+scope+'/bin/run.js'},
   {pid:process.pid,name:binary+'.exe',command:secret});
  assert.equal(await gatewayCliToolRunning(tool,{platform:'win32',run:windowsRunner(tool,rows)}),false);
 });
}

test('Windows counter parser accepts only a bounded nonnegative integer and exposes no raw output',async()=>{
 for(const [output,expected] of [['0',false],[' 0\r\n',false],['1',true],['03',true],['99999999',true]] as const)
  assert.equal(await gatewayCliToolRunning('codex',{platform:'win32',run:async()=>output}),expected);
 for(const output of ['',secret,'-1','1.0','1\n0','100000000','NaN','0 '+secret])
  await assert.rejects(gatewayCliToolRunning('codex',{platform:'win32',run:async()=>output}),error=>error instanceof Error&&!error.message.includes(secret));
});

for(const platform of ['linux','darwin'] as const){
 test(platform+' checks fixed ps arguments and exact native/installed Node CLIs',async()=>{
  const run=(output:string):GatewayProcessRunner=>async(file,args)=>{assert.equal(file,'/bin/ps');assert.deepEqual(args,['-A','-o','pid=','-o','comm=','-o','args=']);return output;};
  assert.equal(await gatewayCliToolRunning('codex',{platform,run:run('  1 /sbin/init init\n 345 /usr/local/bin/codex /usr/local/bin/codex --fixture\n')}),true);
  assert.equal(await gatewayCliToolRunning('claude-code',{platform,run:run('345 claude claude --fixture\n')}),true);
  assert.equal(await gatewayCliToolRunning('codex',{platform,run:run('345 node /usr/bin/node /opt/node_modules/@openai/codex/bin/codex.js\n')}),true);
  assert.equal(await gatewayCliToolRunning('claude-code',{platform,run:run('345 nodejs node /opt/node_modules/@anthropic-ai/claude-code/cli.js\n')}),true);
  assert.equal(await gatewayCliToolRunning('codex',{platform,run:run('345 bash bash /usr/local/bin/codex --fixture\n')}),true);
 });
 test(platform+' ignores unrelated process arguments, lookalike packages and self',async()=>{
  const output='1 /sbin/init init\n'+process.pid+' codex codex '+secret+'\n'
   +'345 sleep sleep codex\n346 chrome chrome @openai/codex/bin/codex.js\n'
   +'347 node node /opt/node_modules/@openai/codex-extra/bin/run.js\n348 node node /opt/claude-helper.js\n';
  for(const tool of ['codex','claude-code'] as const)assert.equal(await gatewayCliToolRunning(tool,{platform,run:async()=>output}),false);
 });
}

test('Unix empty or malformed process output fails closed without returning private lines',async()=>{
 for(const output of ['', '\n  ', secret, '345', 'pid node path', '0 node /opt/codex', '9007199254740993 codex codex', '1 init init\n'+secret])
  await assert.rejects(gatewayCliToolRunning('codex',{platform:'linux',run:async()=>output}),error=>error instanceof Error&&!error.message.includes(secret));
 assert.equal(await gatewayCliToolRunning('codex',{platform:'linux',run:async()=>'1 init init\n'}),false);
});

test('runner rejection is fixed and invalid tools/platforms never invoke an external process',async()=>{
 for(const platform of ['win32','linux','darwin'] as const)
  await assert.rejects(gatewayCliToolRunning('codex',{platform,run:async()=>{throw new Error(secret);}}),error=>error instanceof Error&&!error.message.includes(secret));
 let called=0;const run:GatewayProcessRunner=async()=>{called++;return '0';};
 await assert.rejects(gatewayCliToolRunning('arbitrary-tool' as any,{platform:'win32',run}),/不支持/);
 await assert.rejects(gatewayCliToolRunning('codex',{platform:'freebsd',run}),/平台/);assert.equal(called,0);
});
