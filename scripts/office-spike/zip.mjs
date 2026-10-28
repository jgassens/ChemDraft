import { inflateRawSync } from 'node:zlib';
import { crc32 } from './png.mjs';

export const MAX_ENTRIES = 2000;
export const MAX_INFLATED = 200 * 1024 * 1024;
function checkExtra(buf, start, length) {
  const end = start + length;
  while (start < end) {
    if (start + 4 > end) throw new Error('Truncated ZIP extra field');
    const id = buf.readUInt16LE(start), size = buf.readUInt16LE(start + 2);
    if (id === 1) throw new Error('ZIP64 is unsupported');
    start += 4 + size;
    if (start > end) throw new Error('Truncated ZIP extra field');
  }
}

export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Missing or truncated ZIP central directory');
  const count = buf.readUInt16LE(eocd + 10), size = buf.readUInt32LE(eocd + 12), offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff || (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50)) throw new Error('ZIP64 is unsupported');
  if (buf.readUInt16LE(eocd + 4) || buf.readUInt16LE(eocd + 6) || buf.readUInt16LE(eocd + 8) !== count) throw new Error('Multi-disk ZIP is unsupported');
  if (count > MAX_ENTRIES) throw new Error('ZIP exceeds 2000 entries');
  if (offset + size > eocd) throw new Error('Invalid ZIP central directory bounds');
  const entries = []; let p = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > offset + size || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Truncated ZIP central directory');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), compressed = buf.readUInt32LE(p + 20), length = buf.readUInt32LE(p + 24), nameLength = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    if (flags & 0x2041) throw new Error('Encrypted ZIP is unsupported');
    if ([compressed, length, local].includes(0xffffffff)) throw new Error('ZIP64 is unsupported');
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method ${method}`);
    if (p + 46 + nameLength + extra + comment > offset + size) throw new Error('Truncated ZIP entry');
    checkExtra(buf, p + 46 + nameLength, extra);
    if (buf.readUInt16LE(p + 34) !== 0) throw new Error('Multi-disk ZIP is unsupported');
    total += length;
    if (total > MAX_INFLATED) throw new Error('ZIP exceeds 200 MB inflated');
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    if (local + 30 > offset || buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`Invalid ZIP local header: ${name}`);
    const localFlags = buf.readUInt16LE(local + 6), localName = buf.readUInt16LE(local + 26), localExtra = buf.readUInt16LE(local + 28);
    if (localFlags & 0x2041) throw new Error('Encrypted ZIP is unsupported');
    if (buf.readUInt32LE(local + 18) === 0xffffffff || buf.readUInt32LE(local + 22) === 0xffffffff) throw new Error('ZIP64 is unsupported');
    if (localFlags !== flags || buf.readUInt16LE(local + 8) !== method) throw new Error(`ZIP local/central header mismatch: ${name}`);
    const start = local + 30 + localName + localExtra;
    if (start + compressed > offset) throw new Error(`Truncated ZIP data: ${name}`);
    if (!buf.subarray(local + 30, local + 30 + localName).equals(buf.subarray(p + 46, p + 46 + nameLength))) throw new Error('ZIP local/central filename mismatch');
    checkExtra(buf, local + 30 + localName, localExtra);
    if (method === 0 && compressed !== length) throw new Error(`ZIP stored size mismatch: ${name}`);
    const bytes = buf.subarray(start, start + compressed);
    const data = method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: Math.max(1, length) });
    if (data.length !== length || crc32(data) !== crc) throw new Error(`ZIP CRC or size mismatch: ${name}`);
    entries.push({ name, data }); p += 46 + nameLength + extra + comment;
  }
  if (p !== offset + size) throw new Error('Invalid ZIP central directory size');
  return entries;
}
