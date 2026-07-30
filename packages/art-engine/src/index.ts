import type {
  GraphicEffect,
  GraphicFreehandOptions,
  GraphicFreehandPoint,
  GraphicGradientStop,
  GraphicMarker,
  GraphicObject,
  GraphicObjectData,
  GraphicPaint,
  VisualEffect,
  VisualEffectStyle
} from "@chemdraft/chem-core";
import Flatten from "@flatten-js/core";
import { getStroke, type StrokeOptions } from "perfect-freehand";
import type { PathInfo } from "roughjs/bin/core";
import rough from "roughjs/bin/rough";
import SVGPathCommander from "svg-path-commander";
import {
  getPathBBox,
  getPointAtLength,
  getTotalLength,
  isValidPath
} from "svg-path-commander/util";

const minimumArcSweepRadians = Math.PI / 180;
const maximumArcSweepRadians = Math.PI * 2 - Math.PI / 1800;
const transientFreehandPathCache = new WeakMap<GraphicObject, { revision: string; pathD?: string }>();
const defaultGlowEffectColor = "#fdd835";
export type VisualEffectKind = VisualEffect["kind"];

export interface NativeArtPoint {
  x: number;
  y: number;
}

export interface NativeArtBounds extends NativeArtPoint {
  width: number;
  height: number;
}

export type NativeArtVisualCoordinateSpace = "page" | "local";

export interface NativeArtProjectionMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface NativeArtGradientStopPlan {
  offset: number;
  color: string;
  opacity: number;
}

export type NativeArtPaintPlan =
  | { kind: "none"; opacity: number }
  | { kind: "solid"; color: string; opacity: number }
  | {
      kind: "linear-gradient";
      idHint: string;
      stops: NativeArtGradientStopPlan[];
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      gradientTransform?: string;
    }
  | {
      kind: "radial-gradient";
      idHint: string;
      stops: NativeArtGradientStopPlan[];
      cx: number;
      cy: number;
      r: number;
      fx?: number;
      fy?: number;
      gradientTransform?: string;
    };

export interface NativeArtStrokePlan {
  color: string;
  width: number;
  dasharray?: string;
  opacity: number;
  lineCap: "butt" | "round" | "square";
  lineJoin: "miter" | "round" | "bevel";
  miterLimit: number;
  paint: NativeArtPaintPlan;
}

export interface NativeArtFillPlan {
  color: string;
  mode?: string;
  opacity: number;
  paint: NativeArtPaintPlan;
}

export type NativeArtMarkerKind = GraphicMarker["kind"];

export interface NativeArtMarkerPlan {
  kind: NativeArtMarkerKind;
  sizePx: number;
  angleDegrees: number;
}

export interface NativeArtStrokeTerminalPlan {
  point: NativeArtPoint;
  direction: NativeArtPoint;
}

export type NativeArtMarkerHandleId = "markerStart" | "markerEnd";

export interface NativeArtMarkerHandlePlan {
  id: NativeArtMarkerHandleId;
  marker: NativeArtMarkerPlan;
  point: NativeArtPoint;
  terminal: NativeArtStrokeTerminalPlan;
}

export interface NativeArtCapabilities {
  supportsFill: boolean;
  supportsStroke: boolean;
  supportsDash: boolean;
  supportsLineCap: boolean;
  supportsLineJoin: boolean;
  isOpenStroke: boolean;
  isClosedShape: boolean;
  hasCorners: boolean;
}

export interface NativeArtGlossGradientPlan {
  cx: number;
  cy: number;
  r: number;
  stops: NativeArtGradientStopPlan[];
  gradientTransform?: string;
}

export interface NativeArtShadowEffectPlan {
  kind: "shadow";
  color: string;
  opacity: number;
  offsetX: number;
  offsetY: number;
  blurPx: number;
}

export interface NativeArtGlowEffectPlan {
  kind: "glow";
  color: string;
  opacity: number;
  blurPx: number;
  spreadPx: number;
}

export interface NativeArtSketchPathPlan {
  d: string;
  stroke: string;
  strokeWidth: number;
  fill?: string;
}

export interface NativeArtSketchEffectPlan {
  kind: "sketch";
  color: string;
  opacity: number;
  seed: number;
  roughness: number;
  bowing: number;
  strokeWidth: number;
  paths: NativeArtSketchPathPlan[];
}

export type NativeArtEffectPlan = NativeArtShadowEffectPlan | NativeArtGlowEffectPlan | NativeArtSketchEffectPlan;

export interface NativeArtVisualPlan {
  objectId: string;
  kind: GraphicObject["graphicKind"];
  coordinateSpace: NativeArtVisualCoordinateSpace;
  width: number;
  height: number;
  opacity: number;
  capabilities: NativeArtCapabilities;
  stroke: NativeArtStrokePlan;
  fill: NativeArtFillPlan;
  cornerRadius: number;
  effect?: string;
  effects: NativeArtEffectPlan[];
  projectionMatrix?: NativeArtProjectionMatrix;
  projectionTransform?: string;
  frameBounds: NativeArtBounds;
  line?: { x1: number; y1: number; x2: number; y2: number };
  visibleLine?: { x1: number; y1: number; x2: number; y2: number };
  pathD?: string;
  visiblePathD?: string;
  markerStart?: NativeArtMarkerPlan;
  markerEnd?: NativeArtMarkerPlan;
  markerStartTerminal?: NativeArtStrokeTerminalPlan;
  markerEndTerminal?: NativeArtStrokeTerminalPlan;
  markerHandles: NativeArtMarkerHandlePlan[];
  /** Decoration across the shaft midpoint (the no-reaction X), positioned along the sampled path. */
  shaftMark?: NativeArtShaftMarkPlan;
  projectedShapePathD?: string;
  glossGradient?: NativeArtGlossGradientPlan;
}

export interface NativeArtShaftMarkPlan {
  kind: "cross";
  point: NativeArtPoint;
  direction: NativeArtPoint;
  sizePx: number;
}

export type GraphicPathEditHandle =
  | "start"
  | "middle"
  | "end"
  // Equilibrium arrows only: drag a half-shaft's head end to lengthen or shorten that direction.
  | "shaft:forward"
  | "shaft:reverse"
  | `node:${number}`
  | `node:${number}:in`
  | `node:${number}:out`
  | `segment:${number}`;

export type GraphicPathKind = "line" | "wavy" | "arc" | "quadratic" | "polyline" | "bezier" | "freehand";

interface NativeGraphicPathNode {
  point: NativeArtPoint;
  inControl?: NativeArtPoint;
  outControl?: NativeArtPoint;
}

type NativeGraphicPathNodeData = NonNullable<GraphicObjectData["pathNodes"]>[number];

export interface GraphicPathEditPoints {
  start: NativeArtPoint;
  middle: NativeArtPoint;
  end: NativeArtPoint;
  pathKind: GraphicPathKind;
  /** Equilibrium arrows: head-end of each half-shaft, draggable to set that direction's length. The
   *  middle handle is absent for these — an equilibrium's axis is straight, so there is no curve to
   *  bend, and its slot is taken by the two shaft handles. */
  shafts?: { forward: NativeArtPoint; reverse: NativeArtPoint };
}

export interface GraphicPathNodeEditPoint {
  index: number;
  point: NativeArtPoint;
  inControl?: NativeArtPoint;
  outControl?: NativeArtPoint;
}

export interface GraphicPathNodeEditPoints {
  pathKind: Extract<GraphicPathKind, "polyline" | "bezier">;
  pathClosed: boolean;
  nodes: GraphicPathNodeEditPoint[];
}

export interface GraphicPathSegmentSplitResult {
  object: GraphicObject;
  segmentIndex: number;
  point: NativeArtPoint;
  distance: number;
}

export type NativeArtBooleanOperation = "union" | "subtract" | "intersect" | "split";

export type NativeArtBooleanSkipReason =
  | "open-shape"
  | "unsupported-shape"
  | "invalid-geometry";

export interface NativeArtBooleanSkippedInput {
  objectId: string;
  reason: NativeArtBooleanSkipReason;
}

export interface NativeArtBooleanResultPath {
  pathD: string;
  bounds: NativeArtBounds;
  area: number;
  faceCount: number;
}

export interface NativeArtBooleanOperationPlan {
  operation: NativeArtBooleanOperation;
  resultPaths: NativeArtBooleanResultPath[];
  skippedInputs: NativeArtBooleanSkippedInput[];
  eligibleInputIds: string[];
}

interface CircularGraphicArcGeometry {
  center: NativeArtPoint;
  radiusX: number;
  radiusY: number;
  startRadians: number;
  sweepRadians: number;
  endRadians: number;
}

interface NativeArtBooleanPolygonInput {
  objectId: string;
  polygon?: Flatten.Polygon;
  skipped?: NativeArtBooleanSkippedInput;
}

export function maxGraphicCornerRadius(object: GraphicObject): number {
  if (object.graphicKind !== "rect") {
    return 0;
  }
  const width = Math.max(object.width, 0);
  const height = Math.max(object.height, 0);
  return roundLayoutNumber(Math.min(width, height) / 2);
}

export function graphicCornerRadiusEditPoint(object: GraphicObject): NativeArtPoint | undefined {
  if (object.graphicKind !== "rect") {
    return undefined;
  }
  return {
    x: graphicCornerRadius(object),
    y: 0
  };
}

export function editGraphicCornerRadius(
  object: GraphicObject,
  point: NativeArtPoint
): GraphicObject | undefined {
  if (object.graphicKind !== "rect") {
    return undefined;
  }

  const maxRadius = maxGraphicCornerRadius(object);
  const clampedRadius = clamp(point.x, 0, maxRadius);
  const nextRadius = roundLayoutNumber(
    clampedRadius <= 1 ? 0 : maxRadius - clampedRadius <= 1 ? maxRadius : clampedRadius
  );
  const currentRadius = metadataNumber(object.data.cornerRadiusPx) ?? 0;
  if (Math.abs(currentRadius - nextRadius) < 0.001) {
    return object;
  }

  return {
    ...object,
    data: {
      ...object.data,
      cornerRadiusPx: nextRadius
    }
  };
}

export function planNativeArtVisual(
  object: GraphicObject,
  options: { coordinateSpace?: NativeArtVisualCoordinateSpace } = {}
): NativeArtVisualPlan {
  const coordinateSpace = options.coordinateSpace ?? "page";
  const width = Math.max(object.width, 1);
  const height = Math.max(object.height, 1);
  const matrix = nativeArtProjectionMatrixForObject(object);
  const projectionTransform = matrix ? nativeArtProjectionSvgTransform(object, coordinateSpace, matrix) : undefined;
  const opacity = clampUnit(metadataNumber(object.style.opacity) ?? 1);
  const capabilities = nativeArtCapabilities(object);
  const freehandPath = object.graphicKind === "path" && graphicPathKind(object) === "freehand";
  const rendersStroke = capabilities.supportsStroke && !freehandPath;
  const strokePaint = nativeArtStrokePaint(object, coordinateSpace, projectionTransform);
  const fillPaint = freehandPath
    ? strokePaint
    : capabilities.supportsFill
      ? nativeArtFillPaint(object, coordinateSpace, projectionTransform)
      : { kind: "none" as const, opacity: 1 };
  const stroke: NativeArtStrokePlan = {
    color: rendersStroke ? graphicColor(object.style.strokeColor, object.style.color, "#111111") : "none",
    width: rendersStroke ? metadataNumber(object.style.strokeWidth) ?? 1.5 : 0,
    dasharray: rendersStroke ? metadataString(object.style.strokeDasharray) : undefined,
    opacity: rendersStroke ? graphicStrokeOpacity(object) : 0,
    lineCap: graphicStrokeLineCap(object),
    lineJoin: graphicStrokeLineJoin(object),
    miterLimit: metadataNumber(object.style.strokeMiterLimit) ?? 4,
    paint: rendersStroke ? strokePaint : { kind: "none", opacity: 0 }
  };
  const fill: NativeArtFillPlan = {
    color: freehandPath
      ? graphicColor(object.style.strokeColor, object.style.color, "#111111")
      : capabilities.supportsFill ? graphicFillColor(object.style.fillColor) : "none",
    mode: freehandPath ? undefined : capabilities.supportsFill ? metadataString(object.style.fillMode) : undefined,
    opacity: freehandPath ? graphicStrokeOpacity(object) : capabilities.supportsFill ? graphicFillOpacity(object) : 1,
    paint: fillPaint
  };
  const frameBounds = nativeArtFrameBounds(object, matrix, coordinateSpace);
  const cornerRadius = graphicCornerRadius(object);
  const line = object.graphicKind === "line"
    ? graphicLineEndpoints(object, coordinateSpace)
    : undefined;
  const pathD = object.graphicKind === "path"
    ? graphicPathD(object, coordinateSpace)
    : undefined;
  const markerStart = rendersStroke
    ? nativeArtMarkerPlan(dualShaftScaledMarker(object, object.data.markerStart), stroke.width)
    : undefined;
  const markerEnd = rendersStroke
    ? nativeArtMarkerPlan(dualShaftScaledMarker(object, object.data.markerEnd), stroke.width)
    : undefined;
  const pathPoints = object.graphicKind === "path" && shouldSampleGraphicPathForPlan({
    object,
    matrix,
    capabilities,
    rendersStroke,
    markerStart,
    markerEnd
  })
    ? graphicPathSamplePoints(object, coordinateSpace)
    : undefined;
  // Equilibrium arrows carry two disjoint shafts in one `d`, so the generic terminal derivation (which
  // walks the path as a single polyline) would straddle the gap between them. Take the terminals
  // straight from the geometry instead: `markerEnd` heads the forward shaft, `markerStart` the reverse.
  // The shafts are pre-trimmed for their heads in `graphicPathD`, so the visible-stroke pass is a no-op.
  const equilibrium = capabilities.isOpenStroke && rendersStroke
    ? graphicEquilibriumGeometry(object, coordinateSpace)
    : undefined;
  const openStrokeTerminals = equilibrium
    ? equilibrium.head
      // Parallel (retrosynthetic): one head at the axis end, spanning both shafts. Both terminals
      // resolve to it so the head renders once wherever the marker is declared.
      ? { start: equilibrium.head, end: equilibrium.head }
      : {
          start: { point: equilibrium.reverse.end, direction: equilibrium.reverse.direction },
          end: { point: equilibrium.forward.end, direction: equilibrium.forward.direction }
        }
    : capabilities.isOpenStroke && rendersStroke
      ? nativeArtOpenStrokeTerminals(line, pathD, pathPoints)
      : undefined;
  const visibleStroke = equilibrium ? undefined : nativeArtVisibleOpenStroke({
    line,
    pathD,
    pathPoints,
    markerStart,
    markerEnd,
    markerStartTerminal: openStrokeTerminals?.start,
    markerEndTerminal: openStrokeTerminals?.end,
    strokeWidth: stroke.width
  });
  const projectedShapePathD = matrix && (object.graphicKind === "ellipse" || object.graphicKind === "rect")
    ? projectedArtShapePathD(object, coordinateSpace, matrix, stroke.width)
    : undefined;
  const effects = nativeArtEffectPlans(object, {
    coordinateSpace,
    width,
    height,
    stroke,
    fill,
    cornerRadius,
    line: visibleStroke?.line ?? line,
    pathD: visibleStroke?.pathD ?? pathD,
    projectedShapePathD,
    projectionTransform,
    capabilities
  });

  return {
    objectId: object.id,
    kind: object.graphicKind,
    coordinateSpace,
    width,
    height,
    opacity,
    capabilities,
    stroke,
    fill,
    cornerRadius,
    effect: effects[0]?.kind ?? metadataString(object.style.effect),
    effects,
    projectionMatrix: matrix,
    projectionTransform,
    frameBounds,
    line,
    visibleLine: visibleStroke?.line,
    pathD,
    visiblePathD: visibleStroke?.pathD,
    markerStart,
    markerEnd,
    markerStartTerminal: markerStart ? openStrokeTerminals?.start : undefined,
    markerEndTerminal: markerEnd ? openStrokeTerminals?.end : undefined,
    markerHandles: nativeArtMarkerHandles({
      markerStart,
      markerEnd,
      markerStartTerminal: openStrokeTerminals?.start,
      markerEndTerminal: openStrokeTerminals?.end
    }),
    shaftMark: capabilities.isOpenStroke && rendersStroke
      ? nativeArtShaftMarkPlan(object, line, pathPoints, stroke.width)
      : undefined,
    projectedShapePathD,
    glossGradient: capabilities.supportsFill && fill.mode === "gloss"
      ? nativeArtGlossGradient(object, coordinateSpace, matrix)
      : undefined
  };
}

interface NativeArtEffectPlanInput {
  coordinateSpace: NativeArtVisualCoordinateSpace;
  width: number;
  height: number;
  stroke: NativeArtStrokePlan;
  fill: NativeArtFillPlan;
  cornerRadius: number;
  line?: { x1: number; y1: number; x2: number; y2: number };
  pathD?: string;
  projectedShapePathD?: string;
  projectionTransform?: string;
  capabilities: NativeArtCapabilities;
}

function nativeArtEffectPlans(object: GraphicObject, input: NativeArtEffectPlanInput): NativeArtEffectPlan[] {
  const sketchBasePathD = visualEffectsForStyle(object.style).some((effect) => effect.kind === "sketch")
    ? nativeArtSketchBasePathD(object, input)
    : undefined;
  return visualEffectPlansForStyle({
    objectId: object.id,
    style: object.style,
    sketchBasePathD,
    sketchStrokeWidthPx: input.stroke.width
  });
}

export function visualEffectPlansForStyle({
  objectId,
  style,
  sketchBasePathD,
  sketchStrokeWidthPx = 1.5
}: {
  objectId: string;
  style: Record<string, unknown>;
  sketchBasePathD?: string;
  sketchStrokeWidthPx?: number;
}): NativeArtEffectPlan[] {
  return visualEffectsForStyle(style)
    .map((effect) => visualEffectPlan(objectId, effect, sketchBasePathD, sketchStrokeWidthPx))
    .filter((effect): effect is NativeArtEffectPlan => effect !== undefined);
}

export function visualEffectsForStyle(style: Record<string, unknown>): VisualEffect[] {
  const explicitEffects = mergeVisualEffectsByKind(
    visualEffectArray(style.effects),
    visualEffectArray(style.visualEffects)
  );
  const effects: VisualEffect[] = [];
  if (style.effect === "shadow" && !explicitEffects.some((effect) => effect.kind === "shadow")) {
    effects.push({ kind: "shadow" });
  }

  explicitEffects.forEach((effect) => {
    if (!effects.some((candidate) => candidate.kind === effect.kind)) {
      effects.push(effect);
    }
  });

  return effects;
}

export function inactiveVisualEffectsForStyle(style: Record<string, unknown>): VisualEffect[] {
  return mergeVisualEffectsByKind(
    visualEffectArray(style.inactiveEffects),
    visualEffectArray(style.inactiveVisualEffects)
  );
}

export function mergeVisualEffectsByKind(
  existingEffects: readonly VisualEffect[],
  incomingEffects: readonly VisualEffect[]
): VisualEffect[] {
  return [...existingEffects, ...incomingEffects].reduce<VisualEffect[]>((effects, effect) => {
    const existingIndex = effects.findIndex((candidate) => candidate.kind === effect.kind);
    if (existingIndex >= 0) {
      effects[existingIndex] = effect;
      return effects;
    }
    return [...effects, effect];
  }, []);
}

