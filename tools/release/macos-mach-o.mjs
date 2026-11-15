// Shared, dependency-free Mach-O checks for OPSIN staging and macOS release validation.
const CPU_NAMES = new Map([[0x01000007, "x86_64"], [0x0100000c, "arm64"]]);
const MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

export function isMachO(buffer) {
  return buffer.length >= 4 && MAGICS.has(buffer.readUInt32BE(0));
}

export function targetArchitecture(target) {
  const architecture = { "aarch64-apple-darwin": "arm64", "x86_64-apple-darwin": "x86_64", arm64: "arm64", x86_64: "x86_64", x64: "x86_64" }[target];
  if (!architecture) throw new Error(`Unsupported macOS target: ${target}`);
  return architecture;
}

export function packedVersion(version) {
  const parts = String(version).split(".").map(Number);
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(String(version)) || parts.some((part, index) => !Number.isInteger(part) || part > (index === 0 ? 0xffff : 0xff))) {
    throw new Error(`Invalid macOS version: ${version}`);
  }
  return parts[0] * 0x10000 + parts[1] * 0x100 + (parts[2] ?? 0);
}

export function versionString(version) {
  return `${version >>> 16}.${(version >>> 8) & 0xff}.${version & 0xff}`;
}

// Load-command parsing follows apps/desktop/src/sidecarMinimumMacos.test.ts. Fat containers
// are also decoded because Sparkle ships universal frameworks and helper executables.
export function machOSlices(buffer) {
  if (!isMachO(buffer)) throw new Error("Expected Mach-O, found a placeholder or non-native file");
  const magic = buffer.readUInt32BE(0);
  if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
    if (buffer.length < 8) throw new Error("Truncated fat Mach-O header");
    const little = [0xbebafeca, 0xbfbafeca].includes(magic);
    const wide = [0xcafebabf, 0xbfbafeca].includes(magic);
    const u32 = (offset) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const u64 = (offset) => Number(little ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset));
    const count = u32(4);
    const entrySize = wide ? 32 : 20;
    const tableEnd = 8 + count * entrySize;
    if (!count || tableEnd > buffer.length) throw new Error("Invalid fat Mach-O slice table");
    const slices = [];
    const ranges = [];
    for (let index = 0; index < count; index++) {
      const entry = 8 + index * entrySize;
      const offset = wide ? u64(entry + 8) : u32(entry + 8);
      const size = wide ? u64(entry + 16) : u32(entry + 12);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size < 32 || offset < tableEnd || offset + size > buffer.length || ranges.some(([start, end]) => offset < end && offset + size > start)) {
        throw new Error("Invalid fat Mach-O slice bounds");
      }
      const thin = buffer.subarray(offset, offset + size);
      if (thin.readUInt32LE(0) !== 0xfeedfacf) throw new Error("Expected a little-endian 64-bit Mach-O slice");
      const [slice] = machOSlices(thin);
      if (CPU_NAMES.get(u32(entry)) !== slice.architecture || slices.some((other) => other.architecture === slice.architecture)) throw new Error("Invalid fat Mach-O CPU table");
      slices.push(slice);
      ranges.push([offset, offset + size]);
    }
    return slices;
  }
  if (buffer.length < 32 || buffer.readUInt32LE(0) !== 0xfeedfacf) throw new Error("Expected a little-endian 64-bit Mach-O header");
  const architecture = CPU_NAMES.get(buffer.readUInt32LE(4));
  if (!architecture) throw new Error("Unsupported Mach-O CPU type");
  const commandCount = buffer.readUInt32LE(16);
  const end = 32 + buffer.readUInt32LE(20);
  if (end > buffer.length) throw new Error("Truncated Mach-O load commands");
  let offset = 32;
  let minimum;
  for (let index = 0; index < commandCount; index++) {
    if (offset + 8 > end) throw new Error("Truncated Mach-O load command");
    const command = buffer.readUInt32LE(offset);
    const size = buffer.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > end) throw new Error("Invalid Mach-O load command size");
    if (command === 0x32 || command === 0x24) {
      const versionOffset = command === 0x32 ? 12 : 8;
      if (size < (command === 0x32 ? 24 : 16)) throw new Error("Truncated minimum version command");
      if (command === 0x32 && buffer.readUInt32LE(offset + 8) !== 1) throw new Error("Mach-O build platform is not macOS");
      minimum = Math.max(minimum ?? 0, buffer.readUInt32LE(offset + versionOffset));
    }
    offset += size;
  }
  if (offset !== end) throw new Error("Invalid Mach-O load command count");
  return [{ architecture, minimum }];
}

export function assertMachOArchitecture(buffer, target, label = "Mach-O", { allowUniversal = false } = {}) {
  const expected = targetArchitecture(target);
  const slices = machOSlices(buffer);
  if (!slices.some((slice) => slice.architecture === expected) || (!allowUniversal && slices.length !== 1)) {
    throw new Error(`${label}: expected ${expected}${allowUniversal ? " slice" : " only"}, found ${slices.map((slice) => slice.architecture).join(", ")}`);
  }
  return slices;
}
