import * as zlib from 'node:zlib';
import { crc32 } from '../png.mjs';

// blank-docs.mjs imports zlib.crc32, which was added in Node 22.2.
export const writeZip = typeof zlib.crc32 === 'function'
  ? (await import('../blank-docs.mjs')).writeZip
  : writeClassicZip;

function writeClassicZip(entries) {
  const files = [];
  const central = [];
  let offset = 0;
  for (const [path, content] of entries) {
    const name = Buffer.from(path);
    const bytes = Buffer.from(content);
    const compressed = zlib.deflateRawSync(bytes, { level: 9 });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // UTF-8 names.
    local.writeUInt16LE(8, 8); // DEFLATE.
    local.writeUInt16LE(0x21, 12); // January 1, 1980.
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    local.copy(entry, 6, 4);
    entry.writeUInt32LE(offset, 42);
    files.push(local, name, compressed);
    central.push(entry, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}
