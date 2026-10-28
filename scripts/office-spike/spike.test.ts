import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { makeEnvelope, checkEnvelope, sha256, MAX_ENVELOPE } from './payload.mjs';
import { chunks, makePng, pngFindings, crc32 } from './png.mjs';
import { makeSvg, svgFindings } from './svg.mjs';
import { readZip } from './zip.mjs';
import { makePdf, readPdf } from './pdf.mjs';
import { inspectBlob, inspectPath } from './inspect.mjs';
import { makeCarriers } from './make-carriers.mjs';

const payload = '{"name":"caffeine"}';
const envelope = makeEnvelope(payload);
const png = readFileSync('packages/fixtures/office/sample.png');
const svg = readFileSync('packages/fixtures/office/sample.svg');
const fixtureDir = 'packages/fixtures/office';
const pdf = readFileSync(join(fixtureDir, 'sample.pdf'));
const temp = mkdtempSync(join(tmpdir(), 'office-spike-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe('office spike primitives', () => {
  it('checks envelope integrity and size', () => {
    expect(checkEnvelope(envelope).ok).toBe(true);
    const tampered = JSON.parse(envelope.toString());
    tampered.payload = '{}';
    expect(checkEnvelope(Buffer.from(JSON.stringify(tampered))).ok).toBe(false);
    expect(checkEnvelope(Buffer.alloc(20 * 1024 * 1024 + 1)).ok).toBe(false);
    expect(() => makeEnvelope({ text: 'x'.repeat(MAX_ENVELOPE) })).toThrow(/20 MB/);
    expect(checkEnvelope(Buffer.from('null')).ok).toBe(false);
  });
  it.each([['zTXt', undefined], ['iTXt', undefined], ['zTXt', 96], ['zTXt', 384]])('round trips PNG %s at %s', (kind, dpi) => {
    const carrier = makePng(png, envelope, kind, dpi);
    const list = chunks(carrier);
    expect(list[0].type).toBe('IHDR');
    expect(list.at(-1)?.type).toBe('IEND');
    const found = pngFindings(carrier);
    expect(checkEnvelope(found.found[0].envelope).sha256).toBe(checkEnvelope(envelope).sha256);
    if (dpi) expect(found.dpi[0]).toBeCloseTo(dpi, 1);
  });
  it.each(['metadata', 'comment'])('round trips SVG %s', kind => {
    expect(checkEnvelope(svgFindings(makeSvg(svg, envelope, kind))[0].envelope).sha256).toBe(checkEnvelope(envelope).sha256);
  });
  it('replaces existing PNG pHYs rather than adding a duplicate', () => {
    const existing = makePng(png, envelope, 'zTXt', 96);
    const replaced = makePng(existing, envelope, 'zTXt', 384);
    expect(chunks(replaced).filter(item => item.type === 'pHYs')).toHaveLength(1);
    expect(pngFindings(replaced).dpi[0]).toBeCloseTo(384, 1);
  });
  it('rejects truncated PNG and invalid ZIP', () => {
    expect(() => chunks(png.subarray(0, png.length - 1))).toThrow();
    expect(() => readZip(Buffer.from('PK'))).toThrow();
  });
});

