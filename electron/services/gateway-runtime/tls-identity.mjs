import {generateKeyPairSync,sign,randomBytes,X509Certificate} from 'node:crypto';
const der=(tag,data)=>{
 const size=data.length;
 if(size>65535)throw new Error('certificate-size-limit');
 const length=size<128?Buffer.from([size]):size<256?Buffer.from([0x81,size]):Buffer.from([0x82,size>>8,size&255]);
 return Buffer.concat([Buffer.from([tag]),length,data]);
};
const seq=(...parts)=>der(0x30,Buffer.concat(parts));
const oid=bytes=>der(6,Buffer.from(bytes));
const algorithm=()=>seq(oid([42,134,72,134,247,13,1,1,11]),der(5,Buffer.alloc(0)));
const pem=(label,bytes)=>'-----BEGIN '+label+'-----\n'+bytes.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END '+label+'-----\n';
function time(date){return der(0x18,Buffer.from(date.toISOString().replace(/[-:T]/g,'').replace(/\.\d{3}Z$/,'Z')));}
/** Generate a dedicated loopback identity using standard X.509 and Node crypto. */
export function createTlsIdentity({now=Date.now()}={}){
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:3072});
 const name=seq(der(0x31,seq(oid([85,4,3]),der(12,Buffer.from('Lumi local recording gateway')))));
 const serial=randomBytes(20);serial[0]=(serial[0]&0x7f)|1;
 const extensions=der(0xa3,seq(
  seq(oid([85,29,19]),der(1,Buffer.from([255])),der(4,seq(der(1,Buffer.from([255]))))),
  seq(oid([85,29,17]),der(4,seq(der(0x87,Buffer.from([127,0,0,1]))))),
  seq(oid([85,29,15]),der(1,Buffer.from([255])),der(4,der(3,Buffer.from([1,0x86])))),
  seq(oid([85,29,37]),der(4,seq(oid([43,6,1,5,5,7,3,1])))),
 ));
 const tbs=seq(der(0xa0,der(2,Buffer.from([2]))),der(2,serial),algorithm(),name,
  seq(time(new Date(now-5*60*1000)),time(new Date(now+365*24*60*60*1000))),name,
  publicKey.export({format:'der',type:'spki'}),extensions);
 const raw=seq(tbs,algorithm(),der(3,Buffer.concat([Buffer.from([0]),sign('sha256',tbs,privateKey)])));
 const certificatePem=pem('CERTIFICATE',raw),certificate=new X509Certificate(certificatePem);
 if(!certificate.verify(publicKey) || !certificate.checkIP('127.0.0.1'))throw new Error('invalid-generated-identity');
 return {certificatePem,privateKeyPem:privateKey.export({format:'pem',type:'pkcs8'}).toString(),fingerprintSha256:certificate.fingerprint256.replaceAll(':','').toLowerCase()};
}
