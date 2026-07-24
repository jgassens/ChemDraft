/**
 * Read a built plugin package's zip (M36, ADR-0029 §5).
 *
 * `plugin:package` (M35) emits a **flat** zip — no wrapping directory — precisely so a host can unpack
 * it straight into a staging directory and preserve the co-location that makes the package resolvable.
 * This module is the reading half of that contract: it turns those bytes back into named entries,
 * refusing anything it cannot vouch for.
 *
 * ## No new dependency
 *
 * The repository has no JS zip library (`plugin:package` shells out to the system `zip`), and `fflate` /
 * `pako` are present only transitively — depending on them directly would be a phantom dependency. The
 * platform already provides what is needed: `DecompressionStream("deflate-raw")` (Safari 16.4+/WKWebView,
 * Node 18+) and `crypto.subtle.digest`. So this reads the format directly and adds nothing to the tree.
 *
 * ## Two independent integrity checks
 *
 * The `.sha256` sidecar covers the **whole archive**, and is checked when present. But a sidecar is
 * optional and trivially regenerated, so it can never be the only check — every entry's **CRC-32 and
 * uncompressed length are verified against the archive's own central directory regardless**, which is
 * what "verify the archive's integrity regardless" means in practice. Both are **integrity only**: they
 * detect corruption, never authenticity (ADR-0029 §4 — no signing, no trust gate).
 *
 * Unsupported shapes fail closed and loudly rather than being guessed at: encryption, Zip64, compression
 * methods other than store/deflate, and any entry path that could escape the staging directory.
 */

/** Stable, programmatic codes. Human-readable text rides on the error's `message` (AGENTS.md). */
export const PluginPackageErrorCodes = {
  MalformedArchive: "PLUGIN_PACKAGE_MALFORMED_ARCHIVE",
  UnsupportedArchive: "PLUGIN_PACKAGE_UNSUPPORTED_ARCHIVE",
  CorruptEntry: "PLUGIN_PACKAGE_CORRUPT_ENTRY",
  UnsafeEntryPath: "PLUGIN_PACKAGE_UNSAFE_ENTRY_PATH",
  ResourceLimitExceeded: "PLUGIN_PACKAGE_RESOURCE_LIMIT_EXCEEDED",
  ChecksumMismatch: "PLUGIN_PACKAGE_CHECKSUM_MISMATCH",
  DigestUnavailable: "PLUGIN_PACKAGE_DIGEST_UNAVAILABLE"
} as const;

export type PluginPackageErrorCode = (typeof PluginPackageErrorCodes)[keyof typeof PluginPackageErrorCodes];

export class PluginPackageError extends Error {
  readonly code: PluginPackageErrorCode;

  constructor(code: PluginPackageErrorCode, message: string) {
    super(message);
    this.name = "PluginPackageError";
    this.code = code;
  }
}

/** One file unpacked from a package. `path` is always a safe, relative, forward-slashed path. */
export interface PluginPackageEntry {
  path: string;
  bytes: Uint8Array;
}

/**
 * Hard limits applied to untrusted zip metadata before any entry is decompressed. The NMR plugin's
 * current package is comfortably below these ceilings; they are deliberately large enough for
 * code-split chemistry workers while small enough to bound memory use during package inspection.
 */
export interface PluginPackageArchiveLimits {
  maxCompressedBytes: number;
  maxEntryCount: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
}

const MEBIBYTE = 1024 * 1024;
export const DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS: Readonly<PluginPackageArchiveLimits> = Object.freeze({
  maxCompressedBytes: 32 * MEBIBYTE,
  maxEntryCount: 1024,
  maxEntryUncompressedBytes: 64 * MEBIBYTE,
  maxTotalUncompressedBytes: 128 * MEBIBYTE,
  maxCompressionRatio: 200
});

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;

const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;

const FLAG_ENCRYPTED = 0x0001;
/** Sizes live in a trailing data descriptor; the central directory's copies stay authoritative. */
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;

/** Marker meaning "the real value is in a Zip64 extra field". */
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

const EOCD_MIN_SIZE = 22;
/** The EOCD may be followed by a comment of up to 0xffff bytes. */
const EOCD_MAX_COMMENT = 0xffff;

/** Lowercase hex SHA-256 of `bytes`, for comparing against a `.sha256` sidecar. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new PluginPackageError(
      PluginPackageErrorCodes.DigestUnavailable,
      "This environment exposes no Web Crypto digest, so a plugin package's integrity cannot be verified. " +
        "Refusing to install unverified bytes."
    );
  }
  // Copy into a standalone buffer: `bytes` may be a view onto a larger one, and digest() takes the
  // whole buffer, not the view's window.
  const digest = await subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare an archive against its `.sha256` sidecar.
 *
 * Integrity only (ADR-0029 §4): this detects a corrupted or truncated download. It is emphatically not
 * an authenticity check — anyone who can alter the zip can alter the sidecar. Signing is deliberately
 * out of scope for this audience.
 *
 * @param sidecar Raw sidecar text, in `shasum` format: `<hex>  <filename>`.
 */
