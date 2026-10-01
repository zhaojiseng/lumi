import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The release utility is a JavaScript module.
import {unsignedMachOCode} from '../scripts/mach-o-code.mjs';

function fixture(padding=8,signatureSize=16) {
  const signatureOffset=132+padding,bytes=Buffer.alloc(signatureOffset+signatureSize);
  bytes.writeUInt32LE(0xfeedfacf,0);bytes.writeUInt32LE(2,16);bytes.writeUInt32LE(88,20);
  bytes.writeUInt32LE(0x19,32);bytes.writeUInt32LE(72,36);bytes.write('__LINKEDIT',40);
  bytes.writeBigUInt64LE(BigInt(bytes.length),64);bytes.writeBigUInt64LE(128n,72);bytes.writeBigUInt64LE(BigInt(bytes.length-128),80);
  bytes.writeUInt32LE(0x1d,104);bytes.writeUInt32LE(16,108);bytes.writeUInt32LE(signatureOffset,112);bytes.writeUInt32LE(signatureSize,116);
  bytes[124]=5;bytes[128]=1;bytes[131]=2;bytes.fill(7,signatureOffset);
  return bytes;
}
test('Mach-O comparison ignores signature allocation but retains code and linker metadata',()=>{
  const first=fixture(),second=fixture(24,48);
  assert.deepEqual(unsignedMachOCode(first),unsignedMachOCode(second));
  second[124]=6;assert.notDeepEqual(unsignedMachOCode(first),unsignedMachOCode(second));
  second[124]=5;second[131]=3;assert.notDeepEqual(unsignedMachOCode(first),unsignedMachOCode(second));
});
test('Mach-O comparison rejects malformed signature bounds and trailing unsigned data',()=>{
  const invalid=fixture();invalid.writeUInt32LE(9999,112);assert.throws(()=>unsignedMachOCode(invalid));
  assert.throws(()=>unsignedMachOCode(Buffer.concat([fixture(),Buffer.from([1])])));
});
