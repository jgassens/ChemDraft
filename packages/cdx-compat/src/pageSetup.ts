import {
  createCustomPageLayout,
  createPageLayout,
  cssPxToPageSize,
  PageSizePresets,
  type DocumentPage,
  type PageMargin
} from "@chemdraft/chem-core";
import { utf8String } from "./sha256";

type Attributes = Record<string, string>;
// The visible writer rounds coordinates to four decimal places in points.
const coordinateTolerance = 0.00005;
export interface PageContentBounds { left: number; top: number; right: number; bottom: number }
export interface VisiblePageSetup {
  attributes: Attributes;
  rootAttributes: Attributes;
  offset?: { x: number; y: number };
  unrepresentable?: boolean;
}

// These document-level settings belong to the source page setup, independently of drawing styles.
const rootPageAttributes = new Set([
  "PrintMargins", "MacPrintInfo", "WinPrintInfo", "Orientation", "PageOrientation",
  "Width", "Height", "WidthPages", "HeightPages", "DrawingSpace", "PageOverlap",
  "Header", "HeaderPosition", "Footer", "FooterPosition", "PrintTrimMarks"
]);
const regeneratedAttributes = new Set([
  "BoundingBox", "Width", "Height", "WidthPages", "HeightPages", "PrintMargins",
  "MacPrintInfo", "WinPrintInfo", "Orientation", "PageOrientation", "attrib4346"
]);

function attributes(value: unknown): Attributes {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([name, text]) =>
    /^[a-z_][\w.:-]*$/i.test(name) && typeof text === "string")) as Attributes;
}

function tuple(text: string | undefined, size: number): number[] | undefined {
  if (!text?.trim()) return undefined;
  const values = text.trim().split(/\s+/).map(Number);
  return values.length === size && values.every(Number.isFinite) ? values : undefined;
}

