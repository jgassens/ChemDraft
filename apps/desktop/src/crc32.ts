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

/** Standard CRC-32, as used by PNG and ZIP. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
