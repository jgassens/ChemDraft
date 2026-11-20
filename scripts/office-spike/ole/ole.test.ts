import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emfFindings } from '../emf.mjs';
import { chunk, chunks } from '../png.mjs';
import { readZip } from '../zip.mjs';
import { CLSID, DOCUMENT_STREAM, MAX_CFB_BYTES, PROG_ID, USER_TYPE, readCfb, writeCfb } from './cfb-writer.mjs';
import { decodePng, previewEmf } from './emf-writer.mjs';
import { inspectOle } from './inspect-ole.mjs';
import { writeZip } from './zip-compat.mjs';

const png = readFileSync('packages/fixtures/office/carriers/png-itxt.png');
const document = readFileSync('packages/fixtures/office/sample-document.json');
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const temp = mkdtempSync(join(tmpdir(), 'ole-probe-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function filteredPng(color: number, channels: number, samples: number[], filter: number, extras: Buffer[] = []) {
  const width = 3, height = 2;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = color;
  const stride = channels * width;
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(filter);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const a = x < channels ? 0 : samples[at - channels];
      const b = y === 0 ? 0 : samples[at - stride];
      const c = y === 0 || x < channels ? 0 : samples[at - stride - channels];
      const distances = [Math.abs(b - c), Math.abs(a - c), Math.abs(a + b - 2 * c)];
      const paeth = [a, b, c][distances.indexOf(Math.min(...distances))];
      raw.push((samples[at] - ([0, a, b, Math.floor((a + b) / 2), paeth][filter] ?? 0)) & 255);
    }
  }
  const idat = deflateSync(Buffer.from(raw));
  return Buffer.concat([
    pngSignature, chunk('IHDR', header), ...extras,
    chunk('IDAT', idat.subarray(0, 4)), chunk('IDAT', idat.subarray(4)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('PNG decoding and dual EMF', () => {
  const grayscale = [19, 230, 8, 4, 100, 230];
  const rgb = [19, 230, 8, 56, 22, 90, 255, 14, 53, 93, 0, 177, 1, 48, 66, 52, 200, 37];
  const rgba = Array.from({ length: 24 }, (_, i) => (96 + i * 71) % 256);
  const palette = [
    [31, 2, 88, 0], [32, 44, 170, 128], [255, 54, 86, 255],
  ];
  const indexes = [2, 1, 0, 0, 2, 1];

  it.each([0, 1, 2, 3, 4])('decodes each supported color type with filter %i', filter => {
    const cases = [
      { color: 0, channels: 1, samples: grayscale, extras: [chunk('tRNS', Buffer.from([0, 230]))],
        expected: grayscale.flatMap(x => [x, x, x, x === 230 ? 0 : 255]) },
      { color: 2, channels: 3, samples: rgb, extras: [chunk('tRNS', Buffer.from([0, 19, 0, 230, 0, 8]))],
        expected: rgb.flatMap((x, i) => i % 3 === 2 ? [x, i === 2 ? 0 : 255] : [x]) },
      { color: 3, channels: 1, samples: indexes, extras: [
        chunk('PLTE', Buffer.from(palette.flatMap(pixel => pixel.slice(0, 3)))),
        chunk('tRNS', Buffer.from([0, 128])),
      ], expected: indexes.flatMap(index => palette[index]) },
      { color: 6, channels: 4, samples: rgba, extras: [], expected: rgba },
    ];
    for (const { color, channels, samples, extras, expected } of cases) {
      expect(decodePng(filteredPng(color, channels, samples, filter, extras))).toEqual({
        width: 3, height: 2, rgba: Buffer.from(expected),
      });
    }
  });

  it.each([[8, 4, 0], [16, 6, 0], [8, 6, 1], [4, 3, 0]])(
    'rejects unsupported depth %i, color %i, and interlace %i', (depth, color, interlace) => {
      const ihdr = Buffer.from(chunks(png)[0].data);
      ihdr[8] = depth;
      ihdr[9] = color;
      ihdr[12] = interlace;
      const invalid = Buffer.concat([pngSignature, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
      expect(() => decodePng(invalid)).toThrow(/Unsupported PNG/);
    },
  );

  it('rejects an unsupported filter, corrupt PNG and mismatched EMF dimensions', () => {
    const invalidFilter = filteredPng(0, 1, grayscale, 5);
    expect(() => decodePng(invalidFilter)).toThrow(/Unsupported PNG filter 5/);
    expect(() => decodePng(png.subarray(0, -3))).toThrow(/Truncated PNG/);
    expect(() => previewEmf({ png, widthPx: 1, heightPx: 2, dpi: 96 })).toThrow(/dimensions must match/);
    expect(() => previewEmf({ png, widthPx: 600, heightPx: 671, dpi: 0 })).toThrow(/DPI/);
  });

  it('emits aligned EMF and EMF+ records with the original carrier', () => {
    const emf = previewEmf({ png, widthPx: 600, heightPx: 671, dpi: 96 });
    const images: Buffer[] = [];
    expect(emfFindings(emf, (data: Buffer, kind: string) => {
      expect(kind).toBe('EMF+ image object[0]');
      images.push(data);
    })).toEqual([]);
    expect(images).toEqual([png]);

    const records: Buffer[] = [];
    for (let at = 0; at < emf.length;) {
      const size = emf.readUInt32LE(at + 4);
      expect(size).toBeGreaterThanOrEqual(8);
      expect(size % 4).toBe(0);
      expect(at + size).toBeLessThanOrEqual(emf.length);
      records.push(emf.subarray(at, at += size));
    }
    const [header, comment, dib, eof] = records;
    expect(records.map(bytes => bytes.readUInt32LE())).toEqual([1, 70, 81, 14]);
    expect(header.readUInt32LE(48)).toBe(emf.length);
    expect(header.readUInt32LE(52)).toBe(records.length);
    expect([header.readInt32LE(16), header.readInt32LE(20)]).toEqual([599, 670]);
    expect([header.readInt32LE(32), header.readInt32LE(36)]).toEqual([15875, 17754]);
    expect(comment.readUInt32LE(8)).toBe(comment.length - 12);
    expect(comment.toString('ascii', 12, 16)).toBe('EMF+');

    const plus: Buffer[] = [];
    for (let at = 16; at < comment.length;) {
      const size = comment.readUInt32LE(at + 4);
      const length = comment.readUInt32LE(at + 8);
      expect(size).toBe(12 + Math.ceil(length / 4) * 4);
      expect(at + size).toBeLessThanOrEqual(comment.length);
      expect(comment.subarray(at + 12 + length, at + size)).toEqual(Buffer.alloc(size - 12 - length));
      plus.push(comment.subarray(at, at += size));
    }
    expect(plus.map(bytes => bytes.readUInt16LE())).toEqual([0x4001, 0x4008, 0x401a, 0x4002]);
    expect(plus[0].readUInt16LE(2)).toBe(1);
    expect(plus[1].readUInt16LE(2)).toBe(0x0500);
    expect(plus[1].readUInt32LE(36)).toBe(1);
    expect(plus[2].readUInt32LE(12)).toBe(0xffffffff);
    expect(plus[2].readUInt32LE(16)).toBe(2);
    expect([plus[2].readFloatLE(44), plus[2].readFloatLE(48)]).toEqual([600, 671]);
    expect(dib.readUInt32LE(60)).toBe(dib.length - 120);
    expect(eof.readUInt32LE(16)).toBe(eof.length);
  });

  it('writes top-down 32-bit BI_RGB BGRX pixels on white with SRCCOPY', () => {
    const pixels = [19, 230, 8, 255, 56, 22, 90, 0, 16, 42, 90, 128,
      3, 7, 11, 255, 0, 0, 0, 255, 24, 96, 128, 255];
    const tiny = filteredPng(6, 4, pixels, 4);
    const emf = previewEmf({ png: tiny, widthPx: 3, heightPx: 2, dpi: 96 });
    const start = 108 + emf.readUInt32LE(112);
    const dib = emf.subarray(start, start + emf.readUInt32LE(start + 4));
    expect(dib.readUInt32LE()).toBe(81);
    expect([dib.readUInt32LE(48), dib.readUInt32LE(52), dib.readUInt32LE(56), dib.readUInt32LE(60)])
      .toEqual([80, 40, 120, 24]);
    expect(dib.readUInt32LE(68)).toBe(0xcc0020);
    expect([dib.readInt32LE(84), dib.readInt32LE(88), dib.readUInt16LE(92), dib.readUInt16LE(94), dib.readUInt32LE(96)])
      .toEqual([3, -2, 1, 32, 0]);
    expect([...dib.subarray(120)]).toEqual([
      8, 230, 19, 0, 255, 255, 255, 0, 172, 148, 135, 0,
      11, 7, 3, 0, 0, 0, 0, 0, 128, 96, 24, 0,
    ]);
  });
});

describe('compound storage', () => {
  it.each([7, 4095, 4096, 4097, 12000])('round-trips a %i-byte JSON stream and the OLE metadata', length => {
    const json = Buffer.from('{"x":1}'.padEnd(length, ' '));
    const bytes = writeCfb(json);
    const { clsid, streams } = readCfb(bytes);
    expect(clsid).toBe(CLSID);
    expect(streams.size).toBe(3);
    expect(streams.get(DOCUMENT_STREAM)).toEqual(json);
    const compObj = streams.get('\x01CompObj')!;
    const userLength = compObj.readUInt32LE(28);
    const clipboard = 32 + userLength;
    const progIdLength = compObj.readUInt32LE(clipboard + 4);
    const progId = clipboard + 8;
    expect(compObj.toString('ascii', 32, clipboard)).toBe(USER_TYPE + '\0');
    expect(compObj.readUInt32LE(clipboard)).toBe(0);
    expect(compObj.toString('ascii', progId, progId + progIdLength)).toBe(PROG_ID + '\0');
    expect(streams.get('\x01Ole')?.toString('hex')).toBe('0100000200000000000000000000000000000000');
  });

  it('writes a valid header, directory tree, mini stream, and regular FAT chain', () => {
    const bytes = writeCfb(Buffer.alloc(4097));
    expect(bytes.subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1');
    expect([bytes.readUInt16LE(26), bytes.readUInt16LE(28), bytes.readUInt16LE(30), bytes.readUInt16LE(32)])
      .toEqual([3, 0xfffe, 9, 6]);
    expect(bytes.readUInt32LE(56)).toBe(4096);
    const main = (id: number) => (id + 1) * 512;
    const dir = main(bytes.readUInt32LE(48));
    expect(bytes.readUInt32LE(dir + 76)).toBe(2);
    expect([bytes.readUInt32LE(dir + 256 + 68), bytes.readUInt32LE(dir + 256 + 72)]).toEqual([1, 3]);
    expect(bytes.subarray(dir + 80, dir + 96).toString('hex')).toBe('51ac559597406b418588e2ba35e8af94');
    const fatSid = bytes.readUInt32LE(76);
    const fat = (id: number) => bytes.readUInt32LE(main(fatSid) + id * 4);
    expect(fat(fatSid)).toBe(0xfffffffd);
    expect(fat(bytes.readUInt32LE(48))).toBe(0xfffffffe);
    const miniFat = main(bytes.readUInt32LE(60));
    expect(bytes.readUInt32LE(miniFat + 4)).toBe(2);
    expect(bytes.readUInt32LE(miniFat + 8)).toBe(0xfffffffe);
    const start = bytes.readUInt32LE(dir + 384 + 116);
    let last = start;
    for (let i = 0; i < 8; i++) last = fat(last);
    expect(fat(last)).toBe(0xfffffffe);
    bytes.writeUInt32LE(start, main(fatSid) + start * 4);
    expect(() => readCfb(bytes)).toThrow(/ChemDraftDocument sector chain/);
  });

  it('uses chained DIFAT sectors at the 50 MiB file cap', () => {
    // Header + directory + mini FAT + mini stream + 800 FAT + 6 DIFAT sectors.
    const payloadSize = MAX_CFB_BYTES - (1 + 3 + 800 + 6) * 512;
    const overLimit = Buffer.alloc(payloadSize + 1, 0x20);
    overLimit.write('{"big":true}');
    const payload = overLimit.subarray(0, payloadSize);
    const cfb = writeCfb(payload);
    expect(cfb.length).toBe(MAX_CFB_BYTES);
    expect(cfb.readUInt32LE(44)).toBe(800);
    expect(cfb.readUInt32LE(72)).toBe(6);
    const persisted = readCfb(cfb).streams.get(DOCUMENT_STREAM);
    expect(persisted?.equals(payload)).toBe(true);
    expect(() => writeCfb(overLimit)).toThrow(/50 MiB/);
    expect(() => readCfb(Buffer.alloc(MAX_CFB_BYTES + 1))).toThrow(/50 MiB/);
  });
});

const output = join(temp, 'generated');

describe('Office packages', () => {
  beforeAll(() => {
    const run = spawnSync(process.execPath, ['scripts/office-spike/ole/make-ole-docs.mjs', '--out', output], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });

  it('builds both fixtures and a manifest with the four input and artifact hashes', () => {
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ clsid: CLSID, progId: PROG_ID, widthPx: 600, heightPx: 671, dpi: 96 });
    expect(manifest.sha256).toEqual({
      png: sha256(png), json: sha256(document),
      emf: sha256(readFileSync(join(output, 'preview.emf'))),
      oleObject: sha256(readFileSync(join(output, 'oleObject1.bin'))),
    });
  });

  it.each([
    { file: 'ole-word.docx', base: 'word', part: 'word/document.xml' },
    { file: 'ole-ppt.pptx', base: 'ppt', part: 'ppt/slides/slide1.xml' },
  ])('puts the object and EMF at the correct relationship targets in $file', ({ file, base, part }) => {
    const path = join(output, file);
    const entries = readZip(readFileSync(path));
    const map = new Map(entries.map(({ name, data }: { name: string; data: Buffer }) => [name, data]));
    const xml = (name: string) => {
      expect(map.has(name), name).toBe(true);
      return map.get(name)!.toString('utf8');
    };
    expect(map.get(`${base}/media/image1.emf`)).toEqual(readFileSync(join(output, 'preview.emf')));
    expect(map.get(`${base}/embeddings/oleObject1.bin`)).toEqual(readFileSync(join(output, 'oleObject1.bin')));
    const types = xml('[Content_Types].xml');
    expect(types).toContain('<Default Extension="emf" ContentType="image/x-emf"/>');
    expect(types).toContain('<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>');
    expect(types).toContain(`PartName="/${part}"`);
    expect(xml('_rels/.rels')).toContain(`/officeDocument" Target="${base}/${base === 'word' ? 'document' : 'presentation'}.xml"`);

    const rel = xml(posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels'));
    const body = xml(part);
    const prefix = base === 'ppt' ? '../' : '';
    const imageId = base === 'ppt' ? 3 : 1;
    expect(rel).toMatch(`Id="rId${imageId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${prefix}media/image1.emf"`);
    expect(rel).toMatch(`Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="${prefix}embeddings/oleObject1.bin"`);
    if (base === 'word') {
      expect(body).toMatch(/<w:object\b[\s\S]*<v:shape\b[\s\S]*<v:imagedata r:id="rId1"[\s\S]*<\/v:shape>/);
      expect(body).toMatch(/<o:OLEObject Type="Embed" ProgID="ChemDraft\.Structure\.Probe"[^>]*r:id="rId2"/);
    } else {
      expect(body).toMatch(/<p:graphicFrame>[\s\S]*<a:graphicData uri="[^"]+\/ole">/);
      expect(body).toMatch(/<mc:Choice Requires="v"><p:oleObj[^>]*r:id="rId2"[^>]*spid="_x0000_s1025"><p:embed\/>/);
      expect(body).toMatch(/<mc:Fallback><p:oleObj[^>]*r:id="rId2"[^>]*progId="ChemDraft\.Structure\.Probe"><p:embed\/><p:pic>[\s\S]*<a:blip r:embed="rId3"/);
      expect(rel).toMatch(/relationships\/vmlDrawing" Target="\.\.\/drawings\/vmlDrawing1\.vml"/);
      expect(xml('ppt/drawings/vmlDrawing1.vml')).toMatch(/<v:shape id="_x0000_s1025"[^>]*>\s*<v:imagedata o:relid="rId1"/);
      expect(xml('ppt/drawings/_rels/vmlDrawing1.vml.rels')).toMatch(/Id="rId1"[^>]*Target="\.\.\/media\/image1\.emf"/);
    }

    const result = spawnSync(process.execPath, ['scripts/office-spike/ole/inspect-ole.mjs', path, '--json'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      oleObjectPresent: true, probeClassPresent: true, missingRelatedParts: [],
      oleObjects: [{
        part: `${base}/embeddings/oleObject1.bin`, clsid: CLSID, matchesManifest: true, error: null,
        references: [{ part, id: 'rId2' }],
        streams: expect.arrayContaining([{ name: DOCUMENT_STREAM, size: document.length }]),
        document: { sha256: sha256(document), matchesManifest: true },
      }],
      previews: [{
        part: `${base}/media/image1.emf`, type: 'emf', state: 'unchanged-emf', error: null,
        originalEmf: true, originalPngInEmfPlus: true, emfPlusPngs: [{ sha256: sha256(png) }],
        references: expect.arrayContaining([{ part, id: `rId${imageId}` }]),
      }],
    });
  });

  it('distinguishes a changed EMF that kept the carrier, a lost object, and a replaced preview', () => {
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    const changedEmf = readFileSync(join(output, 'preview.emf'));
    changedEmf.writeInt32LE(601, 72); // Change only the reference device width.
    const newRaster = filteredPng(0, 1, [0, 1, 2, 3, 4, 5], 0);
    const report = inspectOle(writeZip([
      ['word/media/image5.emf', changedEmf],
      ['word/media/image7.png', newRaster],
      ['word/media/image8.png', png],
    ]), manifest);
    expect(report.oleObjectPresent).toBe(false);
    expect(report.previews).toMatchObject([
      { type: 'emf', state: 'changed-emf-carrier-kept', originalEmf: false, originalPngInEmfPlus: true },
      { type: 'png', state: 'changed-or-re-rendered', originalPngInEmfPlus: false },
      { type: 'png', state: 'standalone-original-png', originalPng: true },
    ]);
    expect(inspectOle(writeZip([['word/media/image7.png', newRaster]])).previews[0]).toMatchObject({
      state: 'no-baseline', originalPng: null,
    });
  });

  it('reports a retained probe with different JSON and a dangling preview relationship', () => {
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    const edited = Buffer.from('{"changed":true}');
    const report = inspectOle(writeZip([
      ['word/embeddings/oleObject2.bin', writeCfb(edited)],
      ['word/_rels/document.xml.rels', Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/oleObject2.bin"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="/word/media/image3.emf"/>
</Relationships>`) ],
    ]), manifest);
    expect(report).toMatchObject({
      oleObjectPresent: true, probeClassPresent: true, previews: [], missingRelatedParts: ['word/media/image3.emf'],
      oleObjects: [{ matchesManifest: false, document: { present: true, sha256: sha256(edited), matchesManifest: false } }],
    });
  });
});
