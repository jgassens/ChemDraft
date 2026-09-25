import {
  PluginImageMaxBytes,
  type PluginImageSource,
  type PluginProvidedImage
} from "@chemdraft/plugin-api";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile, stat } from "@tauri-apps/plugin-fs";

import { isTauriHost } from "./pluginStagingFs";

export type ProvidedImage = PluginProvidedImage;

export type ImageSourcePermissionStatus = "granted" | "denied" | "notDetermined" | "notRequired";

export interface ImageSourcePermission {
  status(): Promise<ImageSourcePermissionStatus>;
  request(): Promise<ImageSourcePermissionStatus>;
  openSettings(): Promise<void>;
  requiresRestartAfterGrant: boolean;
  deniedMessage?: string;
  grantedRestartMessage?: string;
  openSettingsLabel?: string;
  restartNote?: string;
}

export interface ImageSourceProvider {
  id: PluginImageSource;
  label: string;
  isAvailable(): Promise<boolean>;
  permission?: ImageSourcePermission;
  acquire(signal: AbortSignal): Promise<ProvidedImage | "cancelled">;
}

export class ImageSourceError extends Error {
  constructor(
    readonly code: "permissionDenied" | "unsupported" | "invalidImage" | "failed",
    message: string
  ) {
    super(message);
    this.name = "ImageSourceError";
  }
}

/** Ordered provider registry. Dialog code consumes only this abstraction, so adding a platform or
 * future clipboard provider never adds another conditional to the UI. */
export class ImageSourceRegistry {
  private readonly providers = new Map<PluginImageSource, ImageSourceProvider>();

