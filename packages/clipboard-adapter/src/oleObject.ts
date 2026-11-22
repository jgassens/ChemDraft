/**
 * ChemDraft's own OLE objects (docs/architecture/office-editing.md, "4. Windows: ChemDraft's own
 * embedded object"): their classes, and a bounded reader for an object's compound file (CFB), such
 * as `word/embeddings/oleObject1.bin` in a .docx, whose `ChemDraftDocument` stream holds the
 * drawing as carrier JSON. The classes match `OleClass` in
 * `apps/desktop/src-tauri/src/office_ole/mod.rs`. The reader follows MS-CFB and the slice 2 probe's
 * reader (`scripts/office-spike/ole/cfb-writer.mjs`); the app's native code reads the same storage
 * with the `cfb` crate (`office_ole/storage.rs`). It needs no dependency.
 *
 * Pure and bounded: the file is untrusted input. Every sector index is range-checked, every chain is
 * walked at most once per sector, and a stream's declared size is checked before it is read.
 */

export interface ChemDraftOleClass {
  clsid: string;
  progId: string;
  independentProgId: string;
}

/** The stable app's class, then the dev build's. Never another program's. */
export const CHEMDRAFT_OLE_CLASSES: readonly ChemDraftOleClass[] = Object.freeze([
  Object.freeze({ clsid: "{CE37136C-13F0-4A5A-954F-0EF6DFE359D0}", progId: "ChemDraft.Structure.1", independentProgId: "ChemDraft.Structure" }),
  Object.freeze({ clsid: "{8D23DEDA-8B23-4D62-BEEC-6C6168D48BB4}", progId: "ChemDraft.DevStructure.1", independentProgId: "ChemDraft.DevStructure" }),
]);

/** The stream holding the drawing (`DOCUMENT` in `office_ole/storage.rs`). */
export const CHEMDRAFT_DOCUMENT_STREAM = "ChemDraftDocument";

/** The whole compound file, as in the native reader (`MAX_STORAGE_BYTES`, 50 MiB). */
export const MAX_COMPOUND_FILE_BYTES = 50 * 1024 * 1024;

function bareClassId(clsid: string): string {
  const bare = clsid.startsWith("{") && clsid.endsWith("}") ? clsid.slice(1, -1) : clsid;
  return bare.toUpperCase();
}

/** True for ChemDraft's stable or dev class, written with or without braces, in any case. */
export function isChemDraftOleClassId(clsid: string | undefined): boolean {
  if (!clsid) return false;
  const bare = bareClassId(clsid);
  return CHEMDRAFT_OLE_CLASSES.some((known) => bareClassId(known.clsid) === bare);
}

/** True for a ChemDraft ProgID, versioned or version-independent (ProgIDs are case-insensitive). */
export function isChemDraftOleProgId(progId: string | undefined): boolean {
  if (!progId) return false;
  const lower = progId.toLowerCase();
  return CHEMDRAFT_OLE_CLASSES.some((known) => known.progId.toLowerCase() === lower || known.independentProgId.toLowerCase() === lower);
}

export type ChemDraftOleRead =
  /** ChemDraft's object: its class and the `ChemDraftDocument` text (UTF-8, not yet parsed). */
  | { kind: "chemdraft"; clsid: string; json: string }
  /** Another program's object, or no class at all: not ChemDraft's to read. */
  | { kind: "other"; clsid: string }
  /** ChemDraft's object whose drawing is over the caller's limit; it was not read. */
  | { kind: "too-large"; clsid: string; documentBytes: number }
  /**
   * Not a readable compound file, or ChemDraft's object without a usable drawing; `clsid` is set
   * once the file is known to be ChemDraft's object.
   */
  | { kind: "invalid"; reason: string; clsid?: string };

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREE = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;
const HEADER_DIFAT_ENTRIES = 109;
const ENTRY_BYTES = 128;
const MINI_SECTOR_BYTES = 64;
const MINI_STREAM_CUTOFF = 4096;
const STORAGE = 1;
const STREAM = 2;
const ROOT = 5;

class CompoundFileError extends Error {}

function fail(reason: string): never {
  throw new CompoundFileError(reason);
}

function formatClassId(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
  const hex = (value: number, digits: number) => value.toString(16).toUpperCase().padStart(digits, "0");
  const tail = [...bytes.subarray(8, 16)].map((byte) => hex(byte, 2)).join("");
  return `{${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}-${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}}`;
}

