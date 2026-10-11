// Read-only catalog discovery for a saved route. No inference, records or
// caller-selected URL/header is introduced by this module.
import https from 'node:https';
import dns from 'node:dns';
import {resolvePublicAddresses,targetUrl} from './transport.mjs';

const MAX_MODELS=500;
const MAX_MODEL_BYTES=256;
const MAX_PAGES=5;
const MAX_RESPONSE_BYTES=1024*1024;
const MAX_RESULT_BYTES=128*1024;
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_CONTEXT_CODES=new Set(['config-conflict','gateway-session-revoked','gateway-stopping','unknown-route','models-route-changed']);
function failure(code){return Object.assign(new Error(code),{code});}
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function validModelId(value){return typeof value==='string'&&value.trim().length>0&&value===value.toWellFormed()&&Buffer.byteLength(value)<=MAX_MODEL_BYTES&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);}
function credential(value){return typeof value==='string'&&value.length>=1&&value.length<=8192&&/^[\x21-\x7e]+$/.test(value);}
function snapshotRoute(value){
 if(!object(value)||!ID.test(value.id??'')||!['openai','anthropic'].includes(value.protocol??'openai')||typeof value.upstream!=='string'||value.upstream.length>2048)throw failure('models-invalid-input');
 let target;
 try{
  const base=new URL(value.upstream);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw failure('models-invalid-upstream');
  target=targetUrl(value.upstream,'/v1/models');
 }catch{throw failure('models-invalid-upstream');}
 if(target.protocol!=='https:'||target.username||target.password||target.search||target.hash)throw failure('models-invalid-upstream');
 return {id:value.id,protocol:value.protocol??'openai',target};
}
function reflected(value,secrets){return secrets.some(secret=>value.includes(secret));}

