import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,X509Certificate} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import {once} from 'node:events';
import {readGatewayPairingFile,parseGatewayPairing,validateGatewayPairing,gatewayPairingTlsOptions} from '../electron/services/gateway-pairing';

// Generate a fake self-signed certificate with Node built-ins: no user certificate/key or openssl dependency.
function certificate(ip=[127,0,0,1],options:{bits?:number;validFrom?:string;validTo?:string}={}){
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
const cert=certificate();
const fileData={version:1,instanceId:'fixture-instance',alias:'本机网关',port:18080,certificatePem:cert.pem,fingerprintSha256:cert.fingerprint,token:'fixture-management-token-0123456789'};
async function directory(t:test.TestContext){
 const parent=process.env.LUMI_GATEWAY_STAGE_ROOT?path.resolve(process.env.LUMI_GATEWAY_STAGE_ROOT,'../gateway-pairing-tests'):path.resolve('.test-data/gateway-pairing');
 await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'import-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;
}

test('host-selected file yields an internal pairing with a generated ID and scoped standard TLS trust',async t=>{
 const root=await directory(t),file=path.join(root,'pairing.json');await writeFile(file,JSON.stringify(fileData));
 const pairing=await readGatewayPairingFile(file);assert.match(pairing.id,/^[0-9a-f-]{36}$/);
 assert.equal(pairing.instanceId,fileData.instanceId);assert.equal(pairing.token,fileData.token);
 const options=gatewayPairingTlsOptions(pairing);assert.equal(options.rejectUnauthorized,true);assert.equal(options.ca,pairing.certificatePem);
 const server=https.createServer({key:cert.key,cert:cert.pem},(_req,res)=>res.end('fixture'));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const response=await new Promise<string>((resolve,reject)=>{
   const request=https.get('https://127.0.0.1:'+(server.address() as {port:number}).port,{...options,agent:false},res=>{
    let body='';res.on('data',data=>body+=data);res.on('end',()=>resolve(body));res.on('error',reject);
   });request.on('error',reject);
  });assert.equal(response,'fixture');
  const peer={subject:{},subjectaltname:'IP Address:127.0.0.1',fingerprint256:cert.fingerprint} as any;
  assert.equal(options.checkServerIdentity!('127.0.0.1',peer),undefined);
  assert.ok(options.checkServerIdentity!('example.com',peer));
  assert.ok(options.checkServerIdentity!('127.0.0.1',{...peer,fingerprint256:'0'.repeat(64)}));
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('pairing import rejects fingerprints, duplicate fields, keys, URLs, invalid SAN and oversized files without exposing input',async t=>{
 const root=await directory(t),file=path.join(root,'pairing.json');
 const wrongIp=certificate([127,0,0,2]);
 for(const value of [
  {...fileData,fingerprintSha256:'0'.repeat(64)},
  {...fileData,certificatePem:cert.pem+'-----BEGIN PRIVATE '+'KEY-----\nsecret\n-----END PRIVATE KEY-----'},
  {...fileData,url:'https://example.com'},
  {...fileData,port:0},{...fileData,token:'short'},
  {...fileData,certificatePem:wrongIp.pem,fingerprintSha256:wrongIp.fingerprint},
 ]){
  await writeFile(file,JSON.stringify(value));await assert.rejects(readGatewayPairingFile(file),error=>{
   assert.ok(error instanceof Error);assert.ok(!error.message.includes(fileData.token));assert.ok(!error.message.includes('PRIVATE'));return true;
  });
 }
 await writeFile(file,JSON.stringify(fileData).replace('"version":1','"version":1,"version":1'));
 await assert.rejects(readGatewayPairingFile(file),{code:'invalid-pairing-file'});
 await writeFile(file,Buffer.alloc(65537,0x20));await assert.rejects(readGatewayPairingFile(file),{code:'pairing-file-unavailable'});
 await writeFile(file,Buffer.from([0xff]));await assert.rejects(readGatewayPairingFile(file),{code:'invalid-pairing-file'});
});


test('decrypted pairing storage is revalidated and preserves only its host-owned ID',()=>{
 const pairing=parseGatewayPairing(fileData,{id:'host-owned-id'});
 assert.equal(pairing.id,'host-owned-id');
 assert.deepEqual(validateGatewayPairing(JSON.parse(JSON.stringify(pairing))),pairing);
 assert.equal(parseGatewayPairing({...fileData,fingerprintSha256:cert.fingerprint.toUpperCase()}).fingerprintSha256,cert.fingerprint);
 for(const value of [
  {...pairing,id:'../other-host'}, {...pairing,id:''}, {...pairing,version:1},
  {...pairing,url:'https://example.com'}, {...pairing,port:65536},
  {...pairing,fingerprintSha256:'0'.repeat(64)}, {...pairing,token:'short'},
  {...pairing,token:fileData.token+'\nAuthorization: leaked'},
 ])assert.throws(()=>validateGatewayPairing(value),error=>{
  assert.ok(error instanceof Error);assert.ok(!error.message.includes(fileData.token));assert.ok(!error.message.includes('Authorization'));return true;
 });
 assert.throws(()=>parseGatewayPairing({...fileData,id:'plugin-id'}),{code:'invalid-pairing-file'});
 assert.throws(()=>parseGatewayPairing(fileData,{id:'../other-host'}),{code:'invalid-pairing-file'});
 assert.throws(()=>gatewayPairingTlsOptions({...pairing,port:0}),{code:'invalid-pairing-file'});
 const options=gatewayPairingTlsOptions(pairing);
 pairing.fingerprintSha256='0'.repeat(64);
 assert.equal(options.checkServerIdentity!('127.0.0.1',{subject:{},subjectaltname:'IP Address:127.0.0.1',fingerprint256:cert.fingerprint} as any),undefined);
});

test('pairing rejects expired, future, weak, tampered and multiple certificates',()=>{
 for(const invalid of [
  certificate([127,0,0,1],{validTo:'260101000000Z'}),
  certificate([127,0,0,1],{validFrom:'480101000000Z'}),
  certificate([127,0,0,1],{bits:1024}),
 ])assert.throws(()=>parseGatewayPairing({...fileData,certificatePem:invalid.pem,fingerprintSha256:invalid.fingerprint}),{code:'invalid-pairing-certificate'});
 assert.throws(()=>parseGatewayPairing({...fileData,certificatePem:cert.pem+cert.pem}),{code:'invalid-pairing-certificate'});
 const raw=new X509Certificate(cert.pem).raw;
 raw[raw.length-1]^=1;
 const tampered='-----BEGIN CERTIFICATE-----\n'+raw.toString('base64').match(/.{1,64}/g)!.join('\n')+'\n-----END CERTIFICATE-----\n';
 assert.throws(()=>parseGatewayPairing({...fileData,certificatePem:tampered,fingerprintSha256:new X509Certificate(tampered).fingerprint256.replaceAll(':','').toLowerCase()}),{code:'invalid-pairing-certificate'});
});
