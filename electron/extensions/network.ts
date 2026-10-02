import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {z} from 'zod';
const inputSchema=z.object({url:z.string().max(4000),headers:z.record(z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),z.string().max(4000)).optional(),secret:z.object({key:z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/),header:z.enum(['Authorization','X-Api-Key']),prefix:z.enum(['Bearer ','']).default('Bearer ')}).strict().optional()}).strict();
export function publicExtensionAddress(address:string){
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return !(a===0 || a===10 || a===127 || a===169 && b===254 || a===172 && b>=16 && b<=31 || a===192 && b===168 || a===100 && b>=64 && b<=127 || a>=224);}
  // IPv4 mappings, unspecified, loopback, private/link-local and multicast IPv6 are excluded.
  return isIP(address)===6 && !/^(?:0*:|::|fc|fd|fe[89ab]|ff)/i.test(address) && !address.includes('.');
}
export async function extensionNetworkRead(raw:unknown,origins:readonly string[],signal:AbortSignal,getSecret:(key:string)=>string|undefined){
  const input=inputSchema.parse(raw),url=new URL(input.url);
  if(url.protocol!=='https:' || url.username || url.password || url.hash || !origins.includes(url.origin))throw new Error('扩展未声明此 HTTPS 网络来源。');
  const headers:Record<string,string>={Accept:'application/json'};
  for(const [key,value] of Object.entries(input.headers || {})){if(!['accept','accept-language','authorization','x-api-key'].includes(key.toLowerCase()) || /[\r\n]/.test(value))throw new Error('扩展请求头无效。');headers[key]=value;}
  if(input.secret){const secret=getSecret(input.secret.key);if(!secret)throw new Error('请先设置此扩展的连接密钥。');if(/[\r\n]/.test(secret))throw new Error('扩展密钥无效。');headers[input.secret.header]=input.secret.prefix+secret;}
  const addresses=await new Promise<{address:string;family:number}[]>((resolve,reject)=>{
    const abort=()=>reject(new Error('扩展请求已取消。'));if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    void lookup(url.hostname.replace(/^\[|\]$/g,''),{all:true}).then(result=>{signal.removeEventListener('abort',abort);resolve(result);},()=>{signal.removeEventListener('abort',abort);reject(new Error('扩展网络域名无法解析。'));});
  });
  if(signal.aborted)throw new Error('扩展已停用。');
  if(!addresses.length || addresses.some(a=>!publicExtensionAddress(a.address)))throw new Error('扩展网络请求不允许访问本机或私有地址。');
  const target=addresses[0];
  return new Promise<{status:number;body:string}>((resolve,reject)=>{
    const request=https.request(url,{method:'GET',headers,signal,family:target.family,lookup:(_host,_options,done)=>done(null,target.address,target.family)},response=>{
      if(response.statusCode && response.statusCode>=300 && response.statusCode<400){response.destroy();reject(new Error('扩展请求不接受重定向。'));return;}
      const chunks:Buffer[]=[];let bytes=0;
      response.on('data',(chunk:Buffer)=>{if((bytes+=chunk.length)>1024*1024){response.destroy(new Error('扩展响应超过大小限制。'));return;}chunks.push(chunk);});
      response.on('error',()=>reject(new Error('扩展请求失败。')));response.on('end',()=>resolve({status:response.statusCode || 0,body:Buffer.concat(chunks).toString('utf8')}));
    });
    request.on('error',()=>reject(new Error(signal.aborted ? '扩展请求已取消。' : '扩展请求失败。')));request.end();
  });
}