function zip(entries: { name: string; data: Buffer; deflate?: boolean }[]) {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0;
  for (const { name, data, deflate } of entries) {
    const filename = Buffer.from(name), bytes = deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
    const crc = crc32(data);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, filename, bytes); centrals.push(central, filename); offset += local.length + filename.length + bytes.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

it('checks ZIP data CRC and entry count', () => {
  const archive = zip([{ name: 'word/media/image.png', data: png }]);
  expect(readZip(archive)[0].data.equals(png)).toBe(true);
  const bad = Buffer.from(archive);
  bad[30 + Buffer.byteLength('word/media/image.png')] ^= 1;
  expect(() => readZip(bad)).toThrow(/CRC/);
  const tooMany = Buffer.from(archive);
  tooMany.writeUInt16LE(2001, tooMany.length - 14);
  tooMany.writeUInt16LE(2001, tooMany.length - 12);
  expect(() => readZip(tooMany)).toThrow(/2000/);
  const path = join(temp, 'oversized.zip'); writeFileSync(path, tooMany);
  expect(inspectPath(path)[0].error).toMatch(/2000/);
});

describe('complete carrier matrix', () => {
  const expected = checkEnvelope(makeEnvelope(readFileSync(join(fixtureDir, 'sample-document.json'), 'utf8'))).sha256;
  it('generates all eight variants and a correct manifest; committed fixtures match', () => {
    const out = join(temp, 'carriers');
    makeCarriers({ payload: join(fixtureDir, 'sample-document.json'), png: join(fixtureDir, 'sample.png'), svg: join(fixtureDir, 'sample.svg'), pdf: join(fixtureDir, 'sample.pdf'), out });
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(manifest).toHaveLength(8);
    for (const item of manifest) {
      const bytes = readFileSync(join(out, item.file));
      expect(sha256(bytes)).toBe(item.sha256);
      expect(bytes.equals(readFileSync(join(fixtureDir, 'carriers', item.file)))).toBe(true);
      const row = inspectBlob(bytes, item.file, item.file, expected);
      expect(row.error).toBeNull();
      expect(row.findings).toHaveLength(1);
      expect(row.findings[0]).toMatchObject({ envelope: { ok: true, sha256: expected }, matchesExpect: true });
      expect(inspectBlob(bytes, item.file, item.file, '0'.repeat(64)).findings[0].matchesExpect).toBe(false);
    }
  });
  it('keeps fixtures under 3 MB, with a 150–300 KB large native document and a reaction', () => {
    const sizes = (dir: string): number => readdirSync(dir).reduce((n, name) => n + (statSync(join(dir, name)).isDirectory() ? sizes(join(dir, name)) : statSync(join(dir, name)).size), 0);
    expect(sizes(fixtureDir)).toBeLessThan(3 * 1024 * 1024);
    expect(statSync(join(fixtureDir, 'large-document.json')).size).toBeGreaterThanOrEqual(150 * 1024);
    expect(statSync(join(fixtureDir, 'large-document.json')).size).toBeLessThanOrEqual(300 * 1024);
    const sample = JSON.parse(readFileSync(join(fixtureDir, 'sample-document.json'), 'utf8'));
    expect(sample.pages[0].objects.some((obj: { type: string }) => obj.type === 'reaction-arrow')).toBe(true);
  });
});

it.each(['embedded', 'catalog-key'])('PDF %s is append-only with valid new xref offsets and /Prev', kind => {
  const bytes = makePdf(pdf, envelope, kind);
  expect(bytes.subarray(0, pdf.length).equals(pdf)).toBe(true);
  const text = bytes.toString('latin1');
  const start = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)![1]);
  expect(text.slice(start, start + 4)).toBe('xref');
  const section = text.slice(start, text.indexOf('trailer', start));
  const rows = [...section.matchAll(/(\d+) 1\n(\d{10}) (\d{5}) n /g)];
  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (const row of rows) expect(text.slice(Number(row[2]))).toMatch(new RegExp(`^${row[1]} ${Number(row[3])} obj\\b`));
  const parsed = readPdf(bytes);
  expect(parsed.trailer.get('Prev').number).toBe(readPdf(pdf).xref);
  for (const [key, value] of readPdf(pdf).catalog) expect(parsed.catalog.get(key).raw).toBe(value.raw);
  expect(inspectBlob(bytes, 'carrier.pdf').findings[0].envelope.ok).toBe(true);
});

