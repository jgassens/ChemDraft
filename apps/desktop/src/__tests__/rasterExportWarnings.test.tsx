// @vitest-environment jsdom
/**
 * Every raster export format: does the text the Export dialog shows match the file the writer
 * really produces? (AGENTS.md §7 and §13: a warning that says the wrong thing is a bug.)
 *
 * The "real output" is not a string. rasterExportWarnings.writerOutput.json holds the bytes the
 * native writer (apps/desktop/src-tauri/src/export.rs, rasterize_svg_impl) produced for each
 * format and each background string MainWindow can send; the decoders below read those bytes
 * (pixel format, alpha channel, top-left corner pixel) without trusting anything else in the
 * fixture. The fixture's Rust-side decode is used only to cross-check these decoders.
 *
 * The dialog side renders the real ExportForm on both platforms and reads every hint and warning
 * paragraph it shows, plus whether "Transparent" can be chosen at all.
 *
 * Platforms: the warning text comes from one shared descriptor table and the writer is pure Rust
 * (resvg + image + tiff crates, no OS codecs, no cfg(target_os) branch in encode_raster), so macOS
 * and Windows run the same code. The fixture bytes were produced on macOS; the Windows report of
 * the TIFF bug (build fc2ba7245) is the same encoder path.
 */
import { inflateSync } from "node:zlib";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportForm, rasterExportFormatForDialogFormat } from "../dialogs/ExportForm";
import { exportFixture } from "../dialogs/exportTestFixtures";
import { desktopExportFormatDescriptors } from "../desktopExportFormats";
import { MemoryStorage } from "../testSupport/memoryStorage";
import writerOutput from "./rasterExportWarnings.writerOutput.json";

type RasterFormat = "png" | "jpeg" | "bmp" | "gif" | "tiff";
type WireBackground = "transparent" | "#ffffff";
interface WriterRecord {
  format: RasterFormat;
  background: WireBackground;
  width: number;
  height: number;
  nativeWarningCodes: string[];
  rustDecodedColorType: string;
  rustDecodedCornerRgba: [number, number, number, number];
  bytesBase64: string;
}
interface Decoded {
  /** The file format can carry, and this file declares, an alpha channel or transparent index. */
  hasAlpha: boolean;
  /** Top-left pixel. For JPEG the three colour values are the decoded luma of the first block. */
  corner: [number, number, number, number];
  describe: string;
}

const RASTER_FORMATS: RasterFormat[] = ["png", "jpeg", "bmp", "gif", "tiff"];

function isWriterRecord(value: unknown): value is WriterRecord {
  if (typeof value !== "object" || value === null) return false;
  if (!("format" in value) || !("background" in value) || !("width" in value) || !("height" in value)
    || !("nativeWarningCodes" in value) || !("rustDecodedColorType" in value)
    || !("rustDecodedCornerRgba" in value) || !("bytesBase64" in value)) return false;
  return (value.format === "png" || value.format === "jpeg" || value.format === "bmp" || value.format === "gif" || value.format === "tiff")
    && (value.background === "transparent" || value.background === "#ffffff")
    && typeof value.width === "number" && typeof value.height === "number"
    && Array.isArray(value.nativeWarningCodes) && value.nativeWarningCodes.every(code => typeof code === "string")
    && typeof value.rustDecodedColorType === "string"
    && Array.isArray(value.rustDecodedCornerRgba) && value.rustDecodedCornerRgba.length === 4
    && value.rustDecodedCornerRgba.every(channel => typeof channel === "number")
    && typeof value.bytesBase64 === "string";
}

const fixtureRecords: unknown = writerOutput.records;
if (!Array.isArray(fixtureRecords) || !fixtureRecords.every(isWriterRecord)) {
  throw new Error("Invalid raster writer output fixture records");
}
const records: WriterRecord[] = fixtureRecords;

function writerBytes(format: RasterFormat, background: WireBackground): Uint8Array {
  const record = records.find(candidate => candidate.format === format && candidate.background === background);
  if (!record) throw new Error(`No writer output recorded for ${format} / ${background}`);
  return Uint8Array.from(Buffer.from(record.bytesBase64, "base64"));
}

// ---------------------------------------------------------------- decoders (top-left pixel only)

