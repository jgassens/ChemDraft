import { applyPatches, type ChemDraftDocument, type DocumentPatch, type GraphicObject, type TextObject } from "@chemdraft/chem-core";
import { arrowAttachmentFrame, arrowShaftSamplePoints, arrowAttachmentPoint, arrowHeadSize, createArrowOffshootGeometry, resolveArrowAttachments, reactionConditionsPlacement, reactionConditionsFrame, type ArrowAttachmentResolutionOptions } from "@chemdraft/layout-engine";
import { nextObjectId, phase4Timestamp } from "./shared";
import { createNativeTextObject, nativeFormattedTextObjectSize } from "./textObjects";

export interface ReactionConditionsDraft {
  side: "above" | "below";
  spans: { text: string; script: "normal" | "subscript" | "superscript" }[];
}
export function reactionConditionsDraft(document: ChemDraftDocument, arrowId: string): ReactionConditionsDraft {
  const label = document.pages.flatMap(page => page.objects).find(object => object.type === "text" &&
    object.arrowAttachment?.kind === "conditions" && object.arrowAttachment.parentObjectId === arrowId) as TextObject | undefined;
  return { side: label?.arrowAttachment?.side ?? "above", spans: label
    ? (label.spans.map(span => span.text).join("") === label.text ? label.spans : [{ text: label.text, script: "normal" as const }])
      .map(({ text, script }) => ({ text, script })) : [] };
}

export function attachReactionArrowOffshoot(document: ChemDraftDocument, arrowId: string, side: "above" | "below", mode?: "fullCurve"): ChemDraftDocument {
  const page = document.pages.find(page => page.objects.some(object => object.id === arrowId));
  const parent = page?.objects.find(object => object.id === arrowId);
  const frame = page && parent && arrowAttachmentFrame(page, parent);
  if (!page || !parent || !frame) throw new Error("Choose an arrow with a visible shaft to attach an offshoot.");
  const base: GraphicObject = { id: nextObjectId(document, "graphic"), type: "graphic", graphicKind: "path",
    x: frame.origin.x, y: frame.origin.y, width: 1, height: 1, rotation: 0,
    style: { strokeColor: parent.type === "graphic" ? parent.style.strokeColor ?? parent.style.color ?? "#111111" : "#111111",
      strokeWidth: parent.type === "graphic" ? parent.style.strokeWidth ?? 2 : 1.6,
      fillColor: "none", strokeLineCap: "butt", artToolId: "reactionArrow", artToolCommandId: "tool.art.reactionArrow" },
    data: { artToolId: "reactionArrow", artPathKind: "quadratic" } };
  const object = createArrowOffshootGeometry(base, frame, side, arrowHeadSize(parent), parent.id, parent.type === 'graphic' ? parent : undefined,mode,arrowShaftSamplePoints(page,parent));
  return applyPatches(document, [{ op: "addObject", pageId: page.id, object },
    { op: "setSelection", pageId: page.id, objectIds: [object.id] }], { now: phase4Timestamp });
}

export function setReactionArrowConditions(document: ChemDraftDocument, arrowId: string, draft: ReactionConditionsDraft): ChemDraftDocument {
  const page = document.pages.find(page => page.objects.some(object => object.id === arrowId));
  const arrow = page?.objects.find(object => object.id === arrowId);
  const frame = page && arrow && reactionConditionsFrame(page, arrow);
  if (!page || !arrow || !frame) throw new Error("The arrow is no longer available. Close and reopen Reaction conditions.");
  const text = draft.spans.map(span => span.text).join("");
  if (text.length > 2000 || draft.spans.length > 128 || !["above", "below"].includes(draft.side) ||
      draft.spans.some(span => !["normal", "subscript", "superscript"].includes(span.script))) throw new Error("Reaction conditions are too long or have invalid formatting.");
  const existing = page.objects.find((object): object is TextObject => object.type === "text" &&
    object.arrowAttachment?.kind === "conditions" && object.arrowAttachment.parentObjectId === arrowId);
  const patches: DocumentPatch[] = [];
  if (!text.trim()) {
    if (!existing) return document;
    patches.push({ op: "removeObject", objectId: existing.id }, { op: "setSelection", pageId: page.id, objectIds: [arrow.id] });
  } else {
    if (existing && existing.text === text && existing.arrowAttachment?.side === draft.side &&
        JSON.stringify(existing.spans.map(({ text, script }) => ({ text, script }))) === JSON.stringify(draft.spans)) return document;
    const base = existing ?? createNativeTextObject(document, { x: 0, y: 0 }, text, { textAlign: "center", fontSizePx: 16 });
    const spans=draft.spans.map(span=>({...span,style:{}}));
    const size=nativeFormattedTextObjectSize({...base,text,spans});
    const previous=existing?.arrowAttachment;
    const manual=previous?.kind==='conditions' && previous.placement==='manual' && previous.side===draft.side;
    const placed=reactionConditionsPlacement(page,arrow,{...base,...size,text,spans},draft.side);
    if(!placed && !manual) throw new Error("There is no clear space for these conditions. Shorten the lines, choose the other side, or move nearby objects.");
    const offset=manual ? {...previous.offset} : placed!.offset;
    const extent=Math.abs(frame.normal.x)*size.width/2+Math.abs(frame.normal.y)*size.height/2;
    const sign=draft.side==='above'?1:-1;
    if(!manual) offset.y=sign*Math.max(sign*offset.y,extent+12);
    const center=arrowAttachmentPoint(frame,offset);
    const object:TextObject={...base,...size,x:center.x-size.width/2,y:center.y-size.height/2,text,spans,
      arrowAttachment:{kind:'conditions',parentObjectId:arrowId,side:draft.side,frame,offset,placement:manual?'manual':'auto'}};
    patches.push(existing ? { op: "updateObject", objectId: existing.id, changes: object } : { op: "addObject", pageId: page.id, object });
    patches.push({ op: "setSelection", pageId: page.id, objectIds: [object.id] });
  }
  return applyPatches(document, patches, { now: phase4Timestamp });
}

export function reconcileReactionArrowAttachments(document: ChemDraftDocument, options: ArrowAttachmentResolutionOptions = {}): ChemDraftDocument {
  const patches: DocumentPatch[] = [];
  for (const page of document.pages) {
    const resolved = resolveArrowAttachments(page, options);
    if (resolved === page) continue;
    resolved.objects.forEach((object, index) => {
      if (object !== page.objects[index]) patches.push({ op: "updateObject", objectId: object.id,
        changes: { ...object, arrowAttachment: object.arrowAttachment } });
    });
  }
  return patches.length ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}
