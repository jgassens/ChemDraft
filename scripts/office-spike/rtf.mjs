export const MAX_PICTURE = 20 * 1024 * 1024;
const space = c => c === 32 || (c >= 9 && c <= 13);
const letter = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const digit = c => c >= 48 && c <= 57;
const hex = c => digit(c) ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;

// Iterative RTF lexer. Picture properties in child destinations are skipped;
// braces and backslashes inside \bin are bytes, never group syntax.
export function rtfPictures(buf, nested) {
  const stack = [], completed = []; let p = 0, count = 0, objects = 0, decoded = 0, spans = 0;
  const add = (pic, start, end, binary) => {
    const length = end - start;
    if (binary && pic.nibbles % 2) throw new Error('RTF pict has odd-length hex before bin');
    if (binary) pic.binary += length;
    else pic.nibbles += length;
    if (pic.binary + Math.ceil(pic.nibbles / 2) > MAX_PICTURE) throw new Error('RTF decoded picture exceeds 20 MB');
    if (pic.spans.length >= 100000) throw new Error('RTF picture data spans exceed 100000');
    if (++spans > 200000) throw new Error('RTF total picture data spans exceed 200000');
    pic.spans.push({ start, end, binary });
  };
  while (p < buf.length) {
    const c = buf[p++], frame = stack.at(-1);
    if (c === 123) {
      if (stack.length >= 256) throw new Error('RTF group nesting exceeds 256');
      stack.push({ picture: null });
    } else if (c === 125) {
      if (!frame) throw new Error('Unbalanced RTF closing brace');
      const pic = stack.pop().picture;
      if (pic) {
        if (pic.nibbles % 2) throw new Error('RTF pict has odd-length hex');
        const length = pic.binary + pic.nibbles / 2;
        if (decoded + length > 200 * 1024 * 1024) throw new Error('RTF decoded pictures exceed 200 MB');
        decoded += length;
        completed.push({ pic, length });
      }
    } else if (c === 92) {
      const start = p;
      if (!letter(buf[p])) {
        if (buf[p++] === 39) {
          if (p + 2 > buf.length || hex(buf[p]) < 0 || hex(buf[p + 1]) < 0) throw new Error('Invalid RTF escaped byte');
          p += 2;
        }
        continue;
      }
      while (letter(buf[p])) p++;
      if (p - start > 64) throw new Error('RTF control word exceeds 64 bytes');
      const word = buf.toString('ascii', start, p);
      const numberStart = p;
      if (buf[p] === 45) p++;
      const digitsStart = p;
      while (digit(buf[p])) p++;
      if (p - digitsStart > 10) throw new Error('RTF control parameter exceeds 10 digits');
      const value = p > digitsStart ? Number(buf.toString('ascii', numberStart, p)) : null;
      if (buf[p] === 32) p++;
      if (word === 'pict' || word === 'objdata') {
        if (!frame || frame.picture) throw new Error('Invalid RTF pict group');
        if (count + objects >= 256) throw new Error('RTF picture count exceeds 256');
        frame.picture = { destination: word, index: word === 'pict' ? count++ : objects++, order: count + objects, kind: 'unknown blip', dimensions: {}, spans: [], nibbles: 0, binary: 0 };
      }
      const pic = frame?.picture;
      if (pic) {
        if (word.endsWith('blip') || ['macpict', 'wmetafile', 'dibitmap', 'wbitmap'].includes(word)) pic.kind = word + (value ?? '');
        if (['picw', 'pich', 'picwgoal', 'pichgoal'].includes(word)) {
          if (value === null) throw new Error(`RTF ${word} requires a value`);
          pic.dimensions[word] = value;
        }
      }
      if (word === 'bin') {
        if (value === null || value < 0 || value > buf.length - p) throw new Error('RTF bin length out of bounds');
        if (pic) add(pic, p, p + value, true);
        p += value;
      }
    } else if (frame?.picture && !space(c)) {
      const start = p - 1;
      if (hex(c) < 0) throw new Error('Invalid RTF pict hex');
      while (hex(buf[p]) >= 0) p++;
      add(frame.picture, start, p, false);
    } else if (!stack.length && !space(c) && c !== 0) throw new Error('RTF trailing bytes outside root group');
  }
  if (stack.length) throw new Error('Truncated RTF group');
  for (const { pic, length } of completed.sort((a, b) => a.pic.order - b.pic.order)) {
    const bytes = Buffer.alloc(length); let at = 0, high = -1;
    for (const span of pic.spans) {
      if (span.binary) { buf.copy(bytes, at, span.start, span.end); at += span.end - span.start; }
      else for (let i = span.start; i < span.end; i++) {
        const nibble = hex(buf[i]);
        if (high < 0) high = nibble;
        else { bytes[at++] = high * 16 + nibble; high = -1; }
      }
    }
    nested(bytes, `${pic.destination}[${pic.index}] ${pic.kind}`, { kind: pic.kind, ...pic.dimensions });
  }
}
