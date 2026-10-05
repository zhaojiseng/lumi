import {groupedTrend} from '../shared/trends.ts';
import {resolveRange} from '../shared/range.ts';

// Synthetic metadata only; this benchmark never reads accounts, sessions or network services.
const now=new Date(2026,9,5,12),range='24h',window=resolveRange(range,now);
const points=Array.from({length:10000},(_,i)=>({created_at:window.start_timestamp+i*7,model_name:'model-'+(i%400),token_id:i%1000+1,token_name:'Token '+(i%1000),quota:i%17+1,token_used:100,count:1,cacheInputTokens:80,cacheReadTokens:i%2*40,outputTokens:20,durationSeconds:i%5+1,speedSamples:1,netOutputTokens:20,subsequentDurationSeconds:.5,netSpeedSamples:1}));
const status={system_name:'Fixture',quota_per_unit:100},results=[];
for(const grouping of ['model','token'])for(const selected of ['',grouping==='model' ? 'model-42' : 'id:43']){
  const run=()=>groupedTrend(points,2,status,range,now,grouping,'speed',selected);
  for(let i=0;i<2;i++)run();
  const samples=Array.from({length:7},()=>{const start=performance.now();const value=run();return {ms:performance.now()-start,lines:value.lines.length,options:value.options.length};}).sort((a,b)=>a.ms-b.ms);
  results.push({grouping,selected:!!selected,points:points.length,medianMs:+samples[3].ms.toFixed(2),lines:samples[3].lines,options:samples[3].options});
}
console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,warmups:2,samples:7,metric:'speed',results},null,2));
