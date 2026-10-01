import assert from 'node:assert/strict';

/** Compare signed ARM64 Mach-O code and metadata while excluding signing allocation. */
export function unsignedMachOCode(input) {
  const bytes=Buffer.from(input);
  assert.equal(bytes.readUInt32LE(0),0xfeedfacf,'Expected a thin 64-bit Mach-O');
  const count=bytes.readUInt32LE(16),commandEnd=32+bytes.readUInt32LE(20);
  assert.ok(commandEnd<=bytes.length);
  let offset=32,signatureOffset,signatureSize,linkedit;
  for(let i=0;i<count;i++) {
    const command=bytes.readUInt32LE(offset),size=bytes.readUInt32LE(offset+4);
    assert.ok(size>=8 && offset+size<=commandEnd);
    if(command===0x1d) {
      assert.equal(size,16);assert.equal(signatureOffset,undefined);
      signatureOffset=bytes.readUInt32LE(offset+8);signatureSize=bytes.readUInt32LE(offset+12);
      bytes.fill(0,offset+8,offset+16);
    }
    if(command===0x19 && bytes.subarray(offset+8,offset+24).toString().replace(/\0.*$/s,'')==='__LINKEDIT') {
      assert.ok(size>=72);
      linkedit=Number(bytes.readBigUInt64LE(offset+40));
      // Re-signing can resize the signature and the containing segment allocation.
      bytes.fill(0,offset+32,offset+40);
      bytes.fill(0,offset+48,offset+56);
    }
    offset+=size;
  }
  assert.equal(offset,commandEnd);
  assert.ok(signatureOffset>=commandEnd && signatureOffset+signatureSize<=bytes.length,'Missing or invalid signature bounds');
  assert.ok(linkedit>=commandEnd && linkedit<=signatureOffset,'Missing or invalid LINKEDIT bounds');
  assert.ok(bytes.subarray(signatureOffset+signatureSize).every(value=>value===0),'Unexpected data after signature');
  let end=signatureOffset;
  // Signature alignment padding is not executable code or linker metadata.
  while(end>linkedit && bytes[end-1]===0)end--;
  return bytes.subarray(0,end);
}
