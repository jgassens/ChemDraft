import { inflateSync } from 'node:zlib';
import { chunks } from '../png.mjs';

const CHANNELS = { 0: 1, 2: 3, 3: 1, 6: 4 };
const MAX_PIXELS = 16 * 1024 * 1024;
const GRAPHICS_VERSION = 0xdbc01002;

function paeth(left, up, corner) {
  const prediction = left + up - corner;
  const a = Math.abs(prediction - left);
  const b = Math.abs(prediction - up);
  const c = Math.abs(prediction - corner);
  return a <= b && a <= c ? left : b <= c ? up : corner;
}

const FILTERS = [() => 0, left => left, (_, up) => up,
  (left, up) => (left + up) >>> 1, paeth];

/** Decode noninterlaced 8-bit PNG pixels in top-down RGBA order. */
export function decodePng(png) {
  const parts = chunks(png);
  const header = parts[0].data;
  if (header.length !== 13) throw new Error('Invalid PNG IHDR length');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const color = header[9];
  const channels = CHANNELS[color];
  if (header[8] !== 8 || !channels || header[10] || header[11] || header[12]) {
    throw new Error('Unsupported PNG: expected noninterlaced 8-bit grayscale, RGB, palette, or RGBA');
  }
  if (!width || !height || width * height > MAX_PIXELS) {
    throw new Error('Invalid PNG dimensions or raster exceeds 16 Mi pixels');
  }

  const compressed = [];
  let palette, transparency, endedIdat = false;
  for (const { type, data } of parts.slice(1)) {
    if (type === 'IDAT') {
      if (endedIdat) throw new Error('PNG IDAT chunks must be consecutive');
      compressed.push(data);
      continue;
    }
    endedIdat ||= compressed.length > 0;
    if (type === 'PLTE') {
      if (palette || endedIdat || color === 0 || !data.length || data.length % 3 || data.length > 768) {
        throw new Error('Invalid PNG PLTE');
      }
      palette = data;
    } else if (type === 'tRNS') {
      if (transparency || endedIdat ||
          (color === 3 ? !palette || !data.length || data.length > palette.length / 3 :
            ![0, 2].includes(color) || data.length !== channels * 2)) {
        throw new Error('Invalid PNG tRNS');
      }
      transparency = data;
    } else if (type === 'IEND') {
      if (data.length) throw new Error('Invalid PNG IEND');
    } else if (/^[A-Z]/.test(type) || ['acTL', 'fcTL', 'fdAT'].includes(type)) {
      throw new Error(`Unsupported PNG chunk ${type}`);
    }
  }
  if (color === 3 && !palette) throw new Error('Missing PNG PLTE for indexed pixels');
  if (!compressed.length) throw new Error('Missing PNG IDAT');

  const stride = width * channels;
  const rowSize = stride + 1;
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: rowSize * height });
  if (raw.length !== rowSize * height) throw new Error('Invalid PNG scanline size');

  const rgba = Buffer.alloc(width * height * 4);
  const transparentSamples = color !== 3 && transparency
    ? Array.from({ length: channels }, (_, index) => transparency.readUInt16BE(index * 2))
    : [];
  let dest = 0;
  for (let y = 0; y < height; y++) {
    const row = y * rowSize + 1;
    const filter = FILTERS[raw[row - 1]];
    if (!filter) throw new Error(`Unsupported PNG filter ${raw[row - 1]}`);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? raw[row + x - channels] : 0;
      const up = y ? raw[row + x - rowSize] : 0;
      const corner = y && x >= channels ? raw[row + x - rowSize - channels] : 0;
      raw[row + x] += filter(left, up, corner);
    }
    for (let x = 0; x < stride; x += channels) {
      const at = row + x;
      const sample = raw[at];
      let r = sample, g = sample, b = sample, alpha = 255;
      if (color === 3) {
        if (sample * 3 >= palette.length) throw new Error('PNG palette index out of range');
        r = palette[sample * 3];
        g = palette[sample * 3 + 1];
        b = palette[sample * 3 + 2];
        alpha = transparency?.[sample] ?? 255;
      } else if (color === 0) {
        if (sample === transparentSamples[0]) alpha = 0;
      } else {
        g = raw[at + 1];
        b = raw[at + 2];
        if (color === 6) alpha = raw[at + 3];
        else if (r === transparentSamples[0] && g === transparentSamples[1] && b === transparentSamples[2]) alpha = 0;
      }
      rgba[dest++] = r;
      rgba[dest++] = g;
      rgba[dest++] = b;
      rgba[dest++] = alpha;
    }
  }
  return { width, height, rgba };
}

function plusRecord(type, flags, data = Buffer.alloc(0)) {
  const record = Buffer.alloc(12 + Math.ceil(data.length / 4) * 4);
  record.writeUInt16LE(type);
  record.writeUInt16LE(flags, 2);
  record.writeUInt32LE(record.length, 4);
  record.writeUInt32LE(data.length, 8);
  data.copy(record, 12);
  return record;
}

function record(type, size) {
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(type);
  bytes.writeUInt32LE(size, 4);
  return bytes;
}