function decodePng(bytes: Uint8Array): Decoded {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(Array.from(bytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8, colorType = -1, bitDepth = 0, palette: number[][] = [], trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { bitDepth = data[8]!; colorType = data[9]!; }
    if (type === "PLTE") for (let i = 0; i < data.length; i += 3) palette.push([data[i]!, data[i + 1]!, data[i + 2]!]);
    if (type === "tRNS") trns = data;
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  expect(bitDepth).toBe(8);
  const raw = inflateSync(Buffer.concat(idat));
  // Row 0, pixel 0: every PNG filter reduces to the raw byte there (left, up and up-left are 0).
  const px = raw.subarray(1, 5);
  switch (colorType) {
    case 6: return { hasAlpha: true, corner: [px[0]!, px[1]!, px[2]!, px[3]!], describe: "PNG RGBA8" };
    case 2: {
      const transparent = trns !== undefined && trns[1] === px[0] && trns[3] === px[1] && trns[5] === px[2];
      return { hasAlpha: trns !== undefined, corner: [px[0]!, px[1]!, px[2]!, transparent ? 0 : 255], describe: "PNG RGB8" };
    }
    case 3: {
      const [r, g, b] = palette[px[0]!]!;
      return { hasAlpha: trns !== undefined, corner: [r!, g!, b!, trns?.[px[0]!] ?? 255], describe: "PNG palette" };
    }
    default: throw new Error(`Unhandled PNG colour type ${colorType}`);
  }
}

function decodeTiff(bytes: Uint8Array): Decoded {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[0] === 0x49;
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  expect(u16(2)).toBe(42);
  const ifd = u32(4);
  const tags = new Map<number, number[]>();
  for (let i = 0; i < u16(ifd); i += 1) {
    const entry = ifd + 2 + i * 12;
    const [tag, type, count] = [u16(entry), u16(entry + 2), u32(entry + 4)];
    const size = type === 3 ? 2 : type === 4 ? 4 : 0;
    if (size === 0) continue;
    const base = count * size <= 4 ? entry + 8 : u32(entry + 8);
    tags.set(tag, Array.from({ length: count }, (_, index) => size === 2 ? u16(base + index * 2) : u32(base + index * 4)));
  }
  expect(tags.get(259)?.[0] ?? 1).toBe(1); // uncompressed
  expect(tags.get(262)?.[0]).toBe(2); // RGB
  expect(tags.get(258)?.every(bits => bits === 8)).toBe(true);
  const samples = tags.get(277)?.[0] ?? 1;
  const extra = tags.get(338) ?? [];
  // ExtraSamples 1 = associated alpha, 2 = unassociated alpha.
  const hasAlpha = samples === 4 && (extra[0] === 1 || extra[0] === 2);
  const start = tags.get(273)![0]!;
  const px = bytes.subarray(start, start + samples);
  return { hasAlpha, corner: [px[0]!, px[1]!, px[2]!, hasAlpha ? px[3]! : 255], describe: `TIFF ${samples} samples, ExtraSamples=[${extra.join(",")}]` };
}

function decodeBmp(bytes: Uint8Array): Decoded {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe("BM");
  const pixels = view.getUint32(10, true), header = view.getUint32(14, true);
  const width = view.getInt32(18, true), height = view.getInt32(22, true), bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  const alphaMask = header >= 56 && compression === 3 ? view.getUint32(54, true) : 0;
  const stride = Math.ceil((width * bpp) / 32) * 4;
  const topRow = height > 0 ? height - 1 : 0; // positive height = bottom-up rows
  const at = pixels + topRow * stride;
  expect([24, 32]).toContain(bpp);
  const hasAlpha = bpp === 32 && alphaMask !== 0;
  return {
    hasAlpha,
    corner: [bytes[at + 2]!, bytes[at + 1]!, bytes[at]!, hasAlpha ? bytes[at + 3]! : 255],
    describe: `BMP ${bpp}bpp`
  };
}

function decodeGif(bytes: Uint8Array): Decoded {
  expect(String.fromCharCode(...bytes.subarray(0, 3))).toBe("GIF");
  let offset = 13;
  const packed = bytes[10]!;
  let palette = packed & 0x80 ? bytes.subarray(offset, offset + 3 * (2 << (packed & 7))) : undefined;
  if (palette) offset += palette.length;
  let transparentIndex: number | undefined;
  for (;;) {
    const introducer = bytes[offset]!;
    if (introducer === 0x21) {
      if (bytes[offset + 1] === 0xf9 && bytes[offset + 3]! & 1) transparentIndex = bytes[offset + 6];
      offset += 2;
      while (bytes[offset] !== 0) offset += bytes[offset]! + 1;
      offset += 1;
      continue;
    }
    expect(introducer).toBe(0x2c);
    break;
  }
  expect([bytes[offset + 1], bytes[offset + 2], bytes[offset + 3], bytes[offset + 4]]).toEqual([0, 0, 0, 0]); // frame at (0,0)
  const local = bytes[offset + 9]!;
  offset += 10;
  if (local & 0x80) { palette = bytes.subarray(offset, offset + 3 * (2 << (local & 7))); offset += palette.length; }
  const minCodeSize = bytes[offset]!;
  const firstBlock = bytes.subarray(offset + 2, offset + 2 + bytes[offset + 1]!);
  // The first pixel is the first non-clear LZW code, read LSB-first at minCodeSize + 1 bits.
  const clear = 1 << minCodeSize, width = minCodeSize + 1;
  let bit = 0;
  const read = () => { let code = 0; for (let i = 0; i < width; i += 1, bit += 1) code |= ((firstBlock[bit >> 3]! >> (bit & 7)) & 1) << i; return code; };
  let index = read();
  while (index === clear) index = read();
  expect(palette).toBeDefined();
  const rgb = palette!.subarray(index * 3, index * 3 + 3);
  return {
    hasAlpha: transparentIndex !== undefined,
    corner: [rgb[0]!, rgb[1]!, rgb[2]!, index === transparentIndex ? 0 : 255],
    describe: `GIF palette${transparentIndex === undefined ? "" : `, transparent index ${transparentIndex}`}`
  };
}

function decodeJpeg(bytes: Uint8Array): Decoded {
  // JPEG has no alpha channel. Decode only the DC term of the first luma block: its average,
  // which for an 8x8 corner of flat background is the corner colour.
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  let offset = 2, dcQuant = 0, components = 0, sof = 0;
  const dcTables = new Map<number, Map<string, number>>();
  let scanDcTable = -1, scanStart = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset + 1]!;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const body = bytes.subarray(offset + 4, offset + 2 + length);
    if (marker === 0xdb) {
      for (let at = 0; at < body.length;) {
        const precision = body[at]! >> 4, id = body[at]! & 15;
        if (id === 0) dcQuant = precision ? (body[at + 1]! << 8) | body[at + 2]! : body[at + 1]!;
        at += 1 + 64 * (precision ? 2 : 1);
      }
    } else if (marker >= 0xc0 && marker <= 0xc2) {
      sof = marker; components = body[5]!;
    } else if (marker === 0xc4) {
      for (let at = 0; at < body.length;) {
        const tableClass = body[at]! >> 4, id = body[at]! & 15;
        const counts = body.subarray(at + 1, at + 17);
        let symbol = at + 17, code = 0;
        const table = new Map<string, number>();
        for (let length = 1; length <= 16; length += 1) {
          for (let n = 0; n < counts[length - 1]!; n += 1) table.set(code.toString(2).padStart(length, "0"), body[symbol++]!), code += 1;
          code <<= 1;
        }
        if (tableClass === 0) dcTables.set(id, table);
        at = symbol;
      }
    } else if (marker === 0xda) {
      scanDcTable = body[2]! >> 4; // first component (Y)
      scanStart = offset + 2 + length;
      break;
    }
    offset += 2 + length;
  }
  expect(sof).toBe(0xc0); // baseline
  const entropy: number[] = [];
  for (let at = scanStart; entropy.length < 8; at += 1) {
    entropy.push(bytes[at]!);
    if (bytes[at] === 0xff) at += 1; // skip the stuffed 0x00
  }
  const bits = entropy.map(byte => byte.toString(2).padStart(8, "0")).join("");
  const table = dcTables.get(scanDcTable)!;
  let length = 1;
  while (!table.has(bits.slice(0, length))) length += 1;
  const category = table.get(bits.slice(0, length))!;
  const raw = bits.slice(length, length + category);
  const diff = category === 0 ? 0 : raw[0] === "1" ? parseInt(raw, 2) : parseInt(raw, 2) - (1 << category) + 1;
  const luma = Math.max(0, Math.min(255, Math.round((diff * dcQuant) / 8 + 128)));
  return { hasAlpha: false, corner: [luma, luma, luma, 255], describe: `JPEG baseline, ${components} components` };
}

