import { deflateSync, inflateSync } from 'node:zlib';
import { MAX_ENVELOPE, trailingNuls, paddingNotes } from './payload.mjs';

const signature = Buffer.from('89504e470d0a1a0a', 'hex');
export function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
export function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}
export function chunks(buf) {
  if (!buf.subarray(0, 8).equals(signature)) throw new Error('Invalid PNG signature');
  const result = [];
  let p = 8;
  while (p < buf.length) {
    if (p + 12 > buf.length) throw new Error('Truncated PNG chunk');
    const n = buf.readUInt32BE(p);
    if (n > buf.length - p - 12) throw new Error('Truncated PNG chunk');
    const type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + n);
    if (crc32(buf.subarray(p + 4, p + 8 + n)) !== buf.readUInt32BE(p + 8 + n)) throw new Error(`Invalid PNG ${type} CRC`);
    result.push({ type, data }); p += n + 12;
    if (type === 'IEND') break;
  }
  if (result[0]?.type !== 'IHDR' || result.at(-1)?.type !== 'IEND' || trailingNuls(buf.subarray(p)) !== buf.length - p) throw new Error('Invalid PNG chunk order or trailing bytes');
  if (p < buf.length) result.notes = paddingNotes(buf.length - p);
  return result;
}
export function makePng(buf, envelope, kind, dpi) {
  const compressed = deflateSync(envelope);
  const content = kind === 'iTXt' ? Buffer.concat([Buffer.from('chemdraft\0\x01\x00\0\0'), compressed]) : Buffer.concat([Buffer.from('chemdraft\0\x00'), compressed]);
  const parts = chunks(buf).filter(c => (!dpi || c.type !== 'pHYs') &&
    !(['tEXt', 'zTXt', 'iTXt'].includes(c.type) && c.data.subarray(0, 10).equals(Buffer.from('chemdraft\0'))));
  const output = [signature];
  for (const item of parts) {
    if (item.type === 'IEND') output.push(chunk(kind, content));
    output.push(chunk(item.type, item.data));
    if (item.type === 'IHDR' && dpi) {
      const phys = Buffer.alloc(9); phys.writeUInt32BE(Math.round(dpi / 0.0254)); phys.writeUInt32BE(Math.round(dpi / 0.0254), 4); phys[8] = 1;
      output.push(chunk('pHYs', phys));
    }
  }
  return Buffer.concat(output);
}
export function pngFindings(buf) {
  const found = [], list = chunks(buf), ihdr = list[0].data;
  if (ihdr.length !== 13) throw new Error('Invalid PNG IHDR');
  let dpi = null;
  for (const { type, data } of list) {
    if (type === 'pHYs' && data.length === 9 && data[8] === 1) dpi = [data.readUInt32BE(0) * 0.0254, data.readUInt32BE(4) * 0.0254];
    if (!['tEXt', 'zTXt', 'iTXt'].includes(type) || !data.subarray(0, 10).equals(Buffer.from('chemdraft\0'))) continue;
    try {
      let offset = type === 'tEXt' ? 10 : 11, compressed = type !== 'tEXt';
      if (type === 'iTXt') {
        if (![0, 1].includes(data[10]) || data[11] !== 0) throw new Error('Unsupported iTXt compression');
        compressed = data[10] === 1;
        offset = 12;
        for (let i = 0; i < 2; i++) { offset = data.indexOf(0, offset); if (offset < 0) throw new Error('Malformed iTXt'); offset++; }
      } else if (type === 'zTXt' && data[10] !== 0) throw new Error('Unsupported zTXt compression');
      const envelope = compressed ? inflateSync(data.subarray(offset), { maxOutputLength: MAX_ENVELOPE }) : data.subarray(offset);
      if (envelope.length > MAX_ENVELOPE) throw new Error('PNG envelope exceeds 20 MB');
      found.push({ carrier: `png ${type}`, envelope });
    } catch (error) { found.push({ carrier: `png ${type}`, error: error.message }); }
  }
  return { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), dpi, found, notes: list.notes ?? [] };
}