  constructor(providers: readonly ImageSourceProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: ImageSourceProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Image source provider "${provider.id}" is already registered.`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: PluginImageSource): ImageSourceProvider | undefined {
    return this.providers.get(id);
  }

  async available(requested: readonly PluginImageSource[]): Promise<ImageSourceProvider[]> {
    const candidates = requested.flatMap((id) => {
      const provider = this.providers.get(id);
      return provider ? [provider] : [];
    });
    const states = await Promise.all(
      candidates.map(async (provider) => {
        try {
          return (await provider.isAvailable()) ? provider : undefined;
        } catch {
          return undefined;
        }
      })
    );
    return states.filter((provider): provider is ImageSourceProvider => provider !== undefined);
  }
}

interface NativeScreenCaptureResponse {
  status: "captured" | "cancelled";
  bytes?: number[];
  width?: number;
  height?: number;
}

export function createDefaultImageSourceRegistry(): ImageSourceRegistry {
  return new ImageSourceRegistry([fileImageSourceProvider, screenRegionImageSourceProvider]);
}

export const fileImageSourceProvider: ImageSourceProvider = {
  id: "file",
  label: "Choose Image File…",
  async isAvailable() {
    return isTauriHost();
  },
  async acquire(signal) {
    throwIfAborted(signal);
    const selection = await open({
      multiple: false,
      directory: false,
      title: "Choose an image",
      filters: [
        {
          name: "Image",
          extensions: ["png", "jpg", "jpeg", "tif", "tiff", "webp"]
        }
      ]
    });
    if (typeof selection !== "string") return "cancelled";
    throwIfAborted(signal);
    // Size first: a multi-gigabyte pick must be refused before it is read into memory, not after.
    rejectOversizedFile(await fileSizeIfKnown(selection));
    throwIfAborted(signal);
    const bytes = await readFile(selection);
    throwIfAborted(signal);
    // The file may have grown since it was measured, or could not be measured at all.
    rejectOversizedFile(bytes.byteLength);
    const metadata = inspectSupportedImage(bytes);
    return {
      ...metadata,
      bytes: new Uint8Array(bytes),
      source: "file",
      fileName: selection.split(/[\\/]/).at(-1) ?? selection
    };
  }
};

export const screenRegionImageSourceProvider: ImageSourceProvider = {
  id: "screenRegion",
  label: "Capture Screen Region…",
  async isAvailable() {
    return isTauriHost() && (await invoke<boolean>("screen_capture_available"));
  },
  permission: {
    status: () => invoke<ImageSourcePermissionStatus>("screen_capture_permission_status"),
    request: () => invoke<ImageSourcePermissionStatus>("request_screen_capture_permission"),
    openSettings: () => invoke<void>("open_screen_capture_settings"),
    requiresRestartAfterGrant: true,
    deniedMessage: "ChemDraft needs Screen Recording permission to capture part of the screen.",
    grantedRestartMessage:
      "Screen Recording permission is granted. Quit and reopen ChemDraft before capturing part of the screen.",
    openSettingsLabel: "Open Screen Recording Settings",
    restartNote: "macOS applies the permission after ChemDraft restarts."
  },
  async acquire(signal) {
    throwIfAborted(signal);
    try {
      const response = await invoke<NativeScreenCaptureResponse>("capture_screen_region");
      throwIfAborted(signal);
      if (response.status === "cancelled") return "cancelled";
      if (!Array.isArray(response.bytes) || !response.width || !response.height) {
        throw new ImageSourceError("failed", "Screen capture returned no usable PNG image.");
      }
      return {
        mediaType: "image/png",
        bytes: new Uint8Array(response.bytes),
        width: response.width,
        height: response.height,
        source: "screenRegion"
      };
    } catch (error) {
      if (signal.aborted) return "cancelled";
      throw normalizeScreenCaptureError(error);
    }
  }
};

/** The file's size, or undefined when it cannot be measured without reading it (a host without the
 * `fs:allow-stat` capability). Then the size is checked once the bytes are read instead. */
async function fileSizeIfKnown(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    console.warn(`[chemdraft images] could not measure ${path} before reading it:`, error);
    return undefined;
  }
}

function rejectOversizedFile(size: number | undefined): void {
  if (size === undefined || size <= PluginImageMaxBytes) return;
  throw new ImageSourceError(
    "invalidImage",
    `The selected file is ${size} bytes; images must be at most ${PluginImageMaxBytes} bytes (25 MB).`
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Image acquisition was cancelled.", "AbortError");
}

function normalizeScreenCaptureError(error: unknown): ImageSourceError {
  if (error instanceof ImageSourceError) return error;
  const candidate = error as { kind?: unknown; message?: unknown } | null;
  const kind = typeof candidate?.kind === "string" ? candidate.kind : undefined;
  const detail = typeof candidate?.message === "string" ? candidate.message : undefined;
  if (kind === "permissionDenied" || String(error).includes("permissionDenied")) {
    return new ImageSourceError(
      "permissionDenied",
      "ChemDraft needs Screen Recording permission to capture part of the screen."
    );
  }
  if (kind === "unsupported" || String(error).includes("unsupported")) {
    return new ImageSourceError("unsupported", detail ?? "Screen-region capture is not available on this platform.");
  }
  return new ImageSourceError("failed", detail ?? (error instanceof Error ? error.message : String(error)));
}

function inspectSupportedImage(bytes: Uint8Array): Pick<ProvidedImage, "mediaType" | "width" | "height"> {
  const png = pngDimensions(bytes);
  if (png) return { mediaType: "image/png", ...png };
  const jpeg = jpegDimensions(bytes);
  if (jpeg) return { mediaType: "image/jpeg", ...jpeg };
  const tiff = tiffDimensions(bytes);
  if (tiff) return { mediaType: "image/tiff", ...tiff };
  const webp = webpDimensions(bytes);
  if (webp) return { mediaType: "image/webp", ...webp };
  throw new ImageSourceError(
    "invalidImage",
    "The selected file is not a readable PNG, JPEG, TIFF, or WebP image."
  );
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) return undefined;
  return { width: readU32(bytes, 16, false), height: readU32(bytes, 20, false) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (startOfFrame.has(marker) && length >= 7) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6]
      };
    }
    offset += length;
  }
  throw new ImageSourceError("invalidImage", "The selected JPEG has no readable dimensions.");
}

function tiffDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 8) return undefined;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!little && !big) return undefined;
  const read16 = (offset: number) =>
    little ? bytes[offset] | (bytes[offset + 1] << 8) : (bytes[offset] << 8) | bytes[offset + 1];
  if (read16(2) !== 42) throw new ImageSourceError("invalidImage", "The selected TIFF header is invalid.");
  const ifdOffset = readU32(bytes, 4, little);
  if (ifdOffset + 2 > bytes.length) throw new ImageSourceError("invalidImage", "The selected TIFF directory is invalid.");
  const count = read16(ifdOffset);
  let width: number | undefined;
  let height: number | undefined;
  for (let index = 0; index < count; index += 1) {
    const offset = ifdOffset + 2 + index * 12;
    if (offset + 12 > bytes.length) break;
    const tag = read16(offset);
    if (tag !== 256 && tag !== 257) continue;
    const type = read16(offset + 2);
    const value = type === 3 ? read16(offset + 8) : type === 4 ? readU32(bytes, offset + 8, little) : undefined;
    if (tag === 256) width = value;
    if (tag === 257) height = value;
  }
  if (!width || !height) throw new ImageSourceError("invalidImage", "The selected TIFF has no readable dimensions.");
  return { width, height };
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return undefined;
  const kind = ascii(bytes, 12, 4);
  if (kind === "VP8X") {
    return { width: 1 + readU24(bytes, 24), height: 1 + readU24(bytes, 27) };
  }
  if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff
    };
  }
  if (kind === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10)
    };
  }
  throw new ImageSourceError("invalidImage", "The selected WebP has no readable dimensions.");
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readU24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readU32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  if (offset + 4 > bytes.length) return 0;
  if (littleEndian) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