const decoders: Record<RasterFormat, (bytes: Uint8Array) => Decoded> = {
  png: decodePng, jpeg: decodeJpeg, bmp: decodeBmp, gif: decodeGif, tiff: decodeTiff
};

// ---------------------------------------------------------------- what the dialog says

let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

function dialogFor(formatId: string, background: "white" | "transparent", platform: "macos" | "windows") {
  const base = exportFixture();
  act(() => root.render(createElement(ExportForm, {
    state: { ...base, busy: false, format: formatId as typeof base.format, filename: `Drawing.${formatId}`, raster: { ...base.raster, background } },
    onChange: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn(), onChooseDestination: vi.fn(), platform
  })));
  const transparentOption = container.querySelector<HTMLOptionElement>("#chemdraft-export-raster-background option[value=transparent]");
  expect(transparentOption, "the raster Background control is shown").not.toBeNull();
  return {
    text: Array.from(container.querySelectorAll("p")).map(p => p.textContent?.trim() ?? "").filter(Boolean),
    transparentOffered: !transparentOption!.disabled
  };
}

const claimsFlattenToWhite = (text: string[]) => text.some(line => /flattens transparency onto a white background/i.test(line));
const claimsPreservesTransparency = (text: string[]) => text.some(line => /preserves transparency/i.test(line));
const isWhite = ([r, g, b]: number[]) => r! >= 245 && g! >= 245 && b! >= 245;

