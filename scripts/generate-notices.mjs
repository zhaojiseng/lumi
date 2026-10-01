import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const notice=/^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i;
const fallback={'@lobehub/icons-static-svg':'public/third-party/lobe-icons-LICENSE.txt','victory-vendor':'public/third-party/victory-vendor-LICENSE.txt','lazy-val':'public/third-party/lazy-val-LICENSE.txt'};
const sections=[];
for(const [directory,entry] of Object.entries(lock.packages).sort(([a],[b])=>a.localeCompare(b))){
  if(!directory || entry.dev || !directory.startsWith('node_modules/'))continue;
  const pkg=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
  const files=(await readdir(directory)).filter(name=>notice.test(name)).sort().map(name=>path.join(directory,name));
  if(!files.length && fallback[pkg.name])files.push(fallback[pkg.name]);
  if(!files.length)throw new Error('Missing license text for '+pkg.name);
  if(pkg.name==='victory-vendor'){
    const vendor=path.join(directory,'lib-vendor');
    for(const name of (await readdir(vendor)).sort())files.push(path.join(vendor,name,'LICENSE'));
  }
  const texts=[];
  for(const file of files)texts.push('--- '+path.relative(directory,file).replaceAll('\\','/')+' ---\n'+(await readFile(file,'utf8')).trim());
  const repository=typeof pkg.repository==='string' ? pkg.repository : pkg.repository?.url || pkg.homepage || '';
  sections.push([pkg.name+' @ '+pkg.version,'License: '+(entry.license || pkg.license),repository,...texts].filter(Boolean).join('\n\n'));
}
await mkdir('dist/third-party',{recursive:true});
await writeFile('dist/third-party/dependencies-LICENSES.txt','Third-party dependency licenses\nGenerated from package-lock.json; includes non-development dependencies.\n\n'+sections.join('\n\n'+'='.repeat(72)+'\n\n')+'\n');
await writeFile('dist/third-party/Lumi-LICENSE.txt',await readFile('LICENSE'));
await writeFile('dist/third-party/THIRD_PARTY_NOTICES.md',await readFile('THIRD_PARTY_NOTICES.md'));
console.log('Bundled full license notices for '+sections.length+' dependency packages.');
