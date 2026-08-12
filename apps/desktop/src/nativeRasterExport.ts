export type NativeRasterExportFormat = "png" | "jpeg" | "bmp" | "gif" | "tiff";

export interface NativeRasterExportOptions {
  scale?: number;
  background?: string;
  jpegQuality?: number;
  maxDimensionPx?: number;
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

export async function rasterizeSvgNative(
  svg: string,
  format: NativeRasterExportFormat,
  options: NativeRasterExportOptions = {}
): Promise<NativeRasterExportResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke<NativeRasterExportResponse>("rasterize_svg", {
    request: {
      svg,
      format,
      scale: options.scale,
      background: options.background,
      jpegQuality: options.jpegQuality,
      maxDimensionPx: options.maxDimensionPx,
      cssPxPerInch: options.cssPxPerInch
    }
  });

  return {
    bytes: response.bytes instanceof Uint8Array ? response.bytes : Uint8Array.from(response.bytes),
    width: response.width,
    height: response.height,
    warnings: response.warnings ?? []
  };
}
