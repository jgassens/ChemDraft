// MS-CFB v3, with ANSI CompObj and an embedded OLEStream from MS-OLEDS.
const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;
const FAT_ENTRIES = SECTOR / 4;
const HEADER_DIFAT = 109;
const DIFAT_ENTRIES = FAT_ENTRIES - 1;
const ENTRY = 128;
const FREE = 0xffffffff;
const END = 0xfffffffe;
const FAT = 0xfffffffd;
const DIFAT = 0xfffffffc;
const SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const CLSID_BYTES = Buffer.from('51ac559597406b418588e2ba35e8af94', 'hex');
export const MAX_CFB_BYTES = 50 * 1024 * 1024;
export const CLSID = '{9555AC51-4097-416B-8588-E2BA35E8AF94}';
export const PROG_ID = 'ChemDraft.Structure.Probe';
export const USER_TYPE = 'ChemDraft Structure (probe)';
export const DOCUMENT_STREAM = 'ChemDraftDocument';

function ansiString(text) {
  const length = Buffer.byteLength(text, 'ascii') + 1;
  const bytes = Buffer.alloc(4 + length);
  bytes.writeUInt32LE(length);
  bytes.write(text, 4, 'ascii');
  return bytes;
}

function compObj() {
  const header = Buffer.alloc(28);
  header.writeUInt32LE(0xfffe0001);
  header.writeUInt32LE(0x00000a03, 4);
  header.writeUInt32LE(FREE, 8);
  CLSID_BYTES.copy(header, 12);

  const unicode = Buffer.alloc(16);
  unicode.writeUInt32LE(0x71b239f4);
  return Buffer.concat([header, ansiString(USER_TYPE), Buffer.alloc(4), ansiString(PROG_ID), unicode]);
}

function oleStream() {
  const bytes = Buffer.alloc(20);
  bytes.writeUInt32LE(0x02000001);
  return bytes; // Flags zero means embedded. There are no linked-object monikers.
}

function directoryEntry(bytes, { name, type, left = FREE, right = FREE, child = FREE, start = END, size = 0 }) {
  const length = bytes.write(name, 0, 'utf16le');
  bytes.writeUInt16LE(length + 2, 64);
  bytes[66] = type;
  bytes[67] = 1; // Black.
  bytes.writeUInt32LE(left, 68);
  bytes.writeUInt32LE(right, 72);
  bytes.writeUInt32LE(child, 76);
  if (type === 5) CLSID_BYTES.copy(bytes, 80);
  bytes.writeUInt32LE(start, 116);
  bytes.writeUInt32LE(size, 120);
}

const sectors = (size, unit = SECTOR) => Math.ceil(size / unit);

