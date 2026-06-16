import type { GraphicGradientStop, GraphicObject, GraphicPaint } from "@chemdraft/chem-core";
import {
  getPathBBox,
  getPointAtLength,
  getTotalLength,
  isValidPath
} from "svg-path-commander/util";

const minimumArcSweepRadians = Math.PI / 180;
const maximumArcSweepRadians = Math.PI * 2 - Math.PI / 1800;

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
  gradientTransform?: string;
}

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
  projectionMatrix?: NativeArtProjectionMatrix;
  projectionTransform?: string;
  frameBounds: NativeArtBounds;
  line?: { x1: number; y1: number; x2: number; y2: number };
  pathD?: string;
  projectedShapePathD?: string;
  glossGradient?: NativeArtGlossGradientPlan;
}

export type GraphicPathEditHandle = "start" | "middle" | "end";

export type GraphicPathKind = "line" | "wavy" | "arc" | "quadratic";

export interface GraphicPathEditPoints {
  start: NativeArtPoint;
  middle: NativeArtPoint;
  end: NativeArtPoint;
  pathKind: GraphicPathKind;
}

interface CircularGraphicArcGeometry {
  center: NativeArtPoint;
  radiusX: number;
  radiusY: number;
  startRadians: number;
  sweepRadians: number;
  endRadians: number;
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
  const stroke: NativeArtStrokePlan = {
    color: graphicColor(object.style.strokeColor, object.style.color, "#111111"),
    width: metadataNumber(object.style.strokeWidth) ?? 1.5,
    dasharray: metadataString(object.style.strokeDasharray),
    opacity: graphicStrokeOpacity(object),
    lineCap: graphicStrokeLineCap(object),
    lineJoin: graphicStrokeLineJoin(object),
    miterLimit: metadataNumber(object.style.strokeMiterLimit) ?? 4,
    paint: nativeArtStrokePaint(object, coordinateSpace, projectionTransform)
  };
  const fill: NativeArtFillPlan = {
    color: capabilities.supportsFill ? graphicFillColor(object.style.fillColor) : "none",
    mode: capabilities.supportsFill ? metadataString(object.style.fillMode) : undefined,
    opacity: capabilities.supportsFill ? graphicFillOpacity(object) : 1,
    paint: capabilities.supportsFill
      ? nativeArtFillPaint(object, coordinateSpace, projectionTransform)
      : { kind: "none", opacity: 1 }
  };
  const frameBounds = nativeArtFrameBounds(object, matrix, coordinateSpace);
  const cornerRadius = graphicCornerRadius(object);
  const line = object.graphicKind === "line"
    ? graphicLineEndpoints(object, coordinateSpace)
    : undefined;
  const pathD = object.graphicKind === "path"
    ? graphicPathD(object, coordinateSpace)
    : undefined;
  const projectedShapePathD = matrix && (object.graphicKind === "ellipse" || object.graphicKind === "rect")
    ? projectedArtShapePathD(object, coordinateSpace, matrix, stroke.width)
    : undefined;

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
    effect: metadataString(object.style.effect),
    projectionMatrix: matrix,
    projectionTransform,
    frameBounds,
    line,
    pathD,
    projectedShapePathD,
    glossGradient: capabilities.supportsFill && fill.mode === "gloss"
      ? nativeArtGlossGradient(object, coordinateSpace, matrix)
      : undefined
  };
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

  const fallback = graphicPathFallbackPoints(object, pathKind);
  if (isSemanticArc(object)) {
    return fallback;
  }
  const explicitStart = pointMetadata(object.data.lineStart);
  const explicitEnd = pointMetadata(object.data.lineEnd);
  const explicitControl = pointMetadata(object.data.pathControlPoint);
  const start = explicitStart ?? fallback.start;
  const end = explicitEnd ?? fallback.end;
  return {
    start,
    end,
    middle: explicitControl ?? fallback.middle ?? midpoint(start, end),
    pathKind
  };
}

export function editGraphicPathGeometry(
  object: GraphicObject,
  handle: GraphicPathEditHandle,
  point: NativeArtPoint
): GraphicObject | undefined {
  const kind = graphicPathKind(object);
  if (kind === "line" && handle === "middle") {
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
    lineStart: projectGraphicObjectPoint(object, points.start),
    lineEnd: projectGraphicObjectPoint(object, points.end)
  };
  if (points.pathKind === "quadratic") {
    nextData.pathControlPoint = projectGraphicObjectPoint(object, points.middle);
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

function nativeArtProjectionMatrixForObject(object: GraphicObject): NativeArtProjectionMatrix | undefined {
  const tiltXDegrees = metadataNumber(object.style.tiltXDegrees) ?? 0;
  const tiltYDegrees = metadataNumber(object.style.tiltYDegrees) ?? 0;
  if (
    Math.abs(tiltXDegrees) < 0.001 &&
    Math.abs(tiltYDegrees) < 0.001 &&
    Math.abs(object.rotation) < 0.001
  ) {
    return undefined;
  }

  return nativeArtProjectionMatrix(tiltXDegrees, tiltYDegrees, object.rotation);
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
  if (kind === "line" || kind === "wavy" || kind === "arc" || kind === "quadratic") {
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
    object.data.artPathKind === nextData.artPathKind &&
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
  const points = data.artPathKind === "quadratic" && start && end && middle
    ? quadraticBezierSamplePoints(start, quadraticControlForMiddlePoint(start, middle, end), end, 24)
    : [start, end, middle].filter((point): point is NativeArtPoint => point !== undefined);
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

function nativeArtFrameBounds(
  object: GraphicObject,
  matrix: NativeArtProjectionMatrix | undefined,
  coordinateSpace: NativeArtVisualCoordinateSpace
): NativeArtBounds {
  const unprojected = coordinateSpace === "page"
    ? { x: object.x, y: object.y, width: object.width, height: object.height }
    : { x: 0, y: 0, width: object.width, height: object.height };
  if (!matrix) {
    return unprojected;
  }

  const localBounds = nativeArtProjectedLocalBounds(object, matrix);
  return coordinateSpace === "page"
    ? { ...localBounds, x: object.x + localBounds.x, y: object.y + localBounds.y }
    : localBounds;
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
    gradientTransform: matrix ? nativeArtProjectionSvgTransform(object, coordinateSpace, matrix) : undefined
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
  return localPoints.map((point) => {
    const projected = projectGraphicObjectPoint(object, point, { coordinateSpace: "local" });
    return {
      x: object.x + projected.x,
      y: object.y + projected.y
    };
  });
}

function graphicPathLocalSamplePoints(object: GraphicObject): NativeArtPoint[] {
  const pathKind = graphicPathKind(object);
  const inset = Math.max(3, (metadataNumber(object.style.strokeWidth) ?? 2) / 2);
  const storedPath = metadataString(object.data.pathD);
  if (storedPath && !pathKind) {
    return svgPathLocalSamplePoints(storedPath, object);
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

function svgPathSamplePoints(pathD: string): NativeArtPoint[] {
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
    return [...pathPoints, ...boundsPoints].filter((point) =>
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

function graphicPathD(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace = "page"
): string | undefined {
  const storedPath = metadataString(object.data.pathD);
  const pathKind = graphicPathKind(object);
  if (storedPath && !pathKind) {
    return storedPath;
  }

  const inset = Math.max(3, (metadataNumber(object.style.strokeWidth) ?? 2) / 2);
  if (pathKind === "line") {
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
