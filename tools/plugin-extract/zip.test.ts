import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readZipEntryNames, writeZip } from "./zip";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function archive(): string {
  const root = mkdtempSync(join(tmpdir(), "chemdraft-zip-"));
  roots.push(root);
  mkdirSync(join(root, "plugin", "src"), { recursive: true });
  writeFileSync(join(root, "plugin", "LICENSE"), "MIT\n");
  writeFileSync(join(root, "plugin", "src", "index.mjs"), "export const answer = 42;\n");
  const zipPath = join(root, "plugin.zip");
  writeZip(zipPath, root, ["plugin"]);
  return zipPath;
}

describe("readZipEntryNames", () => {
  it("lists every file of an intact archive", () => {
    expect(readZipEntryNames(archive())).toEqual(["plugin/LICENSE", "plugin/src/index.mjs"]);
  });

  it("rejects an entry whose bytes no longer match the recorded CRC-32", () => {
    const zipPath = archive();
    const bytes = readFileSync(zipPath);
    // Corrupt the CRC the central directory records for its first entry. The deflate streams are
    // untouched, so fflate alone still decompresses everything cleanly.
    const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const firstCentralEntry = bytes.readUInt32LE(eocd + 16);
    bytes.writeUInt32LE((bytes.readUInt32LE(firstCentralEntry + 16) ^ 0xffffffff) >>> 0, firstCentralEntry + 16);
    writeFileSync(zipPath, bytes);

    expect(() => readZipEntryNames(zipPath)).toThrow(/CRC-32/);
  });
});
