import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join, resolve, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { makeEnvelope, checkEnvelope, sha256, MAX_ENVELOPE } from './payload.mjs';
import { chunks, chunk, makePng, pngFindings, crc32 } from './png.mjs';
import { isSvg, makeSvg, svgFindings } from './svg.mjs';
import { readZip } from './zip.mjs';
import { makePdf, readPdf, pdfFindings } from './pdf.mjs';
import { inspectBlob, inspectPath } from './inspect.mjs';
import { makeCarriers } from './make-carriers.mjs';
import { makeCfHtml } from './cf-html.mjs';
import { MAX_PICTURE, rtfPictures } from './rtf.mjs';
import { emfFindings } from './emf.mjs';

const payload = '{"name":"caffeine"}';
const envelope = makeEnvelope(payload);
const png = readFileSync('packages/fixtures/office/sample.png');
const svg = readFileSync('packages/fixtures/office/sample.svg');
const fixtureDir = 'packages/fixtures/office';
const pdf = readFileSync(join(fixtureDir, 'sample.pdf'));
const temp = mkdtempSync(join(tmpdir(), 'office-spike-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const blankParts = {
  docx: [
    '[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels',
    'word/styles.xml', 'word/settings.xml', 'docProps/core.xml', 'docProps/app.xml',
  ],
  pptx: [
    '[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels',
    'ppt/presProps.xml', 'ppt/viewProps.xml', 'ppt/tableStyles.xml',
    'ppt/slideMasters/slideMaster1.xml', 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    'ppt/slideLayouts/slideLayout1.xml', 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    'ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels', 'ppt/theme/theme1.xml',
    'docProps/core.xml', 'docProps/app.xml',
  ],
};

const blankContentTypes = {
  docx: {
    defaults: {
      rels: 'application/vnd.openxmlformats-package.relationships+xml',
      xml: 'application/xml',
    },
    overrides: {
      '/word/document.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
      '/word/styles.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
      '/word/settings.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
      '/docProps/core.xml': 'application/vnd.openxmlformats-package.core-properties+xml',
      '/docProps/app.xml': 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
    },
  },
  pptx: {
    defaults: {
      rels: 'application/vnd.openxmlformats-package.relationships+xml',
      xml: 'application/xml',
    },
    overrides: {
      '/ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
      '/ppt/presProps.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
      '/ppt/viewProps.xml': 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
      '/ppt/tableStyles.xml': 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
      '/ppt/slideMasters/slideMaster1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
      '/ppt/slideLayouts/slideLayout1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
      '/ppt/slides/slide1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
      '/ppt/theme/theme1.xml': 'application/vnd.openxmlformats-officedocument.theme+xml',
      '/docProps/core.xml': 'application/vnd.openxmlformats-package.core-properties+xml',
      '/docProps/app.xml': 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
    },
  },
};

const blankRelationships: Record<'docx' | 'pptx', Record<string, string[][]>> = {
  docx: {
    '_rels/.rels': [
      ['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', 'word/document.xml'],
      ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
      ['rId3', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'docProps/app.xml'],
    ],
    'word/_rels/document.xml.rels': [
      ['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', 'styles.xml'],
      ['rId2', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings', 'settings.xml'],
    ],
  },
  pptx: {
    '_rels/.rels': [
      ['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', 'ppt/presentation.xml'],
      ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
      ['rId3', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'docProps/app.xml'],
    ],
    'ppt/_rels/presentation.xml.rels': [
      ['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', 'slides/slide1.xml'],
      ['rId3', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps', 'presProps.xml'],
      ['rId4', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps', 'viewProps.xml'],
      ['rId5', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles', 'tableStyles.xml'],
      ['rId6', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', 'theme/theme1.xml'],
    ],
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': [
      ['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', '../theme/theme1.xml'],
    ],
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': [
      ['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', '../slideMasters/slideMaster1.xml'],
    ],
    'ppt/slides/_rels/slide1.xml.rels': [
      ['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', '../slideLayouts/slideLayout1.xml'],
    ],
  },
};

// Checks well-formedness of these generated parts (tag balance, one root, declared prefixes), not schema order.
function checkBlankXmlWellFormedness(text: string) {
  expect(text).toMatch(/^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>/);
  const stack: string[] = [];
  const prefixes = new Set([...text.matchAll(/xmlns:([\w]+)="[^"]+"/g)].map(m => m[1]));
  let roots = 0;
  for (const match of text.matchAll(/<([^>]+)>/g)) {
    const tag = match[1];
    if (tag.startsWith('?')) continue;
    const name = /^\/?([\w:]+)/.exec(tag)![1];
    if (name.includes(':')) expect(prefixes.has(name.split(':')[0]), name).toBe(true);
    if (tag.startsWith('/')) expect(stack.pop()).toBe(name);
    else {
      if (stack.length === 0) roots++;
      if (!tag.endsWith('/')) stack.push(name);
    }
  }
  expect(stack).toEqual([]);
  expect(roots).toBe(1);
}

describe('blank Office documents', () => {
  it.each(['docx', 'pptx'] as const)('writes a complete, deterministic %s package and overwrites only its output files', extension => {
    const out = join(temp, `blank-${extension}`, 'nested output');
    const run = () => spawnSync(process.execPath, ['scripts/office-spike/blank-docs.mjs', out], { encoding: 'utf8' });
    const firstRun = run();
    expect(firstRun.status, firstRun.stderr).toBe(0);
    expect(firstRun.stdout.trim().split(/\r?\n/)).toEqual([join(out, 'blank.docx'), join(out, 'blank.pptx')]);
    const first = readFileSync(join(out, `blank.${extension}`));
    const otherExtension = extension === 'docx' ? 'pptx' : 'docx';
    const otherFirst = readFileSync(join(out, `blank.${otherExtension}`));
    writeFileSync(join(out, 'keep.txt'), 'leave this alone');
    writeFileSync(join(out, 'blank.docx'), 'replace this');
    writeFileSync(join(out, 'blank.pptx'), 'replace this too');
    expect(run().status).toBe(0);
    expect(readFileSync(join(out, `blank.${extension}`)).equals(first)).toBe(true);
    expect(readFileSync(join(out, `blank.${otherExtension}`)).equals(otherFirst)).toBe(true);
    expect(readFileSync(join(out, 'keep.txt'), 'utf8')).toBe('leave this alone');
    expect(readdirSync(out).sort()).toEqual(['blank.docx', 'blank.pptx', 'keep.txt']);

    const entries = readZip(first);
    expect(entries.map(entry => entry.name)).toEqual(blankParts[extension]);
    expect(entries[0].name).toBe('[Content_Types].xml');
    // Check the physical first entry too, independently of central-directory order.
    expect(first.toString('utf8', 30, 30 + first.readUInt16LE(26))).toBe('[Content_Types].xml');
    expect(first.readUInt16LE(10)).toBe(0);
    expect(first.readUInt16LE(12)).toBe(0x21);
    const parts = new Map<string, string>(entries.map(entry => [entry.name, entry.data.toString('utf8')]));
    const types = parts.get('[Content_Types].xml')!;
    const defaults = new Map([...types.matchAll(/<Default Extension="([^"]+)" ContentType="([^"]+)"/g)].map(m => [m[1], m[2]]));
    const overrides = new Map([...types.matchAll(/<Override PartName="([^"]+)" ContentType="([^"]+)"/g)].map(m => [m[1], m[2]]));
    expect(Object.fromEntries(defaults)).toEqual(blankContentTypes[extension].defaults);
    expect(Object.fromEntries(overrides)).toEqual(blankContentTypes[extension].overrides);
    for (const name of overrides.keys()) expect(parts.has(name.slice(1)), name).toBe(true);
    const relationships: Record<string, string[][]> = {};
    for (const [name, text] of parts) {
      checkBlankXmlWellFormedness(text);
      // The content-type stream describes parts; it is not itself an OPC part.
      if (name !== '[Content_Types].xml') {
        expect(overrides.get(`/${name}`) ?? defaults.get(name.split('.').at(-1)!), name).toBeTruthy();
      }
      if (!name.endsWith('.rels')) continue;
      const sourceDirectory = name === '_rels/.rels' ? '' : name.slice(0, name.lastIndexOf('/_rels/'));
      const ids = new Set<string>();
      relationships[name] = [];
      for (const rel of text.matchAll(/<Relationship\s+([^>]+)\/>/g)) {
        const attrs = Object.fromEntries([...rel[1].matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
        expect(ids.has(attrs.Id)).toBe(false);
        ids.add(attrs.Id);
        relationships[name].push([attrs.Id, attrs.Type, attrs.Target]);
        expect(attrs.TargetMode).toBeUndefined();
        const target = posix.normalize(posix.join(sourceDirectory, attrs.Target));
        expect(parts.has(target), `${name} -> ${target}`).toBe(true);
      }
    }
    expect(relationships).toEqual(blankRelationships[extension]);
    expect(parts.get('docProps/app.xml')).toContain('<Application>ChemDraft Office spike</Application>');
    if (extension === 'docx') {
      expect(parts.get('word/settings.xml')).toContain('w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"');
      const doc = parts.get('word/document.xml')!;
      expect(doc.match(/<w:p\s*\/>/g)).toHaveLength(1);
      expect(doc).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
      expect(doc).toContain('w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"');
      expect(parts.get('word/styles.xml')).toContain('w:styleId="Normal"');
    } else {
      const presentation = parts.get('ppt/presentation.xml')!;
      expect(presentation.match(/<p:sldId /g)).toHaveLength(1);
      expect(presentation).toContain('<p:sldMasterId id="2147483648" r:id="rId1"/>');
      expect(presentation).toContain('<p:sldId id="256" r:id="rId2"/>');
      expect(presentation).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
      expect(presentation).toContain('<p:notesSz cx="6858000" cy="9144000"/>');
      expect(parts.get('ppt/slideLayouts/slideLayout1.xml')).toContain('type="blank"');
      expect(parts.get('ppt/slideLayouts/slideLayout1.xml')).toContain('name="Blank"');
      expect(parts.get('ppt/slideMasters/slideMaster1.xml')).toContain('<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>');
      for (const name of ['ppt/slides/slide1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/slideMasters/slideMaster1.xml']) {
        expect(parts.get(name)).not.toMatch(/<p:(?:ph|sp|pic|graphicFrame|cxnSp)\b/);
        expect(parts.get(name)).toContain('<p:nvGrpSpPr>');
        expect(parts.get(name)).toContain('<p:grpSpPr>');
      }
      const theme = parts.get('ppt/theme/theme1.xml')!;
      for (const [list, item] of [['fillStyleLst', 'solidFill'], ['lnStyleLst', 'ln'], ['effectStyleLst', 'effectStyle'], ['bgFillStyleLst', 'solidFill']]) {
        const contents = new RegExp(`<a:${list}>(.*?)</a:${list}>`).exec(theme)![1];
        expect(contents.match(new RegExp(`<a:${item}(?: |>)`, 'g'))).toHaveLength(3);
      }
      for (const colour of ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']) {
        expect(theme).toContain(`<a:${colour}>`);
      }
    }
  });

  it.each([[], ['one', 'two'], ['--force']])('exits 2 on invalid arguments: %j', (...args) => {
    const run = spawnSync(process.execPath, ['scripts/office-spike/blank-docs.mjs', ...args], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Usage:');
    expect(run.stdout).toBe('');
  });
});

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
    expect(pngFindings(replaced).found).toHaveLength(1);
    const changed = makePng(replaced, makeEnvelope('{}'), 'iTXt');
    expect(pngFindings(changed).found).toHaveLength(1);
    expect(checkEnvelope(pngFindings(changed).found[0].envelope).sha256).toBe(sha256('{}'));
  });
  it('rejects truncated PNG and invalid ZIP', () => {
    expect(() => chunks(png.subarray(0, png.length - 1))).toThrow();
    expect(() => readZip(Buffer.from('PK'))).toThrow();
  });
});

function carrierContents(bytes: Buffer, type: string) {
  if (type === 'png') return {
    payloads: pngFindings(bytes).found.map(f => JSON.parse(f.envelope.toString())),
    records: chunks(bytes).map(c => ({ type: c.type, data: ['zTXt', 'iTXt'].includes(c.type) ? c.data.subarray(0, c.type === 'zTXt' ? 11 : 14) : c.data })),
  };
  if (type === 'svg') return {
    payloads: svgFindings(bytes).map(f => JSON.parse(f.envelope.toString())),
    records: bytes.toString().replace(/(encoding="base64-deflate">)[A-Za-z0-9+/=]+/g, '$1PAYLOAD').replace(/(<!-- chemdraft:)[A-Za-z0-9+/=]+/g, '$1PAYLOAD'),
  };
  const parsed = readPdf(bytes);
  return {
    payloads: pdfFindings(bytes).map(f => JSON.parse(f.envelope.toString())),
    records: [...parsed.objects].map(([id, record]) => [id, record?.gen ?? null]),
    catalog: [...parsed.catalog].map(([key, value]) => [key, value.raw]),
    trailer: [...parsed.trailer].map(([key, value]) => [key, value.raw]),
    original: bytes.subarray(0, pdf.length),
  };
}

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

it('isolates the SVG sniffing size-cap error to its ZIP entry', () => {
  const path = join(temp, 'svg-size-cap.docx');
  writeFileSync(path, zip([
    { name: 'word/media/oversized.svg', data: svg },
    { name: 'word/media/valid.png', data: makePng(png, envelope, 'zTXt') },
  ]));
  // Exercise the real size-cap branch without allocating a 200 MB string.
  const byteLength = vi.spyOn(Buffer, 'byteLength').mockReturnValueOnce(200 * 1024 * 1024 + 1);
  try {
    const rows = inspectPath(path);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ entry: 'word/media/oversized.svg', error: 'SVG exceeds 200 MB' });
    expect(rows[1]).toMatchObject({ entry: 'word/media/valid.png', error: null,
      findings: [{ envelope: { ok: true } }] });
    expect(byteLength).toHaveBeenCalledWith(svg.toString('utf8'));
  } finally { byteLength.mockRestore(); }
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
      const row = inspectBlob(bytes, item.file, item.file, expected);
      const committed = readFileSync(join(fixtureDir, 'carriers', item.file));
      expect(carrierContents(bytes, row.type)).toEqual(carrierContents(committed, row.type));
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
  expect(inspectBlob(emf(Buffer.from('chemdraft:\u0001unknown')), 'unknown.emf').findings[0].error).toMatch(/unknown/);
  for (const creator of ['Created by ChemDraft', 'chemdraft is the creator']) {
    expect(inspectBlob(emf(Buffer.from(creator)), 'creator.emf')).toMatchObject({ error: null, findings: [] });
  }
  expect(inspectBlob(emf(envelope), 'json.emf').findings[0].envelope.ok).toBe(true);
  expect(inspectBlob(emf(envelope).subarray(0, -1), 'truncated.emf').error).toMatch(/truncated/);
});

// Synthetic MS-EMF multiformats; never copied from an Office document.
function multiformat(pictures: Buffer[]) {
  const table = Buffer.alloc(28 + pictures.length * 16);
  table.write('GDIC'); table.writeUInt32LE(0x40000004, 4);
  table.writeInt32LE(100, 16); table.writeInt32LE(100, 20);
  table.writeUInt32LE(pictures.length, 24);
  let offset = table.length;
  pictures.forEach((bytes, i) => {
    table.writeUInt32LE(0x50444620, 28 + i * 16); // Signature does not override the actual magic.
    table.writeUInt32LE(0, 32 + i * 16);
    table.writeUInt32LE(bytes.length, 36 + i * 16);
    table.writeUInt32LE(offset, 40 + i * 16);
    offset += bytes.length;
  });
  return emf(Buffer.concat([table, ...pictures]));
}

describe('nested Office pictures (synthetic)', () => {
  const embedded = readFileSync(join(fixtureDir, 'carriers/pdf-embedded.pdf'));
  const catalog = readFileSync(join(fixtureDir, 'carriers/pdf-catalog-key.pdf'));
  const carrierPng = readFileSync(join(fixtureDir, 'carriers/png-ztxt.png'));
  const expected = checkEnvelope(readFileSync(join(fixtureDir, 'sample-envelope.json'))).sha256!;
  const wrapped = multiformat([embedded]);
  const inspect = (name: string, bytes: Buffer, digest = expected): (ReturnType<typeof inspectBlob> & { foundBy?: string })[] => {
    const path = join(temp, name); writeFileSync(path, bytes);
    return inspectPath(path, digest);
  };

  it('reads multiformat PDF and PNG entries with paths, original hashes, references and expectations', () => {
    const bytes = multiformat([embedded, catalog, carrierPng]);
    const rows = inspect('nested.docx', zip([
      { name: 'word/media/image1.emf', data: bytes },
      { name: 'word/_rels/document.xml.rels', data: Buffer.from('<Relationships><Relationship Target="media/image1.emf"/></Relationships>') },
    ]));
    expect(rows).toHaveLength(4);
    for (const [i, original] of [embedded, catalog, carrierPng].entries()) {
      expect(rows[i + 1]).toMatchObject({
        entry: `word/media/image1.emf > EMF multiformat[${i}] (${i === 2 ? 'PNG' : 'PDF'})`,
        size: original.length, sha256: sha256(original), references: ['word/document.xml'], error: null,
        signature: 0x50444620, version: 0, outputRect: [0, 0, 100, 100],
        findings: [{ envelope: { ok: true, sha256: expected }, matchesExpect: true }],
      });
    }
    expect(rows[1].findings[0].carrier).toBe('pdf embedded file');
    expect(rows[2].findings[0].carrier).toBe('pdf catalog key');
    expect(inspect('wrong-expect.emf', wrapped, '0'.repeat(64))[1].findings[0].matchesExpect).toBe(false);
    const cli = spawnSync(process.execPath, ['scripts/office-spike/inspect.mjs', join(temp, 'nested.docx'), '--expect', expected], { encoding: 'utf8' });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toContain('EMF multiformat[0] (PDF)');
    expect(cli.stdout).toContain('pdf embedded file: valid; expect=true');
  });

  it('reads RTF hex pictures, ignores property destinations, and records blips and dimensions', () => {
    const rtf = Buffer.from('{\\rtf1{\\*\\shppict{\\pict{\\*\\picprop ignored{\\sp not hex}}\\emfblip\\picw100\\pich200\\picwgoal300\\pichgoal400\n' +
      wrapped.toString('hex').match(/.{1,73}/g)!.join(' \r\n') + '}}{\\nonshppict{\\pict\\pngblip ' + carrierPng.toString('hex') + '}}}');
    const rows = inspect('public.rtf', rtf);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ type: 'rtf', error: null });
    expect(rows[1]).toMatchObject({ entry: 'public.rtf > pict[0] emfblip', type: 'emf', kind: 'emfblip', picw: 100, pich: 200, picwgoal: 300, pichgoal: 400, sha256: sha256(wrapped) });
    expect(rows[2]).toMatchObject({ entry: 'public.rtf > pict[0] emfblip > EMF multiformat[0] (PDF)', findings: [{ matchesExpect: true }] });
    expect(rows[3]).toMatchObject({ entry: 'public.rtf > pict[1] pngblip', findings: [{ matchesExpect: true }] });
    expect(rows.every(row => !row.error)).toBe(true);
  });

  it('reads binary picture data without interpreting braces, backslashes or high bytes', () => {
    const rtf = Buffer.concat([Buffer.from(`{\\rtf1{\\pict\\pngblip\\bin${carrierPng.length} `), carrierPng, Buffer.from('}}')]);
    const rows = inspect('binary.rtf', rtf);
    expect(rows[1]).toMatchObject({ sha256: sha256(carrierPng), findings: [{ matchesExpect: true }], error: null });
    const special = Buffer.from([123, 125, 92, 255]);
    expect(inspect('special.rtf', Buffer.concat([Buffer.from('{\\rtf1{\\pict\\macpict\\bin4 '), special, Buffer.from('}}')]))[1]).toMatchObject({ kind: 'macpict', sha256: sha256(special), error: null });
  });

  it('labels WMF fallback finds without duplicating EMF bytes labelled as WMF', () => {
    const blob = Buffer.concat([Buffer.from('d7cdc69a', 'hex'), Buffer.alloc(20), embedded, Buffer.from('opaque suffix')]);
    const rows = inspect('synthetic.wmf', blob);
    expect(rows[0].type).toBe('wmf');
    expect(rows[1]).toMatchObject({ entry: 'synthetic.wmf > byte scan at 24 (PDF; found by byte scan)', foundBy: 'byte scan', findings: [{ matchesExpect: true }] });
    const rtf = Buffer.from('{\\rtf1{\\pict\\wmetafile8 ' + wrapped.toString('hex') + '}}');
    const fromRtf = inspect('wmf.rtf', rtf);
    expect(fromRtf).toHaveLength(3);
    expect(fromRtf[2]).toMatchObject({ entry: 'wmf.rtf > pict[0] wmetafile8 > EMF multiformat[0] (PDF)', findings: [{ matchesExpect: true }] });
    expect(fromRtf.some(row => row.foundBy === 'byte scan')).toBe(false);
    const damaged = Buffer.concat([wrapped, Buffer.from('junk after EOF')]);
    const recovered = inspect('damaged.rtf', Buffer.from('{\\rtf1{\\pict\\wmetafile8 ' + damaged.toString('hex') + '}}'));
    expect(recovered).toHaveLength(3);
    expect(recovered[1].error).toMatch(/trailing bytes/);
    expect(recovered[2]).toMatchObject({ foundBy: 'byte scan', size: embedded.length, sha256: sha256(embedded), findings: [{ matchesExpect: true }] });
  });

  it.each(['ole', 'rtfd', 'webarchive', 'unknown'])('scans %s blobs for bounded PNG and SVG pictures', kind => {
    const prefix = kind === 'ole' ? Buffer.from('d0cf11e0a1b11ae1', 'hex') : Buffer.from(kind);
    const carrierSvg = makeSvg(svg, envelope, 'metadata');
    const rows = inspect(`scan-${kind}.bin`, Buffer.concat([prefix, carrierPng, Buffer.from('gap'), carrierSvg]));
    expect(rows.slice(1).map(row => row.type).sort()).toEqual(['png', 'svg']);
    expect(rows.slice(1).every(row => row.foundBy === 'byte scan' && row.entry.includes('found by byte scan') && row.findings[0].envelope.ok)).toBe(true);
  });

  it('reports malformed EMF records, format counts and offsets through inspectPath', () => {
    const cases: [string, number, number, RegExp][] = [
      ['record-end', 92, wrapped.length, /record size/],
      ['record-zero', 92, 0, /record size/],
      ['format-offset', 140, 0xffffffff, /offData\/sizeData/],
      ['format-in-table', 140, 28, /offData\/sizeData/],
      ['format-size', 136, 0xffffffff, /offData\/sizeData/],
      ['format-count', 124, 0xffffffff, /countFormats/],
    ];
    for (const [name, at, value, pattern] of cases) {
      const bytes = Buffer.from(wrapped); bytes.writeUInt32LE(value, at);
      expect(inspect(`${name}.emf`, bytes)[0].error).toMatch(pattern);
    }
    const shortTable = multiformat([Buffer.alloc(1)]); shortTable.writeUInt32LE(2, 124);
    expect(inspect('format-table.emf', shortTable)[0].error).toMatch(/EmrFormat table/);
    const records = Buffer.alloc(8 * 100000);
    for (let i = 0; i < records.length; i += 8) { records.writeUInt32LE(2, i); records.writeUInt32LE(8, i + 4); }
    expect(inspect('records.emf', Buffer.concat([wrapped.subarray(0, 88), records, wrapped.subarray(-20)]))[0].error).toMatch(/record count/);
  });

  it.each([
    ['odd-hex', '{\\rtf1{\\pict\\pngblip 123}}', /odd-length hex/],
    ['bad-hex', '{\\rtf1{\\pict\\pngblip zz}}', /Invalid RTF pict hex/],
    ['short-bin', '{\\rtf1{\\pict\\bin999 x}}', /bin length/],
    ['negative-bin', '{\\rtf1{\\pict\\bin-1 }}', /bin length/],
    ['huge-bin', '{\\rtf1{\\pict\\bin999999999999999 }}', /parameter/],
    ['truncated', '{\\rtf1{\\pict\\pngblip 00}', /Truncated RTF/],
    ['groups', '{\\rtf1' + '{'.repeat(256), /group nesting/],
    ['picture-count', '{\\rtf1' + '{\\pict\\macpict 00}'.repeat(257) + '}', /picture count/],
  ])('reports hostile RTF %s without throwing', (name, text, pattern) => {
    expect(inspect(`${name}.rtf`, Buffer.from(text)).some(row => pattern.test(row.error ?? ''))).toBe(true);
  });

  it('checks decoded hex and binary caps before allocating the picture', () => {
    const binary = Buffer.concat([Buffer.from(`{\\rtf1{\\pict\\bin${MAX_PICTURE + 1} `), Buffer.alloc(MAX_PICTURE + 1), Buffer.from('}}')]);
    const hex = Buffer.from('{\\rtf1{\\pict\\pngblip ' + '00'.repeat(MAX_PICTURE + 1) + '}}');
    const alloc = vi.spyOn(Buffer, 'alloc');
    try {
      for (const [i, bytes] of [binary, hex].entries()) expect(inspect(`cap-${i}.rtf`, bytes)[0].error).toMatch(/decoded picture exceeds 20 MB/);
      expect(alloc.mock.calls.some(([length]) => length > MAX_PICTURE)).toBe(false);
    } finally { alloc.mockRestore(); }
  });

  it('accepts four nested levels and reports a fifth without recursion escaping inspectPath', () => {
    let bytes = embedded;
    for (let i = 0; i < 4; i++) bytes = multiformat([bytes]);
    const allowed = inspect('depth4.emf', bytes);
    expect(allowed).toHaveLength(5);
    expect(allowed.at(-1)!.findings[0].matchesExpect).toBe(true);
    const denied = inspect('depth5.emf', multiformat([bytes]));
    expect(denied.some(row => /depth exceeds 4/.test(row.error ?? ''))).toBe(true);
    expect(denied.some(row => row.findings.some(f => f.envelope?.ok))).toBe(false);
  });

  it('reports unterminated scan candidates and caps candidate counts', () => {
    expect(inspect('short-scan.bin', Buffer.from('blob%PDF-no end'))[0]).toMatchObject({ error: null, notes: [expect.stringMatching(/missing terminator within 20 MB/)] });
    const tinySvg = Buffer.from('<svg></svg>');
    expect(inspect('many-scans.bin', Buffer.concat([Buffer.from('blob'), ...Array(129).fill(tinySvg)]))[0].error).toMatch(/candidate count exceeds 128/);
  });

  it.each(['plain text ', '<html>stray ', 'd0cf11e0a1b11ae1'])('keeps scanning after a stray PDF marker in %s and exits zero', prefix => {
    const rows = inspect('stray.bin', Buffer.concat([Buffer.from(prefix), Buffer.from('%PDF stray'), carrierPng]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ error: null, notes: [expect.stringMatching(/Byte scan PDF/)] });
    expect(rows[1]).toMatchObject({ type: 'png', findings: [{ matchesExpect: true }] });
    const run = spawnSync(process.execPath, ['scripts/office-spike/inspect.mjs', join(temp, 'stray.bin')], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });

  it.each(['\r\n', '\n', '\r'])('includes the PDF end-of-line %j in carved bytes', eol => {
    const original = Buffer.concat([embedded.subarray(0, embedded.lastIndexOf('%%EOF') + 5), Buffer.from(eol)]);
    const rows = inspect('eol.bin', Buffer.concat([Buffer.from('opaque'), original, Buffer.from('suffix')]));
    expect(rows[1]).toMatchObject({ size: original.length, sha256: sha256(original), findings: [{ matchesExpect: true }] });
  });

  it('decodes objdata as nested blobs and restores raw RTF marker notes', () => {
    const ole = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), carrierPng]);
    const rows = inspect('object.rtf', Buffer.from('{\\rtf1{\\*\\objdata ' + ole.toString('hex') + '}}'));
    expect(rows).toHaveLength(3);
    expect(rows[1].entry).toContain('objdata[0]');
    expect(rows[2]).toMatchObject({ foundBy: 'byte scan', findings: [{ matchesExpect: true }] });
    expect(inspect('marker.rtf', Buffer.from('{\\rtf1 chemdraft-spike}'))[0]).toMatchObject({ error: null, findings: [{ carrier: 'raw marker', note: 'marker present, container not decoded' }] });
  });

  it('scans an EMF when typed parsing succeeds without finding a carrier', () => {
    const rows = inspect('empty-parser.emf', emf(Buffer.concat([Buffer.from('opaque'), embedded])));
    expect(rows).toHaveLength(2);
    expect(rows[0].error).toBeNull();
    expect(rows[1]).toMatchObject({ foundBy: 'byte scan', sha256: sha256(embedded), findings: [{ matchesExpect: true }] });
  });

  it('shares picture count and hex validation limits with objdata', () => {
    expect(() => rtfPictures(Buffer.from('{\\rtf1' + '{\\pict 00}'.repeat(128) + '{\\*\\objdata 00}'.repeat(129) + '}'), () => {})).toThrow(/picture count/);
    expect(() => rtfPictures(Buffer.from('{\\rtf1{\\*\\objdata 123}}'), () => {})).toThrow(/odd-length hex/);
  });

  it('ignores escaped bytes and backslashes in pict, and mixes hex with binary', () => {
    const input = Buffer.concat([Buffer.from("{\\rtf1{\\pict 01\\'ff\\\\02\\bin2 "), Buffer.from([123, 92]), Buffer.from('0304}}')]);
    const decoded: Buffer[] = [];
    rtfPictures(input, bytes => decoded.push(bytes));
    expect(decoded).toEqual([Buffer.from([1, 2, 123, 92, 3, 4])]);
    expect(() => rtfPictures(Buffer.from('{\\rtf1{\\pict 0\\bin1 x}}'), () => {})).toThrow(/odd-length hex before bin/);
    expect(() => rtfPictures(Buffer.from("{\\rtf1{\\pict \\'xz}}"), () => {})).toThrow(/Invalid RTF escaped byte/);
  });

  it('emits nested pict groups in opening order', () => {
    const rows: [string, string][] = [];
    rtfPictures(Buffer.from('{\\rtf1{\\pict 01{\\pict 02}03}{\\pict 04}}'), (bytes, label) => rows.push([label, bytes.toString('hex')]));
    expect(rows).toEqual([['pict[0] unknown blip', '0103'], ['pict[1] unknown blip', '02'], ['pict[2] unknown blip', '04']]);
  });

  it('checks per-picture and total span caps before decoded allocation', () => {
    const one = '{\\pict ' + '00 '.repeat(100000) + '}';
    const alloc = vi.spyOn(Buffer, 'alloc');
    try {
      expect(() => rtfPictures(Buffer.from('{\\rtf1{\\pict ' + '00 '.repeat(100001) + '}}'), () => {})).toThrow(/picture data spans exceed 100000/);
      expect(() => rtfPictures(Buffer.from('{\\rtf1' + one + one + '{\\pict 00}}'), () => {})).toThrow(/total picture data spans exceed 200000/);
      expect(alloc).not.toHaveBeenCalled();
    } finally { alloc.mockRestore(); }
  });

  it('enforces shared nested entry and byte budgets before child inspection', () => {
    for (const [budget, pattern] of [
      [{ count: 2000, bytes: 0 }, /entry count exceeds 2000/],
      [{ count: 0, bytes: 200 * 1024 * 1024 - embedded.length + 1 }, /bytes exceed 200 MB/],
    ] as const) {
      const row = inspectBlob(wrapped, 'budget.emf', 'budget.emf', expected, { depth: 0, budget: { ...budget } });
      expect(row.error).toMatch(pattern);
      expect(row.nestedEntries).toBeUndefined();
    }
    const exact = inspectBlob(wrapped, 'exact.emf', 'exact.emf', expected, { depth: 0, budget: { count: 1999, bytes: 200 * 1024 * 1024 - embedded.length } });
    expect(exact.nestedEntries).toHaveLength(1);
    expect(exact.error).toBeNull();
  });

  it('enforces directory depth and path caps', () => {
    const root = join(temp, 'directories');
    const deep = join(root, 'a', 'b', 'c', 'd'); mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'unread.bin'), carrierPng);
    expect(inspectPath(root)[0].error).toMatch(/directory depth exceeds 4/);
    expect(inspectPath(root, undefined, { depth: 0, budget: { count: 1999 } })[0].error).toMatch(/path count exceeds 2000/);
    expect(inspectPath(root, undefined, { depth: 0, budget: { count: 2000 } })[0].error).toMatch(/path count exceeds 2000/);
  });

  it('rejects a non-first header, second header, and 16-byte EOF', () => {
    const header = wrapped.subarray(0, 88), end = wrapped.subarray(-20);
    const other = Buffer.alloc(8); other.writeUInt32LE(2); other.writeUInt32LE(8, 4);
    for (const bytes of [Buffer.concat([other, header, end]), Buffer.concat([header, header, end])]) {
      expect(() => emfFindings(bytes)).toThrow(/Invalid EMF header/);
    }
    const short = Buffer.from(end.subarray(0, 16)); short.writeUInt32LE(16, 4);
    expect(() => emfFindings(Buffer.concat([header, short]))).toThrow(/Truncated EMF EOF/);
  });

  it('scans separate PDFs while retaining the last EOF of incremental updates', () => {
    const rows = inspect('two-pdfs.bin', Buffer.concat([Buffer.from('blob'), embedded, Buffer.from('gap'), catalog]));
    expect(rows).toHaveLength(3);
    expect(rows.slice(1).map(row => row.findings[0].carrier)).toEqual(['pdf embedded file', 'pdf catalog key']);
    expect(rows.slice(1).every(row => row.findings[0].matchesExpect && !row.error)).toBe(true);
  });
});

