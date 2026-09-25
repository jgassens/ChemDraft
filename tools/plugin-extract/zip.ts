/**
 * Zip archives for plugin distributions, written and read in-process.
 *
 * Both tools used to shell out to `zip` (and their tests to `unzip`), which Windows does not ship.
 * fflate (MIT, pure JS) makes the archive identical in shape on every platform: entry names are
 * `/`-separated paths relative to `cwd`, sorted, files only — the layout `zip -X -r` produced.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { unzipSync, zipSync, type Zippable } from "fflate";

/** Archive `entries` (files or directories, relative to `cwd`, recursed) into `zipPath`. */
export function writeZip(zipPath: string, cwd: string, entries: readonly string[]): void {
  const files: Zippable = {};
  const add = (relativePath: string): void => {
    const full = join(cwd, relativePath);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(full).sort()) {
        add(`${relativePath}/${entry}`);
      }
    } else {
      files[relativePath] = [readFileSync(full), { mtime: stat.mtime }];
    }
  };
  for (const entry of [...entries].sort()) {
    add(entry);
  }
  writeFileSync(zipPath, zipSync(files, { level: 9 }));
}

/**
 * Entry names of `zipPath`, after decompressing every entry and proving it against the CRC-32 and
 * length the central directory records — the check `unzip -t` used to provide. fflate's `unzipSync`
 * alone is not that check: it never compares CRCs, so an entry whose deflate stream still decodes
 * after corruption would list cleanly.
 */
export function readZipEntryNames(zipPath: string): string[] {
  const bytes = readFileSync(zipPath);
  const files = unzipSync(bytes);
  const recorded = centralDirectory(bytes);
  for (const [name, content] of Object.entries(files)) {
    const entry = recorded.get(name);
    if (!entry) {
      throw new Error(`${zipPath}: entry "${name}" is missing from the central directory`);
    }
    if (content.byteLength !== entry.size || crc32(content) !== entry.crc) {
      throw new Error(`${zipPath}: entry "${name}" fails its CRC-32/length integrity check`);
    }
  }
  if (recorded.size !== Object.keys(files).length) {
    throw new Error(`${zipPath}: the central directory lists entries that did not decompress`);
  }
  return Object.keys(files).sort();
}

/** Name → recorded CRC-32 and uncompressed size, from the end-of-central-directory index. */
function centralDirectory(bytes: Buffer): Map<string, { crc: number; size: number }> {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) {
    throw new Error("zip has no end-of-central-directory record");
  }
  const count = bytes.readUInt16LE(eocd + 10);
  let cursor = bytes.readUInt32LE(eocd + 16);
  const entries = new Map<string, { crc: number; size: number }>();
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`zip central directory entry ${index + 1} of ${count} is unreadable`);
    }
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    entries.set(name, { crc: bytes.readUInt32LE(cursor + 16), size: bytes.readUInt32LE(cursor + 24) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