/** Write the probe's three streams, preserving the document bytes exactly. */
export function writeCfb(document) {
  const streams = [
    { name: '\x01Ole', data: oleStream() },
    { name: '\x01CompObj', data: compObj() },
    { name: DOCUMENT_STREAM, data: Buffer.isBuffer(document) ? document : Buffer.from(document) },
  ];

  // Directory is sector 0. Allocate the short streams in the root mini stream.
  let miniCount = 0;
  for (const stream of streams.filter(item => item.data.length < CUTOFF)) {
    stream.count = sectors(stream.data.length, MINI);
    stream.start = stream.count ? miniCount : END;
    miniCount += stream.count;
  }
  const miniFatCount = sectors(miniCount * 4);
  const miniStart = 1 + miniFatCount;
  const miniSize = miniCount * MINI;
  let dataCount = miniStart + sectors(miniSize);
  for (const stream of streams.filter(item => item.data.length >= CUTOFF)) {
    stream.count = sectors(stream.data.length);
    stream.start = dataCount;
    dataCount += stream.count;
  }

  // FAT and DIFAT sectors are themselves covered by the FAT.
  let fatCount = 0, difatCount = 0;
  while (fatCount * FAT_ENTRIES < dataCount + fatCount + difatCount) {
    fatCount = sectors((dataCount + fatCount + difatCount) * 4);
    difatCount = Math.max(0, Math.ceil((fatCount - HEADER_DIFAT) / DIFAT_ENTRIES));
  }
  const total = (1 + dataCount + fatCount + difatCount) * SECTOR;
  if (total > MAX_CFB_BYTES) throw new Error('CFB file exceeds 50 MiB');

  const out = Buffer.alloc(total);
  const sectorOffset = index => (index + 1) * SECTOR;
  SIGNATURE.copy(out);
  out.writeUInt16LE(0x003e, 24);
  out.writeUInt16LE(3, 26);
  out.writeUInt16LE(0xfffe, 28);
  out.writeUInt16LE(9, 30);
  out.writeUInt16LE(6, 32);
  out.writeUInt32LE(fatCount, 44);
  out.writeUInt32LE(CUTOFF, 56);
  out.writeUInt32LE(1, 60);
  out.writeUInt32LE(miniFatCount, 64);
  out.writeUInt32LE(difatCount ? dataCount + fatCount : END, 68);
  out.writeUInt32LE(difatCount, 72);
  for (let i = 0; i < HEADER_DIFAT; i++) out.writeUInt32LE(i < fatCount ? dataCount + i : FREE, 76 + i * 4);
  for (let i = 0; i < difatCount; i++) {
    const at = sectorOffset(dataCount + fatCount + i);
    for (let j = 0; j < DIFAT_ENTRIES; j++) {
      const index = HEADER_DIFAT + i * DIFAT_ENTRIES + j;
      out.writeUInt32LE(index < fatCount ? dataCount + index : FREE, at + j * 4);
    }
    out.writeUInt32LE(i + 1 < difatCount ? dataCount + fatCount + i + 1 : END, at + SECTOR - 4);
  }

  const miniFat = out.subarray(sectorOffset(1), sectorOffset(miniStart)).fill(0xff);
  const fat = out.subarray(sectorOffset(dataCount), sectorOffset(dataCount + fatCount)).fill(0xff);
  function chain(table, start, count) {
    for (let i = 0; i < count; i++) table.writeUInt32LE(i + 1 < count ? start + i + 1 : END, (start + i) * 4);
  }
  chain(fat, 0, 1);
  chain(fat, 1, miniFatCount);
  chain(fat, miniStart, sectors(miniSize));
  for (let i = 0; i < fatCount; i++) fat.writeUInt32LE(FAT, (dataCount + i) * 4);
  for (let i = 0; i < difatCount; i++) fat.writeUInt32LE(DIFAT, (dataCount + fatCount + i) * 4);
  for (const { data, start, count } of streams) {
    if (count === 0) continue;
    if (data.length < CUTOFF) {
      chain(miniFat, start, count);
      data.copy(out, sectorOffset(miniStart) + start * MINI);
    } else {
      chain(fat, start, count);
      data.copy(out, sectorOffset(start));
    }
  }

  // CFB sorts siblings by name length, then by uppercase UTF-16 code units.
  // Here the middle name is the parent of two black leaves.
  const directory = out.subarray(SECTOR, SECTOR * 2);
  directoryEntry(directory, { name: 'Root Entry', type: 5, child: 2, start: miniStart, size: miniSize });
  streams.forEach((stream, index) => directoryEntry(directory.subarray((index + 1) * ENTRY), {
    name: stream.name, type: 2, start: stream.start, size: stream.data.length,
    ...(index === 1 ? { left: 1, right: 3 } : {}),
  }));
  return out;
}

