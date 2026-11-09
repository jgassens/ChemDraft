import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { moleculeSmiles, insertSmilesMolecule } from "@chemdraft/document-workflow-core";
import { describe, expect, it } from "vitest";
import { applyPatches, ArrowAttachmentSchema, serializeDocument, deserializeDocument, type TextObject, type DocumentObject } from "@chemdraft/chem-core";
import { setReactionArrowConditions, reactionConditionsDraft } from "@chemdraft/document-workflow-core";
import { resolveArrowAttachments, reactionConditionsFrame, arrowAttachmentPoint } from "@chemdraft/layout-engine";
import { editGraphicPathGeometry } from "@chemdraft/art-engine";
import { createPhase4Document, createNativeArtLineGraphicObject, moveDocumentObjects, normalizeCommittedDocument,
  copyAsScopedDocument, selectDocumentObjects, duplicateSelectedDocumentObjects, createSelectionClipboardPayload,
  pasteSelectionClipboardPayload, deleteSelectedDocumentObjects, rotateDocumentObjectsAroundPoint,
  scaleDocumentObjectsAroundPoint, flipDocumentObjectsAroundPoint, applyObjectColorToDocumentObjects } from "./documentWorkflow";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
function fixture(command = "tool.art.reactionArrow") {
  let document = createPhase4Document("Conditions");
  const arrow = createNativeArtLineGraphicObject(document, { x: 150, y: 300 }, { x: 390, y: 300 }, command)!;
  document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: arrow }]);
  return { document, arrow };
}
const draft = { side: "above" as const, spans: [{ text: "H", script: "normal" as const },
  { text: "2", script: "subscript" as const }, { text: "O\n80 °C, 2 h", script: "normal" as const }] };
