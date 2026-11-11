import type { ArrowAttachmentFrame, DocumentObject, DocumentPage } from "@chemdraft/chem-core";
import { arrowFrameFromPoints, arrowPathSamplePoints, graphicArrowAttachmentFrame,
  graphicOpenStrokePageSamplePoints } from "@chemdraft/art-engine";
// These renderer helpers remain in the entry point because they are widely used there.
import { mechanismArrowGeometry, resolvePageAnchorPoint, nativeTextObjectLineMetrics,
  moleculeOutlineForArrangement, textVisualBoundsForArrangement } from "./index";
export { nativeTextObjectLineMetrics, moleculeOutlineForArrangement, textVisualBoundsForArrangement };
export { arrowAttachmentPoint } from "@chemdraft/art-engine";

type Point = { x: number; y: number };
export function arrowShaftSamplePoints(page:DocumentPage,object:DocumentObject):Point[] {
  if(object.type==='graphic')return graphicOpenStrokePageSamplePoints(object);
  const rotate = (point: Point) => {
    const angle = object.rotation * Math.PI / 180, x = point.x - object.x - object.width / 2, y = point.y - object.y - object.height / 2;
    return { x: object.x + object.width / 2 + x * Math.cos(angle) - y * Math.sin(angle),
      y: object.y + object.height / 2 + x * Math.sin(angle) + y * Math.cos(angle) };
  };
  if (object.type === "reaction-arrow") {
    const start = resolvePageAnchorPoint(page, object.start), end = resolvePageAnchorPoint(page, object.end);
    return start && end ? [rotate(start), rotate(end)] : [];
  }
  if (object.type === "mechanism-arrow") {
    const geometry = mechanismArrowGeometry(page, object);
    return geometry?arrowPathSamplePoints(geometry.pathD).map(rotate):[];
  }
  return [];
}
export function arrowAttachmentFrame(page:DocumentPage,object:DocumentObject,fraction=.5):ArrowAttachmentFrame|undefined {
  return object.type==='graphic'?graphicArrowAttachmentFrame(object,fraction):arrowFrameFromPoints(arrowShaftSamplePoints(page,object),fraction);
}
/** Conditions use the curve's inside/outside rather than arrow direction. For a straight
 * shaft, Top is the upper page side (left for an exactly vertical shaft), including RTL. */
export function reactionConditionsFrame(page: DocumentPage, arrow: DocumentObject): ArrowAttachmentFrame | undefined {
  const frame = arrowAttachmentFrame(page, arrow);
  if (!frame) return undefined;
  const points = arrowShaftSamplePoints(page, arrow), first = points[0], last = points.at(-1);
  const chordLength = first && last ? Math.hypot(last.x-first.x, last.y-first.y) : 0;
  const straight = first && last && chordLength > 1e-7 && points.every(point =>
    Math.abs((point.x-first.x)*(last.y-first.y)-(point.y-first.y)*(last.x-first.x))/chordLength < .01);
  // arrowAttachmentFrame points toward a curved shaft's bow, i.e. its exterior.
  const flip = !straight || frame.normal.y > 1e-7 || Math.abs(frame.normal.y) <= 1e-7 && frame.normal.x > 0;
  return flip ? {...frame, normal:{x:-frame.normal.x,y:-frame.normal.y}} : frame;
}
