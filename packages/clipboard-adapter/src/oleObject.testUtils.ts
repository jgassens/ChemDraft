/**
 * Test-only: a minimal compound file writer (MS-CFB), laid out like the native writer's
 * (`office_ole/storage.rs`): root-level streams, those under 4096 bytes in the mini stream.
 * Version 3 (512-byte sectors) by default, or version 4 (4096-byte sectors). `minFatSectors` pads
 * the FAT so that more than the header's 109 FAT sector slots are needed, which adds a DIFAT chain.
 * Returns the file and where its tables are, so tests can damage them.
 */

const MINI = 64;
const CUTOFF = 4096;
const FREE = 0xffffffff;
const END = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;
const HEADER_DIFAT = 109;

export interface TestCompoundFile {
  bytes: Uint8Array;
  /** Byte offset of FAT entry `n` is `fatOffset + 4 * n`. */
  fatOffset: number;
  /** Byte offset of mini FAT entry `n` is `miniFatOffset + 4 * n`. */
  miniFatOffset: number;
  /** Byte offset of directory entry `n` is `directoryOffset + 128 * n` (0 is the root). */
  directoryOffset: number;
  /** Each stream's first sector (regular) or mini sector (small), in the order given. */
  starts: number[];
  /** The DIFAT sectors, in chain order (empty when the header holds every FAT sector). */
  difatSectors: number[];
  sectorBytes: number;
}

export interface TestCompoundFileOptions {
  version?: 3 | 4;
  minFatSectors?: number;
}

function classIdBytes(clsid: string): Uint8Array {
  const hex = clsid.replace(/[{}-]/g, "");
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Number.parseInt(hex.slice(0, 8), 16), true);
  view.setUint16(4, Number.parseInt(hex.slice(8, 12), 16), true);
  view.setUint16(6, Number.parseInt(hex.slice(12, 16), 16), true);
  for (let index = 0; index < 8; index++) bytes[8 + index] = Number.parseInt(hex.slice(16 + index * 2, 18 + index * 2), 16);
  return bytes;
}