/** Read live root streams of a v3 compound file, including Office-added streams. */
export function readCfb(bytes) {
  if (bytes.length > MAX_CFB_BYTES) throw new Error('CFB file exceeds 50 MiB');
  if (bytes.length < SECTOR * 2 || bytes.length % SECTOR || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Invalid CFB signature or file size');
  }
  if (bytes.readUInt16LE(26) !== 3 || bytes.readUInt16LE(28) !== 0xfffe ||
      bytes.readUInt16LE(30) !== 9 || bytes.readUInt16LE(32) !== 6 ||
      bytes.readUInt32LE(56) !== CUTOFF) {
    throw new Error('Unsupported CFB format: expected v3 with 512-byte sectors');
  }
  const sectorCount = bytes.length / SECTOR - 1;
  const sector = sid => bytes.subarray((sid + 1) * SECTOR, (sid + 2) * SECTOR);
  const used = new Set();
  function take(sid, label) {
    if (sid >= sectorCount || used.has(sid)) throw new Error(`Invalid CFB ${label} sector chain`);
    used.add(sid);
    return sector(sid);
  }

  const fatCount = bytes.readUInt32LE(44);
  const difatCount = bytes.readUInt32LE(72);
  if (!fatCount || fatCount + difatCount > sectorCount) throw new Error('Invalid CFB FAT/DIFAT size');
  const fatIds = [];
  function readFatIds(data, offset, slots) {
    for (let i = 0; i < slots; i++) {
      const id = data.readUInt32LE(offset + i * 4);
      if (id === FREE) continue;
      if (fatIds.length >= fatCount) throw new Error('Invalid CFB DIFAT FAT sector count');
      fatIds.push(id);
    }
  }
  readFatIds(bytes, 76, HEADER_DIFAT);
  const difatIds = [];
  let next = bytes.readUInt32LE(68);
  for (let i = 0; i < difatCount; i++) {
    const data = take(next, 'DIFAT');
    difatIds.push(next);
    readFatIds(data, 0, DIFAT_ENTRIES);
    next = data.readUInt32LE(SECTOR - 4);
  }
  if (next !== END || fatIds.length !== fatCount) throw new Error('Invalid CFB DIFAT chain length');

  const fat = Buffer.concat(fatIds.map(id => take(id, 'FAT')));
  if (fat.length < sectorCount * 4) throw new Error('CFB FAT does not cover all sectors');
  const fatAt = sid => fat.readUInt32LE(sid * 4);
  if (fatIds.some(id => fatAt(id) !== FAT) || difatIds.some(id => fatAt(id) !== DIFAT)) {
    throw new Error('Invalid CFB FAT/DIFAT sector markers');
  }

  function regular(start, count, label) {
    const blocks = [];
    for (let sid = start; sid !== END; sid = fatAt(sid)) {
      if (blocks.length === count) throw new Error(`CFB ${label} chain is longer than declared`);
      blocks.push(take(sid, label));
    }
    if (count !== undefined && blocks.length !== count) throw new Error(`Truncated CFB ${label} chain`);
    return Buffer.concat(blocks);
  }
  const directory = regular(bytes.readUInt32LE(48), undefined, 'directory');
  function entry(id) {
    const at = id * ENTRY;
    if (at >= directory.length) throw new Error('CFB directory entry is out of bounds');
    const length = directory.readUInt16LE(at + 64);
    if (length < 2 || length > 64 || length % 2 || directory.readUInt16LE(at + length - 2) !== 0) {
      throw new Error('Invalid CFB directory name');
    }
    return {
      name: directory.toString('utf16le', at, at + length - 2), type: directory[at + 66],
      left: directory.readUInt32LE(at + 68), right: directory.readUInt32LE(at + 72),
      child: directory.readUInt32LE(at + 76), start: directory.readUInt32LE(at + 116),
      size: directory.readUInt32LE(at + 120), clsid: directory.subarray(at + 80, at + 96),
    };
  }
  const root = entry(0);
  if (root.type !== 5 || root.name !== 'Root Entry') throw new Error('Invalid CFB root entry');
  const guid = root.clsid;
  const fields = [guid.readUInt32LE(), guid.readUInt16LE(4), guid.readUInt16LE(6)];
  const clsid = ('{' + fields.map((n, i) => n.toString(16).padStart(i === 0 ? 8 : 4, '0')).join('-') +
    '-' + guid.toString('hex', 8, 10) + '-' + guid.toString('hex', 10) + '}').toUpperCase();

  const miniFat = regular(bytes.readUInt32LE(60), bytes.readUInt32LE(64), 'mini FAT');
  const miniData = regular(root.start, sectors(root.size), 'root mini stream').subarray(0, root.size);
  const usedMini = new Set();
  function small(start, size, label) {
    const blocks = [];
    const count = sectors(size, MINI);
    let sid = start;
    for (let i = 0; i < count; i++) {
      if (sid * 4 >= miniFat.length || (sid + 1) * MINI > miniData.length || usedMini.has(sid)) {
        throw new Error(`Invalid CFB ${label} mini sector chain`);
      }
      usedMini.add(sid);
      blocks.push(miniData.subarray(sid * MINI, (sid + 1) * MINI));
      sid = miniFat.readUInt32LE(sid * 4);
    }
    if (sid !== END) throw new Error(`CFB ${label} mini chain is longer than declared`);
    return Buffer.concat(blocks).subarray(0, size);
  }

  const streams = new Map();
  const seen = new Set([0]);
  const pending = [root.child];
  while (pending.length) {
    const id = pending.pop();
    if (id === FREE) continue;
    if (seen.has(id)) throw new Error('Cyclic or shared CFB directory entry');
    seen.add(id);
    const item = entry(id);
    pending.push(item.left, item.right);
    if (item.type === 1) continue; // Nested storages are outside the probe.
    if (item.type !== 2 || streams.has(item.name)) throw new Error('Invalid CFB root stream entry');
    const data = item.size < CUTOFF
      ? small(item.start, item.size, item.name)
      : regular(item.start, sectors(item.size), item.name).subarray(0, item.size);
    streams.set(item.name, data);
  }
  return { clsid, streams };
}
