import { imageBase64Error } from "./imageBytes";
import { GraphicObjectSchema, type GraphicObject, type ImageObjectData, type Point } from "./schemas";
import { CSS_PX_PER_INCH } from "./page-layout";

import { imagePixelLimitError, validatePngImage, validateSvgImage } from "./imageInfo";
export { MAX_IMAGE_SIDE, MAX_IMAGE_DECODED_BYTES, imagePixelLimitError, validatePngImage, validateSvgImage,
  readPngInfo, readSvgInfo, isSvgImageSource, type ImagePixelInfo } from "./imageInfo";

export interface CreateImageGraphicObjectOptions {
  mimeType: ImageObjectData["mimeType"];
  dataBase64: string;
  pixelWidth?: number;
  pixelHeight?: number;
  pixelsPerMeter?: { x: number; y: number };
  center: Point;
  id: string;
}

/**
 * The picture's bytes, checked like `decodeImageBase64`. Decoded by the engine (`Uint8Array.fromBase64`)
 * or a plain byte loop: mapping each character through a callback took 140 ms for a 3 MB picture.
 */
function pictureBytes(dataBase64: string, id: string): Uint8Array {
  const error = imageBase64Error(dataBase64, id);
  if (error) throw new Error(error);
  const fromBase64 = (Uint8Array as { fromBase64?: (value: string) => Uint8Array }).fromBase64;
  if (typeof fromBase64 === "function") return fromBase64(dataBase64);
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Centre a picture in page units (96 per inch), using 96 dpi when density is absent.
 * Picture dimensions are physical sizes, independent of molecule drawing styles and bond lengths.
 */
export function createImageGraphicObject(options: CreateImageGraphicObjectOptions): GraphicObject {
  const { mimeType, dataBase64, id, center } = options;
  const bytes = pictureBytes(dataBase64, id);
  const result = mimeType === "image/png" ? validatePngImage(bytes) : validateSvgImage(new TextDecoder().decode(bytes));
  if (result.error) throw new Error(result.error);
  const info = result.info;
  const limitError = imagePixelLimitError(options.pixelWidth ?? info?.pixelWidth ?? 0, options.pixelHeight ?? info?.pixelHeight ?? 0);
  if (limitError) throw new Error(limitError);
  const pixelsPerMeter = options.pixelsPerMeter ?? info?.pixelsPerMeter;
  const image: ImageObjectData = {
    mimeType, dataBase64,
    pixelWidth: options.pixelWidth ?? info?.pixelWidth ?? NaN,
    pixelHeight: options.pixelHeight ?? info?.pixelHeight ?? NaN,
    ...(pixelsPerMeter ? { pixelsPerMeter } : {})
  };
  const width = info?.physicalSize?.width ?? (image.pixelsPerMeter
    ? image.pixelWidth / (image.pixelsPerMeter.x * 0.0254) * CSS_PX_PER_INCH : image.pixelWidth);
  const height = info?.physicalSize?.height ?? (image.pixelsPerMeter
    ? image.pixelHeight / (image.pixelsPerMeter.y * 0.0254) * CSS_PX_PER_INCH : image.pixelHeight);
  // Like rect graphics, the frame is top-level x/y (top left), width/height and rotation.
  // No separate image geometry: moving, resizing and selecting reuse the ordinary graphic frame.
  return GraphicObjectSchema.parse({
    id, type: "graphic", graphicKind: "image", x: center.x - width / 2, y: center.y - height / 2,
    width, height, rotation: 0, style: {}, data: { image }
  });
}
