import { inflateRawSync } from 'node:zlib';
import { MAX_ENVELOPE, trailingNuls, paddingNotes } from './payload.mjs';

const MAX_OBJECT = 200 * 1024 * 1024;

function emfPlusPictures(nested) {
  let records = 0, pending = null;
  const image = (data, id) => {
    if (data.length < 8) throw new Error('Truncated EMF+ Image header');
    const version = data.readUInt32LE(0), imageType = data.readUInt32LE(4);
    const label = `EMF+ image object[${id}]`;
    if (imageType === 1) {
      if (data.length < 28) throw new Error('Truncated EMF+ Bitmap header');
      if (data.readUInt32LE(24) !== 1) return; // Uncompressed pixels have no encoded picture.
      nested(data.subarray(28), label, { objectId: id, version, imageType,
        width: data.readInt32LE(8), height: data.readInt32LE(12),
        stride: data.readInt32LE(16), pixelFormat: data.readUInt32LE(20) });
    } else if (imageType === 2) {
      if (data.length < 16) throw new Error('Truncated EMF+ Metafile header');
      const metafileType = data.readUInt32LE(8), length = data.readUInt32LE(12);
      if (length !== data.length - 16) throw new Error('EMF+ MetafileDataSize out of bounds');
      nested(data.subarray(16), label, { objectId: id, version, imageType, metafileType });
    }
  };
  return {
    comment(data) {
      let p = 4; // EMF+ identifier, followed by records (padding is outside DataSize).
      while (p < data.length) {
        if (++records > 100000) throw new Error('EMF+ record count exceeds 100000');
        if (data.length - p < 12) throw new Error('Truncated EMF+ record header');
        const type = data.readUInt16LE(p), flags = data.readUInt16LE(p + 2);
        const size = data.readUInt32LE(p + 4), dataSize = data.readUInt32LE(p + 8);
        if (size < 12 || size % 4 || size > data.length - p) throw new Error('Invalid or truncated EMF+ record size');
        if (dataSize > size - 12) throw new Error('EMF+ DataSize exceeds record size');
        const id = flags & 0xff, objectType = (flags >>> 8) & 0x7f;
        if (pending && type === 0x4008 && (objectType !== 5 || id !== pending.id)) {
          throw new Error('EMF+ interleaving interrupts continued Image object');
        }
        // Only Image objects need assembly; other object payloads remain opaque.
        if (type === 0x4008 && objectType === 5) {
          let bytes = data.subarray(p + 12, p + 12 + dataSize);
          if (flags & 0x8000) {
            if (bytes.length < 4) throw new Error('Truncated EMF+ TotalObjectSize');
            const total = bytes.readUInt32LE(0);
            if (total > MAX_OBJECT) throw new Error('EMF+ TotalObjectSize exceeds 200 MB');
            if (pending && total !== pending.total) throw new Error('EMF+ mismatched TotalObjectSize');
            if (!pending) pending = { id, total, length: 0, chunks: [] };
            bytes = bytes.subarray(4);
          }
          if (pending) {
            if (bytes.length > pending.total - pending.length) throw new Error('EMF+ Image chunk overruns TotalObjectSize');
            pending.chunks.push(bytes);
            pending.length += bytes.length;
            if (pending.length === pending.total) {
              // Do not allocate TotalObjectSize until all bounded chunks are present.
              const complete = Buffer.concat(pending.chunks, pending.total);
              pending = null;
              image(complete, id);
            } else if (!(flags & 0x8000)) throw new Error('EMF+ Image final chunk does not reach TotalObjectSize');
          } else {
            if (bytes.length > MAX_OBJECT) throw new Error('EMF+ Image object exceeds 200 MB');
            image(bytes, id);
          }
        }
        p += size;
      }
    },
    finish() {
      if (pending) throw new Error('Unfinished EMF+ Image object at EOF');
    },
  };
}

// Only explicit prefixes in plain GDI comments identify our own envelope format.
export function emfFindings(buf, nested = () => {}) {
  const found = []; let p = 0, eof = false, records = 0, formats = 0;
  const emfPlus = emfPlusPictures(nested);
  while (p < buf.length) {
    if (++records > 100000) throw new Error('EMF record count exceeds 100000');
    if (p + 8 > buf.length) throw new Error('Truncated EMF record');
    const type = buf.readUInt32LE(p), size = buf.readUInt32LE(p + 4);
    if (size < 8 || size % 4 || p + size > buf.length) throw new Error('Invalid or truncated EMF record size');
    if ((records === 1 && (type !== 1 || size < 88)) || (records > 1 && type === 1)) throw new Error('Invalid EMF header record');
    if (type === 14 && size < 16) throw new Error('Truncated EMF EOF record');
    if (type === 70) {
      if (size < 12 || buf.readUInt32LE(p + 8) > size - 12) throw new Error('Truncated EMF GDI comment');
      const data = buf.subarray(p + 12, p + 12 + buf.readUInt32LE(p + 8));
      if (data.length >= 4 && data.readUInt32LE(0) === 0x2b464d45) {
        emfPlus.comment(data);
        p += size;
        continue;
      }
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
      const prefix = data.toString('utf8', 0, 28);
      if (!prefix.startsWith('GDIC') && (prefix.startsWith('chemdraft\0') ||
          prefix.startsWith('chemdraft:') || prefix.startsWith('{"format":"chemdraft-spike"'))) {
        const carrier = 'emf GDI comment';
        try {
          if (data.length > MAX_ENVELOPE) throw new Error('EMF envelope exceeds 20 MB');
          if (prefix.startsWith('chemdraft:')) {
            const text = data.subarray(0, data.length - trailingNuls(data)).toString('utf8');
            const encoded = /^chemdraft:\s*([A-Za-z0-9+/]+={0,2})\s*$/.exec(text);
            if (!encoded) throw new Error('chemdraft marker present; unknown envelope encoding');
            found.push({ carrier, envelope: inflateRawSync(Buffer.from(encoded[1], 'base64'), { maxOutputLength: MAX_ENVELOPE }) });
          } else found.push({ carrier, envelope: prefix.startsWith('chemdraft\0') ? data.subarray(10) : data });
        } catch (error) { found.push({ carrier, error: error.message }); }
      }
    }
    p += size;
    if (type === 14) {
      eof = true;
      if (size < 20) found.notes = [...(found.notes ?? []), `short EMR_EOF (${size} bytes; MS-EMF says 20), as Word for Mac writes`];
      break;
    }
  }
  if (!eof || trailingNuls(buf.subarray(p)) !== buf.length - p) throw new Error('Missing EMF EOF or trailing bytes');
  emfPlus.finish();
  if (p < buf.length) found.notes = [...(found.notes ?? []), ...paddingNotes(buf.length - p)];
  return found;
}