it.each(['file', 'items', 'types'])('reports JXA nil %s clearly using mocked Foundation objects', which => {
  const nil = { isNil: () => true };
  const path = { stringByAppendingPathComponent: () => 'missing' };
  const board = { pasteboardItems: which === 'items' ? nil : { isNil: () => false, count: 1, objectAtIndex: () => ({ types: nil }) } };
  const dollar = Object.assign(() => path, {
    NSPasteboard: { generalPasteboard: board }, NSPasteboardItem: { alloc: { init: {} } },
    NSData: { dataWithContentsOfFile: () => nil },
    NSFileManager: { defaultManager: { createDirectoryAtPathWithIntermediateDirectoriesAttributesError: () => true } },
  });
  const context = { $: dollar, ObjC: { import: () => {}, unwrap: (value: unknown) => value } };
  runInNewContext(readFileSync('scripts/office-spike/mac-pasteboard.js', 'utf8'), context);
  const run = (context as typeof context & { run: (args: string[]) => void }).run;
  expect(() => run(which === 'file' ? ['write', '.', 'public.png=missing'] : ['dump', '.'])).toThrow(which === 'file' ? /Cannot read/ : which === 'items' ? /pasteboardItems is nil/ : /types is nil for pasteboard item 0/);
});

function pngText(type: string, data: Buffer) {
  return Buffer.concat([png.subarray(0, 8), ...chunks(png).flatMap(c => c.type === 'IEND'
    ? [chunk(type, data), chunk(c.type, c.data)] : [chunk(c.type, c.data)])]);
}

