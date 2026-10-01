import {execFileSync} from 'node:child_process';

const git=(...args)=>execFileSync('git',args,{maxBuffer:64*1024*1024,windowsHide:true});
const mode=process.argv.slice(2);
if(mode.length>1 || mode[0] && mode[0]!=='--all' && !mode[0].startsWith('--history='))throw new Error('Use no arguments, --all, or --history=<ref>.');
const forbiddenPath=/(?:^|\/)(?:\.env[^/]*|auth\.json|credentials\.json|secrets\.json|settings\.json|vault[^/]*\.json|Cookies|Login Data|Local State|\.codex|\.claude|\.cc-switch|\.lumi|\.ssh|\.aws|\.azure|user-?data|backups|sessions|archived_sessions|Local Storage|Session Storage|IndexedDB)(?:\/|$)|\.(?:key|pem|p12|pfx|jks|db|sqlite|sqlite3)(?:-[^/]*)?$|\.(?:jsonl|log)$/i;
const localOutput=/^(?:node_modules|dist|dist-electron|release|\.cache|\.research|\.test-data|\.test-home|test-results|coverage|screenshots|exports)\/|^docs\/preview-|(?:^|\/)node_modules\//;
const signatures=[
  ['private key',/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['API key',/\bsk-(?:proj-|ant-(?:api\d+-)?)?[A-Za-z0-9_-]{24,}\b/g],
  ['GitHub token',/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ['AWS access key',/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Slack token',/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['JWT',/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g],
  ['npm credentials',/(?:_authToken|_password|_auth)\s*=\s*[^\s#;]+/g],
  ['credential URL',/https?:\/\/[^\s'"\/@:]+:[^\s'"\/@]+@/g],
  ['personal profile path',/(?:[A-Z]:[\\/]Users[\\/]|\/(?:Users|home)\/)[a-z0-9_.-]+[\\/]/gi],
  ['non-example numeric site URL',/https?:\/\/(?!(?:127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)(?:[:/]|\b))\d{1,3}(?:\.\d{1,3}){3}(?=[:/\s'"`]|$)/g],
];
const assignment=/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|experimental_bearer_token|password|passwd|client[_-]?secret|secret[_-]?key)\b["']?\s*[:=]\s*(["'`])([^\r\n]*?)\1/gi;
function entropy(value){
  const counts=new Map();for(const char of value)counts.set(char,(counts.get(char)||0)+1);
  return [...counts.values()].reduce((total,count)=>{const p=count/value.length;return total-p*Math.log2(p);},0);
}
const findings=[],seen=new Set();let checked=0,commits=0;
function inspect(file,data,revision=''){
  checked++;
  const location=revision ? revision.slice(0,12)+':'+file : file;
  if(forbiddenPath.test(file)||localOutput.test(file)){findings.push({file:location,reason:'local data or credential file'});return;}
  if(data.includes(0)){
    if(!/^public\/icon\.(?:png|ico)$/.test(file))findings.push({file:location,reason:'unreviewed binary file'});
    return;
  }
  const lines=data.toString('utf8').split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    for(const [reason,pattern] of signatures){
      pattern.lastIndex=0;
      const matches=[...line.matchAll(pattern)];
      for(const match of matches){const syntheticUrl=reason==='credential URL' && file==='tests/core.test.ts' && match[0]==='https://user:'+'secret@';if(!syntheticUrl)findings.push({file:location,line:i+1,reason});}
    }
    assignment.lastIndex=0;
    for(const match of line.matchAll(assignment)){
      const value=match[2],fixture=file==='tests/workflows.test.ts' && value==='password-only-in-memory';
      if(value.length>=20 && entropy(value)>=3.5 && !/\$\{|\$[A-Z_]+|^<[^>]+>$/.test(value) && !fixture)findings.push({file:location,line:i+1,reason:'possible literal credential'});
    }
  }
}
if(mode[0]?.startsWith('--history=')){
  const ref=mode[0].slice('--history='.length);
  const head=git('rev-parse','--verify',ref+'^{commit}').toString().trim();
  for(const revision of git('rev-list','--reverse',head).toString().trim().split('\n')){
    commits++;
    for(const entry of git('ls-tree','-r','-z',revision).toString().split('\0').filter(Boolean)){
      const [meta,file]=entry.split('\t'),[permissions,type,oid]=meta.split(' ');
      if(type!=='blob' || permissions==='120000'){findings.push({file:revision.slice(0,12)+':'+file,reason:'unreviewed submodule or symlink'});continue;}
      const key=file+'\0'+oid;if(seen.has(key))continue;seen.add(key);
      inspect(file,git('cat-file','blob',oid),revision);
    }
  }
}else{
  const all=mode[0]==='--all';
  const files=(all ? git('ls-files','--cached','-z') : git('diff','--cached','--name-only','--diff-filter=ACMR','-z')).toString().split('\0').filter(Boolean);
  const index=new Map(git('ls-files','--stage','-z').toString().split('\0').filter(Boolean).map(entry=>{
    const tab=entry.indexOf('\t'),[permissions,oid,stage]=entry.slice(0,tab).split(' ');
    return [entry.slice(tab+1),{permissions,oid,stage}];
  }));
  for(const file of files){
    const entry=index.get(file);
    if(!entry || entry.stage!=='0' || !['100644','100755'].includes(entry.permissions)){
      findings.push({file,reason:'unreviewed submodule, symlink or unresolved index'});continue;
    }
    inspect(file,git('cat-file','blob',entry.oid));
  }
}
if(findings.length){
  console.error('Secret check failed: review these files (matched values are hidden).');
  for(const item of findings)console.error(`${item.file}${item.line ? ':'+item.line : ''}: ${item.reason}`);
  process.exitCode=1;
}else console.log(`Secret check passed for ${checked} file versions${commits ? ' in '+commits+' commits' : ''}.`);
