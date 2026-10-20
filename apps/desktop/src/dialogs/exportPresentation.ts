import type { ExportDialogState } from "./exportOptions";
export function defaultExportPresentation(frame: { width: number; height: number }): NonNullable<ExportDialogState["presentation"]> {
 return { width: Math.max(1, Math.round(frame.width)), dpi: 96, crop: "page", background: "white", linked: true, preset: "custom" };
}
export function exportDialogHeight(presentation: NonNullable<ExportDialogState["presentation"]>, ratio: number): number {
  return presentation.linked === false || presentation.height !== undefined ? (presentation.height ?? NaN) : Math.max(1, Math.round(presentation.width * ratio));
}

export function exportDialogSizeError(state: ExportDialogState, ratio: number): string | undefined {
  const presentation = state.presentation ?? defaultExportPresentation({ width: 800, height: 600 });
  const { width, dpi } = presentation;
  const height = exportDialogHeight(presentation, ratio);
  if (!Number.isInteger(width) || width < 1 || width > 8192 || !Number.isInteger(height) || height < 1 || height > 8192) {
    return "Export dimensions must be whole pixels from 1 to 8192 on each side. Reduce the width or height, or choose a size preset to fit the frame.";
  }
  if (!Number.isFinite(dpi) || dpi < 36 || dpi > 1200) {
    return "DPI must be between 36 and 1200. Enter a value in that range.";
  }
  if (state.format === "pdf" && Math.max(width, height) / dpi * 72 > 14400) {
    return "PDF page size exceeds 14400 points (200 inches) per side. Reduce the pixel dimensions or increase DPI.";
  }
  return undefined;
}
