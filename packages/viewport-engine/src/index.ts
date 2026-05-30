export interface Point {
  x: number;
  y: number;
}

export interface RulerUnitState {
  kind: "inch" | "centimeter" | "pixel";
  label: string;
  pixelsPerUnit: number;
  subdivisions: number;
}

export interface ViewportState {
  scale: number;
  translateX: number;
  translateY: number;
  scrollOriginX: number;
  scrollOriginY: number;
  pageOriginX: number;
  pageOriginY: number;
  rulerUnit: RulerUnitState;
  minZoom: number;
  maxZoom: number;
}

export interface ViewportOptions {
  scale?: number;
  translateX?: number;
  translateY?: number;
  scrollOriginX?: number;
  scrollOriginY?: number;
  pageOriginX?: number;
  pageOriginY?: number;
  rulerUnit?: RulerUnitState;
  minZoom?: number;
  maxZoom?: number;
}

export interface RulerRenderState {
  scrollPos: number;
  zoom: number;
  unit: number;
  segment: number;
  range: [number, number];
}

export type RulerTickKind = "major" | "mid" | "minor";

export interface RulerTick {
  value: number;
  position: number;
  label: string;
  kind: RulerTickKind;
}

export interface RulerTickOptions {
  visibleLengthPx: number;
  scrollOffsetPx: number;
  pageLengthPx: number;
  rulerUnit?: RulerUnitState;
  scale?: number;
}

export const inchRulerUnit: RulerUnitState = {
  kind: "inch",
  label: "in",
  pixelsPerUnit: 96,
  subdivisions: 8
};

export const centimeterRulerUnit: RulerUnitState = {
  kind: "centimeter",
  label: "cm",
  pixelsPerUnit: 96 / 2.54,
  subdivisions: 10
};

export function createViewportState(options: ViewportOptions = {}): ViewportState {
  const minZoom = options.minZoom ?? 0.5;
  const maxZoom = options.maxZoom ?? 2;

  return {
    scale: clamp(options.scale ?? 1, minZoom, maxZoom),
    translateX: options.translateX ?? 0,
    translateY: options.translateY ?? 0,
    scrollOriginX: options.scrollOriginX ?? 0,
    scrollOriginY: options.scrollOriginY ?? 0,
    pageOriginX: options.pageOriginX ?? 0,
    pageOriginY: options.pageOriginY ?? 0,
    rulerUnit: options.rulerUnit ?? inchRulerUnit,
    minZoom,
    maxZoom
  };
}

export function screenToPage(point: Point, viewport: ViewportState): Point {
  return {
    x: (point.x - viewport.pageOriginX - viewport.translateX + viewport.scrollOriginX) / viewport.scale,
    y: (point.y - viewport.pageOriginY - viewport.translateY + viewport.scrollOriginY) / viewport.scale
  };
}

export function pageToScreen(point: Point, viewport: ViewportState): Point {
  return {
    x: point.x * viewport.scale + viewport.pageOriginX + viewport.translateX - viewport.scrollOriginX,
    y: point.y * viewport.scale + viewport.pageOriginY + viewport.translateY - viewport.scrollOriginY
  };
}

export function setViewportScale(viewport: ViewportState, scale: number): ViewportState {
  return {
    ...viewport,
    scale: clamp(scale, viewport.minZoom, viewport.maxZoom)
  };
}

export function zoomViewportAtPoint(viewport: ViewportState, nextScale: number, focalScreenPoint: Point): ViewportState {
  const scale = clamp(nextScale, viewport.minZoom, viewport.maxZoom);
  const focalPagePoint = screenToPage(focalScreenPoint, viewport);

  return {
    ...viewport,
    scale,
    translateX: focalScreenPoint.x - viewport.pageOriginX + viewport.scrollOriginX - focalPagePoint.x * scale,
    translateY: focalScreenPoint.y - viewport.pageOriginY + viewport.scrollOriginY - focalPagePoint.y * scale
  };
}

export function zoomViewportBy(viewport: ViewportState, scaleDelta: number, focalScreenPoint: Point): ViewportState {
  return zoomViewportAtPoint(viewport, viewport.scale * scaleDelta, focalScreenPoint);
}

export function wheelDeltaToZoomFactor(deltaY: number, sensitivity = 0.002): number {
  return Math.exp(-deltaY * sensitivity);
}

export function createRulerRenderState(
  viewport: ViewportState,
  pageLengthPx: number,
  scrollOffsetPx: number
): RulerRenderState {
  const zoom = viewport.rulerUnit.pixelsPerUnit * viewport.scale;
  const pageLengthInUnits = pageLengthPx / viewport.rulerUnit.pixelsPerUnit;

  return {
    scrollPos: scrollOffsetPx / viewport.rulerUnit.pixelsPerUnit,
    zoom,
    unit: 1,
    segment: viewport.rulerUnit.subdivisions,
    range: [0, pageLengthInUnits]
  };
}

export function buildRulerTicks(options: RulerTickOptions): RulerTick[] {
  const rulerUnit = options.rulerUnit ?? inchRulerUnit;
  const scale = options.scale ?? 1;
  const unitPx = rulerUnit.pixelsPerUnit * scale;
  const subdivisionPx = unitPx / rulerUnit.subdivisions;
  const pageLengthPx = Math.max(0, options.pageLengthPx * scale);
  const visibleLengthPx = Math.max(0, options.visibleLengthPx);
  const scrollOffsetPx = options.scrollOffsetPx * scale;
  const firstTick = Math.floor(scrollOffsetPx / subdivisionPx) - 1;
  const lastTick = Math.ceil((scrollOffsetPx + visibleLengthPx) / subdivisionPx) + 1;
  const ticks: RulerTick[] = [];

  for (let index = firstTick; index <= lastTick; index += 1) {
    const pagePosition = index * subdivisionPx;
    if (pagePosition < 0 || pagePosition > pageLengthPx) {
      continue;
    }

    const subdivisionIndex = positiveModulo(index, rulerUnit.subdivisions);
    const value = index / rulerUnit.subdivisions;
    ticks.push({
      value,
      position: pagePosition - scrollOffsetPx,
      label: subdivisionIndex === 0 ? formatRulerLabel(value, rulerUnit) : "",
      kind: rulerTickKind(subdivisionIndex, rulerUnit.subdivisions)
    });
  }

  return ticks;
}

export function viewportCssVars(viewport: ViewportState): Record<string, string | number> {
  return {
    "--page-scale": viewport.scale,
    "--page-translate-x": `${viewport.translateX}px`,
    "--page-translate-y": `${viewport.translateY}px`,
    "--ruler-unit-px": `${viewport.rulerUnit.pixelsPerUnit * viewport.scale}px`,
    "--ruler-minor-px": `${(viewport.rulerUnit.pixelsPerUnit / viewport.rulerUnit.subdivisions) * viewport.scale}px`
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rulerTickKind(subdivisionIndex: number, subdivisions: number): RulerTickKind {
  if (subdivisionIndex === 0) {
    return "major";
  }

  if (subdivisionIndex === subdivisions / 2) {
    return "mid";
  }

  return "minor";
}

function formatRulerLabel(value: number, rulerUnit: RulerUnitState): string {
  if (rulerUnit.kind === "pixel") {
    return String(Math.round(value));
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
