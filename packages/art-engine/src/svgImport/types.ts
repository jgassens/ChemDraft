import type { GraphicObject, GroupObject, TextObject } from "@chemdraft/chem-core";

export const SVG_IMPORT_MAX_ELEMENTS = 20_000;
export const SVG_IMPORT_MAX_OBJECTS = 20_000;
export const SVG_IMPORT_MAX_EXPANDED_ELEMENTS = 40_000;
export const SVG_IMPORT_MAX_PATH_CHARS = 2_000_000;
export const SVG_IMPORT_MAX_SOURCE_CHARS = 20 * 1024 * 1024;
export const SVG_IMPORT_MAX_DEPTH = 128;
export const SVG_IMPORT_MAX_REFERENCE_DEPTH = 32;

export type SvgImportReportCode = `svgImport.${
  | "unsupported_element" | "unsupported_attribute" | "stylesheet_not_kept" | "invalid_geometry"
  | "pattern_fill_not_kept" | "mask_not_kept" | "filter_not_kept" | "image_not_kept"
  | "paint_not_kept" | "gradient_not_kept" | "clip_not_kept" | "clip_curve_sampled"
  | "viewport_clip_not_kept" | "fill_rule_not_kept" | "stroke_transform_approximated"
  | "group_opacity_approximated" | "text_not_kept" | "text_style_not_kept"
  | "reference_not_kept" | "reference_cycle" | "reference_depth"
}`;

export interface SvgImportReportEntry {
  code: SvgImportReportCode;
  elementCount: number;
  detail: string;
}

export interface SvgImportFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface SvgImportOptions {
  frame: SvgImportFrame;
  idFactory: () => string;
  domParser: Pick<DOMParser, "parseFromString">;
}

export type SvgImportObject = GraphicObject | GroupObject | TextObject;

export interface SvgImportResult {
  objects: SvgImportObject[];
  /** The roots of the returned object forest, in paint order. */
  selectionIds: string[];
  report: { exact: boolean; entries: SvgImportReportEntry[] };
}

export type SvgImportErrorCode =
  | "invalid_svg" | "invalid_frame" | "element_limit" | "object_limit" | "path_limit" | "source_limit" | "depth_limit";

export class SvgImportError extends Error {
  constructor(readonly code: SvgImportErrorCode, message: string) {
    super(message);
    this.name = "SvgImportError";
  }
}

export type ReportLoss = (code: SvgImportReportCode, detail: string) => void;