export function visualStyleWithEffects<TStyle extends Record<string, unknown>>(
  baseStyle: TStyle,
  effects: readonly VisualEffect[],
  inactiveEffects: readonly VisualEffect[],
  options: { includeGraphicAliases?: boolean } = {}
): TStyle & Partial<VisualEffectStyle> {
  return {
    ...baseStyle,
    ...(effects.length > 0 ? { visualEffects: [...effects] } : {}),
    ...(inactiveEffects.length > 0 ? { inactiveVisualEffects: [...inactiveEffects] } : {}),
    ...(options.includeGraphicAliases && effects.length > 0 ? { effects: [...effects] } : {}),
    ...(options.includeGraphicAliases && inactiveEffects.length > 0 ? { inactiveEffects: [...inactiveEffects] } : {})
  };
}

export function defaultVisualEffectForKind(objectId: string, kind: VisualEffectKind): VisualEffect {
  if (kind === "shadow") {
    return { kind, color: "#52616b", opacity: 0.28, offsetX: 6, offsetY: 6, blurPx: 3 };
  }
  if (kind === "glow") {
    return { kind, color: defaultGlowEffectColor, opacity: 0.42, blurPx: 7, spreadPx: 1.2 };
  }
  return { kind, color: "#111111", seed: visualEffectSeed(objectId, { kind }, kind), roughness: 1.25, bowing: 0.8, strokeWidth: 1.5 };
}

function visualEffectPlan(
  objectId: string,
  effect: VisualEffect,
  sketchBasePathD?: string,
  sketchStrokeWidthPx = 1.5
): NativeArtEffectPlan | undefined {
  if (effect.kind === "shadow") {
    return {
      kind: "shadow",
      color: graphicColor(effect.color, "#52616b"),
      opacity: clampUnit(metadataNumber(effect.opacity) ?? 0.28),
      offsetX: metadataNumber(effect.offsetX) ?? 6,
      offsetY: metadataNumber(effect.offsetY) ?? 6,
      blurPx: Math.max(0, metadataNumber(effect.blurPx) ?? 3)
    };
  }

  if (effect.kind === "glow") {
    return {
      kind: "glow",
      color: graphicColor(effect.color, defaultGlowEffectColor),
      opacity: clampUnit(metadataNumber(effect.opacity) ?? 0.42),
      blurPx: Math.max(0, metadataNumber(effect.blurPx) ?? 7),
      spreadPx: Math.max(0, metadataNumber(effect.spreadPx) ?? 1.2)
    };
  }

  return visualSketchEffectPlan(objectId, effect, sketchBasePathD, sketchStrokeWidthPx);
}

function visualSketchEffectPlan(
  objectId: string,
  effect: VisualEffect,
  basePathD: string | undefined,
  sketchStrokeWidthPx = 1.5
): NativeArtSketchEffectPlan | undefined {
  if (!basePathD) {
    return undefined;
  }

  const color = graphicColor(effect.color, "#111111");
  const strokeWidth = Math.max(0.5, sketchStrokeWidthPx, metadataNumber(effect.strokeWidth) ?? 0);
  const seed = visualEffectSeed(objectId, effect, "sketch");
  const roughness = Math.max(0, metadataNumber(effect.roughness) ?? 1.25);
  const bowing = Math.max(0, metadataNumber(effect.bowing) ?? 0.8);
  const drawable = rough.generator().path(basePathD, {
    seed,
    roughness,
    bowing,
    stroke: color,
    strokeWidth,
    fill: "none",
    disableMultiStrokeFill: true,
    preserveVertices: true,
    fixedDecimalPlaceDigits: 3
  });
  const paths = rough.generator().toPaths(drawable)
    .map((path) => nativeArtSketchPathPlan(path))
    .filter((path): path is NativeArtSketchPathPlan => path !== undefined);

  return paths.length > 0
    ? {
        kind: "sketch",
        color,
        opacity: clampUnit(metadataNumber(effect.opacity) ?? 1),
        seed,
        roughness,
        bowing,
        strokeWidth,
        paths
      }
    : undefined;
}

function nativeArtSketchPathPlan(path: PathInfo): NativeArtSketchPathPlan | undefined {
  if (!path.d.trim()) {
    return undefined;
  }

  return {
    d: path.d,
    stroke: path.stroke,
    strokeWidth: path.strokeWidth,
    fill: path.fill && path.fill !== "none" ? path.fill : undefined
  };
}

function nativeArtSketchBasePathD(object: GraphicObject, input: NativeArtEffectPlanInput): string | undefined {
  if (input.projectedShapePathD) {
    return input.projectedShapePathD;
  }

  if (object.graphicKind === "line" && input.line) {
    return `M ${formatNumber(input.line.x1)} ${formatNumber(input.line.y1)} L ${formatNumber(input.line.x2)} ${formatNumber(input.line.y2)}`;
  }

  if (object.graphicKind === "path" && input.pathD) {
    return input.pathD;
  }

  const offset = input.coordinateSpace === "page" ? { x: object.x, y: object.y } : { x: 0, y: 0 };
  if (object.graphicKind === "rect") {
    return pointsPathD(
      roundedRectPathPoints(input.width, input.height, input.cornerRadius, input.stroke.width, offset),
      true
    );
  }

  if (object.graphicKind === "ellipse") {
    return pointsPathD(ellipsePathPoints(input.width, input.height, input.stroke.width, offset), true);
  }

  return undefined;
}

function visualEffectSeed(objectId: string, effect: VisualEffect, kind: NativeArtEffectPlan["kind"]): number {
  const explicitSeed = metadataNumber(effect.seed);
  if (explicitSeed !== undefined && Number.isInteger(explicitSeed) && explicitSeed > 0) {
    return Math.min(explicitSeed, 2147483646);
  }

  return nativeArtStablePositiveSeed(`${objectId}:${kind}`);
}

function visualEffectArray(value: unknown): VisualEffect[] {
  return Array.isArray(value)
    ? value.map(visualEffectFromUnknown).filter((effect): effect is VisualEffect => effect !== undefined)
    : [];
}

function visualEffectFromUnknown(value: unknown): VisualEffect | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const kind = visualEffectKind(record.kind);
  if (!kind) {
    return undefined;
  }

  return {
    kind,
    ...(typeof record.color === "string" ? { color: record.color } : {}),
    ...(typeof record.opacity === "number" ? { opacity: clampUnit(record.opacity) } : {}),
    ...(typeof record.offsetX === "number" && Number.isFinite(record.offsetX) ? { offsetX: record.offsetX } : {}),
    ...(typeof record.offsetY === "number" && Number.isFinite(record.offsetY) ? { offsetY: record.offsetY } : {}),
    ...(typeof record.blurPx === "number" && Number.isFinite(record.blurPx) && record.blurPx >= 0 ? { blurPx: record.blurPx } : {}),
    ...(typeof record.spreadPx === "number" && Number.isFinite(record.spreadPx) ? { spreadPx: record.spreadPx } : {}),
    ...(typeof record.roughness === "number" && Number.isFinite(record.roughness) && record.roughness >= 0 ? { roughness: record.roughness } : {}),
    ...(typeof record.bowing === "number" && Number.isFinite(record.bowing) && record.bowing >= 0 ? { bowing: record.bowing } : {}),
    ...(typeof record.strokeWidth === "number" && Number.isFinite(record.strokeWidth) && record.strokeWidth > 0 ? { strokeWidth: record.strokeWidth } : {}),
    ...(typeof record.seed === "number" && Number.isInteger(record.seed) && record.seed > 0 ? { seed: record.seed } : {})
  };
}

function visualEffectKind(value: unknown): VisualEffectKind | undefined {
  return value === "shadow" || value === "glow" || value === "sketch" ? value : undefined;
}

function nativeArtStablePositiveSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2147483646 + 1;
}

function nativeArtMarkerHandles(input: {
  markerStart: NativeArtMarkerPlan | undefined;
  markerEnd: NativeArtMarkerPlan | undefined;
  markerStartTerminal: NativeArtStrokeTerminalPlan | undefined;
  markerEndTerminal: NativeArtStrokeTerminalPlan | undefined;
}): NativeArtMarkerHandlePlan[] {
  return [
    input.markerStart && input.markerStartTerminal
      ? nativeArtMarkerHandle("markerStart", input.markerStart, input.markerStartTerminal)
      : undefined,
    input.markerEnd && input.markerEndTerminal
      ? nativeArtMarkerHandle("markerEnd", input.markerEnd, input.markerEndTerminal)
      : undefined
  ].filter((handle): handle is NativeArtMarkerHandlePlan => handle !== undefined);
}

function shouldSampleGraphicPathForPlan(input: {
  object: GraphicObject;
  matrix: NativeArtProjectionMatrix | undefined;
  capabilities: NativeArtCapabilities;
  rendersStroke: boolean;
  markerStart: NativeArtMarkerPlan | undefined;
  markerEnd: NativeArtMarkerPlan | undefined;
}): boolean {
  if (input.object.graphicKind !== "path" || !graphicPathKind(input.object)) {
    return false;
  }

  if (input.matrix) {
    return true;
  }

  return input.capabilities.isOpenStroke &&
    input.rendersStroke &&
    (input.markerStart !== undefined || input.markerEnd !== undefined || input.object.data.shaftMark !== undefined);
}

function nativeArtMarkerHandle(
  id: NativeArtMarkerHandleId,
  marker: NativeArtMarkerPlan,
  terminal: NativeArtStrokeTerminalPlan
): NativeArtMarkerHandlePlan {
  const direction = markerInwardDirection(terminal) ?? { x: -1, y: 0 };
  return {
    id,
    marker,
    terminal,
    point: {
      x: roundLayoutNumber(terminal.point.x + direction.x * marker.sizePx),
      y: roundLayoutNumber(terminal.point.y + direction.y * marker.sizePx)
    }
  };
}

/** Arrowhead size increments (px) — dragging the marker handle snaps to multiples of this step. */
export const MARKER_SIZE_STEP_PX = 4;

/** Largest arrowhead the marker handle (or a size command) can set. */
export const MARKER_SIZE_MAX_PX = 96;

/** Snap an arrowhead size to the discrete steps the marker handle drags between (4, 8, … 96 px).
 *  The single source of truth for the step/limits — the handle drag and the toolbar size command
 *  both funnel through it. */
export function snapGraphicMarkerSizePx(sizePx: number): number {
  const snapped = Math.round(clamp(sizePx, MARKER_SIZE_STEP_PX, MARKER_SIZE_MAX_PX) / MARKER_SIZE_STEP_PX) * MARKER_SIZE_STEP_PX;
  return roundLayoutNumber(clamp(snapped, MARKER_SIZE_STEP_PX, MARKER_SIZE_MAX_PX));
}

export function editGraphicMarkerSize(
  object: GraphicObject,
  markerId: NativeArtMarkerHandleId,
  point: NativeArtPoint,
  options: { symmetric?: boolean } = {}
): GraphicObject | undefined {
  const plan = planNativeArtVisual(object, { coordinateSpace: "page" });
  const handle = plan.markerHandles.find((candidate) => candidate.id === markerId);
  const currentMarker = markerId === "markerStart"
    ? object.data.markerStart
    : object.data.markerEnd;
  if (!handle || !currentMarker || currentMarker.kind === "none") {
    return undefined;
  }

  const distance = Math.hypot(point.x - handle.terminal.point.x, point.y - handle.terminal.point.y);
  if (!Number.isFinite(distance)) {
    return undefined;
  }
  // Arrowhead size snaps to discrete steps (4, 8, 12, 16, … px = levels 1, 2, 3, 4, …) so dragging
  // steps cleanly between sizes instead of sliding continuously. The default 16 px lands on a step.
  const nextSize = snapGraphicMarkerSizePx(distance);

  // Symmetric resize (double-headed arrows, default): the opposite arrowhead tracks this one so both
  // heads stay the same size. Holding Shift (symmetric === false) resizes only the dragged head.
  const otherId: NativeArtMarkerHandleId = markerId === "markerStart" ? "markerEnd" : "markerStart";
  const otherMarker = otherId === "markerStart" ? object.data.markerStart : object.data.markerEnd;
  const syncOther = options.symmetric === true && otherMarker !== undefined && otherMarker.kind !== "none";

  const currentSize = metadataNumber(currentMarker.sizePx) ?? handle.marker.sizePx;
  const otherSize = syncOther ? metadataNumber(otherMarker.sizePx) : undefined;
  const draggedUnchanged = Math.abs(nextSize - currentSize) < 0.001;
  const otherUnchanged = otherSize === undefined || Math.abs(nextSize - otherSize) < 0.001;
  if (draggedUnchanged && otherUnchanged) {
    return object;
  }

  return {
    ...object,
    data: {
      ...object.data,
      [markerId]: {
        ...currentMarker,
        sizePx: nextSize
      },
      ...(syncOther ? { [otherId]: { ...otherMarker, sizePx: nextSize } } : {})
    }
  };
}

function nativeArtVisibleOpenStroke(input: {
  line: NativeArtVisualPlan["line"];
  pathD: string | undefined;
  pathPoints: NativeArtPoint[] | undefined;
  markerStart: NativeArtMarkerPlan | undefined;
  markerEnd: NativeArtMarkerPlan | undefined;
  markerStartTerminal: NativeArtStrokeTerminalPlan | undefined;
  markerEndTerminal: NativeArtStrokeTerminalPlan | undefined;
  strokeWidth: number;
}): { line?: NonNullable<NativeArtVisualPlan["line"]>; pathD?: string } | undefined {
  const startInset = input.markerStart && input.markerStartTerminal
    ? nativeArtMarkerShaftInset(input.markerStart, input.strokeWidth)
    : 0;
  const endInset = input.markerEnd && input.markerEndTerminal
    ? nativeArtMarkerShaftInset(input.markerEnd, input.strokeWidth)
    : 0;
  if (startInset <= 0 && endInset <= 0) {
    return undefined;
  }

  if (input.line) {
    const start = { x: input.line.x1, y: input.line.y1 };
    const end = { x: input.line.x2, y: input.line.y2 };
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (!Number.isFinite(length) || length <= 0.001) {
      return undefined;
    }
    const scaled = scaleTerminalInsets(startInset, endInset, length);
    const startDirection = input.markerStartTerminal
      ? markerInwardDirection(input.markerStartTerminal)
      : normalizedVector({ x: end.x - start.x, y: end.y - start.y });
    const endDirection = input.markerEndTerminal
      ? markerInwardDirection(input.markerEndTerminal)
      : normalizedVector({ x: start.x - end.x, y: start.y - end.y });
    if (!startDirection || !endDirection) {
      return undefined;
    }
    const visibleStart = {
      x: start.x + startDirection.x * scaled.start,
      y: start.y + startDirection.y * scaled.start
    };
    const visibleEnd = {
      x: end.x + endDirection.x * scaled.end,
      y: end.y + endDirection.y * scaled.end
    };
    return {
      line: {
        x1: roundLayoutNumber(visibleStart.x),
        y1: roundLayoutNumber(visibleStart.y),
        x2: roundLayoutNumber(visibleEnd.x),
        y2: roundLayoutNumber(visibleEnd.y)
      }
    };
  }

  if (!input.pathD) {
    return undefined;
  }

  if (input.pathPoints && input.pathPoints.length >= 2) {
    const points = trimNativeArtPolyline(input.pathPoints, startInset, endInset);
    if (points.length >= 2) {
      return {
        pathD: nativeArtPointsPathD(points)
      };
    }
  }

  try {
    if (!isValidPath(input.pathD)) {
      return undefined;
    }
    const length = getTotalLength(input.pathD);
    if (!Number.isFinite(length) || length <= 0.001) {
      return undefined;
    }
    const scaled = scaleTerminalInsets(startInset, endInset, length);
    const startLength = scaled.start;
    const endLength = Math.max(startLength + 0.5, length - scaled.end);
    const visibleLength = Math.max(0.5, endLength - startLength);
    const steps = Math.max(2, Math.min(96, Math.ceil(visibleLength / 6)));
    const points = Array.from({ length: steps + 1 }, (_, index) =>
      finiteSvgPathPoint(getPointAtLength(input.pathD ?? "", startLength + visibleLength * index / steps))
    ).filter((point): point is NativeArtPoint => point !== undefined);
    if (points.length < 2) {
      return undefined;
    }
    return {
      pathD: [
        `M ${formatNumber(points[0].x)} ${formatNumber(points[0].y)}`,
        ...points.slice(1).map((point) => `L ${formatNumber(point.x)} ${formatNumber(point.y)}`)
      ].join(" ")
    };
  } catch {
    return undefined;
  }
}

function nativeArtMarkerShaftInset(marker: NativeArtMarkerPlan, strokeWidth: number): number {
  if (
    marker.kind === "filled-arrow" ||
    marker.kind === "half-arrow" ||
    marker.kind === "chevron" ||
    marker.kind === "diamond"
  ) {
    return Math.max(strokeWidth * 1.5, marker.sizePx * 0.42);
  }
  if (marker.kind === "dot") {
    return marker.sizePx * 0.38;
  }
  return 0;
}

function trimNativeArtPolyline(
  points: readonly NativeArtPoint[],
  startInset: number,
  endInset: number
): NativeArtPoint[] {
  const length = nativeArtPolylineLength(points);
  if (!Number.isFinite(length) || length <= 0.001) {
    return [];
  }

  const scaled = scaleTerminalInsets(startInset, endInset, length);
  const startDistance = scaled.start;
  const endDistance = Math.max(startDistance + 0.5, length - scaled.end);
  const trimmed = [
    nativeArtPolylinePointAtLength(points, startDistance),
    ...nativeArtPolylineInteriorPoints(points, startDistance, endDistance),
    nativeArtPolylinePointAtLength(points, endDistance)
  ].filter((point): point is NativeArtPoint => point !== undefined);

  return trimmed.filter((point, index) => index === 0 || !samePoint(point, trimmed[index - 1]));
}

function nativeArtPolylineInteriorPoints(
  points: readonly NativeArtPoint[],
  startDistance: number,
  endDistance: number
): NativeArtPoint[] {
  const interior: NativeArtPoint[] = [];
  let cursor = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const segmentLength = Math.hypot(point.x - previous.x, point.y - previous.y);
    cursor += segmentLength;
    if (cursor > startDistance && cursor < endDistance) {
      interior.push(point);
    }
  }
  return interior;
}

function nativeArtPolylineLength(points: readonly NativeArtPoint[]): number {
  return points.slice(1).reduce((length, point, index) => {
    const previous = points[index];
    return length + Math.hypot(point.x - previous.x, point.y - previous.y);
  }, 0);
}

function nativeArtPolylinePointAtLength(
  points: readonly NativeArtPoint[],
  targetLength: number
): NativeArtPoint | undefined {
  if (points.length === 0) {
    return undefined;
  }
  if (targetLength <= 0) {
    return points[0];
  }

  let cursor = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const segmentLength = Math.hypot(point.x - previous.x, point.y - previous.y);
    if (cursor + segmentLength >= targetLength) {
      const t = segmentLength <= 0.001 ? 0 : (targetLength - cursor) / segmentLength;
      return {
        x: previous.x + (point.x - previous.x) * t,
        y: previous.y + (point.y - previous.y) * t
      };
    }
    cursor += segmentLength;
  }

  return points[points.length - 1];
}

/** Midpoint + local tangent of the shaft, for the no-reaction cross. Uses the sampled path points so
 *  the mark sits on the curve for arcs, or the straight line for line arrows. */