export async function verifyPackageChecksum(zipBytes: Uint8Array, sidecar: string): Promise<void> {
  const expected = parseChecksumSidecar(sidecar);
  const actual = await sha256Hex(zipBytes);
  if (actual !== expected) {
    throw new PluginPackageError(
      PluginPackageErrorCodes.ChecksumMismatch,
      `This plugin package does not match its .sha256 checksum, so it is corrupted or was modified after ` +
        `packaging. Expected ${expected}, got ${actual}. Refusing to install it.`
    );
  }
}

/** Pull the digest out of a `shasum`-format sidecar. */
export function parseChecksumSidecar(sidecar: string): string {
  const match = /^\s*([0-9a-fA-F]{64})\b/.exec(sidecar);
  if (!match) {
    throw new PluginPackageError(
      PluginPackageErrorCodes.ChecksumMismatch,
      "The .sha256 sidecar next to this package does not contain a SHA-256 digest, so the package's " +
        "integrity cannot be verified."
    );
  }
  return match[1].toLowerCase();
}

/**
 * Unpack a plugin package.
 *
 * Walks the central directory (the archive's authoritative index) rather than scanning local headers, so
 * a truncated or spliced archive is detected instead of partially trusted.
 */
export async function readPluginPackageArchive(
  zipBytes: Uint8Array,
  limits: Readonly<PluginPackageArchiveLimits> = DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS
): Promise<readonly PluginPackageEntry[]> {
  if (zipBytes.byteLength > limits.maxCompressedBytes) {
    throw resourceLimit(
      `This plugin package is ${zipBytes.byteLength} compressed bytes, exceeding ChemDraft's ` +
        `${limits.maxCompressedBytes}-byte package limit.`
    );
  }
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(zipBytes);
  rejectZip64(zipBytes, eocdOffset);

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  if (entryCount === ZIP64_SENTINEL_16 || centralDirectoryOffset === ZIP64_SENTINEL_32) {
    throw unsupported("This plugin package uses the Zip64 format, which ChemDraft cannot read.");
  }
  if (entryCount > limits.maxEntryCount) {
    throw resourceLimit(
      `This plugin package contains ${entryCount} archive entries, exceeding ChemDraft's ` +
        `${limits.maxEntryCount}-entry limit.`
    );
  }
  if (centralDirectoryOffset + centralDirectorySize > zipBytes.byteLength) {
    throw malformed("This plugin package's central directory runs past the end of the file, so it is truncated.");
  }

  const locations: EntryLocation[] = [];
  const seen = new Set<string>();
  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > zipBytes.byteLength || view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw malformed(`This plugin package's directory entry ${index + 1} of ${entryCount} is unreadable.`);
    }

    const flags = view.getUint16(cursor + 8, true);
    const compression = view.getUint16(cursor + 10, true);
    const crc32Expected = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > centralDirectoryOffset + centralDirectorySize || recordEnd > zipBytes.byteLength) {
      throw malformed(`This plugin package's directory entry ${index + 1} of ${entryCount} is truncated.`);
    }
    const name = decodeUtf8(zipBytes.subarray(cursor + 46, cursor + 46 + nameLength));

    assertSupportedEntry(name, flags, compression, compressedSize, uncompressedSize, localHeaderOffset);

    // Directory entries carry no data; staging recreates the tree from each file's own path.
    if (!name.endsWith("/")) {
      const path = safeEntryPath(name);
      if (seen.has(path)) {
        throw malformed(`This plugin package contains "${path}" more than once, so its contents are ambiguous.`);
      }
      seen.add(path);
      assertEntryResourceLimits(path, compressedSize, uncompressedSize, limits);
      totalUncompressedBytes += uncompressedSize;
      if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
        throw resourceLimit(
          `This plugin package declares ${totalUncompressedBytes} uncompressed bytes, exceeding ` +
            `ChemDraft's ${limits.maxTotalUncompressedBytes}-byte total limit.`
        );
      }

      locations.push({
        path,
        localHeaderOffset,
        compression,
        compressedSize,
        uncompressedSize,
        crc32Expected
      });
    }

    cursor = recordEnd;
  }

  if (locations.length === 0) {
    throw malformed("This plugin package contains no files.");
  }

  // Only after the complete central directory has passed every resource and path check do we allow
  // a decompressor to see any bytes. Keep inflation sequential so peak memory remains bounded by the
  // accumulated result plus one declared entry.
  const entries: PluginPackageEntry[] = [];
  for (const location of locations) {
    entries.push({ path: location.path, bytes: await readEntryData(zipBytes, view, location) });
  }
  return entries;
}

