import { inflateRawSync } from 'node:zlib';
import { MAX_ENVELOPE } from './payload.mjs';

// Recognize marker + UTF-8 envelope, or marker + base64 raw-deflate (the SVG encoding).
export function emfFindings(buf) {
  const found = []; let p = 0, eof = false;
  while (p < buf.length) {
    if (p + 8 > buf.length) throw new Error('Truncated EMF record');
    const type = buf.readUInt32LE(p), size = buf.readUInt32LE(p + 4);
    if (size < 8 || size % 4 || p + size > buf.length) throw new Error('Invalid or truncated EMF record size');
    if (type === 70) {
      if (size < 12 || buf.readUInt32LE(p + 8) > size - 12) throw new Error('Truncated EMF GDI comment');
      const data = buf.subarray(p + 12, p + 12 + buf.readUInt32LE(p + 8));
      const text = data.toString('utf8'), marker = /chemdraft/i.exec(text);
      if (marker) {
        const carrier = 'emf GDI comment';
        try {
          if (data.length > MAX_ENVELOPE) throw new Error('EMF envelope exceeds 20 MB');
          const start = text.indexOf('{', marker.index), end = text.lastIndexOf('}');
          if (start >= 0 && end >= start) found.push({ carrier, envelope: Buffer.from(text.slice(start, end + 1)) });
          else {
            const encoded = /^chemdraft\s*:\s*([A-Za-z0-9+/=]+)/i.exec(text.slice(marker.index));
            if (!encoded) throw new Error('chemdraft marker present; unknown envelope encoding');
            found.push({ carrier, envelope: inflateRawSync(Buffer.from(encoded[1], 'base64'), { maxOutputLength: MAX_ENVELOPE }) });
          }
        } catch (error) { found.push({ carrier, error: error.message }); }
      }
    }
    p += size;
    if (type === 14) { eof = true; break; }
  }
  if (!eof || p !== buf.length) throw new Error('Missing EMF EOF or trailing bytes');
  return found;
}
