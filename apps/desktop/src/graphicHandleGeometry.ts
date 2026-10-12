import { projectGraphicObjectPoint } from "@chemdraft/art-engine";
import type { GraphicObject } from "@chemdraft/chem-core";

// Shared by MainWindow (which draws the handles) and documentWorkflow (which
// places the corner-radius handle clear of them).

// Mirrors App.css `.object-resize-handle` (18px square) and its corner
// placements `.object-resize-top-left` etc. (`top`/`left`/`right`/`bottom: -8px`).
export const OBJECT_RESIZE_HANDLE_SIZE_PX = 18;
export const OBJECT_RESIZE_HANDLE_OFFSET_PX = -8;
// Mirrors App.css `.graphic-corner-radius-handle` (9px square).
export const GRAPHIC_CORNER_RADIUS_HANDLE_SIZE_PX = 9;

export interface GraphicHandlePoint {
  x: number;
  y: number;
}

export interface GraphicHandleBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rotatePointAroundCenter(
  point: GraphicHandlePoint,
  center: GraphicHandlePoint,
  cos: number,
  sin: number
): GraphicHandlePoint {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos
  };
}

/** Rotation centre of a graphic's visual shell, in local coordinates. */
export function graphicVisualLocalCenter(object: GraphicObject): GraphicHandlePoint {
  return {
    x: Math.max(object.width, 1) / 2,
    y: Math.max(object.height, 1) / 2
  };
}

/** Bounds of the rotated frame, in local coordinates, as the transform frame draws them. */
export function rotatedGraphicLocalBounds(
  object: GraphicObject,
  bounds: GraphicHandleBounds,
  rotationDegrees: number
): GraphicHandleBounds {
  if (Math.abs(rotationDegrees) < 0.001) {
    return bounds;
  }
  if (
    object.graphicKind === "ellipse" &&
    Math.abs(Math.max(object.width, 1) - Math.max(object.height, 1)) < 0.001
  ) {
    return bounds;
  }

  const center = graphicVisualLocalCenter(object);
  const rotationRad = rotationDegrees * Math.PI / 180;
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height }
  ].map((point) => rotatePointAroundCenter(point, center, cos, sin));

  const minX = Math.min(...corners.map((point) => point.x));
  const maxX = Math.max(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y));
  const maxY = Math.max(...corners.map((point) => point.y));
  return {
    x: roundCssCoordinate(minX),
    y: roundCssCoordinate(minY),
    width: roundCssCoordinate(maxX - minX),
    height: roundCssCoordinate(maxY - minY)
  };
}

/** Project a page point through the graphic's plane and then its visual rotation. */
export function projectGraphicVisualPagePoint(object: GraphicObject, point: GraphicHandlePoint): GraphicHandlePoint {
  const projected = projectGraphicObjectPoint(object, point);
  if (Math.abs(object.rotation) < 0.001) {
    return projected;
  }

  const local = graphicVisualLocalCenter(object);
  const center = { x: object.x + local.x, y: object.y + local.y };
  const rotationRad = object.rotation * Math.PI / 180;
  return rotatePointAroundCenter(projected, center, Math.cos(rotationRad), Math.sin(rotationRad));
}

/** Same as projectGraphicVisualPagePoint, for a local point and a local result. */
export function projectGraphicVisualLocalPoint(object: GraphicObject, point: GraphicHandlePoint): GraphicHandlePoint {
  const projected = projectGraphicObjectPoint(object, point, { coordinateSpace: "local" });
  if (Math.abs(object.rotation) < 0.001) {
    return projected;
  }

  const rotationRad = object.rotation * Math.PI / 180;
  return rotatePointAroundCenter(projected, graphicVisualLocalCenter(object), Math.cos(rotationRad), Math.sin(rotationRad));
}

export function unrotateGraphicVisualPagePoint(object: GraphicObject, point: GraphicHandlePoint): GraphicHandlePoint {
  if (Math.abs(object.rotation) < 0.001) {
    return point;
  }

  const local = graphicVisualLocalCenter(object);
  const center = { x: object.x + local.x, y: object.y + local.y };
  const rotationRad = -object.rotation * Math.PI / 180;
  return rotatePointAroundCenter(point, center, Math.cos(rotationRad), Math.sin(rotationRad));
}

function roundCssCoordinate(value: number): number {
  return Number(value.toFixed(4));
}