it.each([
  ['tEXt', Buffer.concat([Buffer.from('chemdraft\0'), envelope])],
  ['iTXt', Buffer.concat([Buffer.from('chemdraft\0\x00\x00en\0translated keyword\0'), envelope])],
])('reads uncompressed PNG %s payloads and replaces existing payload chunks', (type, data) => {
  const bytes = pngText(type, data);
  const found = pngFindings(bytes).found;
  expect(found).toHaveLength(1);
  expect(found[0].envelope.equals(envelope)).toBe(true);
  expect(inspectBlob(bytes, 'uncompressed.png').findings[0].envelope.ok).toBe(true);
  const replaced = makePng(bytes, makeEnvelope('{}'), 'zTXt');
  expect(pngFindings(replaced).found).toHaveLength(1);
  expect(checkEnvelope(pngFindings(replaced).found[0].envelope).sha256).toBe(sha256('{}'));
});

it.each(['element', 'root', 'ancestor', 'default'])('reads SVG prologs, arbitrary prefixes and %s namespace bindings', scope => {
  const ns = 'https://chemdraft.ai/ns/spike/1';
  const encoded = deflateRawSync(envelope).toString('base64');
  const prefix = scope === 'default' ? '' : 'cd:';
  const declaration = scope === 'default' ? `xmlns='${ns}'` : `xmlns:cd='${ns}'`;
  const attrs = scope === 'element' || scope === 'default' ? declaration : '';
  const content = `<${prefix}payload ${scope === 'default' ? `${attrs} encoding='base64-deflate'` : `encoding='base64-deflate' ${attrs}`}>${encoded}</${prefix}payload>`;
  const prolog = ` \n<?xml version="1.0"?>\n<!--${'prolog '.repeat(500)}-->\n<?office test?>\n<!DOCTYPE svg [<!-- \" ] > --><!ENTITY unused SYSTEM "file:///must-not-read"><?dtd test?>]>\n`;
  const text = `${prolog}<svg ${scope === 'root' ? declaration : ''}><metadata ${scope === 'ancestor' ? declaration : ''}>${content}</metadata></svg>`;
  const row = inspectBlob(Buffer.from(text), 'variant.bin');
  expect(row).toMatchObject({ type: 'svg', error: null });
  expect(row.findings).toHaveLength(1);
  expect(row.findings[0].envelope).toMatchObject({ ok: true, sha256: sha256(payload) });
});

