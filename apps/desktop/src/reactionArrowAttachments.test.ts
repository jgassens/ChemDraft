import { describe, expect, it } from "vitest";
import { applyPatches, ArrowAttachmentSchema, serializeDocument, deserializeDocument, type ChemDraftDocument, type GraphicObject } from "@chemdraft/chem-core";
import { attachReactionArrowOffshoot, setReactionArrowConditions, reactionConditionsDraft } from "@chemdraft/document-workflow-core";
import { arrowAttachmentFrame, arrowHeadSize, resolveArrowAttachments } from "@chemdraft/layout-engine";
import { graphicPathEditPoints, editGraphicPathGeometry, planNativeArtVisual, quadraticArrowGeometry } from "@chemdraft/art-engine";
import { createLayerActions, arrowOffshootCommandId } from './commands';
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { createPhase4Document, createNativeArtLineGraphicObject, moveDocumentObjects, normalizeCommittedDocument,
  createNativeReactionArrow, createNativeSingleBondMolecule,
  copyAsScopedDocument,
  selectDocumentObjects, duplicateSelectedDocumentObjects, createSelectionClipboardPayload, pasteSelectionClipboardPayload,
  deleteSelectedDocumentObjects, rotateSelectedDocumentObjects90, rotateDocumentObjectsAroundPoint, scaleDocumentObjectsAroundPoint,
  groupSelectedDocumentObjects, applyObjectColorToDocumentObjects } from "./documentWorkflow";

function fixture(command = "tool.art.reactionArrow") {
  let document = createPhase4Document("Arrow attachment");
  const arrow = createNativeArtLineGraphicObject(document, { x: 150, y: 300 }, { x: 390, y: 300 }, command)!;
  document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: arrow }]);
  return { document, arrow };
}
const graphics = (document: ChemDraftDocument) => document.pages[0].objects.filter((object): object is GraphicObject => object.type === "graphic");
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => { expect(a.x).toBeCloseTo(b.x, 6); expect(a.y).toBeCloseTo(b.y, 6); };

