import { prepareRasterPictures } from "./rasterPictureDecode";

export type NativeRasterExportFormat = "png" | "jpeg" | "bmp" | "gif" | "tiff";

export interface NativeRasterExportOptions {
  scale?: number;
  background?: string;
  jpegQuality?: number;
  maxDimensionPx?: number;
  maxPngBytes?: number;
  /** Cap decoded picture working-set input for callers exporting a bounded preview. */
  pictureBudgetBytes?: number;
  /**
   * The CSS pixels-per-inch convention the source SVG's own units represent (96, for every SVG
   * this app emits). When set, PNG output embeds a pHYs chunk whose density is derived from this
   * times the scale actually applied — after any maxDimensionPx clamping — so the paste always
   * reflects the bitmap that was really produced, not the nominal request.
   */
  cssPxPerInch?: number;
}

export interface NativeRasterExportWarning {
  code: string;
  message: string;
  severity: "warning";
}

export interface NativeRasterExportResult {
  bytes: Uint8Array;
  width: number;
  height: number;
  warnings: NativeRasterExportWarning[];
}

interface NativeRasterExportResponse {
  bytes: number[] | Uint8Array;
  width: number;
  height: number;
  warnings?: NativeRasterExportWarning[];
}

export class PngOutputLimitError extends Error {
  constructor() { super("PNG output exceeds the requested byte limit."); }
}

export async function rasterizeSvgNative(
  svg: string,
  format: NativeRasterExportFormat,
  options: NativeRasterExportOptions = {}
): Promise<NativeRasterExportResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  // PNG pictures are decoded here, in the webview, and reach Rust as checked RGBA pixels: native
  // code never decodes a bitmap (see rasterPictureDecode.ts). Base64 fields keep the request JSON;
  // the command's argument shape is unchanged when a drawing has no PNG pictures.
  const prepared = await prepareRasterPictures(svg, { budgetBytes: options.pictureBudgetBytes });
  const response = await invoke<NativeRasterExportResponse>("rasterize_svg", {
    request: {
      svg: prepared.svg,
      ...(prepared.pictures.length > 0 ? { pictures: prepared.pictures } : {}),
      format,
      scale: options.scale,
      background: options.background,
      jpegQuality: options.jpegQuality,
      maxDimensionPx: options.maxDimensionPx,
      ...(options.maxPngBytes === undefined ? {} : { maxPngBytes: options.maxPngBytes }),
      cssPxPerInch: options.cssPxPerInch
    }
  }).catch(error => {
    if (error === "PNG output exceeds the requested byte limit.") throw new PngOutputLimitError();
    throw error;
  });
  if (format === "png" && options.maxPngBytes !== undefined && response.bytes.length > options.maxPngBytes) {
    throw new PngOutputLimitError();
  }

  return {
    bytes: response.bytes instanceof Uint8Array ? response.bytes : Uint8Array.from(response.bytes),
    width: response.width,
    height: response.height,
    warnings: response.warnings ?? []
  };
}