it.each([
  ['comment whitespace', `<svg><!-- chemdraft:${' '.repeat(200_000)}! --></svg>`],
  ['prolog whitespace', `${' '.repeat(200_000)}<svg/>`],
  ['unterminated comment', `<svg><!-- chemdraft:${' '.repeat(200_000)}`],
  ['attribute name', `<svg ${'a'.repeat(200_000)}></svg>`],
  ['attribute whitespace', `<svg name${' '.repeat(200_000)}></svg>`],
  ['unterminated attribute', `<svg name="${'a'.repeat(200_000)}`],
])('scans 200k adversarial SVG %s in under 500 ms', (_name, text) => {
  const bytes = Buffer.from(text);
  for (const scan of [isSvg, svgFindings]) {
    const start = performance.now();
    scan(bytes);
    expect(performance.now() - start).toBeLessThan(500);
  }
});

it('reports SVG markers when structure or encoding is not recognised without expanding entities', () => {
  const ns = 'https://chemdraft.ai/ns/spike/1';
  for (const text of [
    `<svg><payload xmlns="${ns}" encoding="unknown">chemdraft-spike</payload></svg>`,
    '<!DOCTYPE svg [<!ENTITY payload SYSTEM "file:///must-not-read">]><svg><!--chemdraft-spike-->&payload;</svg>',
    `<svg xmlns:x="${ns}"><g xmlns:x="wrong"><x:payload encoding="base64-deflate">AAAA</x:payload></g></svg>`,
  ]) {
    expect(inspectBlob(Buffer.from(text), 'unknown.svg')).toMatchObject({ error: null,
      findings: [{ carrier: 'svg marker', note: 'marker present, structure not recognised' }] });
  }
});