function nativeArtShaftMarkPlan(
  object: GraphicObject,
  line: NativeArtVisualPlan["line"],
  pathPoints: NativeArtPoint[] | undefined,
  strokeWidth: number
): NativeArtShaftMarkPlan | undefined {
  if (object.data.shaftMark !== "cross") {
    return undefined;
  }

  const points = pathPoints && pathPoints.length >= 2
    ? pathPoints
    : line
      ? [{ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }]
      : undefined;
  if (!points) {
    return undefined;
  }

  const halfLength = nativeArtPolylineLength(points) / 2;
  const point = nativeArtPolylinePointAtLength(points, halfLength);
  const before = nativeArtPolylinePointAtLength(points, Math.max(0, halfLength - 1));
  const after = nativeArtPolylinePointAtLength(points, halfLength + 1);
  if (!point || !before || !after) {
    return undefined;
  }

  const direction = normalizedVector({ x: after.x - before.x, y: after.y - before.y }) ?? { x: 1, y: 0 };
  return {
    kind: "cross",
    point,
    direction,
    sizePx: Math.max(12, strokeWidth * 5)
  };
}

function nativeArtPointsPathD(points: readonly NativeArtPoint[]): string {
  return [
    `M ${formatNumber(points[0]?.x ?? 0)} ${formatNumber(points[0]?.y ?? 0)}`,
    ...points.slice(1).map((point) => `L ${formatNumber(point.x)} ${formatNumber(point.y)}`)
  ].join(" ");
}

function scaleTerminalInsets(startInset: number, endInset: number, length: number): { start: number; end: number } {
  const available = Math.max(0.5, length - 0.5);
  const total = startInset + endInset;
  if (total <= available) {
    return { start: startInset, end: endInset };
  }
  const scale = available / total;
  return {
    start: startInset * scale,
    end: endInset * scale
  };
}

function markerInwardDirection(terminal: NativeArtStrokeTerminalPlan): NativeArtPoint | undefined {
  return normalizedVector({ x: -terminal.direction.x, y: -terminal.direction.y });
}

function nativeArtOpenStrokeTerminals(
  line: NativeArtVisualPlan["line"],
  pathD: string | undefined,
  pathPoints?: NativeArtPoint[]
): { start: NativeArtStrokeTerminalPlan; end: NativeArtStrokeTerminalPlan } | undefined {
  if (line) {
    const start = { x: line.x1, y: line.y1 };
    const end = { x: line.x2, y: line.y2 };
    const startDirection = normalizedVector({ x: start.x - end.x, y: start.y - end.y });
    const endDirection = normalizedVector({ x: end.x - start.x, y: end.y - start.y });
    return startDirection && endDirection
      ? {
          start: { point: start, direction: startDirection },
          end: { point: end, direction: endDirection }
        }
      : undefined;
  }

  if (!pathD) {
    return undefined;
  }

  if (pathPoints && pathPoints.length >= 2) {
    const length = nativeArtPolylineLength(pathPoints);
    if (!Number.isFinite(length) || length <= 0.001) {
      return undefined;
    }
    const sampleOffset = Math.min(length, Math.max(1, length * 0.02));
    const start = pathPoints[0];
    const startNear = nativeArtPolylinePointAtLength(pathPoints, sampleOffset);
    const end = pathPoints[pathPoints.length - 1];
    const endNear = nativeArtPolylinePointAtLength(pathPoints, Math.max(0, length - sampleOffset));
    if (!startNear || !endNear) {
      return undefined;
    }
    const startDirection = normalizedVector({ x: start.x - startNear.x, y: start.y - startNear.y });
    const endDirection = normalizedVector({ x: end.x - endNear.x, y: end.y - endNear.y });
    return startDirection && endDirection
      ? {
          start: { point: start, direction: startDirection },
          end: { point: end, direction: endDirection }
        }
      : undefined;
  }

  try {
    if (!isValidPath(pathD)) {
      return undefined;
    }
    const length = getTotalLength(pathD);
    if (!Number.isFinite(length) || length <= 0.001) {
      return undefined;
    }

    const sampleOffset = Math.min(length, Math.max(1, length * 0.02));
    const start = finiteSvgPathPoint(getPointAtLength(pathD, 0));
    const startNear = finiteSvgPathPoint(getPointAtLength(pathD, sampleOffset));
    const end = finiteSvgPathPoint(getPointAtLength(pathD, length));
    const endNear = finiteSvgPathPoint(getPointAtLength(pathD, Math.max(0, length - sampleOffset)));
    if (!start || !startNear || !end || !endNear) {
      return undefined;
    }

    const startDirection = normalizedVector({ x: start.x - startNear.x, y: start.y - startNear.y });
    const endDirection = normalizedVector({ x: end.x - endNear.x, y: end.y - endNear.y });
    return startDirection && endDirection
      ? {
          start: { point: start, direction: startDirection },
          end: { point: end, direction: endDirection }
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function finiteSvgPathPoint(point: { x: number; y: number }): NativeArtPoint | undefined {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
    ? { x: point.x, y: point.y }
    : undefined;
}

function normalizedVector(vector: NativeArtPoint): NativeArtPoint | undefined {
  const length = Math.hypot(vector.x, vector.y);
  return Number.isFinite(length) && length > 0.001
    ? { x: vector.x / length, y: vector.y / length }
    : undefined;
}

export function nativeArtCapabilities(object: GraphicObject): NativeArtCapabilities {
  const kind = object.graphicKind;
  if (kind === "line") {
    return nativeArtCapabilityPlan({
      supportsFill: false,
      supportsStroke: true,
      supportsDash: true,
      supportsLineCap: true,
      supportsLineJoin: false,
      isClosedShape: false,
      hasCorners: false
    });
  }

  if (kind === "ellipse") {
    return nativeArtCapabilityPlan({
      supportsFill: true,
      supportsStroke: true,
      supportsDash: true,
      supportsLineCap: false,
      supportsLineJoin: false,
      isClosedShape: true,
      hasCorners: false
    });
  }

  if (kind === "rect") {
    return nativeArtCapabilityPlan({
      supportsFill: true,
      supportsStroke: true,
      supportsDash: true,
      supportsLineCap: false,
      supportsLineJoin: false,
      isClosedShape: true,
      hasCorners: false
    });
  }

  if (kind === "path") {
    const pathKind = graphicPathKind(object);
    if (pathKind === "line" || pathKind === "wavy" || pathKind === "arc" || pathKind === "quadratic") {
      return nativeArtCapabilityPlan({
        supportsFill: false,
        supportsStroke: true,
        supportsDash: true,
        supportsLineCap: true,
        supportsLineJoin: false,
        isClosedShape: false,
        hasCorners: false
      });
    }
    if (pathKind === "polyline" || pathKind === "bezier") {
      const nodes = graphicPathNodes(object);
      const isClosedShape = pathKindSupportsClosedFill(object, nodes);
      return nativeArtCapabilityPlan({
        supportsFill: isClosedShape,
        supportsStroke: nodes.length >= 2,
        supportsDash: true,
        supportsLineCap: !isClosedShape,
        supportsLineJoin: pathKind === "polyline" && nodes.length >= 3,
        isClosedShape,
        hasCorners: pathKind === "polyline" && nodes.length >= 3
      });
    }
    if (pathKind === "freehand") {
      return nativeArtCapabilityPlan({
        supportsFill: false,
        supportsStroke: true,
        supportsDash: false,
        supportsLineCap: false,
        supportsLineJoin: false,
        isClosedShape: false,
        hasCorners: false
      });
    }

    const pathD = metadataString(object.data.pathD);
    const isClosedShape = pathD ? svgPathLooksClosed(pathD) : false;
    const hasCorners = pathD ? svgPathLooksCornered(pathD) : false;
    return nativeArtCapabilityPlan({
      supportsFill: isClosedShape,
      supportsStroke: true,
      supportsDash: true,
      supportsLineCap: !isClosedShape,
      supportsLineJoin: hasCorners,
      isClosedShape,
      hasCorners
    });
  }

  return nativeArtCapabilityPlan({
    supportsFill: false,
    supportsStroke: false,
    supportsDash: false,
    supportsLineCap: false,
    supportsLineJoin: false,
    isClosedShape: false,
    hasCorners: false
  });
}

function nativeArtCapabilityPlan(
  capabilities: Omit<NativeArtCapabilities, "isOpenStroke">
): NativeArtCapabilities {
  return {
    ...capabilities,
    isOpenStroke: capabilities.supportsStroke && !capabilities.isClosedShape
  };
}

function graphicCornerRadius(object: GraphicObject): number {
  if (object.graphicKind !== "rect") {
    return 0;
  }
  return roundLayoutNumber(clamp(
    metadataNumber(object.data.cornerRadiusPx) ?? 0,
    0,
    maxGraphicCornerRadius(object)
  ));
}

export function graphicPathEditPoints(object: GraphicObject): GraphicPathEditPoints | undefined {
  const pathKind = graphicPathKind(object);
  if (!pathKind) {
    return undefined;
  }
  if (pathKind === "polyline" || pathKind === "bezier" || pathKind === "freehand") {
    return undefined;
  }

  const fallback = graphicPathFallbackPoints(object, pathKind);
  if (isSemanticArc(object)) {
    return fallback;
  }
  const explicitStart = pointMetadata(object.data.lineStart);
  const explicitEnd = pointMetadata(object.data.lineEnd);
  const explicitControl = pointMetadata(object.data.pathControlPoint);
  const start = explicitStart ?? fallback.start;
  const end = explicitEnd ?? fallback.end;
  const shafts = graphicEquilibriumHandlePoints(object);
  return {
    start,
    end,
    middle: explicitControl ?? fallback.middle ?? midpoint(start, end),
    pathKind,
    ...(shafts ? { shafts } : {})
  };
}

export function graphicPathNodeEditPoints(object: GraphicObject): GraphicPathNodeEditPoints | undefined {
  const pathKind = graphicPathKind(object);
  if (pathKind !== "polyline" && pathKind !== "bezier") {
    return undefined;
  }

  const nodes = graphicPathNodes(object);
  if (nodes.length === 0) {
    return undefined;
  }

  return {
    pathKind,
    pathClosed: object.data.pathClosed === true,
    nodes: nodes.map((node, index) => ({
      index,
      point: node.point,
      ...(node.inControl ? { inControl: node.inControl } : {}),
      ...(node.outControl ? { outControl: node.outControl } : {})
    }))
  };
}

export function editGraphicPathGeometry(
  object: GraphicObject,
  handle: GraphicPathEditHandle,
  point: NativeArtPoint
): GraphicObject | undefined {
  if (/^node:\d+:(in|out)$/.test(handle)) {
    return editGraphicPathControlGeometry(object, handle, point);
  }

  if (handle.startsWith("node:")) {
    return editGraphicPathNodeGeometry(object, handle, point);
  }

  const kind = graphicPathKind(object);
  if (handle === "shaft:forward" || handle === "shaft:reverse") {
    return editEquilibriumShaftLength(object, handle, point);
  }
  if (kind === "line" && handle === "middle") {
    // A dual-shaft arrow's middle knob resizes it rather than bending it — its axis stays straight,
    // but the whole arrow grows or shrinks: shaft gap and head for a retrosynthetic, shaft gap and
    // both harpoon heads for an equilibrium.
    if (object.data.dualShaft === true) {
      return editDualShaftArrowScale(object, point);
    }
    return promoteLineToQuadraticCurve(object, point);
  }
  if (kind === "quadratic" || isLegacyQuadraticArc(object)) {
    return editQuadraticCurveGeometry(object, handle, point);
  }
  if (kind === "arc") {
    return editSemanticArcGeometry(object, handle, point);
  }
  if (kind === "line" || kind === "wavy") {
    return editOpenSegmentGeometry(object, handle, point);
  }
  return undefined;
}

/**
 * Drag the middle knob to resize a retrosynthetic arrow. Scale comes from how far the pointer sits
 * off the axis, measured the same way the knob is placed, so the arrow tracks the cursor 1:1.
 */
function editDualShaftArrowScale(object: GraphicObject, point: NativeArtPoint): GraphicObject | undefined {
  const start = pointMetadata(object.data.lineStart);
  const end = pointMetadata(object.data.lineEnd);
  if (!start || !end) {
    return undefined;
  }

  const axis = normalizedVector({ x: end.x - start.x, y: end.y - start.y });
  if (!axis) {
    return undefined;
  }

  const normal = { x: axis.y, y: -axis.x };
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const offAxis = Math.abs((point.x - mid.x) * normal.x + (point.y - mid.y) * normal.y);
  const scale = clamp(offAxis / RETRO_SCALE_HANDLE_OFFSET_PX, RETRO_MIN_SCALE, RETRO_MAX_SCALE);
  if (Math.abs(dualShaftArrowScale(object) - scale) < 0.001) {
    return object;
  }

  return {
    ...object,
    data: { ...object.data, dualShaftScale: roundLayoutNumber(scale * 100) / 100 }
  };
}

/**
 * Drag one half-shaft's head to set that direction's length, as a fraction of the axis. The pointer is
 * projected onto the axis, so the shaft slides along it rather than chasing the cursor sideways — the
 * two halves stay parallel however the user drags.
 */
function editEquilibriumShaftLength(
  object: GraphicObject,
  handle: "shaft:forward" | "shaft:reverse",
  point: NativeArtPoint
): GraphicObject | undefined {
  const start = pointMetadata(object.data.lineStart);
  const end = pointMetadata(object.data.lineEnd);
  // Parallel (retrosynthetic) arrows have no independent half-lengths — both shafts are one arrow.
  if (object.data.dualShaft !== true || object.data.dualShaftParallel === true || !start || !end) {
    return undefined;
  }

  const axis = normalizedVector({ x: end.x - start.x, y: end.y - start.y });
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (!axis || length <= 0.001) {
    return undefined;
  }

  // Shafts are centred on the axis midpoint, so a drag measures the head's distance from the centre —
  // half the shaft's length — and the shaft grows or shrinks symmetrically about it. The handle sits
  // seated back from the tip, so add that inset back for the tip to track the pointer.
  const forward = handle === "shaft:forward";
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const sign = forward ? 1 : -1;
  const fromCentre = ((point.x - mid.x) * axis.x + (point.y - mid.y) * axis.y) * sign;
  const shaftLength = 2 * (fromCentre + EQUILIBRIUM_SHAFT_HANDLE_INSET_PX * dualShaftArrowScale(object));
  const frac = clamp(shaftLength / length, EQUILIBRIUM_MIN_FRAC, 1);
  const key = forward ? "dualShaftForwardFrac" : "dualShaftReverseFrac";
  if (Math.abs(equilibriumShaftFraction(object.data[key]) - frac) < 0.001) {
    return object;
  }

  return {
    ...object,
    data: {
      ...object.data,
      [key]: roundLayoutNumber(frac * 1000) / 1000
    }
  };
}

export function deleteGraphicPathNode(
  object: GraphicObject,
  nodeIndex: number
): GraphicObject | undefined {
  const pathKind = graphicPathKind(object);
  if (
    (pathKind !== "polyline" && pathKind !== "bezier") ||
    !Number.isInteger(nodeIndex) ||
    nodeIndex < 0
  ) {
    return undefined;
  }

  const nodes = graphicPathNodes(object);
  if (!nodes[nodeIndex] || nodes.length < 3) {
    return undefined;
  }

  const nextNodes = nodes
    .filter((_, index) => index !== nodeIndex)
    .map((node) => ({
      point: node.point,
      ...(node.inControl ? { inControl: node.inControl } : {}),
      ...(node.outControl ? { outControl: node.outControl } : {})
    }));

  const nextData: GraphicObject["data"] = {
    ...object.data,
    artPathKind: pathKind,
    pathClosed: object.data.pathClosed === true && nextNodes.length >= 3,
    pathNodes: nextNodes
  };
  delete nextData.pathD;

  return updateGraphicPathObject(object, nextData);
}

export function deleteGraphicPathSegment(
  object: GraphicObject,
  segmentIndex: number
): GraphicObject | undefined {
  const pathKind = graphicPathKind(object);
  if (
    (pathKind !== "polyline" && pathKind !== "bezier") ||
    !Number.isInteger(segmentIndex) ||
    segmentIndex < 0
  ) {
    return undefined;
  }

  const nodes = graphicPathNodes(object);
  const closed = object.data.pathClosed === true;
  const segmentCount = closed ? nodes.length : nodes.length - 1;
  if (nodes.length < 2 || segmentIndex >= segmentCount) {
    return undefined;
  }

  if (!closed) {
    if (segmentIndex === 0) {
      return deleteGraphicPathNode(object, 0);
    }
    if (segmentIndex === nodes.length - 2) {
      return deleteGraphicPathNode(object, nodes.length - 1);
    }
    return undefined;
  }

  if (nodes.length < 3) {
    return undefined;
  }

  const gapStartIndex = (segmentIndex + 1) % nodes.length;
  const nextNodes = [
    ...nodes.slice(gapStartIndex),
    ...nodes.slice(0, gapStartIndex)
  ].map(cloneGraphicPathNode);
  const nextData: GraphicObject["data"] = {
    ...object.data,
    artPathKind: pathKind,
    pathClosed: false,
    pathNodes: nextNodes
  };
  delete nextData.pathD;

  return updateGraphicPathObject(object, nextData);
}

export function splitGraphicPathSegmentAtPoint(
  object: GraphicObject,
  point: NativeArtPoint,
  options: { maxDistancePx?: number } = {}
): GraphicPathSegmentSplitResult | undefined {
  const pathKind = graphicPathKind(object);
  const maxDistancePx = Math.max(0, options.maxDistancePx ?? 12);
  if (pathKind === "line") {
    return splitLinePathSegmentAtPoint(object, point, maxDistancePx);
  }
  if (pathKind !== "polyline" && pathKind !== "bezier") {
    return undefined;
  }

  const nodes = graphicPathNodes(object);
  const closed = object.data.pathClosed === true;
  const segmentCount = closed ? nodes.length : nodes.length - 1;
  if (segmentCount <= 0) {
    return undefined;
  }

  const best = nearestGraphicNodeSegment(nodes, closed, pathKind, point);
  if (!best || best.distance > maxDistancePx || best.t <= 0.02 || best.t >= 0.98) {
    return undefined;
  }

  const nextNodes = splitGraphicPathNodes(nodes, closed, pathKind, best.segmentIndex, best.t, best.point);
  if (!nextNodes) {
    return undefined;
  }

  const nextData: GraphicObject["data"] = {
    ...object.data,
    artPathKind: pathKind,
    pathClosed: closed,
    pathNodes: nextNodes
  };
  delete nextData.pathD;

  const edited = updateGraphicPathObject(object, nextData);
  if (!edited || edited === object) {
    return undefined;
  }

  return {
    object: edited,
    segmentIndex: best.segmentIndex,
    point: best.point,
    distance: best.distance
  };
}

export function projectGraphicObjectPoint(
  object: GraphicObject,
  point: NativeArtPoint,
  options: { coordinateSpace?: NativeArtVisualCoordinateSpace } = {}
): NativeArtPoint {
  const matrix = nativeArtProjectionMatrixForObject(object);
  if (!matrix) {
    return point;
  }
  const coordinateSpace = options.coordinateSpace ?? "page";
  const localPoint = coordinateSpace === "page"
    ? { x: point.x - object.x, y: point.y - object.y }
    : point;
  const projected = projectNativeArtLocalPoint(localPoint, object.width, object.height, matrix);
  return coordinateSpace === "page"
    ? { x: object.x + projected.x, y: object.y + projected.y }
    : projected;
}

export function unprojectGraphicObjectPoint(
  object: GraphicObject,
  point: NativeArtPoint,
  options: { coordinateSpace?: NativeArtVisualCoordinateSpace } = {}
): NativeArtPoint {
  const matrix = nativeArtProjectionMatrixForObject(object);
  if (!matrix) {
    return point;
  }

  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(determinant) < 0.000001) {
    return point;
  }

  const coordinateSpace = options.coordinateSpace ?? "page";
  const halfWidth = Math.max(object.width, 1) / 2;
  const halfHeight = Math.max(object.height, 1) / 2;
  const localPoint = coordinateSpace === "page"
    ? { x: point.x - object.x, y: point.y - object.y }
    : point;
  const projectedDx = localPoint.x - halfWidth;
  const projectedDy = localPoint.y - halfHeight;
  const dx = (matrix.d * projectedDx - matrix.c * projectedDy) / determinant;
  const dy = (-matrix.b * projectedDx + matrix.a * projectedDy) / determinant;
  const unprojected = {
    x: halfWidth + dx,
    y: halfHeight + dy
  };
  return coordinateSpace === "page"
    ? { x: object.x + unprojected.x, y: object.y + unprojected.y }
    : unprojected;
}

export function graphicObjectIntersectsRect(object: GraphicObject, rect: NativeArtBounds): boolean {
  const objectRect = { x: object.x, y: object.y, width: object.width, height: object.height };
  if (!nativeArtCapabilities(object).isOpenStroke) {
    return nativeArtRectangleContainsRect(rect, objectRect);
  }

  const pagePoints = graphicOpenStrokePageSamplePoints(object);
  if (pagePoints.length < 2) {
    return nativeArtRectangleContainsRect(rect, objectRect);
  }

  const strokeWidth = metadataNumber(object.style.strokeWidth) ?? 2;
  const hitRect = expandNativeArtRect(rect, Math.max(1, strokeWidth / 2));
  if (pagePoints.some((point) => nativeArtPointInRect(point, hitRect))) {
    return true;
  }

  for (let index = 1; index < pagePoints.length; index += 1) {
    if (nativeArtLineIntersectsRect(pagePoints[index - 1], pagePoints[index], hitRect)) {
      return true;
    }
  }

  return false;
}

export function graphicObjectIntersectsPolygon(object: GraphicObject, polygon: readonly NativeArtPoint[]): boolean {
  if (polygon.length < 3) {
    return false;
  }

  const objectRect = { x: object.x, y: object.y, width: object.width, height: object.height };
  if (!nativeArtCapabilities(object).isOpenStroke) {
    return nativeArtPolygonIntersectsRect(polygon, objectRect);
  }

  const pagePoints = graphicOpenStrokePageSamplePoints(object);
  if (pagePoints.length < 2) {
    return nativeArtPolygonIntersectsRect(polygon, objectRect);
  }

  if (pagePoints.some((point) => nativeArtPointInPolygon(point, polygon))) {
    return true;
  }

  for (let index = 1; index < pagePoints.length; index += 1) {
    if (nativeArtLineIntersectsPolygon(pagePoints[index - 1], pagePoints[index], polygon)) {
      return true;
    }
  }

  return false;
}

export function graphicObjectSupportsBooleanOperation(object: GraphicObject): boolean {
  return graphicObjectBooleanPolygonInput(object).polygon !== undefined;
}

export function planNativeArtBooleanOperation(
  objects: readonly GraphicObject[],
  operation: NativeArtBooleanOperation
): NativeArtBooleanOperationPlan {
  const inputs = objects.map(graphicObjectBooleanPolygonInput);
  const eligible = inputs.filter((input): input is NativeArtBooleanPolygonInput & { polygon: Flatten.Polygon } =>
    input.polygon !== undefined
  );
  const skippedInputs = inputs
    .filter((input): input is NativeArtBooleanPolygonInput & { skipped: NativeArtBooleanSkippedInput } =>
      input.skipped !== undefined
    )
    .map((input) => input.skipped);

  if (eligible.length < 2) {
    return {
      operation,
      resultPaths: [],
      skippedInputs,
      eligibleInputIds: eligible.map((input) => input.objectId)
    };
  }

  const resultPolygons = operation === "split"
    ? splitNativeArtBooleanPolygons(eligible.map((input) => input.polygon))
    : [reduceNativeArtBooleanPolygons(eligible.map((input) => input.polygon), operation)];

  return {
    operation,
    resultPaths: resultPolygons.flatMap((polygon) => nativeArtBooleanResultPaths(polygon)),
    skippedInputs,
    eligibleInputIds: eligible.map((input) => input.objectId)
  };
}

export function prepareGraphicPathForDirectEdit(object: GraphicObject): GraphicObject {
  const pathKind = graphicPathKind(object);
  if (!pathKind || pathKind === "arc") {
    return object;
  }

  const tiltXDegrees = metadataNumber(object.style.tiltXDegrees) ?? 0;
  const tiltYDegrees = metadataNumber(object.style.tiltYDegrees) ?? 0;
  if (
    Math.abs(object.rotation) < 0.001 &&
    Math.abs(tiltXDegrees) < 0.001 &&
    Math.abs(tiltYDegrees) < 0.001
  ) {
    return object;
  }

  const points = graphicPathEditPoints(object);
  if (!points || points.pathKind === "arc") {
    return object;
  }

  const nextData: GraphicObject["data"] = {
    ...object.data,
    artPathKind: points.pathKind,
    lineStart: projectGraphicObjectVisualPointForDirectEdit(object, points.start),
    lineEnd: projectGraphicObjectVisualPointForDirectEdit(object, points.end)
  };
  if (points.pathKind === "quadratic") {
    nextData.pathControlPoint = projectGraphicObjectVisualPointForDirectEdit(object, points.middle);
  } else {
    delete nextData.pathControlPoint;
  }
  deleteSemanticArcData(nextData);

  const nextStyle = { ...object.style };
  delete nextStyle.tiltXDegrees;
  delete nextStyle.tiltYDegrees;

  return updateGraphicPathObject({
    ...object,
    rotation: 0,
    style: nextStyle
  }, nextData) ?? object;
}

function projectGraphicObjectVisualPointForDirectEdit(
  object: GraphicObject,
  point: NativeArtPoint
): NativeArtPoint {
  const projected = projectGraphicObjectPoint(object, point);
  if (Math.abs(object.rotation) < 0.001) {
    return projected;
  }

  const center = {
    x: object.x + Math.max(object.width, 1) / 2,
    y: object.y + Math.max(object.height, 1) / 2
  };
  const rotationRad = degreesToRadians(object.rotation);
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const dx = projected.x - center.x;
  const dy = projected.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos
  };
}

function nativeArtProjectionMatrixForObject(object: GraphicObject): NativeArtProjectionMatrix | undefined {
  const tiltXDegrees = metadataNumber(object.style.tiltXDegrees) ?? 0;
  const tiltYDegrees = metadataNumber(object.style.tiltYDegrees) ?? 0;
  if (
    Math.abs(tiltXDegrees) < 0.001 &&
    Math.abs(tiltYDegrees) < 0.001
  ) {
    return undefined;
  }

  return nativeArtProjectionMatrix(tiltXDegrees, tiltYDegrees, 0);
}

function nativeArtProjectionMatrix(
  tiltXDegrees: number,
  tiltYDegrees: number,
  rotationDegrees: number
): NativeArtProjectionMatrix {
  const tiltXRad = degreesToRadians(tiltXDegrees);
  const tiltYRad = degreesToRadians(tiltYDegrees);
  const cx = Math.cos(tiltXRad);
  const sx = Math.sin(tiltXRad);
  const cy = Math.cos(tiltYRad);
  const sy = Math.sin(tiltYRad);
  const zRad = degreesToRadians(rotationDegrees);
  const cz = Math.cos(zRad);
  const sz = Math.sin(zRad);

  return {
    a: cy * cz,
    b: cx * sz + sx * sy * cz,
    c: -cy * sz,
    d: cx * cz - sx * sy * sz
  };
}

function graphicPathKind(object: GraphicObject): GraphicPathKind | undefined {
  const kind = object.data.artPathKind;
  if (kind === "arc" && pointMetadata(object.data.pathControlPoint)) {
    return "quadratic";
  }
  if (
    kind === "line" ||
    kind === "wavy" ||
    kind === "arc" ||
    kind === "quadratic" ||
    kind === "polyline" ||
    kind === "bezier" ||
    kind === "freehand"
  ) {
    return kind;
  }
  return object.graphicKind === "line" ? "line" : undefined;
}

function isSemanticArc(object: GraphicObject): boolean {
  return graphicPathKind(object) === "arc" && !pointMetadata(object.data.pathControlPoint);
}

function isLegacyQuadraticArc(object: GraphicObject): boolean {
  return object.data.artPathKind === "arc" && pointMetadata(object.data.pathControlPoint) !== undefined;
}

function isQuadraticCurve(object: GraphicObject): boolean {
  return object.data.artPathKind === "quadratic" || isLegacyQuadraticArc(object);
}

function graphicPathNodes(object: GraphicObject): NativeGraphicPathNode[] {
  return graphicPathNodesFromData(object.data);
}

function graphicPathNodesFromData(data: GraphicObject["data"]): NativeGraphicPathNode[] {
  const nodes = data.pathNodes;
  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes
    .map((node): NativeGraphicPathNode | undefined => {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return undefined;
      }
      const record = node as Record<string, unknown>;
      const point = pointMetadata(record.point);
      if (!point) {
        return undefined;
      }
      const inControl = pointMetadata(record.inControl);
      const outControl = pointMetadata(record.outControl);
      return {
        point,
        ...(inControl ? { inControl } : {}),
        ...(outControl ? { outControl } : {})
      };
    })
    .filter((node): node is NativeGraphicPathNode => node !== undefined);
}