interface EntryLocation {
  path: string;
  localHeaderOffset: number;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32Expected: number;
}

/** Read one entry's bytes and prove them against the archive's own CRC-32 and length. */
async function readEntryData(
  zipBytes: Uint8Array,
  view: DataView,
  entry: EntryLocation
): Promise<Uint8Array> {
  if (entry.localHeaderOffset + 30 > zipBytes.byteLength || view.getUint32(entry.localHeaderOffset, true) !== LOCAL_HEADER_SIGNATURE) {
    throw malformed(`This plugin package's entry "${entry.path}" has an unreadable local header.`);
  }

  // The local header's extra field may differ in length from the central directory's, so the data
  // offset must be computed from the local header itself.
  const localNameLength = view.getUint16(entry.localHeaderOffset + 26, true);
  const localExtraLength = view.getUint16(entry.localHeaderOffset + 28, true);
  const dataStart = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zipBytes.byteLength) {
    throw malformed(`This plugin package's entry "${entry.path}" runs past the end of the file, so it is truncated.`);
  }

  const raw = zipBytes.subarray(dataStart, dataEnd);
  const bytes = entry.compression === COMPRESSION_STORED
    ? raw.slice()
    : await inflateRaw(raw, entry.path, entry.uncompressedSize);

  if (bytes.byteLength !== entry.uncompressedSize) {
    throw corrupt(
      `This plugin package's entry "${entry.path}" unpacked to ${bytes.byteLength} bytes but declares ` +
        `${entry.uncompressedSize}, so the package is corrupted.`
    );
  }
  const crc32Actual = crc32(bytes);
  if (crc32Actual !== entry.crc32Expected) {
    throw corrupt(
      `This plugin package's entry "${entry.path}" fails its CRC-32 integrity check, so the package is ` +
        "corrupted or was modified after packaging."
    );
  }
  return bytes;
}

