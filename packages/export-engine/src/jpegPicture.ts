/**
 * A JPEG picture kept as its own encoded bytes (a dropped photo, `apps/desktop/src/imageDrop/jpegPicture.ts`).
 *
 * The document stores pictures as PNG or SVG (`ImageObjectData.mimeType`), and ChemDraft 1.2.2 opens
 * nothing else, so a kept JPEG travels inside a one-element SVG: an `<image>` holding the JPEG, with
 * the transform that turns it upright (its EXIF orientation; the Exif segment itself is removed). The
 * canvas draws that SVG as it is. Exports read it back (`readJpegPicture`) and draw the JPEG itself:
 * SVG export writes a plain `<image href="data:image/jpeg;base64,…">` with the transform, which
 * usvg/resvg, Illustrator and Inkscape draw (a JPEG inside an SVG inside an `<image>` they do not),
 * and PDF export embeds the JPEG bytes (DCTDecode) placed by the same transform.
 *
 * The writer and the reader are kept together so the form has one definition. The reader accepts
 * exactly what the writer writes: any other SVG picture is drawn as an SVG picture, as before.
 */

/** EXIF orientation: 1 upright; 2-4 mirrored or turned; 5-8 also swap width and height. */
export type JpegOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const ORIENTATIONS: readonly JpegOrientation[] = [1, 2, 3, 4, 5, 6, 7, 8];

/** The upright size of a picture stored at `width` × `height` with `orientation`. */
export function orientedJpegSize(width: number, height: number, orientation: JpegOrientation): { width: number; height: number } {
  return orientation >= 5 ? { width: height, height: width } : { width, height };
}

/**
 * The affine map `[a, b, c, d, e, f]` (SVG `matrix()`, canvas `setTransform`, PDF `cm`) that draws a
 * picture stored at `width` × `height` upright in its oriented box; undefined for orientation 1.
 */
export function jpegOrientationMatrix(width: number, height: number, orientation: JpegOrientation): [number, number, number, number, number, number] | undefined {
  switch (orientation) {
    case 1: return undefined;
    case 2: return [-1, 0, 0, 1, width, 0];
    case 3: return [-1, 0, 0, -1, width, height];
    case 4: return [1, 0, 0, -1, 0, height];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, height, 0];
    case 7: return [0, -1, -1, 0, height, width];
    case 8: return [0, -1, 1, 0, 0, width];
  }
}

/**
 * The SVG picture that shows `jpegBase64` (stored `width` × `height` pixels) upright, sized one pixel
 * per page unit like any picture without a density. Written in the form the SVG sanitizer leaves
 * unchanged, so storing it needs no sanitizing pass.
 */
export function jpegPictureSvg(jpegBase64: string, width: number, height: number, orientation: JpegOrientation): string {
  const size = orientedJpegSize(width, height, orientation);
  const matrix = jpegOrientationMatrix(width, height, orientation);
  const transform = matrix ? ` transform="matrix(${matrix.join(" ")})"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`
    + `<image width="${width}" height="${height}" preserveAspectRatio="none"${transform} href="data:image/jpeg;base64,${jpegBase64}"/></svg>`;
}

/** Characters `jpegPictureSvg` writes for a JPEG of `byteLength` bytes, without building it. */
export function jpegPictureSvgLength(byteLength: number, width: number, height: number, orientation: JpegOrientation): number {
  return jpegPictureSvg("", width, height, orientation).length + Math.ceil(byteLength / 3) * 4;
}

/** A kept JPEG read back from its SVG picture. */
export interface JpegPicture {
  /** The JPEG, base64-encoded, exactly as stored. */
  jpegBase64: string;
  /** Stored pixel size, before orientation. */
  width: number;
  height: number;
  orientation: JpegOrientation;
}

const SVG_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="';
const JPEG_HREF = ' href="data:image/jpeg;base64,';
const JPEG_PICTURE_SVG = new RegExp("^<svg xmlns=\"http://www\\.w3\\.org/2000/svg\" width=\"(\\d+)\" height=\"(\\d+)\" viewBox=\"0 0 (\\d+) (\\d+)\">"
  + "<image width=\"(\\d+)\" height=\"(\\d+)\" preserveAspectRatio=\"none\"(?: transform=\"matrix\\((-?\\d+(?: -?\\d+){5})\\)\")?"
  + " href=\"data:image/jpeg;base64,([A-Za-z0-9+/]+={0,2})\"/></svg>$");
/** Base64 characters that hold the head of the form, up to the JPEG's href, at any size `jpegPictureSvg` writes. */
const HEAD_BASE64_LENGTH = 384;

/** The kept JPEG in `svg` when it is exactly what `jpegPictureSvg` writes; undefined for any other SVG. */
export function readJpegPictureSvg(svg: string): JpegPicture | undefined {
  const match = JPEG_PICTURE_SVG.exec(svg);
  if (!match) return undefined;
  const [outerWidth, outerHeight, viewWidth, viewHeight, width, height] = match.slice(1, 7).map(Number) as
    [number, number, number, number, number, number];
  if (!(width > 0 && height > 0) || outerWidth !== viewWidth || outerHeight !== viewHeight) return undefined;
  const transform = match[7];
  const orientation = ORIENTATIONS.find(candidate => {
    const size = orientedJpegSize(width, height, candidate);
    return size.width === outerWidth && size.height === outerHeight &&
      jpegOrientationMatrix(width, height, candidate)?.join(" ") === transform;
  });
  return orientation ? { jpegBase64: match[8]!, width, height, orientation } : undefined;
}

/**
 * The kept JPEG a picture holds, or undefined for any other picture. Only the head of an SVG picture
 * is decoded to tell: a picture of another form costs a few hundred bytes, not its whole size.
 */
export function readJpegPicture(image: { mimeType: string; dataBase64: string }): JpegPicture | undefined {
  if (image.mimeType !== "image/svg+xml") return undefined;
  try {
    const head = atob(image.dataBase64.slice(0, HEAD_BASE64_LENGTH));
    if (!head.startsWith(SVG_HEAD) || !head.includes(JPEG_HREF)) return undefined;
    return readJpegPictureSvg(atob(image.dataBase64));
  } catch {
    return undefined;
  }
}

/** A rectangle in page (or user) units. */
export interface PictureBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a kept JPEG is drawn to fill `frame` upright: `box` is the stored-orientation rectangle
 * centred on the frame (its sides swapped for orientations 5-8), and `matrix`, when the picture is
 * not upright as stored, turns that box into the frame about their shared centre. Because the map is
 * about the centre, a frame resized about its centre (document-style export) keeps the same matrix.
 */
export function jpegPicturePlacement(frame: PictureBox, orientation: JpegOrientation): {
  box: PictureBox; matrix?: [number, number, number, number, number, number];
} {
  const linear = jpegOrientationMatrix(1, 1, orientation);
  if (!linear) return { box: { ...frame } };
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  const swapped = orientation >= 5;
  const width = swapped ? frame.height : frame.width;
  const height = swapped ? frame.width : frame.height;
  const [a, b, c, d] = linear;
  // The centre stays put: e and f undo what the linear part does to it. `+ 0` writes 0, never -0.
  return {
    box: { x: cx - width / 2, y: cy - height / 2, width, height },
    matrix: [a, b, c, d, cx - (a * cx + c * cy) + 0, cy - (b * cx + d * cy) + 0]
  };
}