function pathKindSupportsClosedFill(
  object: GraphicObject,
  nodes = graphicPathNodes(object)
): boolean {
  return object.data.pathClosed === true && nodes.length >= 3;
}

function promoteLineToQuadraticCurve(
  object: GraphicObject,
  point: NativeArtPoint
): GraphicObject | undefined {
  const editPoints = graphicPathEditPoints(object);
  if (!editPoints) {
    return undefined;
  }

  return updateQuadraticCurveObject(object, editPoints.start, editPoints.end, point);
}

function editGraphicPathNodeGeometry(
  object: GraphicObject,
  handle: GraphicPathEditHandle,
  point: NativeArtPoint
): GraphicObject | undefined {
  const pathKind = graphicPathKind(object);
  if (pathKind !== "polyline" && pathKind !== "bezier") {
    return undefined;
  }

  const match = /^node:(\d+)$/.exec(handle);
  const index = match ? Number.parseInt(match[1], 10) : -1;
  const nodes = graphicPathNodes(object);
  const current = nodes[index];
  if (!current) {
    return undefined;
  }

  const dx = point.x - current.point.x;
  const dy = point.y - current.point.y;
  const movePoint = (candidate: NativeArtPoint): NativeArtPoint => ({
    x: roundLayoutNumber(candidate.x + dx),
    y: roundLayoutNumber(candidate.y + dy)
  });
  const nextNodes = nodes.map((node, nodeIndex) => {
    if (nodeIndex !== index) {
      return {
        point: node.point,
        ...(node.inControl ? { inControl: node.inControl } : {}),
        ...(node.outControl ? { outControl: node.outControl } : {})
      };
    }

    return {
      point: {
        x: roundLayoutNumber(point.x),
        y: roundLayoutNumber(point.y)
      },
      ...(node.inControl ? { inControl: movePoint(node.inControl) } : {}),
      ...(node.outControl ? { outControl: movePoint(node.outControl) } : {})
    };
  });

  return updateGraphicPathObject(object, {
    ...object.data,
    artPathKind: pathKind,
    pathNodes: nextNodes
  });
}

function editGraphicPathControlGeometry(
  object: GraphicObject,
  handle: GraphicPathEditHandle,
  point: NativeArtPoint
): GraphicObject | undefined {
  const pathKind = graphicPathKind(object);
  if (pathKind !== "bezier") {
    return undefined;
  }

  const match = /^node:(\d+):(in|out)$/.exec(handle);
  const index = match ? Number.parseInt(match[1], 10) : -1;
  const controlKind = match?.[2];
  const nodes = graphicPathNodes(object);
  if (!nodes[index] || (controlKind !== "in" && controlKind !== "out")) {
    return undefined;
  }

  const controlPoint = {
    x: roundLayoutNumber(point.x),
    y: roundLayoutNumber(point.y)
  };
  const nextNodes = nodes.map((node, nodeIndex) => ({
    point: node.point,
    ...(node.inControl ? { inControl: node.inControl } : {}),
    ...(node.outControl ? { outControl: node.outControl } : {}),
    ...(nodeIndex === index && controlKind === "in" ? { inControl: controlPoint } : {}),
    ...(nodeIndex === index && controlKind === "out" ? { outControl: controlPoint } : {})
  }));

  return updateGraphicPathObject(object, {
    ...object.data,
    artPathKind: pathKind,
    pathNodes: nextNodes
  });
}

function editQuadraticCurveGeometry(
  object: GraphicObject,
  handle: GraphicPathEditHandle,
  point: NativeArtPoint
): GraphicObject | undefined {
  const editPoints = graphicPathEditPoints(object);
  if (!editPoints) {
    return undefined;
  }

  const currentControl = pointMetadata(object.data.pathControlPoint) ?? editPoints.middle;
  return updateQuadraticCurveObject(
    object,
    handle === "start" ? point : editPoints.start,
    handle === "end" ? point : editPoints.end,
    handle === "middle" ? point : currentControl
  );
}

function editOpenSegmentGeometry(
  object: GraphicObject,
  handle: GraphicPathEditHandle,
  point: NativeArtPoint
): GraphicObject | undefined {
  if (handle === "middle") {
    return undefined;
  }

  const editPoints = graphicPathEditPoints(object);
  if (!editPoints) {
    return undefined;
  }

  const nextData: GraphicObject["data"] = {
    ...object.data,
    artPathKind: editPoints.pathKind,
    lineStart: handle === "start" ? point : editPoints.start,
    lineEnd: handle === "end" ? point : editPoints.end
  };
  delete nextData.pathControlPoint;
  deleteSemanticArcData(nextData);

  return updateGraphicPathObject(object, nextData);
}

function updateQuadraticCurveObject(
  object: GraphicObject,
  lineStart: NativeArtPoint,
  lineEnd: NativeArtPoint,
  pathControlPoint: NativeArtPoint
): GraphicObject | undefined {
  const nextData: GraphicObject["data"] = {
    ...object.data,
    artPathKind: "quadratic",
    lineStart,
    lineEnd,
    pathControlPoint
  };
  deleteSemanticArcData(nextData);
  return updateGraphicPathObject(object, nextData);
}

function updateGraphicPathObject(
  object: GraphicObject,
  nextData: GraphicObject["data"]
): GraphicObject | undefined {
  const nextBounds = boundsForGraphicPath(object, nextData);
  const unchanged =
    samePoint(pointMetadata(object.data.lineStart), nextData.lineStart) &&
    samePoint(pointMetadata(object.data.lineEnd), nextData.lineEnd) &&
    samePoint(pointMetadata(object.data.pathControlPoint), nextData.pathControlPoint) &&
    samePathNodes(object.data.pathNodes, nextData.pathNodes) &&
    object.data.artPathKind === nextData.artPathKind &&
    object.data.pathClosed === nextData.pathClosed &&
    Math.abs(object.x - nextBounds.x) < 0.001 &&
    Math.abs(object.y - nextBounds.y) < 0.001 &&
    Math.abs(object.width - nextBounds.width) < 0.001 &&
    Math.abs(object.height - nextBounds.height) < 0.001;
  if (unchanged) {
    return object;
  }

  return {
    ...object,
    ...nextBounds,
    data: nextData
  };
}

function deleteSemanticArcData(data: GraphicObject["data"]): void {
  delete data.arcCenter;
  delete data.arcRadiusX;
  delete data.arcRadiusY;
  delete data.arcStartRadians;
  delete data.arcSweepRadians;
}

function splitLinePathSegmentAtPoint(
  object: GraphicObject,
  point: NativeArtPoint,
  maxDistancePx: number
): GraphicPathSegmentSplitResult | undefined {
  const editPoints = graphicPathEditPoints(object);
  if (!editPoints || editPoints.pathKind !== "line") {
    return undefined;
  }

  const nearest = nearestPointOnLineSegment(point, editPoints.start, editPoints.end);
  if (nearest.distance > maxDistancePx || nearest.t <= 0.02 || nearest.t >= 0.98) {
    return undefined;
  }

  const splitPoint = roundPoint(nearest.point);
  const nextData: GraphicObject["data"] = {
    ...object.data,
    artPathKind: "polyline",
    pathClosed: false,
    pathNodes: [
      { point: roundPoint(editPoints.start) },
      { point: splitPoint },
      { point: roundPoint(editPoints.end) }
    ]
  };
  delete nextData.lineStart;
  delete nextData.lineEnd;
  delete nextData.pathControlPoint;
  delete nextData.pathD;
  deleteSemanticArcData(nextData);

  const edited = updateGraphicPathObject(object, nextData);
  if (!edited || edited === object) {
    return undefined;
  }

  return {
    object: edited,
    segmentIndex: 0,
    point: splitPoint,
    distance: nearest.distance
  };
}

function nearestGraphicNodeSegment(
  nodes: readonly NativeGraphicPathNode[],
  closed: boolean,
  pathKind: Extract<GraphicPathKind, "polyline" | "bezier">,
  point: NativeArtPoint
): { segmentIndex: number; t: number; point: NativeArtPoint; distance: number } | undefined {
  const segmentCount = closed ? nodes.length : nodes.length - 1;
  let best: { segmentIndex: number; t: number; point: NativeArtPoint; distance: number } | undefined;
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const start = nodes[segmentIndex];
    const end = nodes[(segmentIndex + 1) % nodes.length];
    if (!start || !end) {
      continue;
    }

    const nearest = pathKind === "bezier"
      ? nearestPointOnCubicSegment(point, start, end)
      : nearestPointOnLineSegment(point, start.point, end.point);
    if (!best || nearest.distance < best.distance) {
      best = {
        segmentIndex,
        t: nearest.t,
        point: roundPoint(nearest.point),
        distance: nearest.distance
      };
    }
  }

  return best;
}

function splitGraphicPathNodes(
  nodes: readonly NativeGraphicPathNode[],
  closed: boolean,
  pathKind: Extract<GraphicPathKind, "polyline" | "bezier">,
  segmentIndex: number,
  t: number,
  point: NativeArtPoint
): NativeGraphicPathNodeData[] | undefined {
  const start = nodes[segmentIndex];
  const end = nodes[(segmentIndex + 1) % nodes.length];
  if (!start || !end) {
    return undefined;
  }

  const nextNodes = nodes.map(cloneGraphicPathNode);
  let inserted: NativeGraphicPathNodeData = { point: roundPoint(point) };
  if (pathKind === "bezier" && (start.outControl || end.inControl)) {
    const split = splitCubicBezierSegment(start, end, t);
    nextNodes[segmentIndex] = split.start;
    inserted = split.inserted;
    nextNodes[(segmentIndex + 1) % nodes.length] = split.end;
  }

  if (closed && segmentIndex === nodes.length - 1) {
    nextNodes.push(inserted);
  } else {
    nextNodes.splice(segmentIndex + 1, 0, inserted);
  }

  return nextNodes;
}