it.each(['word', 'ppt'])('inspects %s embeddings, including renamed carriers and undecoded OLE markers', host => {
  const ole = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.from('chemdraft-spike', 'utf16le')]);
  const entries = [
    { name: `${host}/embeddings/png.bin`, data: makePng(png, envelope, 'zTXt') },
    { name: `${host}/embeddings/svg.bin`, data: makeSvg(svg, envelope, 'metadata') },
    { name: `${host}/embeddings/pdf.bin`, data: makePdf(pdf, envelope, 'embedded') },
    { name: `${host}/embeddings/emf.bin`, data: emf(envelope) },
    { name: `${host}/embeddings/ole.bin`, data: ole },
    { name: `${host}/_rels/document.xml.rels`, data: Buffer.from('<Relationships><Relationship Target="embeddings/ole.bin"/></Relationships>') },
  ];
  const path = join(temp, `${host}-embedded.zip`); writeFileSync(path, zip(entries));
  const rows = inspectPath(path);
  expect(rows).toHaveLength(5);
  expect(rows.slice(0, 4).every(row => row.error === null && row.findings[0].envelope.ok)).toBe(true);
  expect(rows[4]).toMatchObject({ guess: 'OLE compound file (not a ZIP)', references: [`${host}/document.xml`],
    findings: [{ carrier: 'raw marker', note: 'marker present, container not decoded' }] });
  expect(inspectBlob(Buffer.from('unrelated creator ChemDraft'), 'other.bin').findings).toEqual([]);
});

