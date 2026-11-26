/**
 * Which dropped files are pictures. The extension only decides which files are read as pictures;
 * what a picture actually is comes from its bytes (export-engine `svgSafety/imageSniff.ts`). Everything else keeps the
 * document-open path exactly as before, so a dropped .cdxml, .chemdraft, .cdx or .mol still opens.
 */

/** Per file, checked from metadata before reading and again while reading. */
export const MAX_DROPPED_IMAGE_BYTES = 20 * 1024 * 1024;
/** Pictures inserted from one drop; the rest are refused by name. */
export const MAX_DROPPED_IMAGES = 50;
/** All pictures of one drop together, from metadata, before any is read. */
export const MAX_DROPPED_IMAGE_TOTAL_BYTES = 200 * 1024 * 1024;

export type DroppedFileRole =
  | { kind: "image" }
  | { kind: "refused"; reason: string }
  | { kind: "document" };

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "jpe", "jfif", "pjpeg", "pjp", "gif", "webp", "svg"]);

/**
 * Picture types a webview cannot decode on every platform (TIFF fails in WebView2), and links and
 * shortcuts, which would otherwise be opened as documents and fail with a parser's wording. Refused
 * by name on every route, without being read.
 */
const REFUSED_EXTENSIONS: Readonly<Record<string, string>> = {
  bmp: "BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first.",
  dib: "BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first.",
  tif: "BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first.",
  tiff: "BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first.",
  ico: "icon files can't be dropped as pictures; save it as PNG first.",
  cur: "cursor files can't be dropped as pictures; save it as PNG first.",
  heic: "HEIC/HEIF pictures can't be dropped yet; save it as PNG or JPEG first.",
  heif: "HEIC/HEIF pictures can't be dropped yet; save it as PNG or JPEG first.",
  avif: "AVIF pictures can't be dropped yet; save it as PNG or JPEG first.",
  svgz: "compressed SVG (.svgz) can't be dropped; save it as plain SVG first.",
  pdf: "PDF files can't be placed as pictures; export the page as PNG or SVG first.",
  eps: "EPS files can't be placed as pictures; export it as PNG or SVG first.",
  ai: ".ai files can't be placed as pictures; export it as PNG or SVG first.",
  // A web link from a browser or the desktop: .url on Windows, .webloc on macOS.
  url: "it is a web link, not a picture or a drawing.",
  webloc: "it is a web link, not a picture or a drawing.",
  // A Windows shortcut: the target is what was meant.
  lnk: "it is a shortcut; drop the file it points to instead."
};

export function droppedFileExtension(name: string): string {
  // Accept both separators: a Windows path can arrive on any host.
  const base = name.split(/[\\/]/).at(-1) ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function droppedFileBaseName(name: string): string {
  return name.split(/[\\/]/).at(-1) || name;
}

export function classifyDroppedFile(name: string): DroppedFileRole {
  const extension = droppedFileExtension(name);
  if (IMAGE_EXTENSIONS.has(extension)) return { kind: "image" };
  const reason = REFUSED_EXTENSIONS[extension];
  return reason ? { kind: "refused", reason } : { kind: "document" };
}

export function formatDropBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function droppedImageSizeError(size: number, maxBytes = MAX_DROPPED_IMAGE_BYTES): string | undefined {
  if (!Number.isSafeInteger(size) || size < 0) return "its size could not be read.";
  if (size > maxBytes) {
    const actual = formatDropBytes(size);
    const limit = formatDropBytes(maxBytes);
    return `it is ${actual === limit ? "just over " : ""}${actual}; a dropped picture can be at most ${limit}.`;
  }
  return undefined;
}

/** `Couldn't drop "name": reason` — every refusal names its file. */
export function dropRefusal(name: string, reason: string): string {
  return `Couldn't drop "${droppedFileBaseName(name)}": ${reason}`;
}

/** The shared picture validators speak about pasting; a drop must not. */
export function rewordPictureError(message: string): string {
  return message.replace(/^Couldn't paste the picture:\s*/, "").replace(/^Image object [^ ]+ /, "it ");
}
