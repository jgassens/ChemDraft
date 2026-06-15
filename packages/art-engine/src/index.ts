import type { GraphicObject } from "@chemdraft/chem-core";
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

export interface NativeArtStrokePlan {
  color: string;
  width: number;
  dasharray?: string;
}

export interface NativeArtFillPlan {
  color: string;
  mode?: string;
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

export type GraphicPathKind = "line" | "wavy" | "arc";

export interface GraphicPathEditPoints {
  start: NativeArtPoint;
  middle: NativeArtPoint;
  end: NativeArtPoint;
  pathKind: GraphicPathKind;
}

export function planNativeArtVisual(
  object: GraphicObject,
  options: { coordinateSpace?: NativeArtVisualCoordinateSpace } = {}
): NativeArtVisualPlan {
  const coordinateSpace = options.coordinateSpace ?? "page";
  const width = Math.max(object.width, 1);
  const height = Math.max(object.height, 1);
  const stroke: NativeArtStrokePlan = {
    color: graphicColor(object.style.strokeColor, object.style.color, "#111111"),
    width: metadataNumber(object.style.strokeWidth) ?? 1.5,
    dasharray: metadataString(object.style.strokeDasharray)
  };
  const fill: NativeArtFillPlan = {
    color: graphicFillColor(object.style.fillColor),
    mode: metadataString(object.style.fillMode)
  };
  const matrix = nativeArtProjectionMatrixForObject(object);
  const frameBounds = nativeArtFrameBounds(object, matrix, coordinateSpace);
  const cornerRadius = metadataNumber(object.data.cornerRadiusPx) ?? 0;
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
    stroke,
    fill,
    cornerRadius,
    effect: metadataString(object.style.effect),
    projectionMatrix: matrix,
    projectionTransform: matrix ? nativeArtProjectionSvgTransform(object, coordinateSpace, matrix) : undefined,
    frameBounds,
    line,
    pathD,
    projectedShapePathD,
    glossGradient: fill.mode === "gloss" ? nativeArtGlossGradient(object, coordinateSpace, matrix) : undefined
  };
}

export function graphicPathEditPoints(object: GraphicObject): GraphicPathEditPoints | undefined {
  const pathKind = graphicPathKind(object);
  if (!pathKind) {
    return undefined;
  }

  const explicitStart = pointMetadata(object.data.lineStart);
  const explicitEnd = pointMetadata(object.data.lineEnd);
  const explicitControl = pointMetadata(object.data.pathControlPoint);
  const fallback = graphicPathFallbackPoints(object, pathKind);
  if (isCircularGraphicArc(object)) {
    return fallback;
  }
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
  const editPoints = graphicPathEditPoints(object);
  if (!editPoints) {
    return undefined;
  }

  if (isCircularGraphicArc(object)) {
    return editCircularGraphicArcGeometry(object, handle, point);
  }

  const nextStart = handle === "start" ? point : editPoints.start;
  const nextEnd = handle === "end" ? point : editPoints.end;
  const nextControl = handle === "middle"
    ? point
    : editPoints.pathKind === "arc" ? editPoints.middle : pointMetadata(object.data.pathControlPoint);
  const nextPathKind = handle === "middle" ? "arc" : editPoints.pathKind;
  const nextData: GraphicObject["data"] = {
    ...object.data,
    artPathKind: nextPathKind,
    lineStart: nextStart,
    lineEnd: nextEnd
  };

  if (nextControl) {
    nextData.pathControlPoint = nextControl;
  } else {
    delete nextData.pathControlPoint;
  }

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
  if (kind === "line" || kind === "wavy" || kind === "arc") {
    return kind;
  }
  return object.graphicKind === "line" ? "line" : undefined;
}

function isCircularGraphicArc(object: GraphicObject): boolean {
  return graphicPathKind(object) === "arc" && !pointMetadata(object.data.pathControlPoint);
}