function splitCubicBezierSegment(
  start: NativeGraphicPathNode,
  end: NativeGraphicPathNode,
  t: number
): { start: NativeGraphicPathNodeData; inserted: NativeGraphicPathNodeData; end: NativeGraphicPathNodeData } {
  const p0 = start.point;
  const p1 = start.outControl ?? start.point;
  const p2 = end.inControl ?? end.point;
  const p3 = end.point;
  const q0 = lerpPoint(p0, p1, t);
  const q1 = lerpPoint(p1, p2, t);
  const q2 = lerpPoint(p2, p3, t);
  const r0 = lerpPoint(q0, q1, t);
  const r1 = lerpPoint(q1, q2, t);
  const splitPoint = lerpPoint(r0, r1, t);

  return {
    start: {
      point: roundPoint(start.point),
      ...(start.inControl ? { inControl: roundPoint(start.inControl) } : {}),
      outControl: roundPoint(q0)
    },
    inserted: {
      point: roundPoint(splitPoint),
      inControl: roundPoint(r0),
      outControl: roundPoint(r1)
    },
    end: {
      point: roundPoint(end.point),
      inControl: roundPoint(q2),
      ...(end.outControl ? { outControl: roundPoint(end.outControl) } : {})
    }
  };
}

function cloneGraphicPathNode(node: NativeGraphicPathNode): NativeGraphicPathNodeData {
  return {
    point: roundPoint(node.point),
    ...(node.inControl ? { inControl: roundPoint(node.inControl) } : {}),
    ...(node.outControl ? { outControl: roundPoint(node.outControl) } : {})
  };
}

function nearestPointOnLineSegment(
  point: NativeArtPoint,
  start: NativeArtPoint,
  end: NativeArtPoint
): { t: number; point: NativeArtPoint; distance: number } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared <= 0.000001
    ? 0
    : clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  const projected = {
    x: start.x + dx * t,
    y: start.y + dy * t
  };
  return {
    t,
    point: projected,
    distance: pointDistance(point, projected)
  };
}

function nearestPointOnCubicSegment(
  point: NativeArtPoint,
  start: NativeGraphicPathNode,
  end: NativeGraphicPathNode
): { t: number; point: NativeArtPoint; distance: number } {
  const p0 = start.point;
  const p1 = start.outControl ?? start.point;
  const p2 = end.inControl ?? end.point;
  const p3 = end.point;
  const steps = 48;
  let best = {
    t: 0,
    point: p0,
    distance: pointDistance(point, p0)
  };
  let previous = p0;
  for (let index = 1; index <= steps; index += 1) {
    const segmentEndT = index / steps;
    const next = cubicPointAt(p0, p1, p2, p3, segmentEndT);
    const nearest = nearestPointOnLineSegment(point, previous, next);
    const candidateT = (index - 1 + nearest.t) / steps;
    const candidatePoint = cubicPointAt(p0, p1, p2, p3, candidateT);
    const candidateDistance = pointDistance(point, candidatePoint);
    if (candidateDistance < best.distance) {
      best = { t: candidateT, point: candidatePoint, distance: candidateDistance };
    }
    previous = next;
  }

  let low = Math.max(0, best.t - 1 / steps);
  let high = Math.min(1, best.t + 1 / steps);
  for (let index = 0; index < 10; index += 1) {
    const leftT = low + (high - low) / 3;
    const rightT = high - (high - low) / 3;
    const leftDistance = pointDistance(point, cubicPointAt(p0, p1, p2, p3, leftT));
    const rightDistance = pointDistance(point, cubicPointAt(p0, p1, p2, p3, rightT));
    if (leftDistance <= rightDistance) {
      high = rightT;
    } else {
      low = leftT;
    }
  }

  const t = (low + high) / 2;
  const nearest = cubicPointAt(p0, p1, p2, p3, t);
  return {
    t,
    point: nearest,
    distance: pointDistance(point, nearest)
  };
}

function cubicPointAt(
  p0: NativeArtPoint,
  p1: NativeArtPoint,
  p2: NativeArtPoint,
  p3: NativeArtPoint,
  t: number
): NativeArtPoint {
  const q0 = lerpPoint(p0, p1, t);
  const q1 = lerpPoint(p1, p2, t);
  const q2 = lerpPoint(p2, p3, t);
  const r0 = lerpPoint(q0, q1, t);
  const r1 = lerpPoint(q1, q2, t);
  return lerpPoint(r0, r1, t);
}

function lerpPoint(start: NativeArtPoint, end: NativeArtPoint, t: number): NativeArtPoint {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t
  };
}

function pointDistance(left: NativeArtPoint, right: NativeArtPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function roundPoint(point: NativeArtPoint): NativeArtPoint {
  return {
    x: roundLayoutNumber(point.x),
    y: roundLayoutNumber(point.y)
  };
}

function editSemanticArcGeometry(
  object: GraphicObject,
  handle: GraphicPathEditHandle,
  point: NativeArtPoint
): GraphicObject {
  const current = circularGraphicArcGeometry(object);
  const targetRadians = handle === "middle"
    ? angleRadiansForPoint(current.center, point)
    : ellipseAngleRadiansForPoint(current.center, current.radiusX, current.radiusY, point);
  const nextSweepRadians = handle === "start"
    ? arcSweepRadiansForEndpointDrag(targetRadians, current.endRadians, current.sweepRadians)
    : handle === "end"
      ? arcSweepRadiansForEndpointDrag(current.startRadians, targetRadians, current.sweepRadians)
      : current.sweepRadians;
  const nextStartRadians = handle === "start"
    ? targetRadians
    : handle === "middle" ? targetRadians - nextSweepRadians / 2 : current.startRadians;
  const nextRadius = handle === "middle"
    ? Math.max(Math.hypot(point.x - current.center.x, point.y - current.center.y), 1)
    : undefined;
  const nextRadiusX = nextRadius ?? current.radiusX;
  const nextRadiusY = nextRadius ?? current.radiusY;
  const nextData: GraphicObject["data"] = {
    ...object.data,
    artPathKind: "arc",
    arcCenter: current.center,
    arcRadiusX: nextRadiusX,
    arcRadiusY: nextRadiusY,
    arcStartRadians: nextStartRadians,
    arcSweepRadians: nextSweepRadians
  };
  delete nextData.lineStart;
  delete nextData.lineEnd;
  delete nextData.pathControlPoint;

  const nextBounds = boundsForCircularGraphicArc(object, nextData);
  const unchanged =
    samePoint(pointMetadata(object.data.arcCenter), nextData.arcCenter) &&
    Math.abs((metadataNumber(object.data.arcRadiusX) ?? current.radiusX) - nextRadiusX) < 0.001 &&
    Math.abs((metadataNumber(object.data.arcRadiusY) ?? current.radiusY) - nextRadiusY) < 0.001 &&
    Math.abs((object.data.arcStartRadians ?? current.startRadians) - nextStartRadians) < 0.001 &&
    Math.abs((object.data.arcSweepRadians ?? current.sweepRadians) - nextSweepRadians) < 0.001 &&
    !pointMetadata(object.data.lineStart) &&
    !pointMetadata(object.data.lineEnd) &&
    Math.abs(object.x - nextBounds.x) < 0.001 &&
    Math.abs(object.y - nextBounds.y) < 0.001 &&
    Math.abs(object.width - nextBounds.width) < 0.001 &&
    Math.abs(object.height - nextBounds.height) < 0.001;
  if (unchanged) {
    return object;
  }

  return {
    ...object,
    ...nextBounds,
    data: nextData
  };
}

function circularGraphicArcGeometry(
  object: GraphicObject,
  data: GraphicObject["data"] = object.data
): CircularGraphicArcGeometry {
  const angles = nativeArtArcAngles({ ...object, data });
  const center = pointMetadata(data.arcCenter) ?? objectCenter(object);
  const radiusX = Math.max(metadataNumber(data.arcRadiusX) ?? object.width / 2 - 4, 1);
  const radiusY = Math.max(metadataNumber(data.arcRadiusY) ?? object.height / 2 - 4, 1);
  return {
    center,
    radiusX,
    radiusY,
    startRadians: angles.startRadians,
    sweepRadians: angles.sweepRadians,
    endRadians: angles.endRadians
  };
}

function boundsForCircularGraphicArc(
  object: GraphicObject,
  data: GraphicObject["data"]
): NativeArtBounds {
  const geometry = circularGraphicArcGeometry(object, data);
  const strokeWidth = metadataNumber(object.style.strokeWidth) ?? 2;
  const padding = Math.max(6, strokeWidth * 2);
  const points = circularArcBoundsPoints(geometry);
  return boundsForPoints(points, padding, { x: object.x, y: object.y, width: object.width, height: object.height });
}

function boundsForPoints(
  points: readonly NativeArtPoint[],
  padding: number,
  fallback: NativeArtBounds
): NativeArtBounds {
  const finitePoints = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (finitePoints.length === 0) {
    return fallback;
  }

  const minX = Math.min(...finitePoints.map((point) => point.x));
  const minY = Math.min(...finitePoints.map((point) => point.y));
  const maxX = Math.max(...finitePoints.map((point) => point.x));
  const maxY = Math.max(...finitePoints.map((point) => point.y));
  const minSize = padding * 2;
  return {
    x: roundLayoutNumber(minX - padding),
    y: roundLayoutNumber(minY - padding),
    width: roundLayoutNumber(Math.max(maxX - minX + padding * 2, minSize)),
    height: roundLayoutNumber(Math.max(maxY - minY + padding * 2, minSize))
  };
}

function graphicPathFallbackPoints(
  object: GraphicObject,
  pathKind: GraphicPathKind
): GraphicPathEditPoints {
  if (pathKind === "arc") {
    const geometry = circularGraphicArcGeometry(object);
    return {
      start: ellipsePointAtRadians(geometry.center, geometry.radiusX, geometry.radiusY, geometry.startRadians),
      middle: pointMetadata(object.data.pathControlPoint) ??
        ellipsePointAtRadians(geometry.center, geometry.radiusX, geometry.radiusY, geometry.startRadians + geometry.sweepRadians / 2),
      end: ellipsePointAtRadians(geometry.center, geometry.radiusX, geometry.radiusY, geometry.endRadians),
      pathKind
    };
  }

  const inset = Math.max(3, (metadataNumber(object.style.strokeWidth) ?? 2) / 2);
  const start = { x: object.x + inset, y: object.y + inset };
  const end = { x: object.x + object.width - inset, y: object.y + object.height - inset };
  return {
    start,
    middle: midpoint(start, end),
    end,
    pathKind
  };
}

function boundsForGraphicPath(object: GraphicObject, data: GraphicObject["data"]): NativeArtBounds {
  const start = pointMetadata(data.lineStart);
  const end = pointMetadata(data.lineEnd);
  const middle = pointMetadata(data.pathControlPoint);
  const nodePoints = graphicPathNodesFromData(data)
    .flatMap((node) => [node.point, node.inControl, node.outControl])
    .filter((point): point is NativeArtPoint => point !== undefined);
  const points = data.artPathKind === "quadratic" && start && end && middle
    ? quadraticBezierSamplePoints(start, quadraticControlForMiddlePoint(start, middle, end), end, 24)
    : [...nodePoints, start, end, middle].filter((point): point is NativeArtPoint => point !== undefined);
  if (points.length === 0) {
    return {
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height
    };
  }

  const strokeWidth = metadataNumber(object.style.strokeWidth) ?? 2;
  const padding = Math.max(6, strokeWidth * 2);
  return boundsForPoints(points, padding, { x: object.x, y: object.y, width: object.width, height: object.height });
}

function objectCenter(object: Pick<GraphicObject, "x" | "y" | "width" | "height">): NativeArtPoint {
  return {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2
  };
}

function midpoint(start: NativeArtPoint, end: NativeArtPoint): NativeArtPoint {
  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2
  };
}

function ellipseAngleRadiansForPoint(
  center: NativeArtPoint,
  rx: number,
  ry: number,
  point: NativeArtPoint
): number {
  return Math.atan2((point.y - center.y) / Math.max(ry, 1), (point.x - center.x) / Math.max(rx, 1));
}

function angleRadiansForPoint(center: NativeArtPoint, point: NativeArtPoint): number {
  return Math.atan2(point.y - center.y, point.x - center.x);
}

function clockwiseDeltaRadians(startRadians: number, endRadians: number): number {
  const delta = (endRadians - startRadians) % (Math.PI * 2);
  return delta < 0 ? delta + Math.PI * 2 : delta;
}

function arcSweepRadiansForEndpointDrag(
  startRadians: number,
  endRadians: number,
  currentSweepRadians: number
): number {
  return currentSweepRadians < 0
    ? -arcSweepRadiansFromEndpointDrag(clockwiseDeltaRadians(endRadians, startRadians))
    : arcSweepRadiansFromEndpointDrag(clockwiseDeltaRadians(startRadians, endRadians));
}

function arcSweepRadiansFromEndpointDrag(radians: number): number {
  const sweep = Math.abs(radians);
  return sweep < minimumArcSweepRadians ? maximumArcSweepRadians : clampArcSweepRadians(sweep);
}

function samePoint(left: NativeArtPoint | undefined, right: NativeArtPoint | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return Math.abs(left.x - right.x) < 0.001 && Math.abs(left.y - right.y) < 0.001;
}

function samePathNodes(
  left: GraphicObject["data"]["pathNodes"],
  right: GraphicObject["data"]["pathNodes"]
): boolean {
  const leftNodes = graphicPathNodesFromData({ pathNodes: left });
  const rightNodes = graphicPathNodesFromData({ pathNodes: right });
  if (leftNodes.length !== rightNodes.length) {
    return false;
  }

  return leftNodes.every((leftNode, index) => {
    const rightNode = rightNodes[index];
    return samePoint(leftNode.point, rightNode?.point) &&
      samePoint(leftNode.inControl, rightNode?.inControl) &&
      samePoint(leftNode.outControl, rightNode?.outControl);
  });
}

function nativeArtFrameBounds(
  object: GraphicObject,
  matrix: NativeArtProjectionMatrix | undefined,
  coordinateSpace: NativeArtVisualCoordinateSpace
): NativeArtBounds {
  const unprojectedLocal = nativeArtUnprojectedLocalFrameBounds(object);
  const unprojected = coordinateSpace === "page"
    ? { ...unprojectedLocal, x: object.x + unprojectedLocal.x, y: object.y + unprojectedLocal.y }
    : unprojectedLocal;
  if (!matrix) {
    return unprojected;
  }

  const localBounds = nativeArtProjectedLocalBounds(object, matrix);
  return coordinateSpace === "page"
    ? { ...localBounds, x: object.x + localBounds.x, y: object.y + localBounds.y }
    : localBounds;
}

function nativeArtUnprojectedLocalFrameBounds(object: GraphicObject): NativeArtBounds {
  const defaultBounds = { x: 0, y: 0, width: object.width, height: object.height };
  const pathKind = graphicPathKind(object);
  if (object.graphicKind !== "path") {
    return defaultBounds;
  }

  if (pathKind === "freehand") {
    return defaultBounds;
  }

  if (pathKind !== "polyline" && pathKind !== "bezier") {
    return defaultBounds;
  }

  const points = graphicPathLocalSamplePoints(object);
  if (points.length === 0) {
    return defaultBounds;
  }

  const strokeWidth = metadataNumber(object.style.strokeWidth) ?? 2;
  const padding = Math.max(6, strokeWidth * 2);
  return boundsForPoints(points, padding, defaultBounds);
}

function nativeArtProjectedLocalBounds(
  object: GraphicObject,
  matrix: NativeArtProjectionMatrix
): NativeArtBounds {
  const width = Math.max(object.width, 1);
  const height = Math.max(object.height, 1);
  if (object.graphicKind === "ellipse") {
    return projectedEllipseBounds(width, height, matrix);
  }

  if (object.graphicKind === "rect") {
    return projectedPointsBounds(
      roundedRectPathPoints(width, height, graphicCornerRadius(object), 0, { x: 0, y: 0 }),
      width,
      height,
      matrix
    );
  }

  if (object.graphicKind === "line") {
    return projectedPointsBounds(graphicLineLocalPoints(object), width, height, matrix);
  }

  if (object.graphicKind === "path") {
    const pathPoints = graphicPathLocalSamplePoints(object);
    if (pathPoints.length > 0) {
      return projectedPointsBounds(pathPoints, width, height, matrix);
    }
  }

  return projectedRectangleBounds(width, height, matrix);
}

function projectedEllipseBounds(
  width: number,
  height: number,
  matrix: NativeArtProjectionMatrix
): NativeArtBounds {
  const halfWidth = Math.max(width, 1) / 2;
  const halfHeight = Math.max(height, 1) / 2;
  const projectedHalfWidth = Math.hypot(matrix.a * halfWidth, matrix.c * halfHeight);
  const projectedHalfHeight = Math.hypot(matrix.b * halfWidth, matrix.d * halfHeight);
  return {
    x: roundLayoutNumber(halfWidth - projectedHalfWidth),
    y: roundLayoutNumber(halfHeight - projectedHalfHeight),
    width: roundLayoutNumber(projectedHalfWidth * 2),
    height: roundLayoutNumber(projectedHalfHeight * 2)
  };
}

function projectedRectangleBounds(
  width: number,
  height: number,
  matrix: NativeArtProjectionMatrix
): NativeArtBounds {
  const points = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height }
  ];
  return projectedPointsBounds(points, width, height, matrix);
}

function projectedPointsBounds(
  points: readonly NativeArtPoint[],
  width: number,
  height: number,
  matrix: NativeArtProjectionMatrix
): NativeArtBounds {
  const projected = points.map((point) => projectNativeArtLocalPoint(point, width, height, matrix));
  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  return {
    x: roundLayoutNumber(minX),
    y: roundLayoutNumber(minY),
    width: roundLayoutNumber(maxX - minX),
    height: roundLayoutNumber(maxY - minY)
  };
}

function nativeArtProjectionSvgTransform(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace,
  matrix: NativeArtProjectionMatrix
): string {
  const originX = coordinateSpace === "page" ? object.x : 0;
  const originY = coordinateSpace === "page" ? object.y : 0;
  const centerX = originX + Math.max(object.width, 1) / 2;
  const centerY = originY + Math.max(object.height, 1) / 2;
  const e = centerX - matrix.a * centerX - matrix.c * centerY;
  const f = centerY - matrix.b * centerX - matrix.d * centerY;
  return [
    "matrix(",
    formatNumber(matrix.a),
    " ",
    formatNumber(matrix.b),
    " ",
    formatNumber(matrix.c),
    " ",
    formatNumber(matrix.d),
    " ",
    formatNumber(e),
    " ",
    formatNumber(f),
    ")"
  ].join("");
}

function nativeArtGlossGradient(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace,
  matrix: NativeArtProjectionMatrix | undefined
): NativeArtGlossGradientPlan {
  const originX = coordinateSpace === "page" ? object.x : 0;
  const originY = coordinateSpace === "page" ? object.y : 0;
  return {
    cx: roundLayoutNumber(originX + Math.max(object.width, 1) * 0.34),
    cy: roundLayoutNumber(originY + Math.max(object.height, 1) * 0.28),
    r: roundLayoutNumber(Math.max(object.width, object.height, 1) * 0.7),
    stops: nativeArtGlossGradientStops(object),
    gradientTransform: matrix ? nativeArtProjectionSvgTransform(object, coordinateSpace, matrix) : undefined
  };
}

function nativeArtGlossGradientStops(object: GraphicObject): NativeArtGradientStopPlan[] {
  const fill = normalizeGraphicHexColor(graphicFillColor(object.style.fillColor));
  const stroke = normalizeGraphicHexColor(graphicColor(object.style.strokeColor, object.style.color, "#111111"));
  const base = fill ?? stroke ?? "#111111";
  return [
    { offset: 0, color: mixGraphicHexColor(base, "#ffffff", 0.88), opacity: 1 },
    { offset: 0.28, color: mixGraphicHexColor(base, "#ffffff", 0.58), opacity: 1 },
    { offset: 0.72, color: base, opacity: 1 },
    { offset: 1, color: mixGraphicHexColor(base, "#000000", 0.56), opacity: 1 }
  ];
}

