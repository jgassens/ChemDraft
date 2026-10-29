const WINDOW = 20 * 1024 * 1024;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

// Fallback carving only; every candidate is validated by the ordinary reader.
// Windows and hit counts bound work even when signatures are deliberately dense.
export function scanPictures(buf, nested) {
  let hits = 0;
  for (const [kind, magic] of [['PDF', Buffer.from('%PDF')], ['PNG', PNG], ['SVG', Buffer.from('<svg')]]) {
    let from = 0, start;
    while ((start = buf.indexOf(magic, from)) >= 0) {
      if (++hits > 128) throw new Error('Byte scan candidate count exceeds 128');
      let limit = Math.min(buf.length, start + WINDOW);
      if (kind === 'PDF') {
        // Keep incremental updates (multiple EOFs), without swallowing the next
        // independent PDF in an opaque container.
        const next = buf.indexOf(magic, start + magic.length);
        if (next >= 0) limit = Math.min(limit, next);
      }
      const window = buf.subarray(start, limit);
      let end = -1;
      if (kind === 'PDF') {
        const eof = window.lastIndexOf('%%EOF');
        if (eof >= 4) end = start + eof + 5;
      } else if (kind === 'SVG') {
        const close = window.indexOf('</svg>');
        if (close >= 0) end = start + close + 6;
      } else {
        let p = 8, chunks = 0;
        while (p + 12 <= window.length) {
          if (++chunks > 100000) throw new Error('Byte scan PNG chunk count exceeds 100000');
          const length = window.readUInt32BE(p);
          if (length > window.length - p - 12) break;
          const iend = window.toString('ascii', p + 4, p + 8) === 'IEND';
          p += length + 12;
          if (iend) { end = start + p; break; }
        }
      }
      if (end < 0) throw new Error(`Byte scan ${kind} at ${start}: missing terminator within 20 MB`);
      nested(buf.subarray(start, end), `byte scan at ${start} (${kind}; found by byte scan)`, { foundBy: 'byte scan', offset: start });
      from = end;
    }
  }
}