describe("arrow offshoots and conditions", () => {
  it('registers full-curve availability beside existing offshoot commands',()=>{
    const {document,arrow}=fixture();
    expect(createLayerActions(document,true,{enabled:true,offshootArrows:true}).find(action=>action.id===arrowOffshootCommandId('fullCurve.above'))).toMatchObject({enabled:false,disabledReason:'Select one arrow'});
    const actions=createLayerActions(selectDocumentObjects(document,document.pages[0].id,[arrow.id]),true,{enabled:true,offshootArrows:true});
    for(const choice of ['above','below','fullCurve.above','fullCurve.below'] as const)expect(actions.find(action=>action.id===arrowOffshootCommandId(choice))?.enabled).toBe(true);
  });
  it('creates a full U through the parent midpoint with a forward tangent and matching head',()=>{
    const {document,arrow}=fixture();
    const curved=quadraticArrowGeometry(arrow,{x:150,y:280},{x:390,y:400},{x:280,y:300});
    let d=applyPatches(document,[{op:'updateObject',objectId:arrow.id,changes:curved}]);
    d=attachReactionArrowOffshoot(d,arrow.id,'above','fullCurve');
    const branch=graphics(d)[1],points=graphicPathEditPoints(branch)!,frame=arrowAttachmentFrame(d.pages[0],curved)!;
    near(points.middle,frame.origin);
    const delta={x:points.end.x-points.start.x,y:points.end.y-points.start.y};
    expect(delta.x*frame.tangent.y-delta.y*frame.tangent.x).toBeCloseTo(0,6);
    expect(delta.x*frame.tangent.x+delta.y*frame.tangent.y).toBeGreaterThan(0);
    for(const point of [points.start,points.end])expect((point.x-frame.origin.x)*frame.normal.x+(point.y-frame.origin.y)*frame.normal.y).toBeGreaterThan(0);
    expect(branch.data.markerEnd?.sizePx).toBe(arrowHeadSize(curved));
    expect(ArrowAttachmentSchema.safeParse(branch.arrowAttachment).success).toBe(true);
    expect(ArrowAttachmentSchema.safeParse({...branch.arrowAttachment,startOffset:undefined}).success).toBe(false);
    const half=graphics(attachReactionArrowOffshoot(document,arrow.id,'above'))[1];
    expect(ArrowAttachmentSchema.safeParse(half.arrowAttachment).success).toBe(true);
    expect(half.arrowAttachment).not.toHaveProperty('mode');
  });
  it.each([false,true])('keeps the full-curve junction attached through movement, rotation and nonuniform scale (group=%s)',grouped=>{
    const source=fixture();let d=attachReactionArrowOffshoot(source.document,source.arrow.id,'above','fullCurve');
    const branchId=graphics(d)[1].id;
    d=setReactionArrowConditions(d,branchId,{side:'above',spans:[{text:'THF',script:'normal'}]});
    let ids=[source.arrow.id];
    if(grouped){d=groupSelectedDocumentObjects(selectDocumentObjects(d,d.pages[0].id,[source.arrow.id,branchId]));ids=d.selection.objectIds;}
    d=normalizeCommittedDocument(moveDocumentObjects(d,ids,25,30));
    d=normalizeCommittedDocument(rotateDocumentObjectsAroundPoint(d,ids,{x:270,y:300},37));
    d=normalizeCommittedDocument(scaleDocumentObjectsAroundPoint(d,ids,{x:270,y:300},1.4,.7));
    const parent=graphics(d).find(o=>o.id===source.arrow.id)!,branch=graphics(d).find(o=>o.id===branchId)!;
    near(graphicPathEditPoints(branch)!.middle,arrowAttachmentFrame(d.pages[0],parent)!.origin);
    expect(normalizeCommittedDocument(d)).toBe(d);
    const reopened=deserializeDocument(serializeDocument(d));
    expect(exportDocumentToSvg(reopened).contents).toBe(exportDocumentToSvg(d).contents);
    expect(reactionConditionsDraft(reopened,branchId).spans).toEqual([{text:'THF',script:'normal'}]);
  });
  it('retains edited full-curve tail/head offsets, attachment trees, styles and remapped clipboard IDs',()=>{
    const {document,arrow}=fixture();let d=attachReactionArrowOffshoot(document,arrow.id,'above','fullCurve');
    const branch=graphics(d)[1],p=graphicPathEditPoints(branch)!;
    d=applyPatches(d,[{op:'updateObject',objectId:branch.id,changes:editGraphicPathGeometry(branch,'start',{x:p.start.x-18,y:p.start.y-12})!}]);
    d=normalizeCommittedDocument(d);near(graphicPathEditPoints(graphics(d)[1])!.start,{x:p.start.x-18,y:p.start.y-12});
    d=setReactionArrowConditions(d,branch.id,{side:'above',spans:[{text:'THF',script:'normal'}]});
    d=applyObjectColorToDocumentObjects(d,'#ab1234',[arrow.id]);
    expect(graphics(d)[1].style.strokeColor).toBe('#ab1234');
    d=selectDocumentObjects(d,d.pages[0].id,[arrow.id]);
    const payload=createSelectionClipboardPayload(d)!;
    for(const copy of [duplicateSelectedDocumentObjects(d),pasteSelectionClipboardPayload(d,payload,{x:420,y:420})]) {
      const ids=new Set(d.pages[0].objects.map(o=>o.id)),clones=copy.pages[0].objects.filter(o=>!ids.has(o.id));
      const full=clones.find(o=>o.arrowAttachment?.kind==='offshoot')!;
      const sourceAttachment=graphics(d)[1].arrowAttachment;
      expect(full.arrowAttachment).toMatchObject({mode:'fullCurve',startOffset:sourceAttachment?.kind==='offshoot'?sourceAttachment.startOffset:undefined});
      expect(clones.some(o=>o.id===full.arrowAttachment!.parentObjectId)).toBe(true);
      expect(clones.find(o=>o.type==='text')?.arrowAttachment?.parentObjectId).toBe(full.id);
      const settled=normalizeCommittedDocument(copy);
      expect(normalizeCommittedDocument(settled)).toBe(settled);
      const parent=settled.pages[0].objects.find(o=>o.id===full.arrowAttachment!.parentObjectId)!;
      near(graphicPathEditPoints(settled.pages[0].objects.find(o=>o.id===full.id) as GraphicObject)!.middle,arrowAttachmentFrame(settled.pages[0],parent)!.origin);
    }
    expect(deleteSelectedDocumentObjects(d).pages[0].objects).toHaveLength(0);
  });
  it("fits the initial curve to a short parent while retaining the shared head size", () => {
    const { document, arrow } = fixture();
    const shortened = { ...arrow, data: { ...arrow.data, lineEnd: { x: 230, y: 300 } } };
    const source = applyPatches(document, [{ op: "updateObject", objectId: arrow.id, changes: shortened }]);
    const branch = graphics(attachReactionArrowOffshoot(source, arrow.id, "above"))[1];
    expect(graphicPathEditPoints(branch)!.end.x).toBeLessThan(230);
    expect(branch.data.markerEnd?.sizePx).toBe(arrowHeadSize(shortened));
  });
  it("supports legacy and anchored mechanism arrows without modifying a molecule", () => {
    let document = createPhase4Document("Semantic parents");
    const molecule = createNativeSingleBondMolecule(document, { x: 80, y: 80 });
    const legacy = createNativeReactionArrow(document, { x: 100, y: 300 }, { x: 300, y: 300 }, "forward");
    document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: molecule },
      { op: "addObject", pageId: document.pages[0].id, object: legacy },
      { op: "addObject", pageId: document.pages[0].id, object: { id: "mechanism", type: "mechanism-arrow", arrowKind: "full-headed",
        x: 100, y: 100, width: 200, height: 200, rotation: 0, style: {}, warnings: [], controlPoints: [{ x: 200, y: 100 }],
        source: { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[0].id }, target: { kind: "point", point: { x: 300, y: 300 } } } }]);
    for (const id of [legacy.id, "mechanism"]) {
      document = normalizeCommittedDocument(attachReactionArrowOffshoot(document, id, "above"));
      const branch = document.pages[0].objects.at(-1) as GraphicObject;
      const parent = document.pages[0].objects.find(object => object.id === id)!;
      near(graphicPathEditPoints(branch)!.start, arrowAttachmentFrame(document.pages[0], parent)!.origin);
    }
    expect(document.pages[0].objects.find(object => object.id === molecule.id)).toEqual(molecule);
  });
  it.each(["above", "below"] as const)("creates a tangential %s branch with a matching head", side => {
    const { document, arrow } = fixture();
    const next = attachReactionArrowOffshoot(document, arrow.id, side), branch = graphics(next)[1];
    const points = graphicPathEditPoints(branch)!;
    near(points.start, { x: 270, y: 300 });
    expect(Math.sign(points.end.y - points.start.y)).toBe(side === "above" ? -1 : 1);
    // For a quadratic, C = 2M − (S+E)/2. Its starting tangent is horizontal.
    expect(2 * points.middle.y - (points.start.y + points.end.y) / 2).toBeCloseTo(points.start.y);
    expect(planNativeArtVisual(branch).markerEnd?.sizePx).toBe(planNativeArtVisual(arrow).markerEnd?.sizePx);
    expect(next.selection.objectIds).toEqual([branch.id]);
    expect(document.pages[0].objects).toHaveLength(1);
  });
  it.each(["tool.art.resonanceArrow", "tool.art.equilibriumArrow", "tool.art.retroArrow"])("accepts %s", command => {
    const { document, arrow } = fixture(command);
    const next = attachReactionArrowOffshoot(document, arrow.id, "above");
    expect(graphics(next)[1].data.markerEnd?.sizePx).toBe(arrowHeadSize(arrow));
  });
  it("follows parent movement, curve edits, rotation and later head resizing", () => {
    const { document, arrow } = fixture();
    let next = attachReactionArrowOffshoot(document, arrow.id, "above");
    next = normalizeCommittedDocument(moveDocumentObjects(next, [arrow.id], 30, 70));
    near(graphicPathEditPoints(graphics(next)[1])!.start, { x: 300, y: 370 });
    const parent = graphics(next)[0];
    const curved = editGraphicPathGeometry(parent, "middle", { x: 300, y: 330 })!;
    next = normalizeCommittedDocument(applyPatches(next, [{ op: "updateObject", objectId: parent.id, changes: curved }]));
    near(graphicPathEditPoints(graphics(next)[1])!.start, arrowAttachmentFrame(next.pages[0], graphics(next)[0])!.origin);
    next = selectDocumentObjects(next, next.pages[0].id, [arrow.id]);
    next = normalizeCommittedDocument(rotateSelectedDocumentObjects90(next));
    near(graphicPathEditPoints(graphics(next)[1])!.start, arrowAttachmentFrame(next.pages[0], graphics(next)[0])!.origin);
    const resized = graphics(next)[0];
    next = normalizeCommittedDocument(applyPatches(next, [{ op: "updateObject", objectId: resized.id,
      changes: { data: { ...resized.data, markerEnd: { kind: "filled-arrow", sizePx: 32 } } } }]));
    expect(graphics(next)[1].data.markerEnd?.sizePx).toBe(32);
    expect(normalizeCommittedDocument(next)).toBe(next);
  });
  it("allows branch endpoint and bend edits while retaining its tail", () => {
    const { document, arrow } = fixture();
    let next = attachReactionArrowOffshoot(document, arrow.id, "above"), branch = graphics(next)[1];
    const edited = editGraphicPathGeometry(branch, "end", { x: 420, y: 200 })!;
    next = normalizeCommittedDocument(applyPatches(next, [{ op: "updateObject", objectId: branch.id, changes: edited }]));
    near(graphicPathEditPoints(graphics(next)[1])!.end, { x: 420, y: 200 });
    branch = graphics(next)[1];
    next = normalizeCommittedDocument(applyPatches(next, [{ op: "updateObject", objectId: branch.id,
      changes: editGraphicPathGeometry(branch, "start", { x: 200, y: 200 })! }]));
    near(graphicPathEditPoints(graphics(next)[1])!.start, { x: 270, y: 300 });
  });
  it("creates formatted native conditions, keeps manual offsets, and clears the label", () => {
    const { document, arrow } = fixture();
    const draft = { side: "above" as const, spans: [{ text: "K", script: "normal" as const }, { text: "2", script: "subscript" as const }, { text: "CO₃\n80 °C", script: "normal" as const }] };
    let next = setReactionArrowConditions(document, arrow.id, draft);
    expect(reactionConditionsDraft(next, arrow.id)).toEqual(draft);
    const label = next.pages[0].objects[1];
    expect(label.type).toBe("text");
    const initialX = label.x;
    next = normalizeCommittedDocument(moveDocumentObjects(next, [label.id], 25, -10));
    expect(next.pages[0].objects[1].x).toBeCloseTo(initialX + 25);
    next = normalizeCommittedDocument(moveDocumentObjects(next, [arrow.id], 40, 20));
    expect(next.pages[0].objects[1].x).toBeCloseTo(initialX + 65);
    const saved = serializeDocument(next), reopened = normalizeCommittedDocument(deserializeDocument(saved));
    expect(reopened.pages[0].objects).toEqual(next.pages[0].objects);
    const svg = exportDocumentToSvg(reopened).contents;
    expect(svg).toContain('font-size="11.52"'); expect(svg).toContain("80 °C");
    next = setReactionArrowConditions(next, arrow.id, { side: "above", spans: [] });
    expect(next.pages[0].objects).toHaveLength(1);
    expect(next.selection.objectIds).toEqual([arrow.id]);
  });
  it("does not double-move attached objects selected together", () => {
    const { document, arrow } = fixture();
    let next = attachReactionArrowOffshoot(document, arrow.id, "above");
    const branch = graphics(next)[1], before = graphicPathEditPoints(branch)!;
    next = normalizeCommittedDocument(moveDocumentObjects(next, [arrow.id, branch.id], 15, 25));
    near(graphicPathEditPoints(graphics(next)[1])!.end, { x: before.end.x + 15, y: before.end.y + 25 });
  });
  it("duplicates, copies, pastes and deletes the entire attachment tree", () => {
    const { document, arrow } = fixture();
    let next = attachReactionArrowOffshoot(document, arrow.id, "above");
    const branch = graphics(next)[1];
    next = attachReactionArrowOffshoot(next, branch.id, "below");
    next = setReactionArrowConditions(next, branch.id, { side: "above", spans: [{ text: "hν", script: "normal" }] });
    next = selectDocumentObjects(next, next.pages[0].id, [arrow.id]);
    const duplicated = normalizeCommittedDocument(duplicateSelectedDocumentObjects(next));
    expect(duplicated.pages[0].objects).toHaveLength(8);
    const copies = duplicated.pages[0].objects.slice(4), copyIds = new Set(copies.map(object => object.id));
    expect(copies.filter(object => object.arrowAttachment).every(object => copyIds.has(object.arrowAttachment!.parentObjectId))).toBe(true);
    const payload = createSelectionClipboardPayload(next)!;
    expect(payload.objects).toHaveLength(4);
    const pasted = normalizeCommittedDocument(pasteSelectionClipboardPayload(next, payload, { x: 500, y: 500 }));
    expect(pasted.pages[0].objects).toHaveLength(8);
    expect(deleteSelectedDocumentObjects(next).pages[0].objects).toHaveLength(0);
  });
  it("Copy As keeps the selected arrow's branches and labels inside its fitted frame", () => {
    const { document, arrow } = fixture();
    let next = attachReactionArrowOffshoot(document, arrow.id, "above");
    next = setReactionArrowConditions(next, arrow.id, { side: "below", spans: [{ text: "80 °C", script: "normal" }] });
    next = selectDocumentObjects(next, next.pages[0].id, [arrow.id]);
    const scoped = normalizeCommittedDocument(copyAsScopedDocument(next));
    expect(scoped.pages[0].objects).toHaveLength(3);
    const parent = graphics(scoped)[0], branch = graphics(scoped)[1];
    near(graphicPathEditPoints(branch)!.start, arrowAttachmentFrame(scoped.pages[0], parent)!.origin);
    const svg = exportDocumentToSvg(scoped).contents;
    expect(svg).toContain(branch.id); expect(svg).toContain("80 °C");
  });
  it("handles a missing parent and malicious attachment cycles without recursion", () => {
    const { document, arrow } = fixture();
    const next = attachReactionArrowOffshoot(document, arrow.id, "above");
    const branch = graphics(next)[1];
    const orphan = resolveArrowAttachments({ ...next.pages[0], objects: [branch] });
    expect(orphan.objects[0].arrowAttachment).toBeUndefined();
    const cyclic = { ...branch, arrowAttachment: { ...branch.arrowAttachment!, parentObjectId: branch.id } };
    expect(() => resolveArrowAttachments({ ...next.pages[0], objects: [cyclic] })).not.toThrow();
  });
});