function mixGraphicHexColor(from: string, to: string, amount: number): string {
  const fromRgb = rgbFromGraphicHexColor(from);
  const toRgb = rgbFromGraphicHexColor(to);
  if (!fromRgb || !toRgb) {
    return from;
  }
  const mix = (start: number, end: number) => Math.round(start + (end - start) * amount);
  return `#${[mix(fromRgb.r, toRgb.r), mix(fromRgb.g, toRgb.g), mix(fromRgb.b, toRgb.b)]
    .map((component) => component.toString(16).padStart(2, "0"))
    .join("")}`;
}

function rgbFromGraphicHexColor(color: string): { r: number; g: number; b: number } | undefined {
  const normalized = normalizeGraphicHexColor(color);
  if (!normalized) {
    return undefined;
  }
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16)
  };
}

function projectedArtShapePathD(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace,
  matrix: NativeArtProjectionMatrix,
  strokeWidth: number
): string {
  const width = Math.max(object.width, 1);
  const height = Math.max(object.height, 1);
  const localPoints = object.graphicKind === "ellipse"
    ? ellipsePathPoints(width, height, strokeWidth, { x: 0, y: 0 })
    : roundedRectPathPoints(width, height, graphicCornerRadius(object), strokeWidth, { x: 0, y: 0 });
  const points = localPoints.map((point) => nativeArtPointForSpace(
    object,
    projectNativeArtLocalPoint(point, width, height, matrix),
    coordinateSpace
  ));
  return pointsPathD(points, true);
}

function projectNativeArtLocalPoint(
  point: NativeArtPoint,
  width: number,
  height: number,
  matrix: NativeArtProjectionMatrix
): NativeArtPoint {
  const halfWidth = Math.max(width, 1) / 2;
  const halfHeight = Math.max(height, 1) / 2;
  const dx = point.x - halfWidth;
  const dy = point.y - halfHeight;
  return {
    x: halfWidth + matrix.a * dx + matrix.c * dy,
    y: halfHeight + matrix.b * dx + matrix.d * dy
  };
}

function nativeArtPointForSpace(
  object: GraphicObject,
  localPoint: NativeArtPoint,
  coordinateSpace: NativeArtVisualCoordinateSpace
): NativeArtPoint {
  return coordinateSpace === "page"
    ? { x: object.x + localPoint.x, y: object.y + localPoint.y }
    : localPoint;
}

function graphicColor(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0 && value.trim().toLowerCase() !== "none") {
      return value.trim();
    }
  }
  return "#111111";
}

function graphicFillColor(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "none";
}

function nativeArtFillPaint(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace,
  projectionTransform?: string
): NativeArtPaintPlan {
  const opacity = graphicFillOpacity(object);
  const explicitPaint = graphicPaintMetadata(object.style.fillPaint);
  if (explicitPaint) {
    return nativeArtPaintPlan(object, "fill", explicitPaint, coordinateSpace, projectionTransform, "#111111", opacity);
  }

  const color = graphicFillColor(object.style.fillColor);
  if (color.toLowerCase() === "none") {
    return { kind: "none", opacity };
  }

  return {
    kind: "solid",
    color: normalizeGraphicHexColor(color) ?? color,
    opacity
  };
}

function nativeArtStrokePaint(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace,
  projectionTransform?: string
): NativeArtPaintPlan {
  const opacity = graphicStrokeOpacity(object);
  const explicitPaint = graphicPaintMetadata(object.style.strokePaint);
  if (explicitPaint) {
    return nativeArtPaintPlan(object, "stroke", explicitPaint, coordinateSpace, projectionTransform, "#111111", opacity);
  }

  const color = graphicColor(object.style.strokeColor, object.style.color, "#111111");
  return {
    kind: "solid",
    color: normalizeGraphicHexColor(color) ?? color,
    opacity
  };
}

function nativeArtPaintPlan(
  object: GraphicObject,
  target: "fill" | "stroke",
  paint: GraphicPaint,
  coordinateSpace: NativeArtVisualCoordinateSpace,
  projectionTransform: string | undefined,
  fallbackColor: string,
  targetOpacity: number
): NativeArtPaintPlan {
  if (paint.kind === "none") {
    return { kind: "none", opacity: targetOpacity };
  }

  if (paint.kind === "solid") {
    return {
      kind: "solid",
      color: normalizeGraphicHexColor(paint.color) ?? fallbackColor,
      opacity: clampUnit((paint.opacity ?? 1) * targetOpacity)
    };
  }

  const idHint = `graphic-${target}-${object.id}`;
  const stops = paint.stops
    .map((stop) => nativeArtGradientStopPlan(stop, targetOpacity))
    .sort((a, b) => a.offset - b.offset);
  const base = coordinateSpace === "page" ? { x: object.x, y: object.y } : { x: 0, y: 0 };

  if (paint.kind === "linear-gradient") {
    return {
      kind: "linear-gradient",
      idHint,
      stops,
      x1: base.x + paint.x1 * object.width,
      y1: base.y + paint.y1 * object.height,
      x2: base.x + paint.x2 * object.width,
      y2: base.y + paint.y2 * object.height,
      gradientTransform: projectionTransform
    };
  }

  return {
    kind: "radial-gradient",
    idHint,
    stops,
    cx: base.x + paint.cx * object.width,
    cy: base.y + paint.cy * object.height,
    r: paint.r * Math.max(object.width, object.height, 1),
    fx: typeof paint.fx === "number" ? base.x + paint.fx * object.width : undefined,
    fy: typeof paint.fy === "number" ? base.y + paint.fy * object.height : undefined,
    gradientTransform: projectionTransform
  };
}

function nativeArtGradientStopPlan(stop: GraphicGradientStop, targetOpacity = 1): NativeArtGradientStopPlan {
  return {
    offset: clampUnit(stop.offset),
    color: normalizeGraphicHexColor(stop.color) ?? "#111111",
    opacity: clampUnit((stop.opacity ?? 1) * targetOpacity)
  };
}

function graphicPaintMetadata(value: unknown): GraphicPaint | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const paint = value as GraphicPaint;
  return typeof paint.kind === "string" ? paint : undefined;
}

function nativeArtMarkerPlan(value: unknown, strokeWidth: number): NativeArtMarkerPlan | undefined {
  const marker = graphicMarkerMetadata(value);
  if (!marker || marker.kind === "none") {
    return undefined;
  }

  const metadataSize = metadataNumber(marker.sizePx);
  const strokeAwareSize = marker.kind === "bar"
    ? strokeWidth * 2.4
    : marker.kind === "dot"
      ? strokeWidth * 2.8
      : strokeWidth * 4;
  return {
    kind: marker.kind,
    sizePx: Math.max(2, metadataSize ?? 10, strokeAwareSize),
    angleDegrees: metadataNumber(marker.angleDegrees) ?? 0
  };
}

function graphicMarkerMetadata(value: unknown): GraphicMarker | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const marker = value as GraphicMarker;
  return isNativeArtMarkerKind(marker.kind) ? marker : undefined;
}

function isNativeArtMarkerKind(kind: unknown): kind is NativeArtMarkerKind {
  return kind === "none" ||
    kind === "open-arrow" ||
    kind === "filled-arrow" ||
    kind === "half-arrow" ||
    kind === "bar" ||
    kind === "dot" ||
    kind === "diamond" ||
    kind === "chevron";
}

function graphicFillOpacity(object: GraphicObject): number {
  return clampUnit(metadataNumber(object.style.fillOpacity) ?? 1);
}

function graphicStrokeOpacity(object: GraphicObject): number {
  return clampUnit(metadataNumber(object.style.strokeOpacity) ?? 1);
}

function graphicStrokeLineCap(object: GraphicObject): NativeArtStrokePlan["lineCap"] {
  const value = metadataString(object.style.strokeLineCap);
  if (value === "butt" || value === "round" || value === "square") {
    return value;
  }
  return object.graphicKind === "line" || object.graphicKind === "path" ? "round" : "butt";
}

function graphicStrokeLineJoin(object: GraphicObject): NativeArtStrokePlan["lineJoin"] {
  const value = metadataString(object.style.strokeLineJoin);
  if (value === "miter" || value === "round" || value === "bevel") {
    return value;
  }
  return object.graphicKind === "path" ? "round" : "miter";
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeGraphicHexColor(color: string | undefined): string | undefined {
  const normalized = color?.trim().replace(/^#/, "").toLowerCase();
  if (!normalized || normalized === "none") {
    return undefined;
  }
  if (/^[0-9a-f]{3}$/.test(normalized)) {
    return `#${normalized.split("").map((character) => `${character}${character}`).join("")}`;
  }
  return /^[0-9a-f]{6}$/.test(normalized) ? `#${normalized}` : undefined;
}

function graphicLineEndpoints(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace = "page"
): { x1: number; y1: number; x2: number; y2: number } {
  const start = pointMetadata(object.data.lineStart);
  const end = pointMetadata(object.data.lineEnd);
  const resolvedStart = start ?? { x: object.x, y: object.y };
  const resolvedEnd = end ?? { x: object.x + object.width, y: object.y + object.height };
  const spaceStart = coordinateSpace === "page"
    ? resolvedStart
    : { x: resolvedStart.x - object.x, y: resolvedStart.y - object.y };
  const spaceEnd = coordinateSpace === "page"
    ? resolvedEnd
    : { x: resolvedEnd.x - object.x, y: resolvedEnd.y - object.y };
  return {
    x1: spaceStart.x,
    y1: spaceStart.y,
    x2: spaceEnd.x,
    y2: spaceEnd.y
  };
}

function graphicLineLocalPoints(object: GraphicObject): NativeArtPoint[] {
  const line = graphicLineEndpoints(object, "local");
  return [
    { x: line.x1, y: line.y1 },
    { x: line.x2, y: line.y2 }
  ];
}

function graphicOpenStrokePageSamplePoints(object: GraphicObject): NativeArtPoint[] {
  const localPoints = object.graphicKind === "line"
    ? graphicLineLocalPoints(object)
    : object.graphicKind === "path" ? graphicPathLocalSamplePoints(object) : [];
  // Project (tilt), translate to the page, and apply the object rotation so hit testing matches the
  // visible rotated stroke instead of its pre-rotation position.
  return localPoints.map((point) => graphicObjectLocalPointToPage(object, point));
}

function graphicPathSamplePoints(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace
): NativeArtPoint[] | undefined {
  if (!graphicPathKind(object)) {
    return undefined;
  }

  const localPoints = graphicPathLocalSamplePoints(object);
  return coordinateSpace === "page"
    ? localPoints.map((point) => ({ x: object.x + point.x, y: object.y + point.y }))
    : localPoints;
}

function graphicPathLocalSamplePoints(object: GraphicObject): NativeArtPoint[] {
  const pathKind = graphicPathKind(object);
  const inset = Math.max(3, (metadataNumber(object.style.strokeWidth) ?? 2) / 2);
  const storedPath = metadataString(object.data.pathD);
  if (storedPath && !pathKind) {
    return svgPathLocalSamplePoints(storedPath, object);
  }

  if (pathKind === "polyline" || pathKind === "bezier") {
    const pathD = graphicNodePathD(object, pathKind, "local");
    return pathD ? svgPathSamplePoints(pathD) : [];
  }

  if (pathKind === "freehand") {
    const pathD = graphicFreehandPathD(object, "local");
    return pathD ? svgPathSamplePoints(pathD) : [];
  }

  if (pathKind === "line") {
    const endpoints = graphicPathEndpoints(object, "local", inset);
    return [endpoints.start, endpoints.end];
  }

  if (pathKind === "wavy") {
    const endpoints = graphicPathEndpoints(object, "local", inset);
    return wavyLinePoints(
      endpoints.start,
      endpoints.end,
      Math.max(2, Math.min(5, (metadataNumber(object.style.strokeWidth) ?? 2) * 1.6))
    );
  }

  if (pathKind === "arc") {
    if (isSemanticArc(object)) {
      return artArcSamplePoints(object, "local");
    }
  }

  if (pathKind === "quadratic" || isQuadraticCurve(object)) {
    const explicitStart = pointMetadata(object.data.lineStart);
    const explicitEnd = pointMetadata(object.data.lineEnd);
    const explicitMiddle = pointMetadata(object.data.pathControlPoint);
    if (explicitStart && explicitEnd && explicitMiddle) {
      const start = pointForArtSpace(object, explicitStart, "local");
      const middle = pointForArtSpace(object, explicitMiddle, "local");
      const end = pointForArtSpace(object, explicitEnd, "local");
      return quadraticBezierSamplePoints(
        start,
        quadraticControlForMiddlePoint(start, middle, end),
        end,
        24
      );
    }
  }

  return [];
}

function svgPathLocalSamplePoints(pathD: string, object: GraphicObject): NativeArtPoint[] {
  const bounds = svgPathBounds(pathD);
  if (!bounds) {
    return [];
  }

  const strokeWidth = metadataNumber(object.style.strokeWidth) ?? 2;
  const tolerance = Math.max(8, strokeWidth * 2);
  const pathLooksLocal =
    bounds.x >= -tolerance &&
    bounds.y >= -tolerance &&
    bounds.x + bounds.width <= object.width + tolerance &&
    bounds.y + bounds.height <= object.height + tolerance;
  if (!pathLooksLocal) {
    return [];
  }

  return svgPathSamplePoints(pathD);
}

function svgPathBounds(pathD: string): NativeArtBounds | undefined {
  try {
    if (!isValidPath(pathD)) {
      return undefined;
    }
    const bounds = getPathBBox(pathD);
    if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
      return undefined;
    }
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    };
  } catch {
    return undefined;
  }
}

function svgPathSamplePoints(
  pathD: string,
  options: { includeBounds?: boolean } = {}
): NativeArtPoint[] {
  try {
    if (!isValidPath(pathD)) {
      return [];
    }
    const length = getTotalLength(pathD);
    const bounds = getPathBBox(pathD);
    const boundsPoints = [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x2, y: bounds.y },
      { x: bounds.x2, y: bounds.y2 },
      { x: bounds.x, y: bounds.y2 }
    ];
    if (!Number.isFinite(length) || length <= 0) {
      return boundsPoints;
    }

    const steps = Math.max(8, Math.min(96, Math.ceil(length / 8)));
    const pathPoints = Array.from({ length: steps + 1 }, (_, index) => {
      const point = getPointAtLength(pathD, length * index / steps);
      return { x: point.x, y: point.y };
    });
    const samples = options.includeBounds === false ? pathPoints : [...pathPoints, ...boundsPoints];
    return samples.filter((point) =>
      Number.isFinite(point.x) && Number.isFinite(point.y)
    );
  } catch {
    return [];
  }
}

function svgPathLooksClosed(pathD: string): boolean {
  return /[Zz]/.test(pathD);
}

function svgPathLooksCornered(pathD: string): boolean {
  return /[LlHhVv]/.test(pathD);
}

function graphicObjectBooleanPolygonInput(object: GraphicObject): NativeArtBooleanPolygonInput {
  const resolved = graphicObjectBooleanPagePoints(object);
  if (resolved.reason) {
    return { objectId: object.id, skipped: { objectId: object.id, reason: resolved.reason } };
  }

  const polygon = nativeArtBooleanPolygonFromPoints(resolved.points);
  return polygon
    ? { objectId: object.id, polygon }
    : { objectId: object.id, skipped: { objectId: object.id, reason: "invalid-geometry" } };
}

function graphicObjectBooleanPagePoints(object: GraphicObject): {
  points: NativeArtPoint[];
  reason?: undefined;
} | {
  points?: undefined;
  reason: NativeArtBooleanSkipReason;
} {
  const localPoints = graphicObjectBooleanLocalPoints(object);
  if (localPoints.reason) {
    return { reason: localPoints.reason };
  }

  const pagePoints = localPoints.points.map((point) => graphicObjectLocalPointToPage(object, point));
  const cleanPoints = cleanNativeArtBooleanRingPoints(pagePoints);
  return cleanPoints.length >= 3 ? { points: cleanPoints } : { reason: "invalid-geometry" };
}

function graphicObjectBooleanLocalPoints(object: GraphicObject): {
  points: NativeArtPoint[];
  reason?: undefined;
} | {
  points?: undefined;
  reason: NativeArtBooleanSkipReason;
} {
  if (object.graphicKind === "rect") {
    return {
      points: roundedRectPathPoints(Math.max(object.width, 1), Math.max(object.height, 1), graphicCornerRadius(object), 0, { x: 0, y: 0 })
    };
  }

  if (object.graphicKind === "ellipse") {
    return {
      points: ellipsePathPoints(Math.max(object.width, 1), Math.max(object.height, 1), 0, { x: 0, y: 0 })
    };
  }

  if (object.graphicKind !== "path") {
    return { reason: object.graphicKind === "line" ? "open-shape" : "unsupported-shape" };
  }

  const pathKind = graphicPathKind(object);
  if (pathKind === "polyline" || pathKind === "bezier") {
    const nodes = graphicPathNodes(object);
    if (!pathKindSupportsClosedFill(object, nodes)) {
      return { reason: "open-shape" };
    }
    const pathD = graphicNodePathD(object, pathKind, "local");
    const points = pathD ? svgPathSamplePoints(pathD, { includeBounds: false }) : [];
    return points.length >= 3 ? { points } : { reason: "invalid-geometry" };
  }

  if (pathKind === "freehand") {
    const pathD = graphicFreehandPathD(object, "local");
    const points = pathD ? svgPathSamplePoints(pathD, { includeBounds: false }) : [];
    return points.length >= 3 ? { points } : { reason: "invalid-geometry" };
  }

  if (pathKind) {
    return { reason: "open-shape" };
  }

  const storedPath = metadataString(object.data.pathD);
  if (!storedPath) {
    return { reason: "unsupported-shape" };
  }
  if (!svgPathLooksClosed(storedPath)) {
    return { reason: "open-shape" };
  }

  const points = svgPathSamplePoints(storedPath, { includeBounds: false });
  return points.length >= 3 ? { points } : { reason: "invalid-geometry" };
}

function graphicObjectLocalPointToPage(object: GraphicObject, point: NativeArtPoint): NativeArtPoint {
  const projected = projectGraphicObjectPoint(object, point, { coordinateSpace: "local" });
  const pagePoint = { x: object.x + projected.x, y: object.y + projected.y };
  const rotation = metadataNumber(object.rotation) ?? 0;
  if (Math.abs(rotation) < 0.001) {
    return pagePoint;
  }

  return rotateNativeArtPoint(
    pagePoint,
    { x: object.x + object.width / 2, y: object.y + object.height / 2 },
    degreesToRadians(rotation)
  );
}

function rotateNativeArtPoint(point: NativeArtPoint, center: NativeArtPoint, radians: number): NativeArtPoint {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: roundLayoutNumber(center.x + dx * cos - dy * sin),
    y: roundLayoutNumber(center.y + dx * sin + dy * cos)
  };
}

function nativeArtBooleanPolygonFromPoints(points: readonly NativeArtPoint[]): Flatten.Polygon | undefined {
  const cleanPoints = cleanNativeArtBooleanRingPoints(points);
  if (cleanPoints.length < 3) {
    return undefined;
  }

  try {
    const polygon = new Flatten.Polygon(cleanPoints.map((point) => [point.x, point.y] as [number, number]));
    return nativeArtBooleanPolygonHasArea(polygon) && polygon.isValid() ? polygon : undefined;
  } catch {
    return undefined;
  }
}