function classicPdf(objects: string[]) {
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(text, 'latin1')); text += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const start = Buffer.byteLength(text, 'latin1');
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(text + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`, 'latin1');
}

it.each([false, true])('merges existing %s PDF /Names and attachment tree without losing catalog keys', indirect => {
  const names = '<< /Dests << /Names [(intro) [1 0 R /Fit]] >> /EmbeddedFiles 3 0 R >>';
  const original = classicPdf([
    `<< /Type /Catalog /Pages 2 0 R /Lang (en) /Custom [(nested \\(value\\)) << /Flag true >>] /Names ${indirect ? '5 0 R' : names} >>`,
    '<< /Type /Pages /Kids [] /Count 0 >>',
    '<< /Kids [4 0 R] >>',
    '<< /Names [(a.txt) << /Type /Filespec /F (a.txt) >>] /Limits [(a.txt) (a.txt)] >>', names
  ]);
  const updated = makePdf(original, envelope, 'embedded'), parsed = readPdf(updated), before = readPdf(original);
  for (const [key, value] of before.catalog) if (key !== 'Names') expect(parsed.catalog.get(key).raw).toBe(value.raw);
  const merged = parsed.resolve(parsed.catalog.get('Names')).entries;
  expect(merged.get('Dests').raw).toContain('(intro)');
  expect(parsed.resolve(merged.get('EmbeddedFiles')).raw).toContain('(a.txt)');
  expect(inspectBlob(updated, 'merged.pdf').findings[0].envelope.ok).toBe(true);
  expect(inspectBlob(makePdf(updated, envelope, 'catalog-key'), 'double.pdf').findings).toHaveLength(2);
});

it('refuses PDF xref streams, hybrid xrefs and truncated PDFs clearly', () => {
  const stream = Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /XRef >>\nendobj\nstartxref\n9\n%%EOF\n');
  expect(() => makePdf(stream, envelope, 'embedded')).toThrow(/xref streams/);
  const hybrid = classicPdf(['<< /Type /Catalog >>']).toString().replace('/Root 1 0 R', '/Root 1 0 R /XRefStm 9');
  expect(() => makePdf(Buffer.from(hybrid), envelope, 'embedded')).toThrow(/Hybrid/);
  expect(inspectBlob(pdf.subarray(0, pdf.length - 12), 'truncated.pdf').error).toMatch(/truncated/);
});

it.each(['word', 'ppt', 'xl'])('inspects a %s package with media references, relative/absolute targets, XML entities and deflate', host => {
  const part = host === 'ppt' ? 'slides/slide1.xml' : host === 'xl' ? 'drawings/drawing1.xml' : 'document.xml';
  const relDir = part.includes('/') ? part.slice(0, part.lastIndexOf('/') + 1) : '';
  const base = part.slice(part.lastIndexOf('/') + 1);
  const variants = readdirSync(join(fixtureDir, 'carriers')).filter(name => name !== 'manifest.json');
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${variants.map((name, i) => `<Relationship Id="r${i}" Target="${i % 2 ? `/${host}/media/` : relDir ? '../media/' : 'media/'}${name}"/>`).join('')}<Relationship TargetMode="External" Target="media/external.png"/><r:Relationship xmlns:r="rels" Target='/${host}/media/a&amp;b%20c.png'/></Relationships>`;
  const entries = variants.map((name, i) => ({ name: `${host}/media/${name}`, data: readFileSync(join(fixtureDir, 'carriers', name)), deflate: i % 2 === 0 }));
  entries.push({ name: `${host}/${relDir}_rels/${base}.rels`, data: Buffer.from(rels), deflate: true });
  entries.push({ name: `${host}/media/a&b c.png`, data: png, deflate: true });
  const path = join(temp, host + ({ word: '.docx', ppt: '.pptx', xl: '.xlsx' }[host])); writeFileSync(path, zip(entries));
  const rows = inspectPath(path);
  expect(rows).toHaveLength(9);
  for (const row of rows) { expect(row.error).toBeNull(); expect(row.references).toEqual([`${host}/${part}`]); }
  expect(rows.filter(row => row.findings[0]?.envelope.ok)).toHaveLength(8);
});

