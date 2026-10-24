import type { ArrowAttachmentFrame, DocumentObject, DocumentPage } from "@chemdraft/chem-core";
import { arrowFrameFromPoints, arrowPathSamplePoints, arrowShaftFractionAtPoint, graphicArrowAttachmentFrame, graphicPathEditPoints, fullCurveOffshootGeometry,
  planNativeArtVisual, prepareGraphicPathForDirectEdit, quadraticArrowGeometry, arrowAttachmentPoint, nativeSemanticArrowHeadSizePx,
  graphicOpenStrokePageSamplePoints } from "@chemdraft/art-engine";
export { arrowAttachmentPoint, createArrowOffshootGeometry } from "@chemdraft/art-engine";
import { reactionConditionsPlacement } from "./reactionConditionsLayout";
import { mechanismArrowGeometry, resolvePageAnchorPoint, nativeTextObjectLineMetrics } from "./index";

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
export function arrowAttachmentFractionAtPoint(page:DocumentPage,object:DocumentObject,point:Point):number {
  return arrowShaftFractionAtPoint(arrowShaftSamplePoints(page,object),point);
}
const localPoint = (frame: ArrowAttachmentFrame, point: Point): Point => ({
  x: (point.x - frame.origin.x) * frame.tangent.x + (point.y - frame.origin.y) * frame.tangent.y,
  y: (point.x - frame.origin.x) * frame.normal.x + (point.y - frame.origin.y) * frame.normal.y
});
const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-7;
const sameFrame = (a: ArrowAttachmentFrame, b: ArrowAttachmentFrame) => near(a.origin, b.origin) && near(a.tangent, b.tangent) && near(a.normal, b.normal) && Math.abs((a.length??b.length??0)-(b.length??a.length??0))<1e-7;

/** Conditions on a branch face away from its parent shaft. A branch's own bow-facing
 * normal often faces the parent, so it cannot define the exterior of the arrow tree. */
export function reactionConditionsFrame(page: DocumentPage, arrow: DocumentObject): ArrowAttachmentFrame | undefined {
  const frame=arrowAttachmentFrame(page,arrow),attachment=arrow.arrowAttachment;
  if(!frame || attachment?.kind!=='offshoot')return frame;
  const parent=page.objects.find(object=>object.id===attachment.parentObjectId);
  let outward={x:attachment.frame.normal.x*(attachment.side==='above'?1:-1),
    y:attachment.frame.normal.y*(attachment.side==='above'?1:-1)};
  if(parent?.type==='graphic') {
    const points=graphicOpenStrokePageSamplePoints(parent);
    let nearest:Point|undefined,distance=Infinity;
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i],dx=b.x-a.x,dy=b.y-a.y;
      const t=Math.max(0,Math.min(1,((frame.origin.x-a.x)*dx+(frame.origin.y-a.y)*dy)/(dx*dx+dy*dy||1)));
      const point={x:a.x+t*dx,y:a.y+t*dy},d=Math.hypot(frame.origin.x-point.x,frame.origin.y-point.y);
      if(d<distance){nearest=point;distance=d;}
    }
    if(nearest && distance>1e-6)outward={x:frame.origin.x-nearest.x,y:frame.origin.y-nearest.y};
  }
  return frame.normal.x*outward.x+frame.normal.y*outward.y<0
    ? {...frame,normal:{x:-frame.normal.x,y:-frame.normal.y}} : frame;
}

function scaledLocalOffset(old:ArrowAttachmentFrame,next:ArrowAttachmentFrame,offset:Point,sx:number,sy:number):Point {
  const x=(old.tangent.x*offset.x+old.normal.x*offset.y)*sx;
  const y=(old.tangent.y*offset.x+old.normal.y*offset.y)*sy;
  return {x:x*next.tangent.x+y*next.tangent.y,y:x*next.normal.x+y*next.normal.y};
}

export function arrowHeadSize(object: DocumentObject): number {
  if (object.type !== "graphic") return nativeSemanticArrowHeadSizePx;
  const plan = planNativeArtVisual(object);
  return (plan.markerEnd ?? plan.markerStart)?.sizePx ?? 16;
}

/** Resolve only attachment geometry. Stored local offsets are authoritative when the parent
 * changes; when it stays put, ordinary text drags and path-handle edits update those offsets.
 * Thus a group transform cannot move a child twice. No molecule data is inspected or changed. */
