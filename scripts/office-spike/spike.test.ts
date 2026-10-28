import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeEnvelope, checkEnvelope } from './payload.mjs';
import { chunks, makePng, pngFindings, crc32 } from './png.mjs';
import { makeSvg, svgFindings } from './svg.mjs';
import { readZip } from './zip.mjs';

const payload = '{"name":"caffeine"}';
const envelope = makeEnvelope(payload);
const png = readFileSync('packages/fixtures/office/sample.png');
const svg = readFileSync('packages/fixtures/office/sample.svg');

describe('office spike primitives', () => {
  it('checks envelope integrity and size', () => {
    expect(checkEnvelope(envelope).ok).toBe(true);
    const tampered = JSON.parse(envelope.toString());
    tampered.payload = '{}';
    expect(checkEnvelope(Buffer.from(JSON.stringify(tampered))).ok).toBe(false);
    expect(checkEnvelope(Buffer.alloc(20 * 1024 * 1024 + 1)).ok).toBe(false);
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
  it('rejects truncated PNG and invalid ZIP', () => {
    expect(() => chunks(png.subarray(0, png.length - 1))).toThrow();
    expect(() => readZip(Buffer.from('PK'))).toThrow();
  });
});

function storedZip(name: string, data: Buffer) {
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  const crc = crc32(data);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}

it('checks ZIP data CRC and entry count', () => {
  const archive = storedZip('word/media/image.png', png);
  expect(readZip(archive)[0].data.equals(png)).toBe(true);
  const bad = Buffer.from(archive);
  bad[30 + Buffer.byteLength('word/media/image.png')] ^= 1;
  expect(() => readZip(bad)).toThrow(/CRC/);
  const tooMany = Buffer.from(archive);
  tooMany.writeUInt16LE(2001, tooMany.length - 14);
  tooMany.writeUInt16LE(2001, tooMany.length - 12);
  expect(() => readZip(tooMany)).toThrow(/2000/);
});