it('reports corrupt/truncated PNGs and bounded inflation failures', () => {
  const bad = Buffer.from(png); bad[29] ^= 1;
  expect(inspectBlob(bad, 'bad.png').error).toMatch(/CRC/);
  expect(inspectBlob(png.subarray(0, -1), 'short.png').error).toMatch(/Truncated/);
  const huge = Buffer.alloc(MAX_ENVELOPE + 1, 32);
  expect(pngFindings(makePng(png, huge, 'zTXt')).found[0].error).toBeTruthy();
  expect(svgFindings(makeSvg(svg, huge, 'comment'))[0].error).toBeTruthy();
});

it('refuses ZIP encryption, zip64, truncation, wrong sizes and total inflated sizes over 200 MB', () => {
  const source = zip([{ name: 'a', data: Buffer.from('ok'), deflate: true }]);
  const central = source.readUInt32LE(source.length - 6);
  for (const [offset, value, pattern, width] of [[central + 8, 1, /Encrypted/, 2], [central + 24, 0xffffffff, /ZIP64/, 4], [central + 24, 200 * 1024 * 1024 + 1, /200 MB/, 4], [central + 24, 1, /larger|size|buffer/i, 4]] as const) {
    const bad = Buffer.from(source); if (width === 2) bad.writeUInt16LE(value, offset); else bad.writeUInt32LE(value, offset);
    expect(() => readZip(bad)).toThrow(pattern);
  }
  expect(() => readZip(source.subarray(0, -1))).toThrow(/truncated/);
  const badPath = join(temp, 'bad.docx'), bad = Buffer.from(source); bad.writeUInt32LE(0, central + 16); writeFileSync(badPath, bad);
  expect(inspectPath(badPath)[0].error).toMatch(/CRC/);
  expect(readZip(zip([]))).toEqual([]);
});

it('reports a non-ZIP GVML blob with first bytes and a guess and inspects raw dump files', () => {
  const path = join(temp, 'gvml.zip'); writeFileSync(path, Buffer.from('not a zip'));
  expect(inspectPath(path)[0]).toMatchObject({ guess: 'not a ZIP', firstBytes: Buffer.from('not a zip').toString('hex') });
  expect(inspectBlob(Buffer.from('d0cf11e0a1b11ae1', 'hex'), 'gvml.bin').guess).toMatch(/OLE/);
  const raw = join(temp, 'clipboard.bin'); writeFileSync(raw, makePdf(pdf, envelope, 'embedded'));
  expect(inspectPath(raw)[0].findings[0].envelope.ok).toBe(true);
});

function emf(comment: Buffer) {
  const header = Buffer.alloc(88); header.writeUInt32LE(1); header.writeUInt32LE(88, 4); header.write(' EMF', 40);
  const record = Buffer.alloc(Math.ceil((12 + comment.length) / 4) * 4);
  record.writeUInt32LE(70); record.writeUInt32LE(record.length, 4); record.writeUInt32LE(comment.length, 8); comment.copy(record, 12);
  const end = Buffer.alloc(20); end.writeUInt32LE(14); end.writeUInt32LE(20, 4);
  return Buffer.concat([header, record, end]);
}
it('detects EMF GDI comment envelopes, unknown marker encodings and corrupt records', () => {
  for (const data of [Buffer.concat([Buffer.from('chemdraft\0'), envelope]), Buffer.from('chemdraft:' + deflateRawSync(envelope).toString('base64'))]) {
    expect(inspectBlob(emf(data), 'sample.emf').findings[0]).toMatchObject({ carrier: 'emf GDI comment', envelope: { ok: true } });
  }
  expect(inspectBlob(emf(Buffer.from('chemdraft unknown')), 'unknown.emf').findings[0].error).toMatch(/unknown/);
  expect(inspectBlob(emf(envelope).subarray(0, -1), 'truncated.emf').error).toMatch(/truncated/);
});
