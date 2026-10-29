import { inflateRawSync } from 'node:zlib';
import { MAX_ENVELOPE, trailingNuls, paddingNotes } from './payload.mjs';

// Recognize marker + UTF-8 envelope, or marker + base64 raw-deflate (the SVG encoding).
export function emfFindings(buf, nested = () => {}) {
  const found = []; let p = 0, eof = false, records = 0, formats = 0;
  while (p < buf.length) {
    if (++records > 100000) throw new Error('EMF record count exceeds 100000');
    if (p + 8 > buf.length) throw new Error('Truncated EMF record');
    const type = buf.readUInt32LE(p), size = buf.readUInt32LE(p + 4);
    if (size < 8 || size % 4 || p + size > buf.length) throw new Error('Invalid or truncated EMF record size');
    if ((records === 1 && (type !== 1 || size < 88)) || (records > 1 && type === 1)) throw new Error('Invalid EMF header record');
    if (type === 14 && size < 20) throw new Error('Truncated EMF EOF record');
    if (type === 70) {
      if (size < 12 || buf.readUInt32LE(p + 8) > size - 12) throw new Error('Truncated EMF GDI comment');
      const data = buf.subarray(p + 12, p + 12 + buf.readUInt32LE(p + 8));
      // MS-EMF 2.3.3.4.3: offData is relative to the comment identifier,
      // not the record header. Do not treat binary multiformat data as text.
      if (data.length >= 8 && data.toString('ascii', 0, 4) === 'GDIC' && data.readUInt32LE(4) === 0x40000004) {
        if (data.length < 28) throw new Error('Truncated EMF multiformat header');
        const outputRect = Array.from({ length: 4 }, (_, i) => data.readInt32LE(8 + i * 4));
        const count = data.readUInt32LE(24), tableEnd = 28 + count * 16;
        if (count > 256 || formats + count > 256) throw new Error('EMF countFormats exceeds 256');
        if (tableEnd > data.length) throw new Error('Truncated EMF EmrFormat table');
        for (let i = 0; i < count; i++) {
          const at = 28 + i * 16;
          const signature = data.readUInt32LE(at), version = data.readUInt32LE(at + 4);
          const sizeData = data.readUInt32LE(at + 8), offData = data.readUInt32LE(at + 12);
          if (offData < tableEnd || offData > data.length || sizeData > data.length - offData) throw new Error('EMF multiformat offData/sizeData out of bounds');
          nested(data.subarray(offData, offData + sizeData), `EMF multiformat[${formats++}]`, { signature, version, outputRect });
        }
        p += size;
        continue;
      }
      const text = data.toString('utf8'), marker = /chemdraft\0|chemdraft:|chemdraft-spike/.exec(text);
      if (marker) {
        const carrier = 'emf GDI comment';
        try {
          if (data.length > MAX_ENVELOPE) throw new Error('EMF envelope exceeds 20 MB');
          const before = text.lastIndexOf('{', marker.index);
          const start = before >= 0 ? before : text.indexOf('{', marker.index), end = text.lastIndexOf('}');
          if (start >= 0 && end >= start) found.push({ carrier, envelope: Buffer.from(text.slice(start, end + 1)) });
          else {
            const encoded = /^chemdraft:\s*([A-Za-z0-9+/=]+)/.exec(text.slice(marker.index));
            if (!encoded) throw new Error('chemdraft marker present; unknown envelope encoding');
            found.push({ carrier, envelope: inflateRawSync(Buffer.from(encoded[1], 'base64'), { maxOutputLength: MAX_ENVELOPE }) });
          }
        } catch (error) { found.push({ carrier, error: error.message }); }
      }
    }
    p += size;
    if (type === 14) { eof = true; break; }
  }
  if (!eof || trailingNuls(buf.subarray(p)) !== buf.length - p) throw new Error('Missing EMF EOF or trailing bytes');
  if (p < buf.length) found.notes = paddingNotes(buf.length - p);
  return found;
}
