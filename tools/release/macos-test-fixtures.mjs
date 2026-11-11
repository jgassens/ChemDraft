import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Small synthetic artifact bytes signed with an in-memory, throwaway key.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
export const dmgBytes = Buffer.from("synthetic DMG bytes: never mounted by tests");
export const sparklePublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
export const sparkleSignature = sign(null, dmgBytes, privateKey).toString("base64");

export function signedDmg(t, name) {
  const folder = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".dmg-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, name);
  writeFileSync(file, dmgBytes);
  return file;
}

// Synthetic headers only; tests never need a JDK or compiler.
export function thinMachO(architecture = "x86_64", minimum = 0x000b0000, command = 0x32) {
  const size = command === 0x32 ? 24 : 16;
  const buffer = Buffer.alloc(32 + size);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  buffer.writeUInt32LE(1, 16);
  buffer.writeUInt32LE(size, 20);
  buffer.writeUInt32LE(command, 32);
  buffer.writeUInt32LE(size, 36);
  if (command === 0x32) buffer.writeUInt32LE(1, 40);
  buffer.writeUInt32LE(minimum, command === 0x32 ? 44 : 40);
  return buffer;
}

export function fatMachO(buffers, { little = false, wide = false } = {}) {
  const entrySize = wide ? 32 : 20;
  let offset = 8 + buffers.length * entrySize;
  const result = Buffer.alloc(offset + buffers.reduce((sum, buffer) => sum + buffer.length, 0));
  result.writeUInt32BE(wide ? (little ? 0xbfbafeca : 0xcafebabf) : (little ? 0xbebafeca : 0xcafebabe), 0);
  const u32 = (value, at) => little ? result.writeUInt32LE(value, at) : result.writeUInt32BE(value, at);
  const u64 = (value, at) => little ? result.writeBigUInt64LE(BigInt(value), at) : result.writeBigUInt64BE(BigInt(value), at);
  u32(buffers.length, 4);
  buffers.forEach((buffer, index) => {
    const entry = 8 + index * entrySize;
    u32(buffer.readUInt32LE(4), entry);
    (wide ? u64 : u32)(offset, entry + 8);
    (wide ? u64 : u32)(buffer.length, entry + (wide ? 16 : 12));
    buffer.copy(result, offset);
    offset += buffer.length;
  });
  return result;
}