/** Constructor-only request/DNS hooks support isolated TLS mocks, never SDK input. */
export function createModelCatalog({lookup=dns.lookup,request=https.request,now=Date.now,timeoutMs=12000}={}){
 if(typeof lookup!=='function'||typeof request!=='function'||typeof now!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>12000)throw failure('models-invalid-input');
 return {async detect({route,upstreamKey,configVersion,signal,assertFresh,privateValues=[]}={}){
  const snapshot=snapshotRoute(route);
  if(!credential(upstreamKey)||!Number.isSafeInteger(configVersion)||configVersion<1||configVersion>2147483647||typeof assertFresh!=='function'
   ||signal!==undefined&&!(signal instanceof AbortSignal)||!Array.isArray(privateValues)||privateValues.length>128||privateValues.some(value=>typeof value!=='string'||value.length>16384))throw failure('models-invalid-input');
  const secrets=[...new Set([upstreamKey,...privateValues].filter(value=>value.length>0))];
  const timeout=new AbortController();let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;timeout.abort();},timeoutMs);
  const lifetime=signal?AbortSignal.any([signal,timeout.signal]):timeout.signal;
  const cancelError=()=>failure(timedOut?'models-timeout':'models-cancelled');
  const checkCancelled=()=>{if(lifetime.aborted)throw cancelError();};
  async function fresh(){
   checkCancelled();
   try{
    const value=await new Promise((resolve,reject)=>{
     const abort=()=>reject(cancelError());
     lifetime.addEventListener('abort',abort,{once:true});
     Promise.resolve().then(()=>{checkCancelled();return assertFresh();}).then(resolve,reject).finally(()=>lifetime.removeEventListener('abort',abort));
    });
    if(value===false)throw failure('models-route-changed');
   }
   catch(error){checkCancelled();throw failure(SAFE_CONTEXT_CODES.has(error?.code)?error.code:'models-route-changed');}
   checkCancelled();
  }
  let responseBytes=0;
  async function page(target){
   checkCancelled();
   let selected;
   try{[selected]=await resolvePublicAddresses(target.hostname.replace(/^\[|\]$/g,''),lookup,lifetime);}
   catch(error){checkCancelled();throw failure(error?.code==='invalid-upstream'||error?.code==='upstream-dns-not-public'?'models-invalid-upstream':'models-dns-failed');}
   await fresh();
   return new Promise((resolve,reject)=>{
    let settled=false,upstream,response;const chunks=[];
    const finish=(error,value)=>{
     if(settled)return;settled=true;lifetime.removeEventListener('abort',abort);
     if(error){response?.destroy();upstream?.destroy();reject(error);}else resolve(value);
    };
    const abort=()=>finish(cancelError());
    lifetime.addEventListener('abort',abort,{once:true});
    if(lifetime.aborted){abort();return;}
    const headers={accept:'application/json','accept-encoding':'identity',
     ...(snapshot.protocol==='anthropic'?{'x-api-key':upstreamKey,'anthropic-version':'2023-06-01'}:{authorization:'Bearer '+upstreamKey})};
    try{
     upstream=request(target,{method:'GET',agent:false,headers,rejectUnauthorized:true,minVersion:'TLSv1.2',
      family:selected.family,autoSelectFamily:false,lookup:(host,options,callback)=>{
       if(host.toLowerCase()!==target.hostname.replace(/^\[|\]$/g,'').toLowerCase()){callback(failure('models-address-changed'));return;}
       if(options?.all)callback(null,[{...selected}]);else callback(null,selected.address,selected.family);
      }},incoming=>{
      response=incoming;
      if(settled){incoming.destroy();return;}
      const status=incoming.statusCode;
      if(status!==200){
       finish(failure(status>=300&&status<400?'models-redirect-not-allowed':status===401||status===403?'models-auth-failed':status===404||status===405?'models-endpoint-unavailable':status===429?'models-rate-limited':'models-http-failed'));return;
      }
      if(!/^application\/json(?:\s*;|$)/i.test(incoming.headers['content-type']??'')||incoming.headers['content-encoding']&&incoming.headers['content-encoding']!=='identity'){
       finish(failure('models-response-invalid'));return;
      }
      const declared=incoming.headers['content-length'];
      if(declared!==undefined&&(!/^\d+$/.test(String(declared))||Number(declared)>MAX_RESPONSE_BYTES-responseBytes)){
       finish(failure('models-response-too-large'));return;
      }
      incoming.on('data',chunk=>{
       if(settled)return;responseBytes+=chunk.length;
       if(responseBytes>MAX_RESPONSE_BYTES){finish(failure('models-response-too-large'));return;}
       chunks.push(Buffer.from(chunk));
      });
      incoming.on('aborted',()=>finish(failure('models-response-interrupted')));
      incoming.on('error',()=>finish(failure('models-response-interrupted')));
      incoming.on('end',()=>{
       if(settled)return;
       try{finish(undefined,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}
       catch{finish(failure('models-response-invalid'));}
      });
     });
     upstream.on('error',()=>finish(lifetime.aborted?cancelError():failure('models-connection-failed')));
     if(settled){upstream.destroy();return;}
     upstream.end();
    }catch{finish(lifetime.aborted?cancelError():failure('models-connection-failed'));}
   });
  }
  try{
   const models=[],ids=new Set(),cursors=new Set();let after,truncated=false,modelBytes=0;
   for(let pageNumber=0;pageNumber<MAX_PAGES;pageNumber++){
    await fresh();
    const target=new URL(snapshot.target);
    if(snapshot.protocol==='anthropic'){target.searchParams.set('limit','100');if(after!==undefined)target.searchParams.set('after_id',after);}
    const value=await page(target);await fresh();
    if(!object(value)||!Array.isArray(value.data))throw failure('models-response-invalid');
    for(const item of value.data){
     if(!object(item)||!validModelId(item.id))throw failure('models-response-invalid');
     if(reflected(item.id,secrets))throw failure('models-credentials-reflected');
     if(ids.has(item.id))continue;
     const normalized={id:item.id},bytes=Buffer.byteLength(JSON.stringify(normalized))+1;
     if(models.length>=MAX_MODELS||modelBytes+bytes>MAX_RESULT_BYTES-1024){truncated=true;continue;}
     ids.add(item.id);models.push(normalized);modelBytes+=bytes;
    }
    if(snapshot.protocol==='openai'){
     // Public OpenAI Lists Models has no pagination parameters. Preserve an
     // explicit partial-list signal from a compatible upstream without guessing.
     if(Object.hasOwn(value,'has_more')){
      if(typeof value.has_more!=='boolean')throw failure('models-response-invalid');
      truncated||=value.has_more;
     }
     break;
    }
    if(typeof value.has_more!=='boolean')throw failure('models-response-invalid');
    if(!value.has_more)break;
    if(!validModelId(value.last_id)||reflected(value.last_id,secrets)||value.data.length===0||value.last_id!==value.data.at(-1).id
     ||cursors.has(value.last_id)||value.last_id===after)throw failure('models-pagination-invalid');
    cursors.add(value.last_id);
    if(pageNumber===MAX_PAGES-1||models.length>=MAX_MODELS||truncated){truncated=true;break;}
    after=value.last_id;
   }
   await fresh();
   const result={routeId:snapshot.id,configVersion,checkedAtMs:now(),source:'catalog',models,truncated};
   if(!Number.isSafeInteger(result.checkedAtMs)||result.checkedAtMs<0||Buffer.byteLength(JSON.stringify(result))>MAX_RESULT_BYTES)throw failure('models-result-too-large');
   return result;
  }finally{clearTimeout(timer);}
 }};
}