async function inflateRaw(raw: Uint8Array, path: string, expectedBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw unsupported(
      "This environment cannot decompress a plugin package (no DecompressionStream), so the package " +
        "cannot be installed."
    );
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = new Blob([raw.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    reader = stream.getReader();
    const output = new Uint8Array(expectedBytes);
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expectedBytes) {
        await reader.cancel().catch(() => undefined);
        throw corrupt(
          `This plugin package's entry "${path}" expands beyond its declared ${expectedBytes}-byte size, ` +
            "so the package is corrupted or attempts excessive decompression."
        );
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
    return offset === expectedBytes ? output : output.slice(0, offset);
  } catch (cause: unknown) {
    if (cause instanceof PluginPackageError) throw cause;
    // A deflate stream that will not inflate is corruption, not an unsupported feature.
    throw corrupt(
      `This plugin package's entry "${path}" could not be decompressed, so the package is corrupted ` +
        `(${cause instanceof Error ? cause.message : String(cause)}).`
    );
  } finally {
    reader?.releaseLock();
  }
}

function assertEntryResourceLimits(
  path: string,
  compressedSize: number,
  uncompressedSize: number,
  limits: Readonly<PluginPackageArchiveLimits>
): void {
  if (uncompressedSize > limits.maxEntryUncompressedBytes) {
    throw resourceLimit(
      `This plugin package's entry "${path}" declares ${uncompressedSize} uncompressed bytes, exceeding ` +
        `ChemDraft's ${limits.maxEntryUncompressedBytes}-byte per-entry limit.`
    );
  }
  if (uncompressedSize > 0 && compressedSize === 0) {
    throw resourceLimit(
      `This plugin package's entry "${path}" declares non-empty output from zero compressed bytes.`
    );
  }
  const ratio = uncompressedSize === 0 ? 0 : uncompressedSize / compressedSize;
  if (ratio > limits.maxCompressionRatio) {
    throw resourceLimit(
      `This plugin package's entry "${path}" declares a ${ratio.toFixed(1)}:1 compression ratio, exceeding ` +
        `ChemDraft's ${limits.maxCompressionRatio}:1 limit.`
    );
  }
}

/** Refuse archive features we cannot honestly read, rather than silently mangling the output. */
function assertSupportedEntry(
  name: string,
  flags: number,
  compression: number,
  compressedSize: number,
  uncompressedSize: number,
  localHeaderOffset: number
): void {
  if ((flags & FLAG_ENCRYPTED) !== 0 || (flags & FLAG_STRONG_ENCRYPTION) !== 0) {
    throw unsupported(`This plugin package's entry "${name}" is encrypted, which ChemDraft cannot read.`);
  }
  if (compression !== COMPRESSION_STORED && compression !== COMPRESSION_DEFLATE) {
    throw unsupported(
      `This plugin package's entry "${name}" uses compression method ${compression}, which ChemDraft ` +
        "cannot read (only stored and deflate are supported)."
    );
  }
  if (
    compressedSize === ZIP64_SENTINEL_32 ||
    uncompressedSize === ZIP64_SENTINEL_32 ||
    localHeaderOffset === ZIP64_SENTINEL_32
  ) {
    throw unsupported(`This plugin package's entry "${name}" uses the Zip64 format, which ChemDraft cannot read.`);
  }
  // FLAG_DATA_DESCRIPTOR is fine to ignore: we take sizes and CRC from the central directory, which is
  // authoritative precisely so a streamed archive stays readable.
  void FLAG_DATA_DESCRIPTOR;
}

/**
 * Normalize and vet one entry path.
 *
 * The staging directory is the boundary: an entry may only ever land strictly inside it. Everything that
 * could reach outside — absolute paths, `..`, Windows separators and drive letters, UNC prefixes, NULs —
 * is refused rather than sanitized, because a package trying any of them is malformed by definition and
 * a "cleaned up" version of a hostile path is still a path nobody asked for.
 */
export function safeEntryPath(name: string): string {
  if (name.length === 0) {
    throw unsafePath("This plugin package contains an entry with an empty name.");
  }
  if (name.includes("\0")) {
    throw unsafePath(`This plugin package contains an entry whose name has an embedded NUL: "${name}".`);
  }
  // Treat `\` as a separator rather than a literal, so `..\..\x` cannot slip past the `..` check.
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw unsafePath(`This plugin package contains an absolute entry path, which would write outside the plugin's directory: "${name}".`);
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw unsafePath(`This plugin package contains a drive-qualified entry path, which would write outside the plugin's directory: "${name}".`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw unsafePath(
      `This plugin package contains an entry that would escape the plugin's directory: "${name}". ` +
        "Refusing to install it."
    );
  }
  // Drop `.` and the empty segments that `a//b` produces; neither changes where the file lands.
  const cleaned = segments.filter((segment) => segment !== "." && segment !== "").join("/");
  if (cleaned.length === 0) {
    throw unsafePath(`This plugin package contains an entry with no usable name: "${name}".`);
  }
  return cleaned;
}

/** Locate the End of Central Directory record, scanning back over any trailing comment. */
function findEndOfCentralDirectory(zipBytes: Uint8Array): number {
  if (zipBytes.byteLength < EOCD_MIN_SIZE) {
    throw malformed("This file is too small to be a plugin package (zip archive).");
  }
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const earliest = Math.max(0, zipBytes.byteLength - EOCD_MIN_SIZE - EOCD_MAX_COMMENT);
  for (let offset = zipBytes.byteLength - EOCD_MIN_SIZE; offset >= earliest; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      // Guard against the signature appearing by chance inside compressed data: the record's declared
      // comment length must actually reach the end of the file.
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + EOCD_MIN_SIZE + commentLength === zipBytes.byteLength) {
        return offset;
      }
    }
  }
  throw malformed("This file is not a readable plugin package: no zip central directory was found.");
}

function rejectZip64(zipBytes: Uint8Array, eocdOffset: number): void {
  const locatorOffset = eocdOffset - 20;
  if (locatorOffset < 0) return;
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  if (view.getUint32(locatorOffset, true) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
    throw unsupported("This plugin package uses the Zip64 format, which ChemDraft cannot read.");
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

const CRC32_TABLE = /* @__PURE__ */ (() => {
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

/** Standard CRC-32 (the zip variant), used to prove each entry against the archive's own record. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function malformed(message: string): PluginPackageError {
  return new PluginPackageError(PluginPackageErrorCodes.MalformedArchive, message);
}

function unsupported(message: string): PluginPackageError {
  return new PluginPackageError(PluginPackageErrorCodes.UnsupportedArchive, message);
}

function corrupt(message: string): PluginPackageError {
  return new PluginPackageError(PluginPackageErrorCodes.CorruptEntry, message);
}

function unsafePath(message: string): PluginPackageError {
  return new PluginPackageError(PluginPackageErrorCodes.UnsafeEntryPath, message);
}

function resourceLimit(message: string): PluginPackageError {
  return new PluginPackageError(PluginPackageErrorCodes.ResourceLimitExceeded, message);
}
