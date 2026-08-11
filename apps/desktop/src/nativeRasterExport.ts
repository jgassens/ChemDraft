export type NativeRasterExportFormat = "png" | "jpeg" | "bmp" | "gif" | "tiff";

export interface NativeRasterExportOptions {
  scale?: number;
  background?: string;
  jpegQuality?: number;
  maxDimensionPx?: number;
  pixelsPerInch?: number;
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
      pixelsPerInch: options.pixelsPerInch
    }
  });

  return {
    bytes: response.bytes instanceof Uint8Array ? response.bytes : Uint8Array.from(response.bytes),
    width: response.width,
    height: response.height,
    warnings: response.warnings ?? []
  };
}
