/** Host-only import of a user-selected pairing file. Never expose this DTO to a plugin. */
import {open,lstat} from 'node:fs/promises';
import {X509Certificate,randomUUID,timingSafeEqual} from 'node:crypto';
import {checkServerIdentity,type ConnectionOptions} from 'node:tls';
import {z} from 'zod';

const MAX_PAIRING_BYTES=64*1024;
const fingerprint=z.string().regex(/^[a-fA-F0-9]{64}$/).transform(value=>value.toLowerCase());
const pairingSchema=z.object({
  version:z.literal(1),instanceId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  alias:z.string().trim().min(1).max(100).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)),
  port:z.number().int().min(1).max(65535),certificatePem:z.string().min(1).max(16384),
  fingerprintSha256:fingerprint,token:z.string().min(32).max(8192).regex(/^[A-Za-z0-9._~-]+$/),
}).strict();
const internalPairingSchema=pairingSchema.omit({version:true}).extend({
  id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
}).strict();
export interface GatewayPairing {
  id:string;alias:string;instanceId:string;port:number;certificatePem:string;fingerprintSha256:string;token:string;
}
export class GatewayPairingError extends Error {
  constructor(readonly code:'invalid-pairing-file'|'invalid-pairing-certificate'|'pairing-file-unavailable'){
    super(code==='pairing-file-unavailable' ? '无法读取所选网关配对文件。' : '网关配对文件或服务器证书无效。');
    this.name='GatewayPairingError';
  }
}
function certificate(value:string){
  // One certificate only; no appended keys, chains or other hidden fields.
  if(!/^\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(value))throw new GatewayPairingError('invalid-pairing-certificate');
  try{
    const cert=new X509Certificate(value),now=Date.now();
    if(!cert.checkIP('127.0.0.1') || !cert.checkIssued(cert) || !cert.verify(cert.publicKey)
      || !Number.isFinite(Date.parse(cert.validFrom)) || !Number.isFinite(Date.parse(cert.validTo))
      || now<Date.parse(cert.validFrom) || now>Date.parse(cert.validTo)
      || cert.publicKey.asymmetricKeyType==='rsa' && (cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0)<2048
      || cert.publicKey.asymmetricKeyType==='ec' && !['prime256v1','secp384r1','secp521r1'].includes(cert.publicKey.asymmetricKeyDetails?.namedCurve ?? '')
      || !['rsa','ec','ed25519','ed448'].includes(cert.publicKey.asymmetricKeyType ?? ''))throw new Error();
    return cert;
  }catch{throw new GatewayPairingError('invalid-pairing-certificate');}
}
function uniqueRootKeys(text:string){
  const keys=new Set<string>();let depth=0;
  for(let i=0;i<text.length;i++){
    if(text[i]==='{')depth++;else if(text[i]==='}')depth--;
    else if(text[i]==='\"'){
      const start=i;for(i++;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]==='\"')break;}
      let after=i+1;while(/\s/.test(text[after] || '') && after<text.length)after++;
      if(depth===1 && text[after]===':'){const key=JSON.parse(text.slice(start,i+1)) as string;if(keys.has(key))throw new Error();keys.add(key);}
    }
  }
}
function sameFingerprint(actual:string,expected:string){
  const a=Buffer.from(actual.replaceAll(':','').toLowerCase(),'hex'),b=Buffer.from(expected,'hex');
  return a.length===32 && b.length===32 && timingSafeEqual(a,b);
}
/** Revalidate decrypted host storage; preserve the opaque host-owned pairing ID. */
export function validateGatewayPairing(value:unknown):GatewayPairing{
  let parsed:z.infer<typeof internalPairingSchema>;
  try{parsed=internalPairingSchema.parse(value);}catch{throw new GatewayPairingError('invalid-pairing-file');}
  const cert=certificate(parsed.certificatePem);
  if(!sameFingerprint(cert.fingerprint256,parsed.fingerprintSha256))throw new GatewayPairingError('invalid-pairing-certificate');
  return {...parsed,certificatePem:cert.toString()};
}
/** Parse only the fixed version-1 pairing-file DTO; it never supplies its own host ID. */
export function parseGatewayPairing(value:unknown,options:{id?:string}={}):GatewayPairing{
  let parsed:z.infer<typeof pairingSchema>;
  try{parsed=pairingSchema.parse(value);}catch{throw new GatewayPairingError('invalid-pairing-file');}
  const {version,...fields}=parsed;
  return validateGatewayPairing({...fields,id:options.id ?? randomUUID()});
}
/** Only call after the host's native open-file dialog; plugins never supply this path. */
export async function readGatewayPairingFile(file:string):Promise<GatewayPairing>{
  let bytes:Buffer;
  try{
    const before=await lstat(file);
    if(!before.isFile() || before.isSymbolicLink() || before.size>MAX_PAIRING_BYTES)throw new Error();
    const handle=await open(file,'r');
    try{
      const stat=await handle.stat();
      if(!stat.isFile() || stat.size>MAX_PAIRING_BYTES || stat.dev!==before.dev || stat.ino!==before.ino)throw new Error();
      const buffer=Buffer.alloc(MAX_PAIRING_BYTES+1);let offset=0;
      while(offset<buffer.length){const read=await handle.read(buffer,offset,buffer.length-offset,offset);if(!read.bytesRead)break;offset+=read.bytesRead;}
      if(offset>MAX_PAIRING_BYTES)throw new Error();
      bytes=buffer.subarray(0,offset);
    }finally{await handle.close();}
  }catch{throw new GatewayPairingError('pairing-file-unavailable');}
  let raw:unknown;
  try{
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    raw=JSON.parse(text);uniqueRootKeys(text);
  }catch{throw new GatewayPairingError('invalid-pairing-file');}
  return parseGatewayPairing(raw);
}
/** Scoped trust for one imported self-signed certificate, followed by normal identity and pin checks. */
export function gatewayPairingTlsOptions(pairing:GatewayPairing):Pick<ConnectionOptions,'ca'|'rejectUnauthorized'|'checkServerIdentity'>{
  const verified=validateGatewayPairing(pairing);
  return {ca:verified.certificatePem,rejectUnauthorized:true,checkServerIdentity:(host,cert)=>{
    if(host!=='127.0.0.1')return new Error('网关管理端必须是登记的 loopback 地址。');
    const identityError=checkServerIdentity(host,cert);if(identityError)return new Error('网关服务器身份校验失败。');
    if(!sameFingerprint(cert.fingerprint256 ?? '',verified.fingerprintSha256))return new Error('网关服务器指纹不匹配。');
    return undefined;
  }};
}