export interface ArrowAttachmentResolutionOptions {
  scale?: { objectIds: ReadonlySet<string>; scaleX: number; scaleY: number };
}
export function resolveArrowAttachments(page: DocumentPage, options: ArrowAttachmentResolutionOptions = {}): DocumentPage {
  if (!page.objects.some(object => object.arrowAttachment)) return page;
  const byId = new Map(page.objects.map(object => [object.id, object]));
  const resolved = new Map<string, DocumentObject>(), visiting = new Set<string>();
  const resolve = (object: DocumentObject, depth = 0): DocumentObject => {
    const cached = resolved.get(object.id);
    if (cached) return cached;
    const attachment = object.arrowAttachment;
    if (!attachment || visiting.has(object.id) || depth > 64) return object;
    visiting.add(object.id);
    const rawParent = byId.get(attachment.parentObjectId);
    const parent = rawParent && !visiting.has(rawParent.id) ? resolve(rawParent, depth + 1) : undefined;
    // A condition's parent may itself be a resolved offshoot. Its ancestor shafts must
    // come from the same geometry snapshot when choosing the outside normal and clearance.
    const attachmentPage=attachment.kind==='conditions'?{...page,objects:page.objects.map(o=>resolved.get(o.id)??o)}:page;
    let frame = parent && (attachment.kind==='conditions' ? reactionConditionsFrame(attachmentPage,parent) : arrowAttachmentFrame(page, parent,attachment.tetherFraction??.5));
    if(frame&&attachment.kind==='offshoot'&&attachment.normalSign===-1)frame={...frame,normal:{x:-frame.normal.x,y:-frame.normal.y}};
    let result: DocumentObject = object;
    if (!frame) {
      // An orphan remains visible/editable at its last position (e.g. pasted by itself).
      const { arrowAttachment: _attachment, ...detached } = object;
      result = detached as DocumentObject;
    } else if (attachment.kind === "conditions" && object.type === "text") {
      const height=Math.ceil(nativeTextObjectLineMetrics(object).height*100)/100;
      const resized=height>object.height+1e-7;
      if(resized) {object={...object,height,y:object.y+(object.height-height)/2};result=object;}
      const unchangedParent = sameFrame(attachment.frame, frame);
      const current=localPoint(frame,{x:object.x+object.width/2,y:object.y+object.height/2});
      const moved=unchangedParent && !near(current,attachment.offset);
      const placement=moved?'manual':attachment.placement??'auto';
      const scale=options.scale?.objectIds.has(parent!.id) ? options.scale : undefined;
      // Reinterpret a saved manual label in the corrected normal without moving it on-page.
      const normalOnlyChange=near(attachment.frame.origin,frame.origin) && near(attachment.frame.tangent,frame.tangent) &&
        Math.abs((attachment.frame.length??0)-(frame.length??0))<1e-7;
      let offset=scale ? scaledLocalOffset(attachment.frame,frame,attachment.offset,scale.scaleX,scale.scaleY) :
        unchangedParent || placement==='manual' && normalOnlyChange ? current : {...attachment.offset};
      if(placement==='auto' && (!unchangedParent || scale || resized)) {
        offset=reactionConditionsPlacement(attachmentPage,parent!,object,attachment.side)?.offset??offset;
      }
      const sign=attachment.side==='above'?1:-1;
      const extent=Math.abs(frame.normal.x)*object.width/2+Math.abs(frame.normal.y)*object.height/2;
      if(placement!=='manual') offset.y=sign*Math.max(sign*offset.y,extent+12);
      const center=arrowAttachmentPoint(frame,offset);
      if(!unchangedParent || !near(offset,attachment.offset) || placement!==attachment.placement || !near(center,{x:object.x+object.width/2,y:object.y+object.height/2}))
        result={...object,x:center.x-object.width/2,y:center.y-object.height/2,arrowAttachment:{...attachment,frame,offset,placement}};
    } else if (attachment.kind === "offshoot" && object.type === "graphic" && !graphicArrowAttachmentFrame(object)) {
      const { arrowAttachment: _attachment, ...detached } = object;
      result = detached;
    } else if (attachment.kind === "offshoot" && object.type === "graphic") {
      const unchangedParent = sameFrame(attachment.frame, frame);
      const prepared = prepareGraphicPathForDirectEdit(object), points = graphicPathEditPoints(prepared);
      const scale=options.scale?.objectIds.has(parent!.id) ? options.scale : undefined;
      const mapOffset=(offset:Point)=>scaledLocalOffset(attachment.frame,frame,offset,scale!.scaleX,scale!.scaleY);
      const full=attachment.mode==='fullCurve',savedStart=attachment.startOffset??{x:0,y:0};
      const startOffset=full?(scale?mapOffset(savedStart):unchangedParent&&points?localPoint(frame,points.start):savedStart):{x:0,y:0};
      const start=arrowAttachmentPoint(frame,startOffset);
      const endOffset = scale ? mapOffset(attachment.endOffset) : unchangedParent && points ? localPoint(frame, points.end) : attachment.endOffset;
      const middleOffset = full?{x:0,y:0}:scale ? mapOffset(attachment.middleOffset) : unchangedParent && points ? localPoint(frame, points.middle) : attachment.middleOffset;
      const headSize = arrowHeadSize(parent!);
      if (!unchangedParent || !near(endOffset, attachment.endOffset) || !near(middleOffset, attachment.middleOffset) ||
          full&&(!near(startOffset,savedStart)||object.data.artPathKind!=='bezier') || !points || !near(points.start, start) || object.data.markerEnd?.sizePx !== headSize) {
        const updated={...prepared,arrowAttachment:{...attachment,frame,endOffset,middleOffset,...(full?{startOffset}:{})},
          data:{...prepared.data,markerEnd:{kind:'filled-arrow' as const,sizePx:headSize}}};
        result=full?fullCurveOffshootGeometry(updated):quadraticArrowGeometry(updated,start,arrowAttachmentPoint(frame,endOffset),arrowAttachmentPoint(frame,middleOffset));
      }
    }
    visiting.delete(object.id); resolved.set(object.id, result); return result;
  };
  // A label may have been created before a later offshoot. Resolve every branch first so its
  // new ink participates in label clearance after a parent bend or resize.
  page.objects.forEach(object => { if (object.arrowAttachment?.kind === "offshoot") resolve(object); });
  const objects = page.objects.map(object => resolve(object));
  return objects.some((object, index) => object !== page.objects[index]) ? { ...page, objects } : page;
}