function reduceNativeArtBooleanPolygons(
  polygons: readonly Flatten.Polygon[],
  operation: Exclude<NativeArtBooleanOperation, "split">
): Flatten.Polygon {
  return polygons.slice(1).reduce((current, polygon) => {
    if (operation === "union") {
      return Flatten.BooleanOperations.unify(current, polygon);
    }
    if (operation === "subtract") {
      return Flatten.BooleanOperations.subtract(current, polygon);
    }
    return Flatten.BooleanOperations.intersect(current, polygon);
  }, polygons[0].clone());
}

function splitNativeArtBooleanPolygons(polygons: readonly Flatten.Polygon[]): Flatten.Polygon[] {
  let pieces: Flatten.Polygon[] = [];
  polygons.forEach((polygon) => {
    let remaining = polygon.clone();
    const nextPieces: Flatten.Polygon[] = [];
    pieces.forEach((piece) => {
      const overlap = Flatten.BooleanOperations.intersect(piece, polygon);
      const pieceOnly = Flatten.BooleanOperations.subtract(piece, polygon);
      if (nativeArtBooleanPolygonHasArea(pieceOnly)) {
        nextPieces.push(pieceOnly);
      }
      if (nativeArtBooleanPolygonHasArea(overlap)) {
        nextPieces.push(overlap);
      }
      remaining = Flatten.BooleanOperations.subtract(remaining, piece);
    });
    if (nativeArtBooleanPolygonHasArea(remaining)) {
      nextPieces.push(remaining);
    }
    pieces = nextPieces;
  });
  return pieces;
}

function nativeArtBooleanResultPaths(polygon: Flatten.Polygon): NativeArtBooleanResultPath[] {
  if (!nativeArtBooleanPolygonHasArea(polygon)) {
    return [];
  }

  const faces = Array.from(polygon.faces) as Flatten.Face[];
  const rings = faces
    .map((face) => cleanNativeArtBooleanRingPoints(face.vertices.map((point) => ({ x: point.x, y: point.y }))))
    .filter((ring) => ring.length >= 3);
  const points = rings.flat();
  if (rings.length === 0 || points.length < 3) {
    return [];
  }

  const rawBounds = boundsForPoints(points, 0, { x: 0, y: 0, width: 1, height: 1 });
  const bounds = {
    ...rawBounds,
    width: roundLayoutNumber(Math.max(rawBounds.width, 1)),
    height: roundLayoutNumber(Math.max(rawBounds.height, 1))
  };
  const pathD = rings.map((ring) =>
    pointsPathD(ring.map((point) => ({
      x: roundLayoutNumber(point.x - bounds.x),
      y: roundLayoutNumber(point.y - bounds.y)
    })), true)
  ).join(" ");

  return pathD
    ? [{
        pathD,
        bounds,
        area: roundLayoutNumber(Math.abs(polygon.area())),
        faceCount: rings.length
      }]
    : [];
}

function nativeArtBooleanPolygonHasArea(polygon: Flatten.Polygon): boolean {
  try {
    return !polygon.isEmpty() && Math.abs(polygon.area()) > 0.01 && Array.from(polygon.faces).length > 0;
  } catch {
    return false;
  }
}

function cleanNativeArtBooleanRingPoints(points: readonly NativeArtPoint[]): NativeArtPoint[] {
  const finitePoints = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: roundLayoutNumber(point.x), y: roundLayoutNumber(point.y) }));
  const cleanPoints: NativeArtPoint[] = [];
  finitePoints.forEach((point) => {
    const previous = cleanPoints.at(-1);
    if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 0.001) {
      cleanPoints.push(point);
    }
  });

  const first = cleanPoints[0];
  const last = cleanPoints.at(-1);
  if (first && last && cleanPoints.length > 1 && Math.hypot(first.x - last.x, first.y - last.y) <= 0.001) {
    cleanPoints.pop();
  }

  return cleanPoints;
}

function graphicPathD(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace = "page"
): string | undefined {
  const storedPath = metadataString(object.data.pathD);
  const pathKind = graphicPathKind(object);
  if (storedPath && !pathKind) {
    return coordinateSpace === "page"
      ? translateSvgPathD(storedPath, object.x, object.y)
      : storedPath;
  }

  const inset = Math.max(3, (metadataNumber(object.style.strokeWidth) ?? 2) / 2);
  if (pathKind === "polyline" || pathKind === "bezier") {
    return graphicNodePathD(object, pathKind, coordinateSpace);
  }

  if (pathKind === "freehand") {
    return graphicFreehandPathD(object, coordinateSpace);
  }

  if (pathKind === "line") {
    const equilibrium = graphicEquilibriumPathD(
      object,
      coordinateSpace,
      metadataNumber(object.style.strokeWidth) ?? 2
    );
    if (equilibrium) {
      return equilibrium;
    }
    const endpoints = graphicPathEndpoints(object, coordinateSpace, inset);
    return `M ${formatNumber(endpoints.start.x)} ${formatNumber(endpoints.start.y)} L ${formatNumber(endpoints.end.x)} ${formatNumber(endpoints.end.y)}`;
  }

  if (pathKind === "wavy") {
    const endpoints = graphicPathEndpoints(object, coordinateSpace, inset);
    if (pointMetadata(object.data.lineStart) && pointMetadata(object.data.lineEnd)) {
      return wavyLinePathD(
        endpoints.start,
        endpoints.end,
        Math.max(2, Math.min(5, (metadataNumber(object.style.strokeWidth) ?? 2) * 1.6))
      );
    }
    const originX = coordinateSpace === "page" ? object.x : 0;
    const originY = coordinateSpace === "page" ? object.y : 0;
    const midY = originY + object.height / 2;
    const amplitude = Math.max(4, Math.min(12, object.height * 0.24));
    return [
      `M ${formatNumber(originX + inset)} ${formatNumber(midY)}`,
      `C ${formatNumber(originX + object.width * 0.16)} ${formatNumber(midY - amplitude)}, ${formatNumber(originX + object.width * 0.28)} ${formatNumber(midY + amplitude)}, ${formatNumber(originX + object.width * 0.4)} ${formatNumber(midY)}`,
      `S ${formatNumber(originX + object.width * 0.64)} ${formatNumber(midY - amplitude)}, ${formatNumber(originX + object.width * 0.76)} ${formatNumber(midY)}`,
      `S ${formatNumber(originX + object.width * 0.92)} ${formatNumber(midY + amplitude)}, ${formatNumber(originX + object.width - inset)} ${formatNumber(midY)}`
    ].join(" ");
  }

  if (pathKind === "arc") {
    if (isSemanticArc(object)) {
      return artArcPathD(object, coordinateSpace);
    }
  }

  if (pathKind === "quadratic" || isQuadraticCurve(object)) {
    const explicitStart = pointMetadata(object.data.lineStart);
    const explicitEnd = pointMetadata(object.data.lineEnd);
    const explicitMiddle = pointMetadata(object.data.pathControlPoint);
    if (explicitStart && explicitEnd && explicitMiddle) {
      const endpoints = graphicPathEndpoints(object, coordinateSpace, inset);
      const middle = pointForArtSpace(object, explicitMiddle, coordinateSpace);
      const control = quadraticControlForMiddlePoint(endpoints.start, middle, endpoints.end);
      return [
        `M ${formatNumber(endpoints.start.x)} ${formatNumber(endpoints.start.y)}`,
        `Q ${formatNumber(control.x)} ${formatNumber(control.y)} ${formatNumber(endpoints.end.x)} ${formatNumber(endpoints.end.y)}`
      ].join(" ");
    }
  }

  return storedPath;
}

function translateSvgPathD(pathD: string, x: number, y: number): string {
  if (Math.abs(x) < 0.001 && Math.abs(y) < 0.001) {
    return pathD;
  }

  try {
    return new SVGPathCommander(pathD, { round: 3 })
      .transform({ translate: [x, y] })
      .toString();
  } catch {
    return pathD;
  }
}

export function createGraphicFreehandPathCache(
  object: GraphicObject
): Pick<GraphicObjectData, "cachedFreehandPathD" | "cachedFreehandPathRevision"> | undefined {
  if (object.graphicKind !== "path" || graphicPathKind(object) !== "freehand") {
    return undefined;
  }

  const cachedFreehandPathRevision = graphicFreehandPathRevision(object);
  const cachedFreehandPathD = graphicFreehandPathD(object, "local", { ignoreCache: true });
  return cachedFreehandPathD
    ? { cachedFreehandPathD, cachedFreehandPathRevision }
    : undefined;
}

function graphicFreehandPathD(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace,
  options: { ignoreCache?: boolean } = {}
): string | undefined {
  if (coordinateSpace === "local" && !options.ignoreCache) {
    const revision = graphicFreehandPathRevision(object);
    const persistedPathD = metadataString(object.data.cachedFreehandPathD);
    const persistedRevision = metadataString(object.data.cachedFreehandPathRevision);
    if (persistedPathD && persistedRevision === revision) {
      return persistedPathD;
    }

    const transient = transientFreehandPathCache.get(object);
    if (transient?.revision === revision) {
      return transient.pathD;
    }

    const computed = graphicFreehandPathD(object, coordinateSpace, { ignoreCache: true });
    transientFreehandPathCache.set(object, { revision, pathD: computed });
    return computed;
  }

  const outline = graphicFreehandOutlinePoints(object, coordinateSpace);
  if (outline.length < 2) {
    return undefined;
  }

  return `${nativeArtPointsPathD(outline)} Z`;
}

function graphicFreehandPathRevision(object: GraphicObject): string {
  const points = graphicFreehandPoints(object);
  const options = graphicFreehandStrokeOptions(object.data.freehandOptions);
  let xTotal = 0;
  let yTotal = 0;
  let pressureTotal = 0;
  for (const [index, point] of points.entries()) {
    const weight = index + 1;
    xTotal += point.x * weight;
    yTotal += point.y * weight;
    pressureTotal += (point.pressure ?? 0.5) * weight;
  }

  return [
    points.length,
    roundLayoutNumber(xTotal),
    roundLayoutNumber(yTotal),
    roundLayoutNumber(pressureTotal),
    options.size,
    options.thinning,
    options.smoothing,
    options.streamline,
    options.simulatePressure ? 1 : 0
  ].join(":");
}

function graphicFreehandOutlinePoints(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace
): NativeArtPoint[] {
  const points = graphicFreehandPoints(object);
  if (points.length === 0) {
    return [];
  }

  const input = points.map((point) => {
    const resolved = pointForArtSpace(object, point, coordinateSpace);
    return {
      x: resolved.x,
      y: resolved.y,
      pressure: typeof point.pressure === "number" && Number.isFinite(point.pressure)
        ? clampUnit(point.pressure)
        : 0.5
    };
  });
  const outline = getStroke(input, graphicFreehandStrokeOptions(object.data.freehandOptions));
  return outline
    .map(([x, y]) => ({ x: roundLayoutNumber(x), y: roundLayoutNumber(y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function graphicFreehandPoints(object: GraphicObject): GraphicFreehandPoint[] {
  const points = object.data.freehandPoints;
  if (!Array.isArray(points)) {
    return [];
  }

  return points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      x: point.x,
      y: point.y,
      ...(typeof point.pressure === "number" && Number.isFinite(point.pressure)
        ? { pressure: clampUnit(point.pressure) }
        : {})
    }));
}

function graphicFreehandStrokeOptions(options: GraphicFreehandOptions | undefined): StrokeOptions {
  return {
    size: clamp(metadataNumber(options?.size) ?? 8, 1, 128),
    thinning: clamp(metadataNumber(options?.thinning) ?? 0.5, -1, 1),
    smoothing: clampUnit(metadataNumber(options?.smoothing) ?? 0.5),
    streamline: clampUnit(metadataNumber(options?.streamline) ?? 0.5),
    simulatePressure: options?.simulatePressure ?? true,
    last: true
  };
}

function graphicNodePathD(
  object: GraphicObject,
  pathKind: Extract<GraphicPathKind, "polyline" | "bezier">,
  coordinateSpace: NativeArtVisualCoordinateSpace
): string | undefined {
  const nodes = graphicPathNodes(object);
  if (nodes.length === 0) {
    return undefined;
  }

  const commands = [`M ${formattedNodePoint(object, nodes[0].point, coordinateSpace)}`];
  for (let index = 1; index < nodes.length; index += 1) {
    commands.push(graphicNodeSegmentCommand(object, nodes[index - 1], nodes[index], pathKind, coordinateSpace));
  }

  if (pathKindSupportsClosedFill(object, nodes)) {
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (pathKind === "bezier" && (last.outControl || first.inControl)) {
      commands.push(graphicNodeSegmentCommand(object, last, first, pathKind, coordinateSpace));
    }
    commands.push("Z");
  }

  return commands.join(" ");
}

function graphicNodeSegmentCommand(
  object: GraphicObject,
  startNode: NativeGraphicPathNode,
  endNode: NativeGraphicPathNode,
  pathKind: Extract<GraphicPathKind, "polyline" | "bezier">,
  coordinateSpace: NativeArtVisualCoordinateSpace
): string {
  const end = formattedNodePoint(object, endNode.point, coordinateSpace);
  if (pathKind === "bezier" && (startNode.outControl || endNode.inControl)) {
    return [
      "C",
      formattedNodePoint(object, startNode.outControl ?? startNode.point, coordinateSpace),
      formattedNodePoint(object, endNode.inControl ?? endNode.point, coordinateSpace),
      end
    ].join(" ");
  }

  return `L ${end}`;
}

function formattedNodePoint(
  object: GraphicObject,
  point: NativeArtPoint,
  coordinateSpace: NativeArtVisualCoordinateSpace
): string {
  const resolved = pointForArtSpace(object, point, coordinateSpace);
  return `${formatNumber(resolved.x)} ${formatNumber(resolved.y)}`;
}

/** One half of an equilibrium arrow: tail at `start`, arrowhead at `end` pointing along `direction`. */
export interface NativeArtEquilibriumShaft {
  start: NativeArtPoint;
  end: NativeArtPoint;
  direction: NativeArtPoint;
}

export interface NativeArtEquilibriumGeometry {
  forward: NativeArtEquilibriumShaft;
  reverse: NativeArtEquilibriumShaft;
  /** Retrosynthetic (parallel) arrows only: the single head spanning both shafts, at the axis end.
   *  Its presence is also what marks the geometry as parallel rather than opposed. */
  head?: { point: NativeArtPoint; direction: NativeArtPoint };
}

export const EQUILIBRIUM_DEFAULT_GAP_PX = 10;
/** Shafts never shrink past this fraction of the axis, so both halves stay grabbable. */
const EQUILIBRIUM_MIN_FRAC = 0.15;
/**
 * How far back along its shaft a length handle sits from the arrowhead tip.
 *
 * At full length a shaft's head lands exactly on the axis endpoint, so a handle drawn at the tip would
 * stack on top of the endpoint handle and the endpoint would always win the press. Seating the handle
 * at the base of the arrowhead keeps the two apart and grabbable.
 */
export const EQUILIBRIUM_SHAFT_HANDLE_INSET_PX = 16;
/** Retrosynthetic head arms: how far back along the axis they sweep from the tip, and how far past
 *  each shaft they reach. Proportions follow the long-standing retrosynthesis drawing (arms ~10px
 *  back, ~4.5px beyond shafts sitting 2.5px off the axis). */
const RETRO_HEAD_ARM_BACK_PX = 10;
const RETRO_HEAD_ARM_CLEARANCE_PX = 4.5;
/** Where the resize knob floats off the axis at scale 1; it tracks the scale, so grabbing it never
 *  jumps and the drag distance reads directly as the new scale. */
const RETRO_SCALE_HANDLE_OFFSET_PX = 12;
const RETRO_MIN_SCALE = 0.4;
const RETRO_MAX_SCALE = 6;

/** Overall heft of a dual-shaft arrow: scales its shaft gap and head(s) together. */
export function dualShaftArrowScale(object: GraphicObject): number {
  const scale = metadataNumber(object.data.dualShaftScale);
  return scale === undefined ? 1 : clamp(scale, RETRO_MIN_SCALE, RETRO_MAX_SCALE);
}

/** Dual-shaft arrows draw their marker heads scaled by the arrow's heft, so the middle-knob resize
 *  grows an equilibrium's harpoons together with its shaft gap. Non-dual-shaft markers pass through. */
function dualShaftScaledMarker(
  object: GraphicObject,
  marker: GraphicMarker | undefined
): GraphicMarker | undefined {
  if (object.data.dualShaft !== true || !marker || marker.kind === "none") {
    return marker;
  }
  const scale = dualShaftArrowScale(object);
  const sizePx = metadataNumber(marker.sizePx);
  if (scale === 1 || sizePx === undefined) {
    return marker;
  }
  return { ...marker, sizePx: sizePx * scale };
}

export function equilibriumShaftFraction(value: unknown): number {
  const frac = metadataNumber(value);
  return frac === undefined ? 1 : clamp(frac, EQUILIBRIUM_MIN_FRAC, 1);
}

/**
 * The two half-shafts of an equilibrium arrow, derived from the `lineStart`->`lineEnd` axis.
 *
 * The forward shaft sits one half-gap to the left of the axis and runs from the tail toward the head;
 * the reverse shaft mirrors it on the other side, running back the other way. Each length is an
 * independent fraction of the axis so the two directions can be drawn unequal.
 */
export function graphicEquilibriumGeometry(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace = "page"
): NativeArtEquilibriumGeometry | undefined {
  if (object.data.dualShaft !== true) {
    return undefined;
  }

  const rawStart = pointMetadata(object.data.lineStart);
  const rawEnd = pointMetadata(object.data.lineEnd);
  if (!rawStart || !rawEnd) {
    return undefined;
  }

  const a = pointForArtSpace(object, rawStart, coordinateSpace);
  const b = pointForArtSpace(object, rawEnd, coordinateSpace);
  const axis = normalizedVector({ x: b.x - a.x, y: b.y - a.y });
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!axis || length <= 0.001) {
    return undefined;
  }

  // The forward shaft takes the -normal side (above a left-to-right axis) and the reverse shaft the
  // +normal side, which is the conventional equilibrium layout: forward on top, reverse beneath. It
  // also puts each half-arrow's barb — always drawn on one fixed side of its own direction — on the
  // outside of the pair rather than facing inward, which reads as upside down.
  const normal = { x: axis.y, y: -axis.x };
  // Both dual-shaft forms scale their gap with the arrow's heft (the middle-knob resize).
  const half = ((metadataNumber(object.data.dualShaftGapPx) ?? EQUILIBRIUM_DEFAULT_GAP_PX) / 2) *
    dualShaftArrowScale(object);

  // Retrosynthetic: both shafts run the same way, full length, with one head spanning them at the
  // axis end. There is nothing per-shaft to vary here — it reads as a single double-shafted arrow.
  if (object.data.dualShaftParallel === true) {
    const offset = (side: 1 | -1): NativeArtEquilibriumShaft => ({
      start: { x: a.x + normal.x * half * side, y: a.y + normal.y * half * side },
      end: { x: b.x + normal.x * half * side, y: b.y + normal.y * half * side },
      direction: axis
    });
    return { forward: offset(1), reverse: offset(-1), head: { point: b, direction: axis } };
  }

  const forwardLength = length * equilibriumShaftFraction(object.data.dualShaftForwardFrac);
  const reverseLength = length * equilibriumShaftFraction(object.data.dualShaftReverseFrac);
  // Both shafts stay centred on the axis midpoint: an equilibrium's two halves are often unequal in
  // length, but they are always centred on each other rather than anchored to opposite ends.
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const reach = (shaftLength: number, towards: 1 | -1, side: 1 | -1): NativeArtPoint => ({
    x: mid.x + axis.x * (shaftLength / 2) * towards + normal.x * half * side,
    y: mid.y + axis.y * (shaftLength / 2) * towards + normal.y * half * side
  });

  return {
    forward: {
      start: reach(forwardLength, -1, 1),
      end: reach(forwardLength, 1, 1),
      direction: axis
    },
    reverse: {
      start: reach(reverseLength, 1, -1),
      end: reach(reverseLength, -1, -1),
      direction: { x: -axis.x, y: -axis.y }
    }
  };
}

/**
 * Where a dual-shaft arrow's resize knob sits (retrosynthetic and equilibrium alike): off the axis
 * midpoint, at a distance that tracks the current scale. Because position and scale share one
 * factor, grabbing the knob never makes it jump, and the drag distance maps straight back to the
 * new scale.
 */
export function graphicDualShaftScaleHandlePoint(object: GraphicObject): NativeArtPoint | undefined {
  const geometry = graphicEquilibriumGeometry(object);
  const start = pointMetadata(object.data.lineStart);
  const end = pointMetadata(object.data.lineEnd);
  if (!geometry || !start || !end) {
    return undefined;
  }

  const axis = normalizedVector({ x: end.x - start.x, y: end.y - start.y });
  if (!axis) {
    return undefined;
  }

  const normal = { x: axis.y, y: -axis.x };
  const reach = RETRO_SCALE_HANDLE_OFFSET_PX * dualShaftArrowScale(object);
  return {
    x: (start.x + end.x) / 2 + normal.x * reach,
    y: (start.y + end.y) / 2 + normal.y * reach
  };
}

/** Where each half-shaft's length handle sits: back along the shaft from its arrowhead tip. */
export function graphicEquilibriumHandlePoints(
  object: GraphicObject
): { forward: NativeArtPoint; reverse: NativeArtPoint } | undefined {
  const geometry = graphicEquilibriumGeometry(object);
  // Parallel (retrosynthetic) arrows have nothing per-shaft to adjust — both halves are one arrow —
  // so they get the ordinary endpoint handles only.
  if (!geometry || geometry.head) {
    return undefined;
  }

  // The seat scales with the arrow's heft so the handle stays at the base of the (scaled) harpoon
  // head instead of disappearing inside a grown one.
  const seatInset = EQUILIBRIUM_SHAFT_HANDLE_INSET_PX * dualShaftArrowScale(object);
  const seat = (shaft: NativeArtEquilibriumShaft): NativeArtPoint => {
    const length = Math.hypot(shaft.end.x - shaft.start.x, shaft.end.y - shaft.start.y);
    const inset = Math.min(seatInset, Math.max(0, length * 0.5));
    return {
      x: shaft.end.x - shaft.direction.x * inset,
      y: shaft.end.y - shaft.direction.y * inset
    };
  };

  return { forward: seat(geometry.forward), reverse: seat(geometry.reverse) };
}

/** Both shafts as one two-subpath `d`, each already shortened to leave room for its arrowhead. */
function graphicEquilibriumPathD(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace,
  strokeWidth: number
): string | undefined {
  const geometry = graphicEquilibriumGeometry(object, coordinateSpace);
  if (!geometry) {
    return undefined;
  }

  // Retrosynthetic head geometry, needed up front because the shafts stop where they MEET the arms.
  // The arms sweep from the tip back past both shafts, so each shaft's trim is the along-axis
  // distance at which an arm crosses its offset: back * (halfGap / reach). A fixed trim only worked
  // at scale 1 — grow the head and the shafts speared straight through the V.
  const head = geometry.head
    ? (() => {
        const { point: tip, direction } = geometry.head;
        const normal = { x: direction.y, y: -direction.x };
        const halfGap = Math.abs(
          (geometry.forward.start.x - geometry.reverse.start.x) * normal.x +
          (geometry.forward.start.y - geometry.reverse.start.y) * normal.y
        ) / 2;
        const scale = dualShaftArrowScale(object);
        const reach = halfGap + RETRO_HEAD_ARM_CLEARANCE_PX * scale;
        const back = RETRO_HEAD_ARM_BACK_PX * scale;
        return { tip, direction, normal, reach, back, shaftTrim: back * (halfGap / reach) };
      })()
    : undefined;

  const shaft = (part: NativeArtEquilibriumShaft, marker: GraphicMarker | undefined): string => {
    const plan = nativeArtMarkerPlan(dualShaftScaledMarker(object, marker), strokeWidth);
    const inset = head
      ? head.shaftTrim
      : plan ? nativeArtMarkerShaftInset(plan, strokeWidth) : 0;
    const length = Math.hypot(part.end.x - part.start.x, part.end.y - part.start.y);
    const trim = Math.min(inset, Math.max(0, length - 1));
    const tip = {
      x: part.end.x - part.direction.x * trim,
      y: part.end.y - part.direction.y * trim
    };
    return `M ${formatNumber(part.start.x)} ${formatNumber(part.start.y)} ` +
      `L ${formatNumber(tip.x)} ${formatNumber(tip.y)}`;
  };

  const shafts = `${shaft(geometry.forward, object.data.markerEnd)} ${shaft(geometry.reverse, object.data.markerStart)}`;
  if (!head) {
    return shafts;
  }

  // Two arms from the tip sweeping back past BOTH shafts, the classic "=>" — an ordinary arrowhead
  // marker centred on the axis can never span the pair. Drawn as the arrow's own path geometry.
  const arm = (side: 1 | -1): string => {
    const end = {
      x: head.tip.x - head.direction.x * head.back + head.normal.x * head.reach * side,
      y: head.tip.y - head.direction.y * head.back + head.normal.y * head.reach * side
    };
    return `M ${formatNumber(head.tip.x)} ${formatNumber(head.tip.y)} L ${formatNumber(end.x)} ${formatNumber(end.y)}`;
  };
  return `${shafts} ${arm(1)} ${arm(-1)}`;
}

function graphicPathEndpoints(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace,
  inset: number
): { start: NativeArtPoint; end: NativeArtPoint } {
  const start = pointMetadata(object.data.lineStart);
  const end = pointMetadata(object.data.lineEnd);
  return start && end
    ? {
        start: pointForArtSpace(object, start, coordinateSpace),
        end: pointForArtSpace(object, end, coordinateSpace)
      }
    : {
        start: nativeArtPointForSpace(object, { x: inset, y: inset }, coordinateSpace),
        end: nativeArtPointForSpace(object, { x: object.width - inset, y: object.height - inset }, coordinateSpace)
      };
}

function pointForArtSpace(
  object: GraphicObject,
  point: NativeArtPoint,
  coordinateSpace: NativeArtVisualCoordinateSpace
): NativeArtPoint {
  return coordinateSpace === "page"
    ? point
    : { x: point.x - object.x, y: point.y - object.y };
}

function wavyLinePathD(start: NativeArtPoint, end: NativeArtPoint, amplitude: number): string {
  const points = wavyLinePoints(start, end, amplitude);
  return [
    `M ${formatNumber(points[0].x)} ${formatNumber(points[0].y)}`,
    ...points.slice(1).map((point) => `L ${formatNumber(point.x)} ${formatNumber(point.y)}`)
  ].join(" ");
}

function wavyLinePoints(start: NativeArtPoint, end: NativeArtPoint, amplitude: number): NativeArtPoint[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) {
    return [start, end];
  }
  const normal = { x: -dy / length, y: dx / length };
  const steps = Math.max(8, Math.ceil(length / 5));
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    const wave = Math.sin(t * Math.PI * 2 * Math.max(2, length / 8)) * amplitude;
    return {
      x: start.x + dx * t + normal.x * wave,
      y: start.y + dy * t + normal.y * wave
    };
  });
}

