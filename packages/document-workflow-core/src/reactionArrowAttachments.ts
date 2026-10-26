import { applyPatches, type ChemDraftDocument, type DocumentPatch, type GraphicObject } from "@chemdraft/chem-core";
import { arrowAttachmentFrame, arrowShaftSamplePoints, arrowHeadSize, createArrowOffshootGeometry, resolveArrowAttachments, type ArrowAttachmentResolutionOptions } from "@chemdraft/layout-engine";
import { nextObjectId, phase4Timestamp } from "./shared";

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
