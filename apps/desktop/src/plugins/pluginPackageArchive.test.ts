import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ZIP64_SENTINEL_16, ZIP64_SENTINEL_32, createZipFixture, sidecarFor, tamperByte } from "../testSupport/zipFixture";
import {
  DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS,
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
    const zip = await createZipFixture([{ path: "entry.js", content: "abc", sizeOverride: 100 }]);
    await expectPackageError(readPluginPackageArchive(zip), PluginPackageErrorCodes.CorruptEntry);
  });

  it("stops a deflate stream that expands beyond its declared size", async () => {
    const zip = await createZipFixture([
      { path: "entry.js", content: "A".repeat(100_000), deflate: true, sizeOverride: 1 }
    ]);
    const error = await expectPackageError(readPluginPackageArchive(zip), PluginPackageErrorCodes.CorruptEntry);
    expect(error.message).toContain("expands beyond its declared 1-byte size");
  });

  it("enforces the compressed archive byte limit before parsing", async () => {
    const zip = await createZipFixture([{ path: "entry.js", content: "abc" }]);
    const limits = { ...DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS, maxCompressedBytes: zip.byteLength - 1 };

    const error = await expectPackageError(
      readPluginPackageArchive(zip, limits),
      PluginPackageErrorCodes.ResourceLimitExceeded
    );
    expect(error.message).toContain("compressed bytes");
  });

  it("enforces the central-directory entry-count limit", async () => {
    const zip = await createZipFixture([
      { path: "one.js", content: "1" },
      { path: "two.js", content: "2" },
      { path: "three.js", content: "3" }
    ]);
    const limits = { ...DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS, maxEntryCount: 2 };

    const error = await expectPackageError(
      readPluginPackageArchive(zip, limits),
      PluginPackageErrorCodes.ResourceLimitExceeded
    );
    expect(error.message).toContain("3 archive entries");
  });

  it("enforces per-entry and total uncompressed limits from metadata before inflation", async () => {
    const oversizedEntry = await createZipFixture([{ path: "entry.js", content: "12345" }]);
    const perEntryLimits = { ...DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS, maxEntryUncompressedBytes: 4 };
    let error = await expectPackageError(
      readPluginPackageArchive(oversizedEntry, perEntryLimits),
      PluginPackageErrorCodes.ResourceLimitExceeded
    );
    expect(error.message).toContain("per-entry limit");

    const oversizedTotal = await createZipFixture([
      { path: "one.js", content: "1234" },
      { path: "two.js", content: "5678" }
    ]);
    const totalLimits = { ...DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS, maxTotalUncompressedBytes: 7 };
    error = await expectPackageError(
      readPluginPackageArchive(oversizedTotal, totalLimits),
      PluginPackageErrorCodes.ResourceLimitExceeded
    );
    expect(error.message).toContain("total limit");
  });

  it("validates the complete archive's limits before inflating an earlier entry", async () => {
    const zip = await createZipFixture([
      // If the reader inflates as it scans, this deliberately bad CRC would win. The later total-size
      // violation must be found first so no decompressor sees attacker-controlled bytes prematurely.
      { path: "first.js", content: "1234", deflate: true, crcOverride: 0x12345678 },
      { path: "second.js", content: "5678" }
    ]);
    const limits = { ...DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS, maxTotalUncompressedBytes: 7 };

    const error = await expectPackageError(
      readPluginPackageArchive(zip, limits),
      PluginPackageErrorCodes.ResourceLimitExceeded
    );
    expect(error.message).toContain("total limit");
  });

  it("rejects excessive compression ratios before decompression", async () => {
    const zip = await createZipFixture([
      { path: "entry.js", content: "repeated source line\n".repeat(2_000), deflate: true }
    ]);
    const limits = { ...DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS, maxCompressionRatio: 2 };

    const error = await expectPackageError(
      readPluginPackageArchive(zip, limits),
      PluginPackageErrorCodes.ResourceLimitExceeded
    );
    expect(error.message).toContain("compression ratio");
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

  // "Zip64 fails closed and loudly" is a headline safety property of this reader: every 32-bit field
  // below can carry a sentinel meaning "the real value lives in a Zip64 extra field", and silently
  // treating a sentinel as a real length/offset is how a reader ends up doing arithmetic on 0xffffffff.
  // Each guard is driven independently so one still-working guard cannot mask a broken one.
  it("refuses a Zip64 end-of-central-directory locator", async () => {
    const zip = await createZipFixture([{ path: "entry.js", content: "abc" }], { zip64Locator: true });
    const error = await expectPackageError(readPluginPackageArchive(zip), PluginPackageErrorCodes.UnsupportedArchive);
    expect(error.message).toContain("Zip64");
  });

  it("refuses the Zip64 entry-count and central-directory-offset sentinels in the EOCD", async () => {
    const withEntryCountSentinel = await createZipFixture([{ path: "entry.js", content: "abc" }], {
      entryCountOverride: ZIP64_SENTINEL_16
    });
    expect(
      (await expectPackageError(readPluginPackageArchive(withEntryCountSentinel), PluginPackageErrorCodes.UnsupportedArchive))
        .message
    ).toContain("Zip64");

    const withOffsetSentinel = await createZipFixture([{ path: "entry.js", content: "abc" }], {
      centralDirectoryOffsetOverride: ZIP64_SENTINEL_32
    });
    expect(
      (await expectPackageError(readPluginPackageArchive(withOffsetSentinel), PluginPackageErrorCodes.UnsupportedArchive)).message
    ).toContain("Zip64");
  });

  it("refuses a Zip64 sentinel in an entry's sizes or local-header offset", async () => {
    for (const override of [
      { compressedSizeOverride: ZIP64_SENTINEL_32 },
      { sizeOverride: ZIP64_SENTINEL_32 },
      { localHeaderOffsetOverride: ZIP64_SENTINEL_32 }
    ]) {
      const zip = await createZipFixture([{ path: "entry.js", content: "abc", ...override }]);
      const error = await expectPackageError(readPluginPackageArchive(zip), PluginPackageErrorCodes.UnsupportedArchive);
      expect(error.message, JSON.stringify(override)).toContain("Zip64");
    }
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