function artArcPathD(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace = "page"
): string {
  const geometry = circularGraphicArcGeometry(object);
  const center = pointForArtSpace(object, geometry.center, coordinateSpace);
  const start = ellipsePointAtRadians(center, geometry.radiusX, geometry.radiusY, geometry.startRadians);
  const end = ellipsePointAtRadians(center, geometry.radiusX, geometry.radiusY, geometry.endRadians);
  return [
    `M ${formatNumber(start.x)} ${formatNumber(start.y)}`,
    `A ${formatNumber(geometry.radiusX)} ${formatNumber(geometry.radiusY)} 0 ${Math.abs(geometry.sweepRadians) > Math.PI ? 1 : 0} ${geometry.sweepRadians < 0 ? 0 : 1} ${formatNumber(end.x)} ${formatNumber(end.y)}`
  ].join(" ");
}

function artArcSamplePoints(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace = "page"
): NativeArtPoint[] {
  const geometry = circularGraphicArcGeometry(object);
  return arcSamplePointsRadians(
    pointForArtSpace(object, geometry.center, coordinateSpace),
    geometry.radiusX,
    geometry.radiusY,
    geometry.startRadians,
    geometry.endRadians,
    32
  );
}

function nativeArtArcAngles(object: GraphicObject): { startRadians: number; sweepRadians: number; endRadians: number } {
  const sweepRadians = clampSignedArcSweepRadians(metadataNumber(object.data.arcSweepRadians) ?? Math.PI);
  const startRadians = metadataNumber(object.data.arcStartRadians) ?? -Math.PI / 2 - sweepRadians / 2;
  return {
    startRadians,
    sweepRadians,
    endRadians: startRadians + sweepRadians
  };
}

function quadraticBezierSamplePoints(
  start: NativeArtPoint,
  control: NativeArtPoint,
  end: NativeArtPoint,
  steps: number
): NativeArtPoint[] {
  return Array.from({ length: Math.max(1, steps) + 1 }, (_, index) => {
    const t = index / Math.max(1, steps);
    const inverseT = 1 - t;
    return {
      x: inverseT * inverseT * start.x + 2 * inverseT * t * control.x + t * t * end.x,
      y: inverseT * inverseT * start.y + 2 * inverseT * t * control.y + t * t * end.y
    };
  });
}

function quadraticControlForMiddlePoint(
  start: NativeArtPoint,
  middle: NativeArtPoint,
  end: NativeArtPoint
): NativeArtPoint {
  return {
    x: 2 * middle.x - (start.x + end.x) / 2,
    y: 2 * middle.y - (start.y + end.y) / 2
  };
}

function roundedRectPathPoints(
  width: number,
  height: number,
  rx: number,
  strokeWidth: number,
  offset: NativeArtPoint
): NativeArtPoint[] {
  const inset = Math.max(strokeWidth / 2, 0);
  const x0 = inset + offset.x;
  const y0 = inset + offset.y;
  const x1 = Math.max(width - inset + offset.x, x0 + 0.5);
  const y1 = Math.max(height - inset + offset.y, y0 + 0.5);
  const radius = Math.max(0, Math.min(rx, (x1 - x0) / 2, (y1 - y0) / 2));
  if (radius <= 0.001) {
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 }
    ];
  }

  return [
    ...arcSamplePoints({ x: x1 - radius, y: y0 + radius }, radius, radius, -90, 0, 8),
    ...arcSamplePoints({ x: x1 - radius, y: y1 - radius }, radius, radius, 0, 90, 8).slice(1),
    ...arcSamplePoints({ x: x0 + radius, y: y1 - radius }, radius, radius, 90, 180, 8).slice(1),
    ...arcSamplePoints({ x: x0 + radius, y: y0 + radius }, radius, radius, 180, 270, 8).slice(1)
  ];
}

function ellipsePathPoints(
  width: number,
  height: number,
  strokeWidth: number,
  offset: NativeArtPoint
): NativeArtPoint[] {
  const inset = Math.max(strokeWidth / 2, 0);
  return arcSamplePoints(
    { x: width / 2 + offset.x, y: height / 2 + offset.y },
    Math.max(width / 2 - inset, 0.5),
    Math.max(height / 2 - inset, 0.5),
    0,
    360,
    72
  );
}

function arcSamplePoints(
  center: NativeArtPoint,
  rx: number,
  ry: number,
  startDegrees: number,
  endDegrees: number,
  steps: number
): NativeArtPoint[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = steps <= 0 ? 1 : index / steps;
    return ellipsePointAtDegrees(center, rx, ry, startDegrees + (endDegrees - startDegrees) * t);
  });
}

function arcSamplePointsRadians(
  center: NativeArtPoint,
  rx: number,
  ry: number,
  startRadians: number,
  endRadians: number,
  steps: number
): NativeArtPoint[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = steps <= 0 ? 1 : index / steps;
    return ellipsePointAtRadians(center, rx, ry, startRadians + (endRadians - startRadians) * t);
  });
}

function circularArcBoundsPoints(geometry: CircularGraphicArcGeometry): NativeArtPoint[] {
  const arcPoints = arcSamplePointsRadians(
    geometry.center,
    geometry.radiusX,
    geometry.radiusY,
    geometry.startRadians,
    geometry.endRadians,
    48
  );
  const extremaPoints = [0, Math.PI / 2, Math.PI, Math.PI * 1.5]
    .filter((angle) => angleWithinSweptArc(angle, geometry.startRadians, geometry.sweepRadians))
    .map((angle) => ellipsePointAtRadians(geometry.center, geometry.radiusX, geometry.radiusY, angle));
  const middle = ellipsePointAtRadians(
    geometry.center,
    geometry.radiusX,
    geometry.radiusY,
    geometry.startRadians + geometry.sweepRadians / 2
  );
  return [...arcPoints, ...extremaPoints, middle];
}

function angleWithinSweptArc(angle: number, startRadians: number, sweepRadians: number): boolean {
  return sweepRadians < 0
    ? clockwiseDeltaRadians(normalizeRadians(angle), normalizeRadians(startRadians)) <= Math.abs(sweepRadians) + 0.000001
    : clockwiseDeltaRadians(normalizeRadians(startRadians), normalizeRadians(angle)) <= sweepRadians + 0.000001;
}

function normalizeRadians(radians: number): number {
  const fullCircle = Math.PI * 2;
  const normalized = radians % fullCircle;
  return normalized < 0 ? normalized + fullCircle : normalized;
}

function pointsPathD(points: readonly NativeArtPoint[], closed: boolean): string {
  const first = points[0];
  if (!first) {
    return "";
  }

  return [
    `M ${formatNumber(first.x)} ${formatNumber(first.y)}`,
    ...points.slice(1).map((point) => `L ${formatNumber(point.x)} ${formatNumber(point.y)}`),
    closed ? "Z" : ""
  ].filter(Boolean).join(" ");
}

function roundLayoutNumber(value: number): number {
  return Number(value.toFixed(4));
}

function ellipsePointAtDegrees(
  center: NativeArtPoint,
  rx: number,
  ry: number,
  degrees: number
): NativeArtPoint {
  const radians = degreesToRadians(degrees);
  return {
    x: center.x + Math.cos(radians) * rx,
    y: center.y + Math.sin(radians) * ry
  };
}

function expandNativeArtRect(rect: NativeArtBounds, amount: number): NativeArtBounds {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2
  };
}

function nativeArtRectangleContainsRect(outer: NativeArtBounds, inner: NativeArtBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y >= outer.y &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function nativeArtPointInRect(point: NativeArtPoint, rect: NativeArtBounds): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function nativeArtLineIntersectsRect(start: NativeArtPoint, end: NativeArtPoint, rect: NativeArtBounds): boolean {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  return (
    nativeArtSegmentsIntersect(start, end, { x: left, y: top }, { x: right, y: top }) ||
    nativeArtSegmentsIntersect(start, end, { x: right, y: top }, { x: right, y: bottom }) ||
    nativeArtSegmentsIntersect(start, end, { x: right, y: bottom }, { x: left, y: bottom }) ||
    nativeArtSegmentsIntersect(start, end, { x: left, y: bottom }, { x: left, y: top })
  );
}

function nativeArtPolygonIntersectsRect(polygon: readonly NativeArtPoint[], rect: NativeArtBounds): boolean {
  if (polygon.length < 3) {
    return false;
  }

  const corners = nativeArtRectCorners(rect);
  return (
    corners.some((corner) => nativeArtPointInPolygon(corner, polygon)) ||
    polygon.some((point) => nativeArtPointInRect(point, rect)) ||
    nativeArtPolygonEdges(polygon).some(([start, end]) => nativeArtLineIntersectsRect(start, end, rect))
  );
}

function nativeArtPointInPolygon(point: NativeArtPoint, polygon: readonly NativeArtPoint[]): boolean {
  let inside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    const crossesY = current.y > point.y !== previous.y > point.y;
    if (!crossesY) {
      continue;
    }
    const intersectionX = ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
    if (point.x < intersectionX) {
      inside = !inside;
    }
  }
  return inside;
}

function nativeArtLineIntersectsPolygon(
  start: NativeArtPoint,
  end: NativeArtPoint,
  polygon: readonly NativeArtPoint[]
): boolean {
  return (
    nativeArtPointInPolygon(start, polygon) ||
    nativeArtPointInPolygon(end, polygon) ||
    nativeArtPolygonEdges(polygon).some(([edgeStart, edgeEnd]) =>
      nativeArtSegmentsIntersect(start, end, edgeStart, edgeEnd)
    )
  );
}

function nativeArtRectCorners(rect: NativeArtBounds): NativeArtPoint[] {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom }
  ];
}

function nativeArtPolygonEdges(polygon: readonly NativeArtPoint[]): Array<[NativeArtPoint, NativeArtPoint]> {
  const edges: Array<[NativeArtPoint, NativeArtPoint]> = polygon
    .slice(0, -1)
    .map((point, index) => [point, polygon[index + 1]]);
  // Lasso/selection polygons render as a closed shape, so include the closing edge from the last
  // sampled point back to the first; otherwise an object only crossing that edge is never selected.
  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  if (polygon.length >= 3 && first && last && (first.x !== last.x || first.y !== last.y)) {
    edges.push([last, first]);
  }
  return edges;
}

function nativeArtSegmentsIntersect(
  a: NativeArtPoint,
  b: NativeArtPoint,
  c: NativeArtPoint,
  d: NativeArtPoint
): boolean {
  const orientation = (p: NativeArtPoint, q: NativeArtPoint, r: NativeArtPoint) =>
    Math.sign((q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y));
  const onSegment = (p: NativeArtPoint, q: NativeArtPoint, r: NativeArtPoint) =>
    q.x >= Math.min(p.x, r.x) - 0.000001 &&
    q.x <= Math.max(p.x, r.x) + 0.000001 &&
    q.y >= Math.min(p.y, r.y) - 0.000001 &&
    q.y <= Math.max(p.y, r.y) + 0.000001;

  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return (
    (o1 !== o2 && o3 !== o4) ||
    (o1 === 0 && onSegment(a, c, b)) ||
    (o2 === 0 && onSegment(a, d, b)) ||
    (o3 === 0 && onSegment(c, a, d)) ||
    (o4 === 0 && onSegment(c, b, d))
  );
}

function ellipsePointAtRadians(
  center: NativeArtPoint,
  rx: number,
  ry: number,
  radians: number
): NativeArtPoint {
  return {
    x: center.x + Math.cos(radians) * rx,
    y: center.y + Math.sin(radians) * ry
  };
}

function clampArcSweepRadians(radians: number): number {
  return Math.max(Math.PI / 180, Math.min(Math.PI * 2 - Math.PI / 1800, Math.abs(radians)));
}

function clampSignedArcSweepRadians(radians: number): number {
  const clamped = clampArcSweepRadians(radians);
  return radians < 0 ? -clamped : clamped;
}

function pointMetadata(value: unknown): NativeArtPoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const point = value as Record<string, unknown>;
  const x = point.x;
  const y = point.y;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
    ? { x, y }
    : undefined;
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function metadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return Number(value.toFixed(4)).toString();
}