it.each([
  ['png', makePng(png, envelope, 'zTXt')],
  ['pdf', makePdf(pdf, envelope, 'embedded')],
  ['json', envelope],
  ['emf', emf(envelope)],
])('accepts trailing NUL padding in %s and reports its length, while rejecting non-zero garbage', (kind, bytes) => {
  const row = inspectBlob(Buffer.concat([bytes, Buffer.alloc(137)]), `padded.${kind}`);
  expect(row.error).toBeNull();
  expect(row.findings[0].envelope.ok).toBe(true);
  expect(kind === 'json' ? row.findings[0].envelope.notes : row.notes).toEqual(['Trailing NUL padding: 137 bytes']);
  const bad = inspectBlob(Buffer.concat([bytes, Buffer.from([0, 65, 0])]), `bad.${kind}`);
  if (kind === 'json') expect(bad.findings[0].envelope.ok).toBe(false);
  else expect(bad.error).toBeTruthy();
});

it('accepts padded ZIPs beyond the EOCD search window, retaining zero-ended comments and exact padding notes', () => {
  const original = zip([{ name: 'word/embeddings/payload.bin', data: envelope }]);
  const commented = Buffer.from(original); commented.writeUInt16LE(3, commented.length - 2);
  const bytes = Buffer.concat([commented, Buffer.from([65, 0, 0])]);
  const padded = Buffer.concat([bytes, Buffer.alloc(70000)]);
  expect(readZip(bytes).notes).toBeUndefined();
  expect(readZip(padded).notes).toEqual(['Trailing NUL padding: 70000 bytes']);
  const path = join(temp, 'padded.docx'); writeFileSync(path, padded);
  expect(inspectPath(path)[0]).toMatchObject({ error: null, notes: ['Trailing NUL padding: 70000 bytes'], findings: [{ envelope: { ok: true } }] });
  expect(() => readZip(Buffer.concat([original, Buffer.from([0, 65, 0])]))).toThrow();
  expect(checkEnvelope(Buffer.concat([envelope, Buffer.alloc(7)])).notes).toEqual(['Trailing NUL padding: 7 bytes']);
});