const label = (d: ReturnType<typeof fixture>["document"]) => d.pages[0].objects.find((o): o is TextObject => o.type === "text")!;
describe("conditions on ordinary arrows", () => {
  it("deleting an arrow preserves molecules and refuses crafted attachments instead of deleting chemistry", () => {
    const { document, arrow } = fixture();
    const molecule = { id: "molecule", type: "molecule" as const, x: 40, y: 40, width: 22, height: 0, rotation: 0,
      style: {}, structureFormat: "smiles" as const, structure: "CC", atoms: [], bonds: [], superatoms: [], rGroups: [] };
    const valid = applyPatches(setReactionArrowConditions(document, arrow.id, draft), [
      { op: "addObject", pageId: document.pages[0].id, object: molecule }
    ]);
    const removed = deleteSelectedDocumentObjects(valid, [arrow.id]);
    expect(removed.pages[0].objects).toEqual([molecule]);
    const craftedMolecule = { ...molecule, arrowAttachment: label(valid).arrowAttachment } as DocumentObject;
    const crafted = { ...valid, pages: [{ ...valid.pages[0], objects: valid.pages[0].objects.map(object =>
      object.id === molecule.id ? craftedMolecule : object) }] };
    // The patch boundary validates the surviving invalid molecule. The old expansion deleted
    // it first, letting the crafted document through with its chemistry silently removed.
    expect(() => deleteSelectedDocumentObjects(crafted, [arrow.id])).toThrow();
    expect(crafted.pages[0].objects).toContain(craftedMolecule);
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

  it.each(["tool.art.reactionArrow", "tool.art.resonanceArrow", "tool.art.equilibriumArrow", "tool.art.retroArrow"])("attaches to %s without changing its geometry", command => {
    const {document, arrow} = fixture(command);
    const next = setReactionArrowConditions(document, arrow.id, draft);
    expect(next.pages[0].objects[0]).toEqual(arrow);
    expect(ArrowAttachmentSchema.safeParse(label(next).arrowAttachment).success).toBe(true);
    for (const extra of [{kind:"offshoot"}, {arrangementConnection:{}}, {endOffset:{x:0,y:0}}])
      expect(ArrowAttachmentSchema.safeParse({...label(next).arrowAttachment, ...extra}).success).toBe(false);
  });
  it("moves the arrow and its label once, even when both are selected", () => {
    const {document, arrow} = fixture();
    const source = setReactionArrowConditions(document, arrow.id, draft), before = label(source);
    for (const ids of [[arrow.id], [arrow.id, before.id]]) {
      const next = normalizeCommittedDocument(moveDocumentObjects(source, ids, 25, 35));
      expect(label(next).x).toBeCloseTo(before.x+25);
      expect(label(next).y).toBeCloseTo(before.y+35);
      expect(normalizeCommittedDocument(next)).toBe(next);
    }
  });
  it("follows rotation, scale and both flips and keeps its draft", () => {
    const {document, arrow} = fixture();
    const source = setReactionArrowConditions(document, arrow.id, draft);
    const center={x:270,y:300};
    const rotated=rotateDocumentObjectsAroundPoint(source,[arrow.id],center,35);
    const scaled=scaleDocumentObjectsAroundPoint(source,[arrow.id],center,1.4,.7);
    const flipped=flipDocumentObjectsAroundPoint(source,[arrow.id],center,"vertical");
    const horizontal=flipDocumentObjectsAroundPoint(source,[arrow.id],center,"horizontal");
    for (const next of [rotated,scaled,flipped,horizontal]) {
      const object=label(next), attachment=object.arrowAttachment!;
      const frame=reactionConditionsFrame(next.pages[0],next.pages[0].objects[0])!;
      expect(attachment.frame).toEqual(frame);
      const point=arrowAttachmentPoint(frame,attachment.offset);
      expect(object.x+object.width/2).toBeCloseTo(point.x,6);
      expect(object.y+object.height/2).toBeCloseTo(point.y,6);
      expect(reactionConditionsDraft(next,arrow.id)).toEqual(draft);
      expect(normalizeCommittedDocument(next)).toBe(next);
    }
    expect(label(scaled).style.fontSizePx).not.toEqual(label(source).style.fontSizePx);
  });
  it("duplicates, copies, pastes, recolors and deletes the arrow with its label", () => {
    const {document, arrow} = fixture();
    const source=selectDocumentObjects(setReactionArrowConditions(document,arrow.id,draft),document.pages[0].id,[arrow.id]);
    const payload=createSelectionClipboardPayload(source)!;
    expect(payload.objects).toHaveLength(2);
    for (const copy of [duplicateSelectedDocumentObjects(source),pasteSelectionClipboardPayload(source,payload,{x:480,y:480})]) {
      const clones=copy.pages[0].objects.filter(o=>!source.pages[0].objects.some(s=>s.id===o.id));
      expect(clones).toHaveLength(2);
      expect(clones.find(o=>o.type==="text")?.arrowAttachment?.parentObjectId).toBe(clones.find(o=>o.type==="graphic")!.id);
      expect(normalizeCommittedDocument(copy).pages[0].objects.filter(o=>source.pages[0].objects.some(s=>s.id===o.id))).toEqual(source.pages[0].objects);
    }
    expect(copyAsScopedDocument(source).pages[0].objects).toHaveLength(2);
    expect(label(applyObjectColorToDocumentObjects(source,"#123456",[arrow.id])).style.color).toBe("#123456");
    expect(deleteSelectedDocumentObjects(source).pages[0].objects).toHaveLength(0);
    const detached=normalizeCommittedDocument(pasteSelectionClipboardPayload(source,
      createSelectionClipboardPayload(selectDocumentObjects(source,source.pages[0].id,[label(source).id]))!,{x:400,y:400}));
    const pasted = detached.pages[0].objects.at(-1);
    expect(pasted?.type === "text" ? pasted.arrowAttachment : undefined).toBeUndefined();
  });
  it("keeps orphans visible and refuses text or itself as an attachment parent", () => {
    const {document,arrow}=fixture(), next=setReactionArrowConditions(document,arrow.id,draft);
    const object=label(next);
    for (const parentObjectId of ["missing",object.id]) {
      const orphan=resolveArrowAttachments({...next.pages[0],objects:[{...object,arrowAttachment:{...object.arrowAttachment!,parentObjectId}}]});
      expect(orphan.objects[0]).toMatchObject({x:object.x,y:object.y});
      expect(orphan.objects[0]).not.toHaveProperty("arrowAttachment");
    }
  });
  it("uses page top for reversed straight arrows, left for vertical arrows, and curve-relative sides", () => {
    const {document,arrow}=fixture();
    const reversed=createNativeArtLineGraphicObject(document,{x:390,y:300},{x:150,y:300},"tool.art.reactionArrow")!;
    const vertical=createNativeArtLineGraphicObject(document,{x:300,y:180},{x:300,y:420},"tool.art.reactionArrow")!;
    expect(reactionConditionsFrame(document.pages[0],reversed)?.normal.y).toBeLessThan(0);
    expect(reactionConditionsFrame(document.pages[0],vertical)?.normal.x).toBeLessThan(0);
    const curved=editGraphicPathGeometry(arrow,"middle",{x:270,y:240})!;
    const page={...document.pages[0],objects:[curved]};
    const top=setReactionArrowConditions({...document,pages:[page]},arrow.id,draft);
    const bottom=setReactionArrowConditions({...document,pages:[page]},arrow.id,{...draft,side:"below"});
    expect(label(top).y).toBeGreaterThan(label(bottom).y);
  });
});

it("preserves canonical SMILES, charge, isotopes, stereo and reaction roles/components",async()=>{
  installNodeRdkitModuleLoader();
  const {document,arrow}=fixture();
  let source=document;
  for(const [index,smiles] of ["C[C@H](O)C(=O)[O-]","[Na+]","[13CH3]CO"].entries())
    source=insertSmilesMolecule(source,{x:100+index*230,y:500},depictSmiles2D(smiles),smiles);
  const molecules=source.pages[0].objects.filter(o=>o.type==="molecule");
  const scheme={id:"scheme",type:"reaction" as const,x:40,y:200,width:700,height:400,rotation:0,style:{},
    components:molecules.map((m,i)=>({objectId:m.id,role:(["reactant","agent","product"] as const)[i]})),
    conditionsTextObjectIds:[],mappingState:"absent" as const};
  source=applyPatches(source,[{op:"addObject",pageId:source.pages[0].id,object:scheme}]);
  const before=await Promise.all(molecules.map((m,i)=>moleculeSmiles(m,i,[],computeStructureIdentifiers)));
  expect(before.every(Boolean)).toBe(true);expect(before.join(".")).toContain("@");expect(before.join(".")).toContain("[Na+]");
  let next=setReactionArrowConditions(source,arrow.id,draft);
  next=rotateDocumentObjectsAroundPoint(next,[arrow.id],{x:270,y:300},15);
  next=scaleDocumentObjectsAroundPoint(next,[arrow.id],{x:270,y:300},1.1,.9);
  next=flipDocumentObjectsAroundPoint(next,[arrow.id],{x:270,y:300},"horizontal");
  next=normalizeCommittedDocument(moveDocumentObjects(next,[arrow.id],15,20));
  const after=next.pages[0].objects.filter(o=>o.type==="molecule");
  expect(after).toEqual(molecules);expect(next.pages[0].objects.find(o=>o.id==="scheme")).toEqual(scheme);
  expect(after.map(m=>m.atoms.reduce((n,a)=>n+a.formalCharge,0))).toEqual([-1,1,0]);
  expect(after.map(m=>[m.atoms.length,m.bonds.length])).toEqual(molecules.map(m=>[m.atoms.length,m.bonds.length]));
  expect(await Promise.all(after.map((m,i)=>moleculeSmiles(m,i,[],computeStructureIdentifiers)))).toEqual(before);
});
