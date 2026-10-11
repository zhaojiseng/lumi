import {generateKeyPairSync,sign,X509Certificate} from 'node:crypto';

/** Fake certificates generated only for isolated local TLS fixtures. */
export function gatewayTestCertificate(ip=[127,0,0,1],options:{bits?:number;validFrom?:string;validTo?:string}={}){
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:options.bits ?? 2048});
  const der=(tag:number,data:Buffer)=>Buffer.concat([Buffer.from([tag]),data.length<128?Buffer.from([data.length]):data.length<256?Buffer.from([0x81,data.length]):Buffer.from([0x82,data.length>>8,data.length&255]),data]);
  const seq=(...data:Buffer[])=>der(0x30,Buffer.concat(data));
  const oid=(bytes:number[])=>der(6,Buffer.from(bytes));
  const algorithm=seq(oid([42,134,72,134,247,13,1,1,11]),der(5,Buffer.alloc(0)));
  const name=seq(der(0x31,seq(oid([85,4,3]),der(12,Buffer.from('Lumi local fixture')))));
  const validity=seq(der(0x17,Buffer.from(options.validFrom ?? '250101000000Z')),der(0x17,Buffer.from(options.validTo ?? '490101000000Z')));
  const extensions=der(0xa3,seq(
    seq(oid([85,29,19]),der(1,Buffer.from([255])),der(4,seq(der(1,Buffer.from([255]))))),
    seq(oid([85,29,17]),der(4,seq(der(0x87,Buffer.from(ip))))),
  ));
  const tbs=seq(der(0xa0,der(2,Buffer.from([2]))),der(2,Buffer.from([1])),algorithm,name,validity,name,
    publicKey.export({format:'der',type:'spki'}),extensions);
  const raw=seq(tbs,algorithm,der(3,Buffer.concat([Buffer.from([0]),sign('sha256',tbs,privateKey)])));
  const pem='-----BEGIN CERTIFICATE-----\n'+raw.toString('base64').match(/.{1,64}/g)!.join('\n')+'\n-----END CERTIFICATE-----\n';
  return {pem,key:privateKey.export({format:'pem',type:'pkcs8'}),fingerprint:new X509Certificate(pem).fingerprint256.replaceAll(':','').toLowerCase()};
}