const rasterDescriptors = desktopExportFormatDescriptors.filter(descriptor =>
  descriptor.status === "implemented" && rasterExportFormatForDialogFormat(descriptor.id) !== undefined);

describe("raster export writer output (decoded from the real bytes)", () => {
  it("covers every raster format the Export dialog offers", () => {
    expect(rasterDescriptors.map(descriptor => rasterExportFormatForDialogFormat(descriptor.id)).sort()).toEqual([...RASTER_FORMATS].sort());
    for (const format of RASTER_FORMATS) for (const background of ["transparent", "#ffffff"] as const) expect(() => writerBytes(format, background)).not.toThrow();
  });

  it.each(records.map(record => [record.format, record.background, record] as const))("%s / %s: these decoders agree with the Rust decode", (format, _background, record) => {
    const decoded = decoders[format](writerBytes(record.format, record.background));
    if (format === "jpeg") expect(Math.abs(decoded.corner[0] - record.rustDecodedCornerRgba[0])).toBeLessThanOrEqual(3);
    else expect(decoded.corner).toEqual(record.rustDecodedCornerRgba);
  });

  it.each(["jpeg", "bmp", "gif"] as const)("%s cannot carry the transparency a transparent request asks for, and flattens it onto white", format => {
    const decoded = decoders[format](writerBytes(format, "transparent"));
    expect(decoded.hasAlpha, decoded.describe).toBe(false);
    expect(decoded.corner[3]).toBe(255);
    expect(isWhite(decoded.corner), `corner ${decoded.corner}`).toBe(true);
  });
});

describe.each(["macos", "windows"] as const)("Export dialog warning vs the written file on %s", platform => {
  for (const descriptor of rasterDescriptors) {
    const format = rasterExportFormatForDialogFormat(descriptor.id)! as RasterFormat;
    for (const background of ["white", "transparent"] as const) {
      it(`${descriptor.menuLabel}, Background ${background === "white" ? "White page" : "Transparent"}`, context => {
        const dialog = dialogFor(descriptor.id, background, platform);
        if (background === "transparent" && !dialog.transparentOffered) {
          // Not reachable from the dialog: updateExportDialogFormat forces White page and
          // MainWindow sends "#ffffff". The White page row checks that file. Reported as
          // skipped so a run shows which formats do not offer Transparent.
          context.skip();
        }
        // MainWindow: transparent only when the format supports it and the user chose it.
        const wire: WireBackground = background === "transparent" ? "transparent" : "#ffffff";
        const output = decoders[format](writerBytes(format, wire));
        const written = `${output.describe}, corner RGBA ${output.corner.join(",")}`;
        const shown = dialog.text.join(" | ") || "(nothing)";

        if (claimsFlattenToWhite(dialog.text)) {
          expect(output.corner[3], `Dialog says "${shown}" but the ${descriptor.menuLabel} file written is transparent (${written}).`).toBe(255);
          expect(isWhite(output.corner), `Dialog says "${shown}" but the corner is not white (${written}).`).toBe(true);
        }
        if (background === "transparent" && claimsPreservesTransparency(dialog.text)) {
          expect(output.corner[3], `Dialog says "${shown}" but the file is opaque (${written}).`).toBe(0);
        }
        // §7: never degrade quietly. A transparent request that came out opaque must have said so.
        if (background === "transparent" && output.corner[3] === 255) {
          expect(claimsFlattenToWhite(dialog.text), `Transparent ${descriptor.menuLabel} came out opaque (${written}) and the dialog only said "${shown}".`).toBe(true);
        }
        // A White page export is always opaque white at the uncovered corner.
        if (background === "white") {
          expect(output.corner[3], written).toBe(255);
          expect(isWhite(output.corner), written).toBe(true);
        }
      });
    }
  }
});
