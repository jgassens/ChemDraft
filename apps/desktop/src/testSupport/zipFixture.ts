/**
 * Build zip archives in tests (M36).
 *
 * The installer's fail-closed paths are only worth as much as the hostile archives used to prove them,
 * and the real `plugin:package` output — correctly — cannot produce a traversal entry, a bad CRC, or a
 * truncated central directory. So the tests need to construct those archives deliberately, which means
 * writing the format rather than shelling out to `zip`.
 *
 * Deliberately dumb and independent of `pluginPackageArchive.ts`: if both shared a helper, a bug in the
 * shared understanding of the format would cancel out and the tests would pass on archives no real zip
 * tool would accept.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
/** The value a 32-bit zip field carries when the real value lives in a Zip64 extra field. */
export const ZIP64_SENTINEL_32 = 0xffffffff;
/** The 16-bit equivalent, used for the EOCD's entry count. */
export const ZIP64_SENTINEL_16 = 0xffff;

export interface ZipFixtureEntry {
  path: string;
  /** File contents. Ignored when `directory` is set. */
  content?: string | Uint8Array;
  /** Emit as a directory entry (trailing slash, no data). */
  directory?: boolean;
  /** Deflate the entry instead of storing it. */
  deflate?: boolean;
  /** Override the CRC-32 written to the archive, to simulate corruption. */
  crcOverride?: number;
  /** Override the uncompressed size written to the archive. */
  sizeOverride?: number;
  /** Override the compressed size written to the archive. `0xffffffff` is the Zip64 sentinel. */
  compressedSizeOverride?: number;
  /** Override the local-header offset in the central directory. `0xffffffff` is the Zip64 sentinel. */
  localHeaderOffsetOverride?: number;
  /** Override the compression method, to simulate an unreadable archive. */
  methodOverride?: number;
  /** Set general-purpose bit flags (e.g. 0x01 for "encrypted"). */
  flags?: number;
}

export interface ZipFixtureOptions {
  /**
   * Emit a Zip64 end-of-central-directory locator immediately before the EOCD, as a real Zip64
   * writer does. Readers that cannot handle Zip64 are expected to detect this and refuse.
   */
  zip64Locator?: boolean;
  /** Override the entry count written to the EOCD. `0xffff` is the Zip64 sentinel. */
  entryCountOverride?: number;
  /** Override the central-directory offset written to the EOCD. `0xffffffff` is the Zip64 sentinel. */
  centralDirectoryOffsetOverride?: number;
}

/** Build a zip. Entries are stored (method 0) unless `deflate` is set. */
export async function createZipFixture(
  entries: readonly ZipFixtureEntry[],
  options: ZipFixtureOptions = {}
): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.directory ? ensureTrailingSlash(entry.path) : entry.path);
    const raw = entry.directory ? new Uint8Array(0) : toBytes(entry.content ?? "");
    const method = entry.methodOverride ?? (entry.deflate ? 8 : 0);
    const data = entry.deflate ? await deflateRaw(raw) : raw;
    const crc = entry.crcOverride ?? crc32(raw);
    const uncompressedSize = entry.sizeOverride ?? raw.byteLength;
    const flags = entry.flags ?? 0;
    const compressedSize = entry.compressedSizeOverride ?? data.byteLength;
    const localHeaderOffset = entry.localHeaderOffsetOverride ?? offset;

    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressedSize, true);
    localView.setUint32(22, uncompressedSize, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressedSize, true);
    centralView.setUint32(24, uncompressedSize, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localHeaderOffset, true);
    central.set(name, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.byteLength + data.byteLength;
  }

  const centralDirectory = concat(centrals);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, EOCD_SIGNATURE, true);
  eocdView.setUint16(8, options.entryCountOverride ?? entries.length, true);
  eocdView.setUint16(10, options.entryCountOverride ?? entries.length, true);
  eocdView.setUint32(12, centralDirectory.byteLength, true);
  eocdView.setUint32(16, options.centralDirectoryOffsetOverride ?? offset, true);

  // A real Zip64 archive carries a 20-byte locator directly before the EOCD; emitting it is how a
  // fixture can prove the reader refuses Zip64 instead of misreading the 32-bit fields.
  const locator = options.zip64Locator ? buildZip64Locator(offset + centralDirectory.byteLength) : undefined;

  return concat([...locals, centralDirectory, ...(locator ? [locator] : []), eocd]);
}

function buildZip64Locator(zip64EocdOffset: number): Uint8Array {
  const locator = new Uint8Array(20);
  const view = new DataView(locator.buffer);
  view.setUint32(0, ZIP64_EOCD_LOCATOR_SIGNATURE, true);
  view.setUint32(4, 0, true); // disk holding the Zip64 EOCD
  view.setUint32(8, zip64EocdOffset, true); // 64-bit offset, low word
  view.setUint32(12, 0, true); // high word
  view.setUint32(16, 1, true); // total disks
  return locator;
}

/** Flip one byte, to simulate a corrupted download. */
export function tamperByte(bytes: Uint8Array, index: number): Uint8Array {
  const copy = bytes.slice();
  copy[index] = copy[index] ^ 0xff;
  return copy;
}

/** A `shasum`-format sidecar for `bytes`. */
export async function sidecarFor(bytes: Uint8Array, filename = "package.zip"): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex}  ${filename}\n`;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function ensureTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
