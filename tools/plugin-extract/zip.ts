/**
 * Zip archives for plugin distributions, written and read in-process.
 *
 * Both tools used to shell out to `zip` (and their tests to `unzip`), which Windows does not ship.
 * fflate (MIT, pure JS) makes the archive identical in shape on every platform: entry names are
 * `/`-separated paths relative to `cwd`, sorted, files only — the layout `zip -X -r` produced.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * Entry names of `zipPath`, after decompressing every entry — so a truncated or corrupt archive
 * throws here rather than listing cleanly (the check `unzip -t` used to provide).
 */
export function readZipEntryNames(zipPath: string): string[] {
  return Object.keys(unzipSync(readFileSync(zipPath))).sort();
}