function plusComment(png, width, height, dpi) {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(GRAPHICS_VERSION);
  header.writeUInt32LE(1, 4); // Display device.
  header.writeUInt32LE(Math.round(dpi), 8);
  header.writeUInt32LE(Math.round(dpi), 12);

  const bitmap = Buffer.alloc(28);
  bitmap.writeUInt32LE(GRAPHICS_VERSION);
  bitmap.writeUInt32LE(1, 4); // ImageDataTypeBitmap.
  // Dimensions, stride, and pixel format are supplied by the encoded image.
  bitmap.writeUInt32LE(1, 24); // BitmapDataTypeCompressed.

  const draw = Buffer.alloc(40);
  draw.writeUInt32LE(0xffffffff); // Default image attributes.
  draw.writeInt32LE(2, 4); // UnitPixel for the source.
  draw.writeFloatLE(width, 16);
  draw.writeFloatLE(height, 20);
  draw.writeFloatLE(width, 32);
  draw.writeFloatLE(height, 36);

  const plus = Buffer.concat([
    Buffer.from('EMF+'),
    plusRecord(0x4001, 1, header), // EmfPlusHeader, dual mode.
    plusRecord(0x4008, 0x0500, Buffer.concat([bitmap, png])), // Image object 0.
    plusRecord(0x401a, 0, draw), // EmfPlusDrawImage, RectF, image object 0.
    plusRecord(0x4002, 0), // EmfPlusEndOfFile.
  ]);
  const comment = record(70, 12 + plus.length);
  comment.writeUInt32LE(plus.length, 8);
  plus.copy(comment, 12);
  return comment;
}

function gdiBitmap(width, height, rgba) {
  const dib = record(81, 120 + rgba.length); // EMR_STRETCHDIBITS.
  dib.writeInt32LE(width - 1, 16);
  dib.writeInt32LE(height - 1, 20);
  dib.writeInt32LE(width, 40); // Source width and height.
  dib.writeInt32LE(height, 44);
  dib.writeUInt32LE(80, 48); // BITMAPINFO offset and size.
  dib.writeUInt32LE(40, 52);
  dib.writeUInt32LE(120, 56); // Pixel offset and size.
  dib.writeUInt32LE(rgba.length, 60);
  dib.writeUInt32LE(0x00cc0020, 68); // SRCCOPY.
  dib.writeInt32LE(width, 72); // Destination width and height.
  dib.writeInt32LE(height, 76);
  dib.writeUInt32LE(40, 80); // BITMAPINFOHEADER size.
  dib.writeInt32LE(width, 84);
  dib.writeInt32LE(-height, 88); // Top-down.
  dib.writeUInt16LE(1, 92); // Planes.
  dib.writeUInt16LE(32, 94); // BGRX, BI_RGB.
  dib.writeUInt32LE(rgba.length, 100);

  // BI_RGB ignores alpha. Composite onto the white probe page before writing BGRX.
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3];
    for (let c = 0; c < 3; c++) {
      dib[120 + i + c] = 255 - Math.round((255 - rgba[i + 2 - c]) * alpha / 255);
    }
  }
  return dib;
}

/** Write an EMF+ dual preview with the original compressed PNG and a GDI DIB. */
export function previewEmf({ png, widthPx, heightPx, dpi }) {
  const { width, height, rgba } = decodePng(png);
  if (width !== widthPx || height !== heightPx) throw new Error('EMF dimensions must match the PNG');
  const micrometers = [width, height].map(pixels => Math.round(pixels * 25400 / dpi));
  if (!Number.isFinite(dpi) || Math.round(dpi) < 1 || dpi > 0xffffffff ||
      micrometers.some(value => value < 10 || value > 0x7fffffff)) {
    throw new Error('Invalid DPI for EMF frame or device size');
  }

  const comment = plusComment(png, width, height, dpi);
  const dib = gdiBitmap(width, height, rgba);
  const eof = record(14, 20);
  eof.writeUInt32LE(16, 12); // Offset where the empty palette would start.
  eof.writeUInt32LE(eof.length, 16);

  const header = record(1, 108); // EMR_HEADER with HeaderExtension2.
  header.writeInt32LE(width - 1, 16);
  header.writeInt32LE(height - 1, 20);
  header.writeInt32LE(Math.round(micrometers[0] / 10), 32); // 0.01 mm.
  header.writeInt32LE(Math.round(micrometers[1] / 10), 36);
  header.writeUInt32LE(0x464d4520, 40);
  header.writeUInt32LE(0x00010000, 44);
  header.writeUInt32LE(header.length + comment.length + dib.length + eof.length, 48);
  header.writeUInt32LE(4, 52);
  header.writeUInt16LE(1, 56); // Handle table includes the reserved slot.
  header.writeInt32LE(width, 72); // Reference device pixels.
  header.writeInt32LE(height, 76);
  header.writeInt32LE(Math.max(1, Math.round(micrometers[0] / 1000)), 80);
  header.writeInt32LE(Math.max(1, Math.round(micrometers[1] / 1000)), 84);
  header.writeInt32LE(micrometers[0], 100);
  header.writeInt32LE(micrometers[1], 104);
  return Buffer.concat([header, comment, dib, eof]);
}