export function writeTestCompoundFile(
  clsid: string, streams: { name: string; data: Uint8Array | string }[], options: TestCompoundFileOptions = {},
): TestCompoundFile {
  const version = options.version ?? 3;
  const SECTOR = version === 4 ? 4096 : 512;
  const perSector = SECTOR / 4;
  const encoded = streams.map((stream) => ({
    name: stream.name, data: typeof stream.data === "string" ? new TextEncoder().encode(stream.data) : stream.data,
  }));
  const miniFat: number[] = [];
  const miniParts: Uint8Array[] = [];
  const miniStarts = encoded.map((stream) => {
    if (stream.data.length >= CUTOFF) return undefined;
    const count = Math.ceil(stream.data.length / MINI);
    if (!count) return END;
    const start = miniFat.length;
    for (let index = 0; index < count; index++) miniFat.push(index === count - 1 ? END : start + index + 1);
    const padded = new Uint8Array(count * MINI);
    padded.set(stream.data);
    miniParts.push(padded);
    return start;
  });
  const miniStream = new Uint8Array(miniParts.reduce((sum, part) => sum + part.length, 0));
  miniParts.reduce((at, part) => (miniStream.set(part, at), at + part.length), 0);

  const sectorsFor = (bytes: number) => Math.ceil(bytes / SECTOR);
  const directorySectors = sectorsFor((encoded.length + 1) * 128);
  const miniFatSectors = sectorsFor(miniFat.length * 4);
  const miniStreamSectors = sectorsFor(miniStream.length);
  const largeSectors = encoded.map((stream, index) => miniStarts[index] === undefined ? sectorsFor(stream.data.length) : 0);
  const content = directorySectors + miniFatSectors + miniStreamSectors + largeSectors.reduce((sum, count) => sum + count, 0);
  const difatFor = (fat: number) => Math.max(0, Math.ceil((fat - HEADER_DIFAT) / (perSector - 1)));
  let fatSectors = Math.max(1, options.minFatSectors ?? 1);
  while (fatSectors * perSector < fatSectors + difatFor(fatSectors) + content) fatSectors++;
  const difatCount = difatFor(fatSectors);
  const fat: number[] = new Array(fatSectors * perSector).fill(FREE);
  for (let index = 0; index < fatSectors; index++) fat[index] = FAT_SECTOR;
  const difatSectors = Array.from({ length: difatCount }, (_, index) => fatSectors + index);
  for (const id of difatSectors) fat[id] = DIFAT_SECTOR;
  let next = fatSectors + difatCount;
  const allocate = (count: number) => {
    if (!count) return END;
    const start = next;
    for (let index = 0; index < count; index++) fat[next + index] = index === count - 1 ? END : next + index + 1;
    next += count;
    return start;
  };
  const directoryStart = allocate(directorySectors);
  const miniFatStart = allocate(miniFatSectors);
  const miniStreamStart = allocate(miniStreamSectors);
  const largeStarts = largeSectors.map(allocate);

  const bytes = new Uint8Array((fatSectors + difatCount + content + 1) * SECTOR);
  const view = new DataView(bytes.buffer);
  const at = (sector: number) => (sector + 1) * SECTOR;
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x3e, true);
  view.setUint16(26, version, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, version === 4 ? 12 : 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, fatSectors, true);
  view.setUint32(48, directoryStart, true);
  view.setUint32(56, CUTOFF, true);
  view.setUint32(60, miniFatStart, true);
  view.setUint32(64, miniFatSectors, true);
  if (version === 4) view.setUint32(40, directorySectors, true);
  view.setUint32(68, difatCount ? difatSectors[0]! : END, true);
  view.setUint32(72, difatCount, true);
  for (let index = 0; index < HEADER_DIFAT; index++) view.setUint32(76 + index * 4, index < fatSectors ? index : FREE, true);
  difatSectors.forEach((id, chainIndex) => {
    bytes.fill(0xff, at(id), at(id) + SECTOR);
    for (let slot = 0; slot < perSector - 1; slot++) {
      const fatIndex = HEADER_DIFAT + chainIndex * (perSector - 1) + slot;
      if (fatIndex < fatSectors) view.setUint32(at(id) + slot * 4, fatIndex, true);
    }
    view.setUint32(at(id) + SECTOR - 4, difatSectors[chainIndex + 1] ?? END, true);
  });
  fat.forEach((entry, index) => view.setUint32(at(0) + index * 4, entry, true));
  if (miniFatSectors) {
    bytes.fill(0xff, at(miniFatStart), at(miniFatStart) + miniFatSectors * SECTOR);
    miniFat.forEach((entry, index) => view.setUint32(at(miniFatStart) + index * 4, entry, true));
  }
  bytes.set(miniStream, miniStreamSectors ? at(miniStreamStart) : 0);
  encoded.forEach((stream, index) => {
    if (miniStarts[index] === undefined) bytes.set(stream.data, at(largeStarts[index]!));
  });

  const entry = (id: number, fields: { name: string; type: number; right?: number; child?: number; start: number; size: number; clsid?: string }) => {
    const offset = at(directoryStart) + id * 128;
    for (let index = 0; index < fields.name.length; index++) view.setUint16(offset + index * 2, fields.name.charCodeAt(index), true);
    view.setUint16(offset + 64, fields.name ? (fields.name.length + 1) * 2 : 0, true);
    bytes[offset + 66] = fields.type;
    bytes[offset + 67] = 1; // black
    view.setUint32(offset + 68, FREE, true);
    view.setUint32(offset + 72, fields.right ?? FREE, true);
    view.setUint32(offset + 76, fields.child ?? FREE, true);
    if (fields.clsid) bytes.set(classIdBytes(fields.clsid), offset + 80);
    view.setUint32(offset + 116, fields.start, true);
    view.setUint32(offset + 120, fields.size, true);
  };
  for (let id = 0; id < directorySectors * (SECTOR / 128); id++) entry(id, { name: "", type: 0, start: 0, size: 0 });
  entry(0, { name: "Root Entry", type: 5, child: encoded.length ? 1 : FREE, clsid,
    start: miniStream.length ? miniStreamStart : END, size: miniStream.length });
  encoded.forEach((stream, index) => entry(index + 1, {
    name: stream.name, type: 2, right: index + 1 < encoded.length ? index + 2 : FREE,
    start: miniStarts[index] ?? largeStarts[index]!, size: stream.data.length,
  }));
  return {
    bytes, fatOffset: at(0), miniFatOffset: miniFatSectors ? at(miniFatStart) : -1, directoryOffset: at(directoryStart),
    starts: encoded.map((_, index) => miniStarts[index] ?? largeStarts[index]!),
    difatSectors, sectorBytes: SECTOR,
  };
}
