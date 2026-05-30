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

export const inchRulerUnit: RulerUnitState = {
  kind: "inch",
  label: "in",
  pixelsPerUnit: 96,
  subdivisions: 8
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
