import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { formatToolPin, hostToolPins, parityCommand, parityPlatformMessage, parseClaudeLatestVersion, pinDiff, singleArchiveEntryName, validateArchiveEntry, zipArchiveEntryNames } from "./pin-external-tools.mjs";

describe("external tool pin script", () => {
  it("selects both host binaries on macOS and Windows and skips unsupported hosts", () => {
    const pins = ["DarwinArm64", "DarwinX64", "WindowsX64"].flatMap((platform) =>
      ["Claude", "Codex"].map((tool) => ({ tool, platform })));
    for (const [platform, arch, expected] of [
      ["darwin", "arm64", "DarwinArm64"],
      ["darwin", "x64", "DarwinX64"],
      ["win32", "x64", "WindowsX64"]
    ]) {
      expect(hostToolPins(pins, platform, arch)).toEqual(pins.filter((pin) => pin.platform === expected));
    }
    expect(hostToolPins(pins, "linux", "x64")).toEqual([]);
    expect(hostToolPins(pins, "win32", "arm64")).toEqual([]);
    expect(hostToolPins(pins.filter((pin) => pin.tool === "Codex"), "darwin", "arm64")).toEqual([{ tool: "Codex", platform: "DarwinArm64" }]);
  });

  it("constructs the cargo parity command with verified paths and preserves the login environment", () => {
    const command = parityCommand({ Claude: "C:\\Temp Dir\\claude.exe", Codex: "C:\\Temp Dir\\codex.exe" }, {
      HOME: "/real home", CLAUDE_CONFIG_DIR: "/real config", USERPROFILE: "C:\\Users\\Chemist", PATH: "cargo-path",
      CHEMDRAFT_PINNED_CLAUDE: "unverified", chemdraft_pinned_codex: "unverified"
    });
    expect(command.command).toBe("cargo");
    expect(command.args).toEqual(["test", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml", "pinned_", "--", "--include-ignored", "--nocapture"]);
    expect(command.options).toMatchObject({ shell: false, stdio: "inherit", env: {
      HOME: "/real home", CLAUDE_CONFIG_DIR: "/real config", USERPROFILE: "C:\\Users\\Chemist", PATH: "cargo-path",
      CHEMDRAFT_PINNED_CLAUDE: "C:\\Temp Dir\\claude.exe", CHEMDRAFT_PINNED_CODEX: "C:\\Temp Dir\\codex.exe"
    } });
    expect(command.options.cwd).toBe(fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, ""));
    expect(command.options.env).not.toHaveProperty("chemdraft_pinned_codex");
  });

  it("states which platform was checked and which still needs a parity run", () => {
    expect(parityPlatformMessage("darwin", "arm64")).toBe("Pinned CLI parity checked on host macOS (darwin-arm64); NOT checked on Windows. Run --check on a Windows host too.");
    expect(parityPlatformMessage("win32", "x64")).toBe("Pinned CLI parity checked on host Windows (win32-x64); NOT checked on macOS. Run --check on a macOS host too.");
    expect(parityPlatformMessage("linux", "x64")).toBe("Pinned CLI parity checked on host linux-x64 (no supported desktop platform); NOT checked on macOS and Windows. Run --check on macOS and Windows hosts too.");
  });

  it("does not inherit a parity binary for a tool absent on the host", () => {
    expect(parityCommand({ Codex: "/verified/codex" }, {
      CHEMDRAFT_PINNED_CLAUDE: "/unverified/claude", CHEMDRAFT_PINNED_CODEX: "/unverified/codex"
    }).options.env).toEqual({ CHEMDRAFT_PINNED_CODEX: "/verified/codex" });
  });
  it("formats a ToolPin exactly as pins.rs does", () => {
    expect(formatToolPin({ tool: "Claude", platform: "DarwinArm64", version: "CLAUDE_VERSION", url: "https://example.test/claude", size: 42, sha256: "abc", archive: "Raw", entry: "claude", binary: "claude" })).toBe(`    ToolPin {\n        tool: ToolId::Claude,\n        platform: ToolPlatform::DarwinArm64,\n        version: CLAUDE_VERSION,\n        url: "https://example.test/claude",\n        size: 42,\n        sha256: "abc",\n        archive: ArchiveKind::Raw,\n        entry: "claude",\n        binary: "claude",\n    },`);
  });

  it("parses the plain-text Claude latest version and rejects JSON or malformed versions", () => {
    expect(parseClaudeLatestVersion("2.1.308\n")).toBe("2.1.308");
    expect(() => parseClaudeLatestVersion('{"version":"2.1.308"}')).toThrow("Invalid Claude latest version.");
    expect(() => parseClaudeLatestVersion("2.1")).toThrow("Invalid Claude latest version.");
  });

  it("validates one-entry tar.gz and zip archives", () => {
    const header = Buffer.alloc(512);
    header.write("codex", 0); header.write("0000755\0", 100); header.write("00000000001\0", 124);
    header[156] = 48; header.write("ustar\0", 257); header.write("00", 263);
    header.fill(32, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    expect(singleArchiveEntryName("tar.gz", gzipSync(Buffer.concat([header, Buffer.from("x"), Buffer.alloc(511), Buffer.alloc(1024)])))).toBe("codex");
    header.write("ustar ", 257); header.write("00000000001\0", 345);
    header.fill(32, 148, 156);
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
    expect(singleArchiveEntryName("tar.gz", gzipSync(Buffer.concat([header, Buffer.from("x"), Buffer.alloc(511), Buffer.alloc(1024)])))).toBe("codex");
    expect(singleArchiveEntryName("zip", zip(["codex"]))).toBe("codex");
  });

  it("reads streaming ZIPs with descriptors, comments, and ZIP64 directories", () => {
    expect(singleArchiveEntryName("zip", zip(["codex"], true))).toBe("codex");
    const commented = zip(["codex"]);
    commented.writeUInt16LE(65535, commented.length - 2);
    expect(singleArchiveEntryName("zip", Buffer.concat([commented, Buffer.alloc(65535)]))).toBe("codex");
    expect(() => singleArchiveEntryName("zip", Buffer.alloc(10))).toThrow("central directory");
    expect(() => singleArchiveEntryName("zip", zip(["a", "b"]))).toThrow("found 2");
  });

  it("validates that a tree contains the packaged main executable", () => {
    const bytes = zip(["codex.exe", "codex-resources/runner.exe"]);
    expect(zipArchiveEntryNames(bytes)).toEqual(["codex.exe", "codex-resources/runner.exe"]);
    expect(() => validateArchiveEntry("ZipTree", bytes, "codex.exe")).not.toThrow();
    expect(() => validateArchiveEntry("ZipTree", bytes, "absent.exe")).toThrow("missing");
  });

  it("reports a pin difference", () => {
    const current = 'pub const CLAUDE_VERSION: &str = "1";\npub const CODEX_TAG: &str = "rust-v1";\npub const CODEX_VERSION: &str = "1";\npub const PINS: [ToolPin; 6] = [\n];';
    expect(pinDiff(current, "new")).toBe("Published external-tool pins differ from pins.rs.");
    expect(pinDiff(`prefix\n${current}`, current)).toBe("");
  });

  it("keeps the compared pins.rs block limited to pin declarations and ToolPin rows", () => {
    const pins = readFileSync(new URL("../apps/desktop/src-tauri/src/external_tools/pins.rs", import.meta.url), "utf8");
    const block = pins.match(/pub const CLAUDE_VERSION:[\s\S]*?^\];$/m)?.[0];
    expect(block).toBeDefined();

    const allowedLine = /^(?:pub const (?:CLAUDE_VERSION|CODEX_TAG|CODEX_VERSION): &str = ".*";|pub const PINS: \[ToolPin; 6\] = \[|ToolPin \{|tool: ToolId::(?:Claude|Codex),|platform: ToolPlatform::(?:DarwinArm64|DarwinX64|WindowsX64),|version: (?:CLAUDE_VERSION|CODEX_VERSION),|url: ".*",|size: \d+,|sha256: ".*",|archive: ArchiveKind::(?:Raw|TarGz|Zip|ZipTree),|entry: ".*",|binary: ".*",|\},|\];)$/;
    const unexpectedLines = block!.split("\n").filter((line) => !allowedLine.test(line.trim()));
    expect(unexpectedLines).toEqual([]);
  });
});

// Streaming entries have zero CRC/sizes in the local header and a signed descriptor.
function zip(names: string[], zip64 = false): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const payload = deflateRawSync(Buffer.from("payload"));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc32(Buffer.from("payload")), 4);
    descriptor.writeUInt32LE(payload.length, 8); descriptor.writeUInt32LE(7, 12);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(Buffer.from("payload")), 16);
    central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(7, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    const entry = Buffer.concat([local, Buffer.from(name), payload, descriptor]);
    locals.push(entry); directory.push(central, Buffer.from(name)); offset += entry.length;
  }
  const central = Buffer.concat(directory);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(names.length, 8); eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(offset, 16);
  const records: Buffer[] = [];
  if (zip64) {
    const record = Buffer.alloc(56); record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(BigInt(names.length), 24); record.writeBigUInt64LE(BigInt(names.length), 32);
    record.writeBigUInt64LE(BigInt(central.length), 40); record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset + central.length), 8);
    locator.writeUInt32LE(1, 16); records.push(record, locator);
    eocd.writeUInt16LE(0xffff, 8); eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12); eocd.writeUInt32LE(0xffffffff, 16);
  }
  return Buffer.concat([...locals, central, ...records, eocd]);
}
