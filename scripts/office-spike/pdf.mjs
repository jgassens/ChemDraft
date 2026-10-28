import { deflateSync, inflateSync } from 'node:zlib';
import { MAX_ENVELOPE } from './payload.mjs';

// Deliberately small PDF reader: classic xrefs, no object streams or encryption.
function parser(text, start = 0) {
  let p = start;
  const skip = () => { while (p < text.length) { if (/\s/.test(text[p])) p++; else if (text[p] === '%') { while (p < text.length && !/[\r\n]/.test(text[p])) p++; } else break; } };
  function value(depth = 0) {
    if (depth > 100) throw new Error('PDF syntax nesting exceeds 100');
    skip(); const begin = p; let result;
    if (text.startsWith('<<', p)) {
      p += 2; const entries = new Map();
      while (true) {
        skip(); if (text.startsWith('>>', p)) { p += 2; break; }
        const key = value(depth + 1);
        if (key.type !== 'name') throw new Error('Invalid PDF dictionary key');
        entries.set(key.name, value(depth + 1));
      }
      result = { type: 'dict', entries };
    } else if (text[p] === '[') {
      p++; const items = [];
      while (true) { skip(); if (text[p] === ']') { p++; break; } items.push(value(depth + 1)); }
      result = { type: 'array', items };
    } else if (text[p] === '(') {
      p++; let level = 1, decoded = '';
      while (level && p < text.length) {
        let c = text[p++];
        if (c === '\\') {
          c = text[p++];
          if (/[0-7]/.test(c ?? '')) { let oct = c; while (oct.length < 3 && /[0-7]/.test(text[p] ?? '')) oct += text[p++]; decoded += String.fromCharCode(parseInt(oct, 8)); }
          else if (c === '\r' || c === '\n') { if (c === '\r' && text[p] === '\n') p++; }
          else decoded += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] ?? c;
        } else { if (c === '(') level++; if (c === ')') level--; if (level) decoded += c; }
      }
      if (level) throw new Error('Truncated PDF string');
      result = { type: 'string', decoded };
    } else if (text[p] === '<') {
      const end = text.indexOf('>', ++p); if (end < 0) throw new Error('Truncated PDF hex string');
      let hex = text.slice(p, end).replace(/\s/g, ''); if (!/^[a-f\d]*$/i.test(hex)) throw new Error('Invalid PDF hex string');
      if (hex.length % 2) hex += '0'; p = end + 1; result = { type: 'string', decoded: Buffer.from(hex, 'hex').toString('latin1') };
    } else if (text[p] === '/') {
      p++; const match = /^[^\s()[\]<>/%]+/.exec(text.slice(p));
      const name = match?.[0] ?? ''; p += name.length;
      result = { type: 'name', name: name.replace(/#([a-f\d]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    } else {
      const ref = /^(\d+)\s+(\d+)\s+R\b/.exec(text.slice(p));
      const token = /^[^\s()[\]<>/%]+/.exec(text.slice(p));
      if (ref) { p += ref[0].length; result = { type: 'ref', id: +ref[1], gen: +ref[2] }; }
      else if (token) { p += token[0].length; result = { type: 'token', number: Number(token[0]) }; }
      else throw new Error(`Invalid or truncated PDF syntax at ${p}`);
    }
    return { ...result, raw: text.slice(begin, p) };
  }
  return { value, get position() { return p; } };
}
const raw = text => ({ raw: text });
const dictionary = entries => `<<\n${[...entries].map(([key, v]) => `/${key.replace(/[^A-Za-z0-9]/g, c => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'))} ${v.raw}`).join('\n')}\n>>`;
const dict = v => { if (v?.type !== 'dict') throw new Error('Expected PDF dictionary'); return v.entries; };

export function readPdf(buf) {
  const text = buf.toString('latin1');
  if (!text.startsWith('%PDF-')) throw new Error('Invalid PDF signature');
  const end = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  if (!end) throw new Error('PDF startxref not found or PDF truncated');
  const xref = +end[1], objects = new Map(), visited = new Set(), trailer = new Map();
  let offset = xref;
  while (true) {
    if (visited.has(offset) || visited.size >= 100) throw new Error('Invalid PDF /Prev chain');
    visited.add(offset);
    if (!text.startsWith('xref', offset)) throw new Error('PDF xref streams are unsupported; use a classic xref table');
    let p = offset + 4;
    while (true) {
      p += /^\s*/.exec(text.slice(p))[0].length;
      if (text.startsWith('trailer', p)) { p += 7; break; }
      const section = /^(\d+)\s+(\d+)\s*/.exec(text.slice(p));
      if (!section || +section[2] > 100000 || objects.size + +section[2] > 200000) throw new Error('Invalid or oversized PDF xref subsection');
      p += section[0].length;
      for (let i = 0; i < +section[2]; i++) {
        const row = /^(\d{10}) (\d{5}) ([nf])\s*/.exec(text.slice(p));
        if (!row) throw new Error('Truncated PDF xref table');
        const id = +section[1] + i;
        if (!objects.has(id)) objects.set(id, row[3] === 'n' ? { offset: +row[1], gen: +row[2] } : null);
        p += row[0].length;
      }
    }
    const current = dict(parser(text, p).value());
    if (current.has('XRefStm')) throw new Error('Hybrid PDF xref streams are unsupported');
    if (current.has('Encrypt')) throw new Error('Encrypted PDF is unsupported');
    for (const [key, v] of current) if (!trailer.has(key)) trailer.set(key, v);
    if (!current.has('Prev')) break;
    offset = current.get('Prev').number;
  }
  function object(ref) {
    if (ref?.type !== 'ref') throw new Error('Expected PDF object reference');
    const record = objects.get(ref.id);
    if (!record || record.gen !== ref.gen) throw new Error(`Missing PDF object ${ref.raw}`);
    const header = /^(\d+)\s+(\d+)\s+obj\b/.exec(text.slice(record.offset));
    if (!header || +header[1] !== ref.id || +header[2] !== ref.gen) throw new Error(`Invalid PDF object offset: ${ref.raw}`);
    const reader = parser(text, record.offset + header[0].length), v = reader.value();
    return { value: v, position: reader.position };
  }
  const resolve = v => v?.type === 'ref' ? object(v).value : v;
  function stream(ref) {
    const obj = object(ref), entries = dict(obj.value);
    const marker = /^\s*stream(?:\r\n|\n|\r)/.exec(text.slice(obj.position));
    const length = resolve(entries.get('Length'))?.number;
    if (!marker || !Number.isSafeInteger(length) || length < 0) throw new Error('Invalid PDF stream length');
    const start = obj.position + marker[0].length;
    if (start + length > buf.length || !/^\s*endstream\b/.test(text.slice(start + length))) throw new Error('Truncated PDF stream');
    let filter = resolve(entries.get('Filter'));
    if (filter?.type === 'array' && filter.items.length === 1) filter = filter.items[0];
    const bytes = buf.subarray(start, start + length);
    if (!filter) { if (length > MAX_ENVELOPE) throw new Error('PDF envelope exceeds 20 MB'); return bytes; }
    if (filter.name !== 'FlateDecode') throw new Error('Unsupported PDF payload stream filter');
    return inflateSync(bytes, { maxOutputLength: MAX_ENVELOPE });
  }
  const catalogRef = trailer.get('Root'), catalog = dict(resolve(catalogRef));
  return { text, xref, objects, trailer, catalogRef, catalog, resolve, stream };
}

function namePairs(pdf, node, seen = new Set()) {
  if (seen.has(node?.raw) || seen.size >= 2000) throw new Error('Invalid or oversized PDF name tree');
  seen.add(node?.raw); const tree = dict(pdf.resolve(node));
  if (tree.has('Names')) {
    const list = pdf.resolve(tree.get('Names'));
    if (list?.type !== 'array' || list.items.length % 2) throw new Error('Invalid PDF /Names array');
    return Array.from({ length: list.items.length / 2 }, (_, i) => [list.items[2 * i], list.items[2 * i + 1]]);
  }
  if (!tree.has('Kids')) return [];
  const kids = pdf.resolve(tree.get('Kids'));
  if (kids?.type !== 'array') throw new Error('Invalid PDF name tree /Kids');
  return kids.items.flatMap(kid => namePairs(pdf, kid, seen));
}

export function makePdf(buf, envelope, kind) {
  const pdf = readPdf(buf), catalog = new Map(pdf.catalog), updates = [];
  let next = pdf.trailer.get('Size')?.number;
  if (!Number.isSafeInteger(next) || next < 1 || next > 0x7ffffff0) throw new Error('Invalid or oversized PDF /Size');
  for (const id of pdf.objects.keys()) next = Math.max(next, id + 1);
  const add = body => { const id = next++; updates.push({ id, gen: 0, body }); return `${id} 0 R`; };
  const compressed = deflateSync(envelope);
  const stream = add(Buffer.concat([Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode${kind === 'embedded' ? ' /Type /EmbeddedFile /Subtype /application#2Fjson' : ''} >>\nstream\n`), compressed, Buffer.from('\nendstream')]));
  if (kind === 'embedded') {
    const file = add(`<< /Type /Filespec /F (chemdraft.json) /UF (chemdraft.json) /EF << /F ${stream} >> >>`);
    const names = catalog.has('Names') ? new Map(dict(pdf.resolve(catalog.get('Names')))) : new Map();
    const pairs = names.has('EmbeddedFiles') ? namePairs(pdf, names.get('EmbeddedFiles')) : [];
    const kept = pairs.filter(([key]) => key.decoded !== 'chemdraft.json');
    kept.push([{ raw: '(chemdraft.json)', decoded: 'chemdraft.json' }, raw(file)]);
    kept.sort((a, b) => Buffer.compare(Buffer.from(a[0].decoded, 'latin1'), Buffer.from(b[0].decoded, 'latin1')));
    names.set('EmbeddedFiles', raw(add(`<< /Names [${kept.map(pair => pair.map(v => v.raw).join(' ')).join(' ')}] >>`)));
    catalog.set('Names', raw(add(dictionary(names))));
  } else if (kind === 'catalog-key') catalog.set('ChemDraftPayload', raw(stream));
  else throw new Error(`Unknown PDF carrier ${kind}`);
  updates.push({ id: pdf.catalogRef.id, gen: pdf.catalogRef.gen, body: dictionary(catalog) });
  let position = buf.length + 1; const parts = [buf, Buffer.from('\n')], offsets = [];
  for (const obj of updates) {
    const bytes = Buffer.concat([Buffer.from(`${obj.id} ${obj.gen} obj\n`), Buffer.from(obj.body), Buffer.from('\nendobj\n')]);
    offsets.push({ ...obj, offset: position }); parts.push(bytes); position += bytes.length;
  }
  let xref = 'xref\n';
  for (const obj of offsets.sort((a, b) => a.id - b.id)) xref += `${obj.id} 1\n${String(obj.offset).padStart(10, '0')} ${String(obj.gen).padStart(5, '0')} n \n`;
  const trailer = new Map(pdf.trailer); trailer.set('Size', raw(String(next))); trailer.set('Prev', raw(String(pdf.xref)));
  parts.push(Buffer.from(`${xref}trailer\n${dictionary(trailer)}\nstartxref\n${position}\n%%EOF\n`));
  return Buffer.concat(parts);
}

export function pdfFindings(buf) {
  const pdf = readPdf(buf), result = [];
  const take = (carrier, ref) => { try { result.push({ carrier, envelope: pdf.stream(ref) }); } catch (error) { result.push({ carrier, error: error.message }); } };
  if (pdf.catalog.has('ChemDraftPayload')) take('pdf catalog key', pdf.catalog.get('ChemDraftPayload'));
  if (pdf.catalog.has('Names')) {
    const names = dict(pdf.resolve(pdf.catalog.get('Names')));
    if (names.has('EmbeddedFiles')) for (const [name, ref] of namePairs(pdf, names.get('EmbeddedFiles'))) {
      const file = dict(pdf.resolve(ref));
      if (name.decoded !== 'chemdraft.json' && file.get('F')?.decoded !== 'chemdraft.json' && file.get('UF')?.decoded !== 'chemdraft.json') continue;
      const ef = dict(pdf.resolve(file.get('EF'))); take('pdf embedded file', ef.get('UF') ?? ef.get('F'));
    }
  }
  return result;
}
