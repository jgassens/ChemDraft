import { inflateRawSync } from 'node:zlib';
import { crc32 } from './png.mjs';

export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Missing or truncated ZIP central directory');
  const count = buf.readUInt16LE(eocd + 10), size = buf.readUInt32LE(eocd + 12), offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error('ZIP64 is unsupported');
  if (buf.readUInt16LE(eocd + 4) || buf.readUInt16LE(eocd + 6) || buf.readUInt16LE(eocd + 8) !== count) throw new Error('Multi-disk ZIP is unsupported');
  if (count > 2000) throw new Error('ZIP exceeds 2000 entries');
  if (offset + size > eocd) throw new Error('Invalid ZIP central directory bounds');
  const entries = []; let p = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > offset + size || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Truncated ZIP central directory');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), compressed = buf.readUInt32LE(p + 20), length = buf.readUInt32LE(p + 24), nameLength = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    if (flags & 1) throw new Error('Encrypted ZIP is unsupported');
    if ([compressed, length, local].includes(0xffffffff)) throw new Error('ZIP64 is unsupported');
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method ${method}`);
    if (p + 46 + nameLength + extra + comment > offset + size) throw new Error('Truncated ZIP entry');
    total += length;
    if (total > 200 * 1024 * 1024) throw new Error('ZIP exceeds 200 MB inflated');
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`Invalid ZIP local header: ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + compressed > offset) throw new Error(`Truncated ZIP data: ${name}`);
    const bytes = buf.subarray(start, start + compressed);
    const data = method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: Math.max(1, length) });
    if (data.length !== length || crc32(data) !== crc) throw new Error(`ZIP CRC or size mismatch: ${name}`);
    entries.push({ name, data }); p += 46 + nameLength + extra + comment;
  }
  if (p !== offset + size) throw new Error('Invalid ZIP central directory size');
  return entries;
}
