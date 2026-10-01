import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
function crc32(b) { let c = 0xffffffff; for (const byte of b) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const header = Buffer.alloc(8); header.writeUInt32BE(data.length); header.write(type, 4); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data]))); return Buffer.concat([header, data, crc]); }
function segment(x, y, ax, ay, bx, by) { const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2))); return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))); }
const size = 256; const raw = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const px = (x + .5) / size * 64, py = (y + .5) / size * 64;
  const qx = Math.max(Math.abs(px - 32) - 15, 0), qy = Math.max(Math.abs(py - 32) - 15, 0);
  const inside = Math.hypot(qx, qy) <= 16;
  let col = [40,107,84,inside ? 255 : 0];
  if (inside && (segment(px, py, 23, 17, 23, 40) < 3 || segment(px, py, 23, 40, 28, 45) < 3 || segment(px, py, 28, 45, 46, 45) < 3)) col = [255,255,255,255];
  if (inside && Math.hypot(px - 42, py - 22) <= 6) col = [198,229,208,255];
  const off = y * (size * 4 + 1) + x * 4 + 1; for (let j = 0; j < 4; j++) raw[off + j] = col[j];
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size,0); ihdr.writeUInt32BE(size,4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
await writeFile('public/icon.png',png);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1,2); ico.writeUInt16LE(1,4); ico[8] = 0; ico.writeUInt16LE(1,10); ico.writeUInt16LE(32,12); ico.writeUInt32LE(png.length,14); ico.writeUInt32LE(22,18);
await writeFile('public/icon.ico',Buffer.concat([ico,png]));
console.log('Desktop PNG and ICO icons generated.');