interface DirectoryEntry {
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

/**
 * Read a compound file's root class and, when it is ChemDraft's, its `ChemDraftDocument` stream.
 * `maxDocumentBytes` bounds that stream; a larger one is reported as `too-large` without being read.
 */
export function readChemDraftOleObject(bytes: Uint8Array, maxDocumentBytes: number): ChemDraftOleRead {
  const known: { clsid?: string } = {};
  try {
    return readCompoundFile(bytes, maxDocumentBytes, known);
  } catch (error) {
    if (error instanceof CompoundFileError) return { kind: "invalid", reason: error.message, ...(known.clsid ? { clsid: known.clsid } : {}) };
    throw error;
  }
}

function readCompoundFile(bytes: Uint8Array, maxDocumentBytes: number, known: { clsid?: string }): ChemDraftOleRead {
  if (bytes.length > MAX_COMPOUND_FILE_BYTES) fail("the embedded object is larger than the 50 MB limit");
  if (bytes.length < 512 || SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    fail("the embedded object is not an OLE compound file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const major = u16(26);
  const sectorShift = u16(30);
  if (u16(28) !== 0xfffe || !((major === 3 && sectorShift === 9) || (major === 4 && sectorShift === 12)) ||
      u16(32) !== 6 || u32(56) !== MINI_STREAM_CUTOFF) {
    fail("the embedded object uses an unsupported compound file layout");
  }
  const sectorBytes = 1 << sectorShift;
  const entriesPerSector = sectorBytes / 4;
  const sectorCount = Math.ceil(bytes.length / sectorBytes) - 1;
  const sector = (id: number): Uint8Array => {
    if (id >= sectorCount) fail("a sector index points past the end of the file");
    const start = (id + 1) * sectorBytes;
    const data = bytes.subarray(start, start + sectorBytes);
    if (data.length < sectorBytes) fail("the file ends inside a sector");
    return data;
  };
  const sectorView = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);

  // The FAT: its sector list starts in the header and continues in the DIFAT chain.
  const fatSectorCount = u32(44);
  const difatSectorCount = u32(72);
  if (fatSectorCount === 0 || fatSectorCount > sectorCount || difatSectorCount > sectorCount) fail("the sector tables are damaged");
  const fatSectors: number[] = [];
  const addFatSector = (id: number) => {
    if (id === FREE) return;
    if (fatSectors.length >= fatSectorCount) fail("the sector tables are damaged");
    fatSectors.push(id);
  };
  for (let index = 0; index < HEADER_DIFAT_ENTRIES; index++) addFatSector(u32(76 + index * 4));
  const difatSectors: number[] = [];
  let difat = u32(68);
  for (let index = 0; index < difatSectorCount; index++) {
    if (difatSectors.includes(difat)) fail("the sector tables are damaged");
    const data = sectorView(sector(difat));
    difatSectors.push(difat);
    for (let slot = 0; slot < entriesPerSector - 1; slot++) addFatSector(data.getUint32(slot * 4, true));
    difat = data.getUint32(sectorBytes - 4, true);
  }
  if (fatSectors.length !== fatSectorCount || (difatSectorCount > 0 && difat !== END_OF_CHAIN && difat !== FREE)) {
    fail("the sector tables are damaged");
  }
  const fat = new Uint32Array(fatSectorCount * entriesPerSector);
  for (const [index, id] of fatSectors.entries()) {
    const data = sectorView(sector(id));
    for (let slot = 0; slot < entriesPerSector; slot++) fat[index * entriesPerSector + slot] = data.getUint32(slot * 4, true);
  }
  if (fatSectors.some((id) => fat[id] !== FAT_SECTOR) || difatSectors.some((id) => fat[id] !== DIFAT_SECTOR)) {
    fail("the sector tables are damaged");
  }

  /** Follow a sector chain, at most `maxSectors` long, visiting each sector once. */
  const chain = (start: number, maxSectors: number, what: string): Uint8Array => {
    const ids: number[] = [];
    const seen = new Set<number>();
    for (let id = start; id !== END_OF_CHAIN;) {
      if (id >= sectorCount || id >= fat.length || seen.has(id) || ids.length >= maxSectors) fail(`the ${what} sector chain is damaged`);
      seen.add(id);
      ids.push(id);
      id = fat[id]!;
    }
    const data = new Uint8Array(ids.length * sectorBytes);
    for (const [index, id] of ids.entries()) data.set(sector(id), index * sectorBytes);
    return data;
  };

  const directory = chain(u32(48), sectorCount, "directory");
  const directoryView = sectorView(directory);
  const entryCount = directory.length / ENTRY_BYTES;
  const entry = (id: number): DirectoryEntry => {
    if (id >= entryCount) fail("a directory entry points past the directory");
    const at = id * ENTRY_BYTES;
    const nameBytes = directoryView.getUint16(at + 64, true);
    if (nameBytes > 64 || nameBytes % 2) fail("a directory entry has a damaged name");
    let name = "";
    for (let offset = 0; offset + 2 < nameBytes; offset += 2) name += String.fromCharCode(directoryView.getUint16(at + offset, true));
    const sizeHigh = directoryView.getUint32(at + 124, true);
    // Version 3 writers may leave the high size word uninitialized (MS-CFB 2.6.3); ignore it there.
    if (major === 4 && sizeHigh !== 0) fail("a stream is larger than the 50 MB limit");
    return {
      name, type: directory[at + 66]!, left: directoryView.getUint32(at + 68, true), right: directoryView.getUint32(at + 72, true),
      child: directoryView.getUint32(at + 76, true), start: directoryView.getUint32(at + 116, true), size: directoryView.getUint32(at + 120, true),
    };
  };
  const root = entry(0);
  if (root.type !== ROOT) fail("the compound file has no root entry");
  const clsid = formatClassId(directory.subarray(80, 96));
  if (!isChemDraftOleClassId(clsid)) return { kind: "other", clsid };
  known.clsid = clsid;

  // The root's children form a tree through left and right siblings; names compare without case.
  let document: DirectoryEntry | undefined;
  const pending = [root.child];
  const seen = new Set<number>([0]);
  const wanted = CHEMDRAFT_DOCUMENT_STREAM.toUpperCase();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === FREE) continue;
    if (seen.has(id)) fail("the directory is damaged");
    seen.add(id);
    const child = entry(id);
    pending.push(child.left, child.right);
    if (child.type === STREAM && child.name.toUpperCase() === wanted) {
      if (document) fail(`the object has two ${CHEMDRAFT_DOCUMENT_STREAM} streams`);
      document = child;
    } else if (child.type !== STREAM && child.type !== STORAGE) {
      fail("the directory is damaged");
    }
  }
  if (!document) fail(`the ChemDraft object has no ${CHEMDRAFT_DOCUMENT_STREAM} stream`);
  if (document.size > maxDocumentBytes) return { kind: "too-large", clsid, documentBytes: document.size };

