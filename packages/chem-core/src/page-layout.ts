export const CSS_PX_PER_INCH = 96;
export const MM_PER_INCH = 25.4;
export const PAGE_LAYOUT_TOLERANCE = 0.000001;

export const PageSizePresetIds = [
  "letter",
  "legal",
  "tabloid",
  "a0",
  "a1",
  "a2",
  "a3",
  "a4",
  "a5",
  "a6",
  "a7",
  "a8",
  "a9",
  "a10",
  "custom"
] as const;

export const PageSizeUnits = ["inch", "mm", "css-px"] as const;
export const PageOrientations = ["portrait", "landscape"] as const;

export type PageSizePresetId = (typeof PageSizePresetIds)[number];
export type PageSizeUnit = (typeof PageSizeUnits)[number];
export type PageOrientation = (typeof PageOrientations)[number];
export type PageSizeCategory = "us" | "iso-a" | "custom";

export interface PageMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PageSizePreset {
  id: PageSizePresetId;
  title: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceUnit: PageSizeUnit;
  widthPx: number;
  heightPx: number;
  defaultMarginsPx: PageMargin;
  category: PageSizeCategory;
}

export interface PageLayout {
  presetId: PageSizePresetId;
  orientation: PageOrientation;
  widthPx: number;
  heightPx: number;
  marginTopPx: number;
  marginRightPx: number;
  marginBottomPx: number;
  marginLeftPx: number;
  sourceUnit?: PageSizeUnit;
  sourceWidth?: number;
  sourceHeight?: number;
}

export const DefaultPageMarginPx: PageMargin = {
  top: 72,
  right: 72,
  bottom: 72,
  left: 72
};

export const PageSizePresets: readonly PageSizePreset[] = [
  inchPreset("letter", "US Letter", 8.5, 11),
  inchPreset("legal", "US Legal", 8.5, 14),
  inchPreset("tabloid", "Tabloid / Ledger", 11, 17),
  mmPreset("a0", "A0", 841, 1189),
  mmPreset("a1", "A1", 594, 841),
  mmPreset("a2", "A2", 420, 594),
  mmPreset("a3", "A3", 297, 420),
  mmPreset("a4", "A4", 210, 297),
  mmPreset("a5", "A5", 148, 210),
  mmPreset("a6", "A6", 105, 148),
  mmPreset("a7", "A7", 74, 105),
  mmPreset("a8", "A8", 52, 74),
  mmPreset("a9", "A9", 37, 52),
  mmPreset("a10", "A10", 26, 37),
  {
    id: "custom",
    title: "Custom",
    sourceWidth: 8.5,
    sourceHeight: 11,
    sourceUnit: "inch",
    widthPx: inchesToCssPx(8.5),
    heightPx: inchesToCssPx(11),
    defaultMarginsPx: DefaultPageMarginPx,
    category: "custom"
  }
];

export const MinimalPageSizePresetIds = ["letter", "legal", "a4", "a3", "a2", "a1", "a0", "a5"] as const;
export const DefaultPageLayout = createPageLayout("letter", "portrait");

export function inchesToCssPx(inches: number): number {
  return inches * CSS_PX_PER_INCH;
}

export function mmToCssPx(mm: number): number {
  return (mm / MM_PER_INCH) * CSS_PX_PER_INCH;
}

export function findPageSizePreset(presetId: PageSizePresetId): PageSizePreset {
  const preset = PageSizePresets.find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw new Error(`Unknown page size preset "${presetId}".`);
  }

  return preset;
}

export function createPageLayout(
  presetId: PageSizePresetId,
  orientation: PageOrientation = "portrait",
  margins: PageMargin = findPageSizePreset(presetId).defaultMarginsPx
): PageLayout {
  const preset = findPageSizePreset(presetId);
  const landscape = orientation === "landscape";

  return {
    presetId,
    orientation,
    widthPx: landscape ? preset.heightPx : preset.widthPx,
    heightPx: landscape ? preset.widthPx : preset.heightPx,
    marginTopPx: margins.top,
    marginRightPx: margins.right,
    marginBottomPx: margins.bottom,
    marginLeftPx: margins.left,
    sourceUnit: preset.sourceUnit,
    sourceWidth: landscape ? preset.sourceHeight : preset.sourceWidth,
    sourceHeight: landscape ? preset.sourceWidth : preset.sourceHeight
  };
}

export function pageMarginFromLayout(layout: PageLayout): PageMargin {
  return {
    top: layout.marginTopPx,
    right: layout.marginRightPx,
    bottom: layout.marginBottomPx,
    left: layout.marginLeftPx
  };
}

export function pageLayoutMatchesSize(layout: PageLayout, width: number, height: number): boolean {
  return (
    Math.abs(layout.widthPx - width) <= PAGE_LAYOUT_TOLERANCE &&
    Math.abs(layout.heightPx - height) <= PAGE_LAYOUT_TOLERANCE
  );
}

export function pageLayoutSvgSize(layout: PageLayout): { width: string; height: string } {
  const sourceUnit = layout.sourceUnit ?? "css-px";
  const sourceWidth = layout.sourceWidth ?? layout.widthPx;
  const sourceHeight = layout.sourceHeight ?? layout.heightPx;

  if (sourceUnit === "inch") {
    return {
      width: `${formatPhysicalLength(sourceWidth)}in`,
      height: `${formatPhysicalLength(sourceHeight)}in`
    };
  }

  if (sourceUnit === "mm") {
    return {
      width: `${formatPhysicalLength(sourceWidth)}mm`,
      height: `${formatPhysicalLength(sourceHeight)}mm`
    };
  }

  return {
    width: `${formatPhysicalLength(layout.widthPx)}px`,
    height: `${formatPhysicalLength(layout.heightPx)}px`
  };
}

function inchPreset(id: PageSizePresetId, title: string, widthInches: number, heightInches: number): PageSizePreset {
  return {
    id,
    title,
    sourceWidth: widthInches,
    sourceHeight: heightInches,
    sourceUnit: "inch",
    widthPx: inchesToCssPx(widthInches),
    heightPx: inchesToCssPx(heightInches),
    defaultMarginsPx: DefaultPageMarginPx,
    category: "us"
  };
}

function mmPreset(id: PageSizePresetId, title: string, widthMm: number, heightMm: number): PageSizePreset {
  return {
    id,
    title,
    sourceWidth: widthMm,
    sourceHeight: heightMm,
    sourceUnit: "mm",
    widthPx: mmToCssPx(widthMm),
    heightPx: mmToCssPx(heightMm),
    defaultMarginsPx: DefaultPageMarginPx,
    category: "iso-a"
  };
}

function formatPhysicalLength(value: number): string {
  return Number(value.toFixed(6)).toString();
}
