import { decodeImageBase64 } from "./imageBytes";
import { GraphicObjectSchema, type GraphicObject, type ImageObjectData, type Point } from "./schemas";
import { DOCUMENT_STYLE_UNITS_PER_PT } from "./styles";

export interface ImagePixelInfo {
  pixelWidth: number;
  pixelHeight: number;
  pixelsPerMeter?: { x: number; y: number };
}

export const MAX_IMAGE_SIDE = 16_384;
export const MAX_IMAGE_DECODED_BYTES = 256 * 1024 * 1024;

/** Inspect chunk framing without decompressing pixels or checking CRCs. */
function inspectPng(bytes: Uint8Array): { info?: ImagePixelInfo; error?: string } {
  const invalid = { error: "the PNG has invalid structure." };
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return invalid;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkType = (offset: number) => String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  if (view.getUint32(8) !== 13 || chunkType(8) !== "IHDR") return invalid;
  const pixelWidth = view.getUint32(16);
  const pixelHeight = view.getUint32(20);
  if (pixelWidth === 0 || pixelHeight === 0 || pixelWidth > 0x7fffffff || pixelHeight > 0x7fffffff) return invalid;
  const info: ImagePixelInfo = { pixelWidth, pixelHeight };
  let hasData = false;
  for (let offset = 33; offset < bytes.length;) {
    if (offset + 12 > bytes.length) return invalid;
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return invalid;
    const type = chunkType(offset);
    if (type === "IHDR") return invalid;
    if (type === "pHYs") {
      if (length !== 9) return invalid;
      const x = view.getUint32(offset + 8);
      const y = view.getUint32(offset + 12);
      if (bytes[offset + 16] === 1 && x > 0 && y > 0) info.pixelsPerMeter = { x, y };
    }
    if (type === "IDAT" && length > 0) hasData = true;
    if (type === "IEND") {
      if (length !== 0 || offset + 12 !== bytes.length) return invalid;
      return hasData ? { info } : { error: "the PNG has no image data." };
    }
    offset += length + 12;
  }
  return hasData ? invalid : { error: "the PNG has no image data." };
}

export function readPngInfo(bytes: Uint8Array): ImagePixelInfo | undefined {
  return inspectPng(bytes).info;
}

export function imagePixelLimitError(width: number, height: number): string | undefined {
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    return `Couldn't paste the picture: it is ${width} x ${height} pixels; the limit is ${MAX_IMAGE_SIDE} pixels on a side.`;
  }
  if (width * height * 4 > MAX_IMAGE_DECODED_BYTES) {
    return `Couldn't paste the picture: it is ${width} x ${height} pixels; the decoded limit is 256 MiB.`;
  }
  return undefined;
}

export function validatePngImage(bytes: Uint8Array): { info?: ImagePixelInfo; error?: string } {
  const result = inspectPng(bytes);
  if (result.error) return { error: `Couldn't paste the picture: ${result.error}` };
  const info = result.info!;
  const error = imagePixelLimitError(info.pixelWidth, info.pixelHeight);
  return error ? { error } : { info };
}

/** SVG image pixels follow the paste default of 72 dpi; absolute units retain their physical size. */
export function readSvgInfo(source: string): ImagePixelInfo | undefined {
  let rest = source.trimStart();
  // Skip XML declarations, comments and doctypes without interpreting entities or fetching URLs.
  const prolog = /^(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE(?:[^>"'\[]|"[^"]*"|'[^']*'|\[[\s\S]*?\])*>)/i;
  for (let match = rest.match(prolog); match; match = rest.match(prolog)) {
    rest = rest.slice(match[0].length).trimStart();
  }
  if (!/^<svg(?=[\s/>])/.test(rest)) return undefined;
  const root = rest.match(/^<svg(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>/);
  // An incomplete SVG root is still artwork source, never ordinary text to paste into a text box.
  const attributes = new Map([...(root?.[1] ?? "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map((match) => [match[1], match[2] ?? match[3]]));
  const length = (value: string | undefined): number | undefined => {
    const match = value?.trim().match(/^([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|in|mm|cm)?$/i);
    if (!match) return undefined;
    const scale: Record<string, number> = { px: 1, pt: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54 };
    const result = Number(match[1]) * scale[(match[2] ?? "px").toLowerCase()];
    return Number.isFinite(result) && result > 0 ? result : undefined;
  };
  const viewBox = attributes.get("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const box = viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0
    ? { width: viewBox[2], height: viewBox[3] } : undefined;
  let width = length(attributes.get("width"));
  let height = length(attributes.get("height"));
  if (box) {
    if (width === undefined && height !== undefined) width = height * box.width / box.height;
    if (height === undefined && width !== undefined) height = width * box.height / box.width;
    width ??= box.width;
    height ??= box.height;
  }
  // SVG's default viewport is 300 × 150 when no usable dimensions/viewBox are provided.
  return { pixelWidth: Math.max(1, Math.round(width ?? 300)), pixelHeight: Math.max(1, Math.round(height ?? 150)) };
}

export interface CreateImageGraphicObjectOptions {
  mimeType: ImageObjectData["mimeType"];
  dataBase64: string;
  pixelWidth?: number;
  pixelHeight?: number;
  pixelsPerMeter?: { x: number; y: number };
  center: Point;
  id: string;
}

export function createImageGraphicObject(options: CreateImageGraphicObjectOptions): GraphicObject {
  const { mimeType, dataBase64, id, center } = options;
  const bytes = decodeImageBase64(dataBase64, id);
  const png = mimeType === "image/png" ? validatePngImage(bytes) : undefined;
  if (png?.error) throw new Error(png.error);
  const info = png?.info ?? (mimeType === "image/svg+xml" ? readSvgInfo(new TextDecoder().decode(bytes)) : undefined);
  const actualLimitError = info && imagePixelLimitError(info.pixelWidth, info.pixelHeight);
  if (actualLimitError) throw new Error(actualLimitError);
  const limitError = imagePixelLimitError(options.pixelWidth ?? info?.pixelWidth ?? 0, options.pixelHeight ?? info?.pixelHeight ?? 0);
  if (limitError) throw new Error(limitError);
  const pixelsPerMeter = options.pixelsPerMeter ?? info?.pixelsPerMeter;
  const image: ImageObjectData = {
    mimeType, dataBase64,
    pixelWidth: options.pixelWidth ?? info?.pixelWidth ?? NaN,
    pixelHeight: options.pixelHeight ?? info?.pixelHeight ?? NaN,
    ...(pixelsPerMeter ? { pixelsPerMeter } : {})
  };
  const widthPt = image.pixelsPerMeter ? image.pixelWidth / (image.pixelsPerMeter.x * 0.0254) * 72 : image.pixelWidth;
  const heightPt = image.pixelsPerMeter ? image.pixelHeight / (image.pixelsPerMeter.y * 0.0254) * 72 : image.pixelHeight;
  const width = widthPt * DOCUMENT_STYLE_UNITS_PER_PT;
  const height = heightPt * DOCUMENT_STYLE_UNITS_PER_PT;
  // Like rect graphics, the frame is top-level x/y (top left), width/height and rotation.
  // No separate image geometry: moving, resizing and selecting reuse the ordinary graphic frame.
  return GraphicObjectSchema.parse({
    id, type: "graphic", graphicKind: "image", x: center.x - width / 2, y: center.y - height / 2,
    width, height, rotation: 0, style: {}, data: { image }
  });
}
