import type { ArrowAttachmentFrame, DocumentObject, DocumentPage } from "@chemdraft/chem-core";
import { arrowAttachmentPoint } from "@chemdraft/art-engine";
import { reactionConditionsPlacement } from "./reactionConditionsLayout";
import { nativeTextObjectLineMetrics, reactionConditionsFrame } from "./arrowAttachmentFrames";
export * from "./arrowAttachmentFrames";

type Point = { x: number; y: number };
const localPoint = (frame: ArrowAttachmentFrame, point: Point): Point => ({
  x: (point.x - frame.origin.x) * frame.tangent.x + (point.y - frame.origin.y) * frame.tangent.y,
  y: (point.x - frame.origin.x) * frame.normal.x + (point.y - frame.origin.y) * frame.normal.y
});
const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-7;
const sameFrame = (a: ArrowAttachmentFrame, b: ArrowAttachmentFrame) => near(a.origin, b.origin) && near(a.tangent, b.tangent) && near(a.normal, b.normal) && Math.abs((a.length??b.length??0)-(b.length??a.length??0))<1e-7;

function scaledLocalOffset(old:ArrowAttachmentFrame,next:ArrowAttachmentFrame,offset:Point,sx:number,sy:number):Point {
  const x=(old.tangent.x*offset.x+old.normal.x*offset.y)*sx;
  const y=(old.tangent.y*offset.x+old.normal.y*offset.y)*sy;
  return {x:x*next.tangent.x+y*next.tangent.y,y:x*next.normal.x+y*next.normal.y};
}

/** Resolve only attachment geometry. Stored local offsets are authoritative when the parent
 * changes; when it stays put, ordinary text drags and path-handle edits update those offsets.
 * Thus a group transform cannot move a child twice. No molecule data is inspected or changed. */
export interface ArrowAttachmentResolutionOptions {
  scale?: { objectIds: ReadonlySet<string>; scaleX: number; scaleY: number };
}
export function resolveArrowAttachments(page: DocumentPage, options: ArrowAttachmentResolutionOptions = {}): DocumentPage {
  if (!page.objects.some(object => object.type === "text" && object.arrowAttachment?.kind === "conditions")) return page;
  const byId = new Map(page.objects.map(object => [object.id, object]));
  const objects = page.objects.map((object): DocumentObject => {
    if (object.type !== "text" || object.arrowAttachment?.kind !== "conditions") return object;
    const attachment = object.arrowAttachment;
    const parent = byId.get(attachment.parentObjectId);
    const frame = parent && reactionConditionsFrame(page, parent);
    let result: DocumentObject = object;
    if (!frame) {
      // An orphan remains visible/editable at its last position (e.g. pasted by itself).
      const { arrowAttachment: _attachment, ...detached } = object;
      result = detached as DocumentObject;
    } else {
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
        offset=reactionConditionsPlacement(page,parent!,object,attachment.side)?.offset??offset;
      }
      const sign=attachment.side==='above'?1:-1;
      const extent=Math.abs(frame.normal.x)*object.width/2+Math.abs(frame.normal.y)*object.height/2;
      if(placement!=='manual') offset.y=sign*Math.max(sign*offset.y,extent+12);
      const center=arrowAttachmentPoint(frame,offset);
      if(!unchangedParent || !near(offset,attachment.offset) || placement!==attachment.placement || !near(center,{x:object.x+object.width/2,y:object.y+object.height/2}))
        result={...object,x:center.x-object.width/2,y:center.y-object.height/2,arrowAttachment:{...attachment,frame,offset,placement}};
    }
    return result;
  });
  return objects.some((object, index) => object !== page.objects[index]) ? { ...page, objects } : page;
}

/** Include attached conditions whenever their parent arrow participates in an operation. */
const attachmentChildren = new WeakMap<readonly DocumentObject[], Map<string, string[]>>();
export function withArrowAttachmentIds(objects: readonly DocumentObject[], ids: readonly string[]): string[] {
  let children = attachmentChildren.get(objects);
  if (!children) {
    children = new Map();
    for (const object of objects) if (object.type === "text" && object.arrowAttachment?.kind === "conditions") {
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