function editCircularGraphicArcGeometry(
  object: GraphicObject,
  handle: GraphicPathEditHandle,
  point: NativeArtPoint
): GraphicObject {
  const currentAngles = nativeArtArcAngles(object);
  const center = objectCenter(object);
  const rx = Math.max(object.width / 2 - 4, 1);
  const ry = Math.max(object.height / 2 - 4, 1);
  const targetRadians = ellipseAngleRadiansForPoint(center, rx, ry, point);
  const nextSweepRadians = handle === "start"
    ? arcSweepRadiansFromEndpointDrag(clockwiseDeltaRadians(targetRadians, currentAngles.endRadians))
    : handle === "end"
      ? arcSweepRadiansFromEndpointDrag(clockwiseDeltaRadians(currentAngles.startRadians, targetRadians))
      : currentAngles.sweepRadians;
  const nextStartRadians = handle === "start"
    ? targetRadians
    : handle === "middle" ? targetRadians - nextSweepRadians / 2 : currentAngles.startRadians;
  const nextData: GraphicObject["data"] = {
    ...object.data,
    artPathKind: "arc",
    arcStartRadians: nextStartRadians,
    arcSweepRadians: nextSweepRadians
  };
  delete nextData.lineStart;
  delete nextData.lineEnd;
  delete nextData.pathControlPoint;

  const radiusChanges = handle === "middle"
    ? circularArcRadiusChanges(object, center, point)
    : undefined;
  const unchanged =
    Math.abs((object.data.arcStartRadians ?? currentAngles.startRadians) - nextStartRadians) < 0.001 &&
    Math.abs((object.data.arcSweepRadians ?? currentAngles.sweepRadians) - nextSweepRadians) < 0.001 &&
    !pointMetadata(object.data.lineStart) &&
    !pointMetadata(object.data.lineEnd) &&
    !radiusChanges;
  if (unchanged) {
    return object;
  }

  return {
    ...object,
    ...(radiusChanges ?? {}),
    data: nextData
  };
}

function circularArcRadiusChanges(
  object: GraphicObject,
  center: NativeArtPoint,
  point: NativeArtPoint
): Pick<GraphicObject, "x" | "y" | "width" | "height"> | undefined {
  const currentRadius = Math.max(Math.max(object.width, object.height) / 2 - 4, 1);
  const nextRadius = Math.max(Math.hypot(point.x - center.x, point.y - center.y), 1);
  if (Math.abs(nextRadius - currentRadius) < 0.001) {
    return undefined;
  }
  const nextSize = roundLayoutNumber(nextRadius * 2 + 8);
  return {
    x: roundLayoutNumber(center.x - nextSize / 2),
    y: roundLayoutNumber(center.y - nextSize / 2),
    width: nextSize,
    height: nextSize
  };
}