it('builds CF_HTML with byte offsets excluding its trailing NUL, CRLF headers and unchanged UTF-8 HTML', () => {
  for (const html of [readFileSync(join(fixtureDir, 'sample.html')), Buffer.from('<html>π😀\n<!--StartFragment--><p>é → 文</p><!--EndFragment-->\n</html>')]) {
    const bytes = makeCfHtml(html);
    const header = /^(Version:0\.9\r\nStartHTML:(\d{10})\r\nEndHTML:(\d{10})\r\nStartFragment:(\d{10})\r\nEndFragment:(\d{10})\r\n)/.exec(bytes.toString())!;
    expect(header).not.toBeNull();
    const [start, end, fragmentStart, fragmentEnd] = header.slice(2).map(Number);
    expect(start).toBe(Buffer.byteLength(header[1]));
    expect(end).toBe(bytes.length - 1);
    expect(bytes.subarray(end).equals(Buffer.from([0]))).toBe(true);
    expect(bytes.subarray(start, end).equals(html)).toBe(true);
    expect(fragmentStart).toBe(start + html.indexOf('<!--StartFragment-->') + Buffer.byteLength('<!--StartFragment-->'));
    expect(fragmentEnd).toBe(start + html.indexOf('<!--EndFragment-->'));
    expect(fragmentEnd).toBeLessThan(end);
    expect(bytes.subarray(fragmentStart, fragmentEnd).toString()).toMatch(/^<p>.*<\/p>$/);
  }
  for (const bad of ['<p>missing</p>', '<!--StartFragment-->only start', '<!--EndFragment--><!--StartFragment-->']) {
    expect(() => makeCfHtml(Buffer.from(bad))).toThrow(/markers/);
  }
});

it('runs both CLIs through a symlinked directory (a junction on Windows)', () => {
  const link = join(temp, 'linked-tools');
  symlinkSync(resolve('scripts/office-spike'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const inspect = spawnSync(process.execPath, [join(link, 'inspect.mjs'), join(fixtureDir, 'sample-envelope.json'), '--json'], { encoding: 'utf8' });
  expect(inspect.status, inspect.stderr).toBe(0);
  expect(JSON.parse(inspect.stdout)[0].findings[0].envelope.ok).toBe(true);
  const out = join(temp, 'symlink-carriers');
  const make = spawnSync(process.execPath, [join(link, 'make-carriers.mjs'), '--payload', join(fixtureDir, 'sample-document.json'), '--png', join(fixtureDir, 'sample.png'), '--svg', join(fixtureDir, 'sample.svg'), '--pdf', join(fixtureDir, 'sample.pdf'), '--out', out], { encoding: 'utf8' });
  expect(make.status, make.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))).toHaveLength(8);
});