/** Overlapping SVG object frames are not arrow targets. Pick the nearest actual shaft. */
export function nearestArrowObjectAtPoint(page: DocumentPage, point: Point, tolerance: number): DocumentObject | undefined {
  let best:DocumentObject|undefined, distance=tolerance*tolerance;
  for(const object of page.objects) {
    const frame=arrowAttachmentFrame(page,object);if(!frame)continue;
    const points=object.type==='graphic'?graphicOpenStrokePageSamplePoints(object):[
      {x:frame.origin.x-frame.tangent.x*(frame.length??0)/2,y:frame.origin.y-frame.tangent.y*(frame.length??0)/2},
      {x:frame.origin.x+frame.tangent.x*(frame.length??0)/2,y:frame.origin.y+frame.tangent.y*(frame.length??0)/2}];
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i],dx=b.x-a.x,dy=b.y-a.y;
      const t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/(dx*dx+dy*dy||1)));
      const d=(point.x-a.x-t*dx)**2+(point.y-a.y-t*dy)**2;
      if(d<=distance){distance=d;best=object;}
    }
  }
  return best;
}

/** Closure in page order, including branches attached to branches and their condition labels. */
const attachmentChildren = new WeakMap<readonly DocumentObject[], Map<string, string[]>>();
export function withArrowAttachmentIds(objects: readonly DocumentObject[], ids: readonly string[]): string[] {
  let children = attachmentChildren.get(objects);
  if (!children) {
    children = new Map();
    for (const object of objects) if (object.arrowAttachment) {
      const list = children.get(object.arrowAttachment.parentObjectId) ?? [];
      list.push(object.id); children.set(object.arrowAttachment.parentObjectId, list);
    }
    attachmentChildren.set(objects, children);
  }
  const selected = new Set(ids);
  const queue = [...ids];
  for (let i = 0; i < queue.length; i++) {
    for (const id of children.get(queue[i]) ?? []) if (!selected.has(id)) {
      selected.add(id); queue.push(id);
    }
  }
  return [...selected];
}