function graphicPathFallbackPoints(
  object: GraphicObject,
  pathKind: GraphicPathKind
): GraphicPathEditPoints {
  if (pathKind === "arc") {
    const angles = nativeArtArcAngles(object);
    const rx = Math.max(object.width / 2 - 4, 1);
    const ry = Math.max(object.height / 2 - 4, 1);
    const center = objectCenter(object);
    return {
      start: ellipsePointAtRadians(center, rx, ry, angles.startRadians),
      middle: ellipsePointAtRadians(center, rx, ry, angles.startRadians + angles.sweepRadians / 2),
      end: ellipsePointAtRadians(center, rx, ry, angles.endRadians),
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
  const points = [
    pointMetadata(data.lineStart),
    pointMetadata(data.lineEnd),
    pointMetadata(data.pathControlPoint)
  ].filter((point): point is NativeArtPoint => point !== undefined);
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
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  const minSize = padding * 2;
  return {
    x: minX - padding,
    y: minY - padding,
    width: Math.max(maxX - minX + padding * 2, minSize),
    height: Math.max(maxY - minY + padding * 2, minSize)
  };
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

function clockwiseDeltaRadians(startRadians: number, endRadians: number): number {
  const delta = (endRadians - startRadians) % (Math.PI * 2);
  return delta < 0 ? delta + Math.PI * 2 : delta;
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
      roundedRectPathPoints(width, height, metadataNumber(object.data.cornerRadiusPx) ?? 0, 0, { x: 0, y: 0 }),
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
    : roundedRectPathPoints(width, height, metadataNumber(object.data.cornerRadiusPx) ?? 0, strokeWidth, { x: 0, y: 0 });
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

function graphicPathLocalSamplePoints(object: GraphicObject): NativeArtPoint[] {
  const pathKind = metadataString(object.data.artPathKind);
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
    const explicitStart = pointMetadata(object.data.lineStart);
    const explicitEnd = pointMetadata(object.data.lineEnd);
    const explicitControl = pointMetadata(object.data.pathControlPoint);
    if (explicitStart && explicitEnd && explicitControl) {
      return quadraticBezierSamplePoints(
        pointForArtSpace(object, explicitStart, "local"),
        pointForArtSpace(object, explicitControl, "local"),
        pointForArtSpace(object, explicitEnd, "local"),
        24
      );
    }

    return artArcSamplePoints(object, "local");
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

function graphicPathD(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace = "page"
): string | undefined {
  const storedPath = metadataString(object.data.pathD);
  const pathKind = metadataString(object.data.artPathKind);
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
    const explicitStart = pointMetadata(object.data.lineStart);
    const explicitEnd = pointMetadata(object.data.lineEnd);
    const explicitControl = pointMetadata(object.data.pathControlPoint);
    if (explicitStart && explicitEnd && explicitControl) {
      const endpoints = graphicPathEndpoints(object, coordinateSpace, inset);
      const control = pointForArtSpace(object, explicitControl, coordinateSpace);
      return [
        `M ${formatNumber(endpoints.start.x)} ${formatNumber(endpoints.start.y)}`,
        `Q ${formatNumber(control.x)} ${formatNumber(control.y)} ${formatNumber(endpoints.end.x)} ${formatNumber(endpoints.end.y)}`
      ].join(" ");
    }
    return artArcPathD(object, coordinateSpace);
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
  const angles = nativeArtArcAngles(object);
  const rx = Math.max(object.width / 2 - 4, 1);
  const ry = Math.max(object.height / 2 - 4, 1);
  const originX = coordinateSpace === "page" ? object.x : 0;
  const originY = coordinateSpace === "page" ? object.y : 0;
  const center = {
    x: originX + object.width / 2,
    y: originY + object.height / 2
  };
  const start = ellipsePointAtRadians(center, rx, ry, angles.startRadians);
  const end = ellipsePointAtRadians(center, rx, ry, angles.endRadians);
  return [
    `M ${formatNumber(start.x)} ${formatNumber(start.y)}`,
    `A ${formatNumber(rx)} ${formatNumber(ry)} 0 ${angles.sweepRadians > Math.PI ? 1 : 0} 1 ${formatNumber(end.x)} ${formatNumber(end.y)}`
  ].join(" ");
}

function artArcSamplePoints(
  object: GraphicObject,
  coordinateSpace: NativeArtVisualCoordinateSpace = "page"
): NativeArtPoint[] {
  const angles = nativeArtArcAngles(object);
  const rx = Math.max(object.width / 2 - 4, 1);
  const ry = Math.max(object.height / 2 - 4, 1);
  const originX = coordinateSpace === "page" ? object.x : 0;
  const originY = coordinateSpace === "page" ? object.y : 0;
  return arcSamplePointsRadians(
    {
      x: originX + object.width / 2,
      y: originY + object.height / 2
    },
    rx,
    ry,
    angles.startRadians,
    angles.endRadians,
    32
  );
}

function nativeArtArcAngles(object: GraphicObject): { startRadians: number; sweepRadians: number; endRadians: number } {
  const sweepRadians = clampArcSweepRadians(metadataNumber(object.data.arcSweepRadians) ?? Math.PI);
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
