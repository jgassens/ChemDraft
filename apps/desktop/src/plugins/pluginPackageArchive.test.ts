import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createZipFixture, sidecarFor, tamperByte } from "../testSupport/zipFixture";
import {
  PluginPackageError,
  PluginPackageErrorCodes,
  crc32,
  parseChecksumSidecar,
  readPluginPackageArchive,
  safeEntryPath,
  sha256Hex,
  verifyPackageChecksum
} from "./pluginPackageArchive";

/** The real artifact `plugin:package` emits. A build output (gitignored), so tests using it skip when absent. */
const realPackagePath = fileURLToPath(
  new URL("../../../../dist/plugin-packages/mass-fragment-demo-0.0.0.zip", import.meta.url)
);
const hasRealPackage = existsSync(realPackagePath);

async function expectPackageError(promise: Promise<unknown>, code: string): Promise<PluginPackageError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause
  );
  expect(error, "expected the archive to be refused").toBeInstanceOf(PluginPackageError);
  expect((error as PluginPackageError).code).toBe(code);
  return error as PluginPackageError;
}

describe("readPluginPackageArchive", () => {
  it("reads stored and deflated entries, skipping directory entries", async () => {
    const zip = await createZipFixture([
      { path: "manifest.json", content: '{"id":"x"}' },
      { path: "assets/", directory: true },
      { path: "assets/worker.js", content: "export const worker = 1;\n".repeat(200), deflate: true },
      { path: "entry.js", content: "export const entry = 1;" }
    ]);

    const entries = await readPluginPackageArchive(zip);

    expect(entries.map((entry) => entry.path)).toEqual(["manifest.json", "assets/worker.js", "entry.js"]);
    expect(new TextDecoder().decode(entries[0].bytes)).toBe('{"id":"x"}');
    expect(new TextDecoder().decode(entries[1].bytes)).toBe("export const worker = 1;\n".repeat(200));
  });

  it("refuses an entry whose CRC-32 does not match — integrity is checked with or without a sidecar", async () => {
    const zip = await createZipFixture([{ path: "entry.js", content: "export const entry = 1;", crcOverride: 0x12345678 }]);

    const error = await expectPackageError(readPluginPackageArchive(zip), PluginPackageErrorCodes.CorruptEntry);
    expect(error.message).toContain("CRC-32");
    expect(error.message).toContain("entry.js");
  });

  it("refuses an entry whose declared length disagrees with its contents", async () => {
    const zip = await createZipFixture([{ path: "entry.js", content: "abc", sizeOverride: 999 }]);
    await expectPackageError(readPluginPackageArchive(zip), PluginPackageErrorCodes.CorruptEntry);
  });

  it("refuses an encrypted entry rather than producing garbage", async () => {
    const zip = await createZipFixture([{ path: "entry.js", content: "abc", flags: 0x0001 }]);
    const error = await expectPackageError(readPluginPackageArchive(zip), PluginPackageErrorCodes.UnsupportedArchive);
    expect(error.message).toContain("encrypted");
  });

  it("refuses a compression method it cannot read", async () => {
    const zip = await createZipFixture([{ path: "entry.js", content: "abc", methodOverride: 14 }]);
    const error = await expectPackageError(readPluginPackageArchive(zip), PluginPackageErrorCodes.UnsupportedArchive);
    expect(error.message).toContain("compression method 14");
  });

  it("refuses a file that is not a zip, and one that is truncated", async () => {
    await expectPackageError(
      readPluginPackageArchive(new TextEncoder().encode("this is definitely not a zip archive at all")),
      PluginPackageErrorCodes.MalformedArchive
    );
    await expectPackageError(readPluginPackageArchive(new Uint8Array(4)), PluginPackageErrorCodes.MalformedArchive);

    // Losing the trailing EOCD is the classic truncated download.
    const zip = await createZipFixture([{ path: "entry.js", content: "abc" }]);
    await expectPackageError(readPluginPackageArchive(zip.slice(0, zip.byteLength - 10)), PluginPackageErrorCodes.MalformedArchive);
  });

  it("refuses a duplicated entry, whose contents would otherwise be ambiguous", async () => {
    const zip = await createZipFixture([
      { path: "entry.js", content: "first" },
      { path: "entry.js", content: "second" }
    ]);
    const error = await expectPackageError(readPluginPackageArchive(zip), PluginPackageErrorCodes.MalformedArchive);
    expect(error.message).toContain("more than once");
  });

  it("refuses an empty archive", async () => {
    const zip = await createZipFixture([]);
    await expectPackageError(readPluginPackageArchive(zip), PluginPackageErrorCodes.MalformedArchive);
  });

  // Criterion 7: a package must never write outside its staging directory.
  it("refuses every shape of path-traversal entry", async () => {
    for (const hostile of [
      "../../../../etc/passwd",
      "assets/../../../etc/passwd",
      "/etc/passwd",
      "..\\..\\Windows\\System32\\evil.dll",
      "C:\\Windows\\evil.dll"
    ]) {
      const zip = await createZipFixture([{ path: hostile, content: "pwned" }]);
      await expectPackageError(readPluginPackageArchive(zip), PluginPackageErrorCodes.UnsafeEntryPath);
    }
  });
});