  let data: Uint8Array;
  if (document.size < MINI_STREAM_CUTOFF) {
    // Small streams live in 64-byte mini sectors inside the root's mini stream.
    if (root.size > bytes.length) fail("the mini stream is larger than the file");
    const miniStream = chain(root.start, Math.ceil(root.size / sectorBytes), "mini stream").subarray(0, root.size);
    const miniFatBytes = chain(u32(60), u32(64), "mini FAT");
    if (miniFatBytes.length !== u32(64) * sectorBytes) fail("the mini FAT sector chain is damaged");
    const miniFat = sectorView(miniFatBytes);
    const count = Math.ceil(document.size / MINI_SECTOR_BYTES);
    data = new Uint8Array(count * MINI_SECTOR_BYTES);
    const seenMini = new Set<number>();
    let id = document.start;
    for (let index = 0; index < count; index++) {
      if (id * 4 + 4 > miniFatBytes.length || (id + 1) * MINI_SECTOR_BYTES > miniStream.length || seenMini.has(id)) {
        fail(`the ${CHEMDRAFT_DOCUMENT_STREAM} mini sector chain is damaged`);
      }
      seenMini.add(id);
      data.set(miniStream.subarray(id * MINI_SECTOR_BYTES, (id + 1) * MINI_SECTOR_BYTES), index * MINI_SECTOR_BYTES);
      id = miniFat.getUint32(id * 4, true);
    }
    if (id !== END_OF_CHAIN) fail(`the ${CHEMDRAFT_DOCUMENT_STREAM} mini sector chain is damaged`);
  } else {
    data = chain(document.start, Math.ceil(document.size / sectorBytes), CHEMDRAFT_DOCUMENT_STREAM);
  }
  if (data.length < document.size) fail(`${CHEMDRAFT_DOCUMENT_STREAM} is shorter than its declared size`);
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data.subarray(0, document.size));
  } catch {
    fail(`${CHEMDRAFT_DOCUMENT_STREAM} is not UTF-8 text`);
  }
  return { kind: "chemdraft", clsid, json };
}
