import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Mach-O packed versions use 16 bits for major and 8 bits each for minor and patch.
function minimumMacos(buffer: Buffer): number {
  if (buffer.length < 32 || buffer.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error("Expected a little-endian 64-bit Mach-O header");
  }
  const commandCount = buffer.readUInt32LE(16);
  const end = 32 + buffer.readUInt32LE(20);
  if (end > buffer.length) throw new Error("Truncated Mach-O load commands");
  let offset = 32;
  for (let index = 0; index < commandCount; index++) {
    if (offset + 8 > end) throw new Error("Truncated Mach-O load command");
    const command = buffer.readUInt32LE(offset);
    const size = buffer.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > end) throw new Error("Invalid Mach-O load command size");
    if (command === 0x32 || command === 0x24) {
      const versionOffset = command === 0x32 ? 12 : 8;
      if (size < versionOffset + 4) throw new Error("Truncated minimum version command");
      if (command === 0x32 && buffer.readUInt32LE(offset + 8) !== 1) {
        throw new Error("Mach-O build platform is not macOS");
      }
      return buffer.readUInt32LE(offset + versionOffset);
    }
    offset += size;
  }
  throw new Error("Mach-O has no minimum macOS version command");
}

function versionString(version: number): string {
  return `${version >>> 16}.${(version >>> 8) & 0xff}.${version & 0xff}`;
}

function packedVersion(version: string): number {
  const parts = version.split(".").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part, index) =>
    !Number.isInteger(part) || part < 0 || part > (index === 0 ? 0xffff : 0xff))) {
    throw new Error(`Invalid macOS version: ${version}`);
  }
  return parts[0] * 0x10000 + parts[1] * 0x100 + (parts[2] ?? 0);
}

describe("sidecar minimum macOS", () => {
  it.each([0x32, 0x24])("parses a synthetic version command %#", (command) => {
    const size = command === 0x32 ? 24 : 16;
    const buffer = Buffer.alloc(32 + size);
    buffer.writeUInt32LE(0xfeedfacf, 0);
    buffer.writeUInt32LE(1, 16);
    buffer.writeUInt32LE(size, 20);
    buffer.writeUInt32LE(command, 32);
    buffer.writeUInt32LE(size, 36);
    if (command === 0x32) buffer.writeUInt32LE(1, 40);
    buffer.writeUInt32LE(0x000b0203, command === 0x32 ? 44 : 40);
    expect(versionString(minimumMacos(buffer))).toBe("11.2.3");
  });

  it("does not exceed the app's declared minimum", () => {
    const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    const declared = config.bundle.macOS.minimumSystemVersion as string;
    expect(declared).toBe("11.0");
    const binary = readFileSync(new URL("../src-tauri/binaries/avogadro3d-sidecar-aarch64-apple-darwin", import.meta.url));
    const actual = minimumMacos(binary);
    expect(actual, `Sidecar requires macOS ${versionString(actual)}; app declares ${declared}`).toBeLessThanOrEqual(packedVersion(declared));
  });
});