function pageCount(text: string | undefined): number | undefined {
  if (text === undefined) return 1;
  const count = Number(text);
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

function nativeSetup(page: DocumentPage): string {
  const { margin, layout } = page;
  // Schema parsing can reorder object keys; compare field values rather than object spelling.
  return JSON.stringify([page.width, page.height, margin.top, margin.left, margin.bottom, margin.right,
    layout.presetId, layout.orientation, layout.widthPx, layout.heightPx,
    layout.marginTopPx, layout.marginLeftPx, layout.marginBottomPx, layout.marginRightPx,
    layout.sourceUnit, layout.sourceWidth, layout.sourceHeight]);
}

function paperPreset(width: number, height: number) {
  return PageSizePresets.find(preset => preset.id !== "custom"
    && Math.abs(preset.widthPx * 0.75 - Math.min(width, height)) < 0.02
    && Math.abs(preset.heightPx * 0.75 - Math.max(width, height)) < 0.02);
}

/** Preserve source spelling before origin restoration touches any visible coordinate attributes. */
export function importPageSetup(page: DocumentPage, source: Attributes, root: Attributes): DocumentPage {
  const rootAttributes = Object.fromEntries(Object.entries(root).filter(([name]) => rootPageAttributes.has(name)));
  const box = tuple(source.BoundingBox, 4);
  // PrintMargins is top/left/bottom/right, unlike the left/top/right/bottom BoundingBox.
  const margins = tuple(source.PrintMargins ?? root.PrintMargins, 4);
  const validMargins = margins?.every(value => value >= 0) ? margins : undefined;
  const margin: PageMargin = validMargins ? {
    top: validMargins[0] / 0.75, left: validMargins[1] / 0.75,
    bottom: validMargins[2] / 0.75, right: validMargins[3] / 0.75
  } : page.margin;
  let width: number | undefined, height: number | undefined;
  if (box && box[2] > box[0] && box[3] > box[1]) {
    const columns = pageCount(source.WidthPages ?? root.WidthPages);
    const rows = pageCount(source.HeightPages ?? root.HeightPages);
    const counted = source.WidthPages !== undefined || source.HeightPages !== undefined
      || root.WidthPages !== undefined || root.HeightPages !== undefined;
    if (counted && validMargins && columns && rows) {
      width = (box[2] - box[0]) / columns + validMargins[1] + validMargins[3];
      height = (box[3] - box[1]) / rows + validMargins[0] + validMargins[2];
    } else if (!counted && !validMargins) {
      // The plain, uncounted form describes paper rather than a printable-page grid.
      width = box[2] - box[0]; height = box[3] - box[1];
    } else if (!counted && validMargins) {
      // With no counts, accept a recognised paper size only when exactly one convention fits.
      const plain = [box[2] - box[0], box[3] - box[1]];
      const printable = [plain[0] + validMargins[1] + validMargins[3], plain[1] + validMargins[0] + validMargins[2]];
      const plainPreset = paperPreset(plain[0], plain[1]);
      const printablePreset = paperPreset(printable[0], printable[1]);
      if (Boolean(plainPreset) !== Boolean(printablePreset)
          || plainPreset && plain[0] === printable[0] && plain[1] === printable[1]) {
        [width, height] = plainPreset ? plain : printable;
      }
    }
  }
  let mapped = page;
  if (width && height && [width / 0.75, height / 0.75, ...Object.values(margin)].every(Number.isFinite)) {
    let layout = createCustomPageLayout(width / 0.75, height / 0.75, "css-px", margin);
    const orientation = width > height ? "landscape" : "portrait";
    const preset = paperPreset(width, height);
    if (preset) layout = { ...layout, presetId: preset.id, orientation, sourceUnit: preset.sourceUnit,
      sourceWidth: cssPxToPageSize(layout.widthPx, preset.sourceUnit),
      sourceHeight: cssPxToPageSize(layout.heightPx, preset.sourceUnit) };
    mapped = { ...page, width: layout.widthPx, height: layout.heightPx, margin, layout };
  } else if (validMargins && Object.values(margin).every(Number.isFinite)) {
    mapped = { ...page, margin, layout: { ...page.layout,
      marginTopPx: margin.top, marginRightPx: margin.right,
      marginBottomPx: margin.bottom, marginLeftPx: margin.left } };
  }
  return { ...mapped, compatibility: { sourceFormat: "cdxml", originalId: source.id, warnings: [], unknown: {
    cdxmlPageAttributes: { ...source }, cdxmlRootPageAttributes: rootAttributes,
    cdxmlPageNativeSetup: nativeSetup(mapped)
  } } };
}

function sourceOffset(source: Attributes): { x: number; y: number } | undefined {
  const encoded = source.attrib4346;
  if (encoded === undefined) return { x: 0, y: 0 };
  try {
    if (!/^\|x\|(?:[0-9a-f]{2})+$/i.test(encoded)) return undefined;
    const value: unknown = JSON.parse(utf8String(new Uint8Array(encoded.slice(3).match(/../g)!.map(value => parseInt(value, 16)))));
    if (Array.isArray(value) && value.length === 2 && value.every(value => typeof value === "number" && Number.isFinite(value))) {
      return { x: value[0], y: value[1] };
    }
  } catch { /* Invalid origin metadata was already reported by the importer. */ }
  return undefined;
}

const number = (value: number): string => Number(value.toFixed(4)).toString();

export function pagePrintMargins(page: DocumentPage): string {
  const margin = page.margin;
  return [margin.top, margin.left, margin.bottom, margin.right].map(value => number(value * 0.75)).join(" ");
}

export function equalPrintMargins(left: string | undefined, right: string | undefined): boolean {
  const a = tuple(left, 4), b = tuple(right, 4);
  return Boolean(a && b && a.every((value, index) => Math.abs(value - b[index]) <= coordinateTolerance));
}

export function fitPageSetup(page: DocumentPage, bounds: PageContentBounds, allowPlain: boolean,
  printMargins = pagePrintMargins(page)): VisiblePageSetup {
  const source = attributes(page.compatibility?.unknown.cdxmlPageAttributes);
  const sourceRoot = attributes(page.compatibility?.unknown.cdxmlRootPageAttributes);
  const box = tuple(source.BoundingBox, 4);
  const originalOffset = sourceOffset(source);
  const sourceMargins = source.PrintMargins ?? sourceRoot.PrintMargins;
  const counted = source.WidthPages !== undefined || source.HeightPages !== undefined
    || sourceRoot.WidthPages !== undefined || sourceRoot.HeightPages !== undefined;
  // A preserved grid is valid only for the document-wide margins that will actually be written.
  const matchingMargins = equalPrintMargins(pagePrintMargins(page), printMargins)
    && (sourceMargins === undefined ? !counted : equalPrintMargins(sourceMargins, printMargins));
  if (page.compatibility?.unknown.cdxmlPageNativeSetup === nativeSetup(page) && box && originalOffset
      && matchingMargins
      && bounds.left + originalOffset.x >= box[0] - coordinateTolerance && bounds.top + originalOffset.y >= box[1] - coordinateTolerance
      && bounds.right + originalOffset.x <= box[2] + coordinateTolerance && bounds.bottom + originalOffset.y <= box[3] + coordinateTolerance) {
    return { attributes: source, rootAttributes: sourceRoot,
      ...(originalOffset.x || originalOffset.y ? { offset: originalOffset } : {}) };
  }

  const paperWidth = page.width * 0.75, paperHeight = page.height * 0.75;
  const margin = page.margin;
  const [marginTop, marginLeft, marginBottom, marginRight] = tuple(printMargins, 4)!;
  const printableWidth = paperWidth - marginLeft - marginRight;
  const printableHeight = paperHeight - marginTop - marginBottom;
  // Preserve the established padding and reversible offset for strokes and arrowheads.
  const offset = { x: bounds.left < 0 ? Math.ceil(18 - bounds.left) : 0,
    y: bounds.top < 0 ? Math.ceil(18 - bounds.top) : 0 };
  const right = Math.max(0, bounds.right + offset.x);
  const bottom = Math.max(0, bounds.bottom + offset.y);
  const defaultPage = createPageLayout("letter");
  const plain = allowPlain && !Object.keys(source).length && paperWidth === 612 && paperHeight === 792
    && page.layout.orientation === "portrait"
    && margin.top === defaultPage.marginTopPx && margin.left === defaultPage.marginLeftPx
    && margin.bottom === defaultPage.marginBottomPx && margin.right === defaultPage.marginRightPx
    && right <= paperWidth && bottom <= paperHeight;
  const columns = Math.max(1, Math.ceil((right - coordinateTolerance) / printableWidth));
  const rows = Math.max(1, Math.ceil((bottom - coordinateTolerance) / printableHeight));
  const width = plain ? paperWidth : columns * printableWidth;
  const height = plain ? paperHeight : rows * printableHeight;
  const finite = printableWidth > 0 && printableHeight > 0
    && [offset.x, offset.y, width / 0.75, height / 0.75, bounds.right + offset.x, bounds.bottom + offset.y].every(Number.isFinite);
  const kept = Object.fromEntries(Object.entries(source).filter(([name]) => !regeneratedAttributes.has(name)));
  const keptRoot = Object.fromEntries(Object.entries(sourceRoot).filter(([name]) => !regeneratedAttributes.has(name)));
  if (!finite) {
    // An impossible fit must never translate only part of a page or serialize Infinity/NaN.
    // Retain each representable unshifted extent, as in the original overflow guard.
    const fallback = (extent: number, paper: number, minimum: number): number => {
      const fitted = Math.max(minimum, paper, Math.ceil(extent + 18));
      return Number.isFinite(fitted / 0.75) ? fitted : Math.max(minimum, paper);
    };
    return { attributes: { ...kept, BoundingBox: `0 0 ${number(fallback(bounds.right, paperWidth, 612))} ${number(fallback(bounds.bottom, paperHeight, 792))}` },
      rootAttributes: keptRoot, unrepresentable: true };
  }
  return { attributes: { ...kept, BoundingBox: `0 0 ${number(width)} ${number(height)}`,
    ...(!plain ? { WidthPages: String(columns), HeightPages: String(rows) } : {}) },
    rootAttributes: { ...keptRoot, ...(!plain ? { PrintMargins: printMargins } : {}) },
    ...(offset.x || offset.y ? { offset } : {}) };
}