describe("safeEntryPath", () => {
  it("accepts ordinary package paths and normalizes harmless noise", () => {
    expect(safeEntryPath("entry.js")).toBe("entry.js");
    expect(safeEntryPath("assets/worker-BcY5tkZR.js")).toBe("assets/worker-BcY5tkZR.js");
    // `.` and doubled separators do not change where a file lands, so they are cleaned rather than refused.
    expect(safeEntryPath("./assets//worker.js")).toBe("assets/worker.js");
  });

  it("refuses anything that could escape, including via a backslash separator", () => {
    for (const hostile of ["../x", "a/../../x", "/abs", "C:/x", "..\\x", "a\\..\\..\\x", "\0", "a\0b"]) {
      expect(() => safeEntryPath(hostile), hostile).toThrow(PluginPackageError);
    }
    expect(() => safeEntryPath("")).toThrow(PluginPackageError);
  });
});

describe("checksums", () => {
  it("verifies a matching sidecar and refuses a tampered archive", async () => {
    const zip = await createZipFixture([{ path: "entry.js", content: "export const entry = 1;" }]);
    const sidecar = await sidecarFor(zip);

    await expect(verifyPackageChecksum(zip, sidecar)).resolves.toBeUndefined();

    // Criterion 3: flip a byte. Target the stored file data, so the archive still parses and only the
    // checksum betrays it — the realistic corruption case.
    const tampered = tamperByte(zip, 40);
    const error = await expectPackageError(verifyPackageChecksum(tampered, sidecar), PluginPackageErrorCodes.ChecksumMismatch);
    expect(error.message).toContain("does not match its .sha256 checksum");
  });

  it("refuses a sidecar with no digest in it", async () => {
    const zip = await createZipFixture([{ path: "entry.js", content: "abc" }]);
    await expectPackageError(verifyPackageChecksum(zip, "not a checksum\n"), PluginPackageErrorCodes.ChecksumMismatch);
    expect(() => parseChecksumSidecar("garbage")).toThrow(PluginPackageError);
  });

  it("parses a shasum-format sidecar", () => {
    const digest = "9d83a901d94764d60bc4ba2c7aaf1bac90f9b8fc5e5577cd9aaeac182a56d8c9";
    expect(parseChecksumSidecar(`${digest}  mass-fragment-demo-0.0.0.zip\n`)).toBe(digest);
    expect(parseChecksumSidecar(`${digest.toUpperCase()}  x.zip`)).toBe(digest);
  });

  it("computes a known SHA-256", async () => {
    // The canonical empty-string digest: proves the hex encoding, not just self-consistency.
    expect(await sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("crc32", () => {
  it("matches the standard check value", () => {
    // The reference vector: CRC-32("123456789") == 0xCBF43926.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

// Proving the reader against the artifact M36 must actually install — not only against fixtures the
// same test file invented. Skipped when the package has not been built (dist/ is gitignored); build it
// with `pnpm plugin:package -- examples/plugins/mass-fragment-demo`.
describe.skipIf(!hasRealPackage)("the real mass-fragment-demo package", () => {
  it("unpacks, verifies against its own sidecar, and carries the mass analyzer's manifest", async () => {
    const zip = new Uint8Array(readFileSync(realPackagePath));
    const sidecar = readFileSync(`${realPackagePath}.sha256`, "utf8");

    // The sidecar digest describes the artifact's actual bytes. (No pinned constant: the zip embeds
    // its sourceCommit, so the digest legitimately changes with every commit.)
    await expect(verifyPackageChecksum(zip, sidecar)).resolves.toBeUndefined();
    expect(await sha256Hex(zip)).toBe(parseChecksumSidecar(sidecar));

    const entries = await readPluginPackageArchive(zip);
    const paths = entries.map((entry) => entry.path).sort();
    expect(paths).toContain("manifest.json");
    expect(paths).toContain("entry.js");
    expect(paths).toContain("LICENSE");

    const manifest = JSON.parse(new TextDecoder().decode(entries.find((entry) => entry.path === "manifest.json")!.bytes));
    expect(manifest.id).toBe("org.chemdraft.mass.fragment");
    expect(manifest.entry).toBe("entry.js");
    expect(manifest.permissions).toEqual(["selection.read", "analysis.write", "ui.menu", "ui.panel"]);
  });
});
