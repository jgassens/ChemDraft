import { describe, expect, it } from "vitest";
import { applyPatches, deserializeDocument, serializeDocument, type ChemDraftDocument } from "@chemdraft/chem-core";
import { ArrangementLayouts, defaultArrangementDraft, planArrangementConnections, planObjectArrangement, type ArrangementDraft } from "@chemdraft/layout-engine";
import { graphicPathEditPoints, graphicOpenStrokePageSamplePoints, planNativeArtVisual } from "@chemdraft/art-engine";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { attachReactionArrowOffshoot, setReactionArrowConditions } from "@chemdraft/document-workflow-core";
import { adjustArrangementSpacing, selectedArrangementDraft, arrangeSelectedDocumentObjects, arrangeSelectedDocumentObjectsWithOptions, createNativeSingleBondMolecule, createPhase4Document, selectDocumentObjects, setDocumentCustomPageSize, groupSelectedDocumentObjects, duplicateSelectedDocumentObjects, normalizeCommittedDocument, createNativeArtLineGraphicObject, moveDocumentObjects } from "./documentWorkflow";

function fixture(count = 6): ChemDraftDocument {
  let d = setDocumentCustomPageSize(createPhase4Document("Connected arrangement"), { width: 1600, height: 1200, unit: "css-px" });
  for (let i = 0; i < count; i++) d = applyPatches(d, [{ op: "addObject", pageId: d.pages[0].id,
    object: createNativeSingleBondMolecule(d, { x: 350 + i%3*140, y: 300 + Math.floor(i/3)*160 }) }]);
  return selectDocumentObjects(d, d.pages[0].id, d.pages[0].objects.map(o => o.id));
}
const options = (extra: Partial<ArrangementDraft> = {}): ArrangementDraft => ({ ...defaultArrangementDraft, arrows: true, ...extra });

describe("optional arrangement connections", () => {
  it.each(['left','center','right'] as const)('reroutes a saved circle through the quick grid %s command, retaining matching arrows and their attachment trees',gridAlignment=>{
    let source=arrangeSelectedDocumentObjectsWithOptions(fixture(4),options({layout:'circle',closeCycle:true})).document;
    const arrows=source.pages[0].objects.filter(o=>o.arrangementConnection),retained=arrows[1];
    source=applyPatches(source,[{op:'updateObject',objectId:retained.id,changes:{style:{...retained.style,strokeColor:'#aa2244'}}}]);
    source=attachReactionArrowOffshoot(source,retained.id,'above','fullCurve');
    const branchId=source.selection.objectIds[0];
    source=setReactionArrowConditions(source,retained.id,{side:'above',spans:[{text:'SDK',script:'normal'}]});
    const labelId=source.selection.objectIds[0];
    const unrelated=createNativeArtLineGraphicObject(source,{x:80,y:80},{x:180,y:80},'tool.art.reactionArrow')!;
    source=applyPatches(source,[{op:'addObject',pageId:source.pages[0].id,object:unrelated}]);
    const molecules=source.pages[0].objects.filter(o=>o.type==='molecule');
    source=selectDocumentObjects(source,source.pages[0].id,molecules.map(o=>o.id));
    const result=arrangeSelectedDocumentObjects(source,'grid',{gridAlignment});
    const after=normalizeCommittedDocument(result.document),connections=after.pages[0].objects.filter(o=>o.arrangementConnection);
    expect(connections).toHaveLength(2);
    expect(connections.every(o=>o.arrangementConnection!.settings?.layout==='grid')).toBe(true);
    expect(connections.every(o=>o.arrangementConnection!.settings?.gridAlignment===gridAlignment)).toBe(true);
    for(const arrow of connections) {
      if(arrow.type!=='graphic')throw new Error('fixture');
      const p=graphicPathEditPoints(arrow)!;
      expect((p.middle.x-p.start.x)*(p.end.y-p.start.y)-(p.middle.y-p.start.y)*(p.end.x-p.start.x)).toBeCloseTo(0,5);
    }
    expect(after.pages[0].objects.find(o=>o.id===retained.id)?.style.strokeColor).toBe('#aa2244');
    expect(after.pages[0].objects.find(o=>o.id===branchId)?.arrowAttachment?.parentObjectId).toBe(retained.id);
    expect(after.pages[0].objects.find(o=>o.id===labelId)?.arrowAttachment?.parentObjectId).toBe(retained.id);
    expect(after.pages[0].objects.find(o=>o.id===unrelated.id)).toEqual(unrelated);
    const reopened=normalizeCommittedDocument(deserializeDocument(serializeDocument(after)));
    expect(reopened.pages[0].objects).toEqual(after.pages[0].objects);
    expect(exportDocumentToSvg(reopened).contents).toBe(exportDocumentToSvg(after).contents);
    for(const original of molecules) {
      const moved=after.pages[0].objects.find(o=>o.id===original.id)!;
      expect(moved.width).toBe(original.width);expect(moved.height).toBe(original.height);
    }
  });
  it('keeps ordinary molecule moves independent but reflows connections on an explicit same-layout command',()=>{
    let source=arrangeSelectedDocumentObjectsWithOptions(fixture(4),options({layout:'circle',closeCycle:true})).document;
    const oldArrow=source.pages[0].objects.find(o=>o.arrangementConnection)!;
    const molecule=source.pages[0].objects.find(o=>o.type==='molecule')!;
    source=normalizeCommittedDocument(moveDocumentObjects(source,[molecule.id],20,0));
    expect(source.pages[0].objects.find(o=>o.id===oldArrow.id)).toEqual(oldArrow);
    const after=arrangeSelectedDocumentObjects(source,'circle').document;
    const updated=after.pages[0].objects.find(o=>o.id===oldArrow.id)!;
    expect(updated).toBeDefined();
    if(updated.type!=='graphic'||oldArrow.type!=='graphic')throw new Error('fixture');
    expect(graphicPathEditPoints(updated)).not.toEqual(graphicPathEditPoints(oldArrow));
  });
  it('refuses a quick layout that cannot fit without moving compounds or arrows',()=>{
    const source=arrangeSelectedDocumentObjectsWithOptions(fixture(4),options({layout:'circle',closeCycle:true})).document;
    const result=arrangeSelectedDocumentObjects(source,'row',{gap:10000});
    expect(result.document).toBe(source);expect(result.status).toContain('does not fit');
  });
  it.each(['row','column'] as const)('preserves separate mixed directions/layouts (%s) for length-only edits but applies an intentional topology change',secondLayout=>{
    let d=fixture(4);const ids=d.selection.objectIds;
    for(const [i,reverse] of [false,true].entries()) {
      const result=arrangeSelectedDocumentObjectsWithOptions(selectDocumentObjects(d,d.pages[0].id,ids.slice(i*2,i*2+2)),options({layout:i===0?'row':secondLayout,reverse}));
      expect(result.ok,result.status).toBe(true);d=result.document;
    }
    d=selectDocumentObjects(d,d.pages[0].id,ids);
    const molecules=d.pages[0].objects.filter(o=>o.type==='molecule'),arrows=d.pages[0].objects.filter(o=>o.arrangementConnection);
    const result=arrangeSelectedDocumentObjectsWithOptions(d,{...selectedArrangementDraft(d),arrowLength:60});
    expect(result.ok,result.status).toBe(true);d=result.document;
    expect(d.pages[0].objects.filter(o=>o.type==='molecule')).toEqual(molecules);
    const edited=d.pages[0].objects.filter(o=>o.arrangementConnection);
    expect(edited.map(o=>o.id)).toEqual(arrows.map(o=>o.id));
    expect(edited.map(o=>[o.arrangementConnection!.fromObjectId,o.arrangementConnection!.toObjectId])).toEqual(arrows.map(o=>[o.arrangementConnection!.fromObjectId,o.arrangementConnection!.toObjectId]));
    expect(edited.map(o=>o.arrangementConnection!.settings!.reverse)).toEqual([false,true]);
    expect(edited.map(o=>o.arrangementConnection!.settings!.layout)).toEqual(['row',secondLayout]);
    expect(edited.every(o=>o.arrangementConnection!.settings!.arrowLength===60)).toBe(true);
    const changed=arrangeSelectedDocumentObjectsWithOptions(d,{...selectedArrangementDraft(d),layout:'column'});
    expect(changed.ok,changed.status).toBe(true);
    expect(changed.document.pages[0].objects.filter(o=>o.arrangementConnection)).toHaveLength(3);
    expect(changed.document.pages[0].objects.filter(o=>o.type==='molecule')).not.toEqual(molecules);
  });
  it('persists recovered legacy spatial order across consecutive length edits without resetting custom spacing',()=>{
    let d=arrangeSelectedDocumentObjectsWithOptions(fixture(5),options({layout:'row'})).document;
    d=adjustArrangementSpacing(d,1.2).document;
    const arrows=d.pages[0].objects.filter(o=>o.arrangementConnection),molecules=d.pages[0].objects.filter(o=>o.type==='molecule');
    const order=arrows.find(o=>o.arrangementConnection!.itemObjectIds)!.arrangementConnection!.itemObjectIds;
    d=applyPatches(d,arrows.map(o=>({op:'updateObject' as const,objectId:o.id,changes:{arrangementConnection:{fromObjectId:o.arrangementConnection!.fromObjectId,toObjectId:o.arrangementConnection!.toObjectId,bend:o.arrangementConnection!.bend}}})));
    for(const arrowLength of [70,60]) {
      const result=arrangeSelectedDocumentObjectsWithOptions(d,{...selectedArrangementDraft(d),arrowLength});
      expect(result.ok,result.status).toBe(true);d=deserializeDocument(serializeDocument(result.document));
      expect(d.pages[0].objects.filter(o=>o.type==='molecule')).toEqual(molecules);
      expect(d.pages[0].objects.find(o=>o.arrangementConnection?.itemObjectIds)?.arrangementConnection!.itemObjectIds).toEqual(order);
      expect(d.pages[0].objects.filter(o=>o.arrangementConnection).map(o=>o.id)).toEqual(arrows.map(o=>o.id));
    }
  });
  it('rebuilds a missing neighbor edge while retaining the other editable arrow IDs',()=>{
    let d=arrangeSelectedDocumentObjectsWithOptions(fixture(4),options({layout:'row'})).document;
    const arrows=d.pages[0].objects.filter(o=>o.arrangementConnection),removed=arrows[1];
    d=applyPatches(d,[{op:'removeObject',objectId:removed.id}]);
    const result=arrangeSelectedDocumentObjectsWithOptions(d,selectedArrangementDraft(d));
    expect(result.ok,result.status).toBe(true);
    const next=result.document.pages[0].objects.filter(o=>o.arrangementConnection);
    expect(next).toHaveLength(3);
    for(const arrow of [arrows[0],arrows[2]])expect(next.some(o=>o.id===arrow.id)).toBe(true);
    expect(next.some(o=>o.arrangementConnection!.fromObjectId===removed.arrangementConnection!.fromObjectId&&
      o.arrangementConnection!.toObjectId===removed.arrangementConnection!.toObjectId)).toBe(true);
  });
  it('updates saved membership for a reduced selection without touching the excluded compound or its connection',()=>{
    let d=arrangeSelectedDocumentObjectsWithOptions(fixture(3),options({layout:'row'})).document;
    const molecules=d.pages[0].objects.filter(o=>o.type==='molecule'),ids=molecules.slice(0,2).map(o=>o.id);
    const excluded=d.pages[0].objects.find(o=>o.arrangementConnection?.toObjectId===molecules[2].id)!;
    d=selectDocumentObjects(d,d.pages[0].id,ids);
    const result=arrangeSelectedDocumentObjectsWithOptions(d,selectedArrangementDraft(d));
    expect(result.ok,result.status).toBe(true);
    const edited=result.document.pages[0].objects.find(o=>o.arrangementConnection?.fromObjectId===ids[0])!;
    expect(edited.arrangementConnection!.itemObjectIds).toEqual(ids);
    expect(result.document.pages[0].objects.find(o=>o.id===excluded.id)).toEqual(excluded);
    expect(result.document.pages[0].objects.find(o=>o.id===molecules[2].id)).toEqual(molecules[2]);
  });
  it('applies a common shortened length per arrangement while retaining positions and already matching geometry',()=>{
    let d=fixture(4);const ids=d.pages[0].objects.map(o=>o.id);
    for(const [members,arrowLength] of [[ids.slice(0,2),100],[ids.slice(2),30]] as const) {
      const result=arrangeSelectedDocumentObjectsWithOptions(selectDocumentObjects(d,d.pages[0].id,members),options({layout:'row',arrowLength}));
      expect(result.ok,result.status).toBe(true);d=result.document;
    }
    const before=d.pages[0].objects.filter(o=>o.arrangementConnection);
    const molecules=d.pages[0].objects.filter(o=>o.type==='molecule');
    d=selectDocumentObjects(d,d.pages[0].id,ids);
    const result=arrangeSelectedDocumentObjectsWithOptions(d,{...selectedArrangementDraft(d),arrowLength:30});
    expect(result.ok,result.status).toBe(true);
    expect(result.document.pages[0].objects.filter(o=>o.type==='molecule')).toEqual(molecules);
    for(const [index,arrow] of before.entries()) {
      const next=result.document.pages[0].objects.find(o=>o.id===arrow.id)! as import('@chemdraft/chem-core').GraphicObject;
      expect(next.arrangementConnection!.settings!.arrowLength).toBe(30);
      if(index===0)expect(graphicPathEditPoints(next)).not.toEqual(graphicPathEditPoints(arrow as typeof next));
      else expect(graphicPathEditPoints(next)).toEqual(graphicPathEditPoints(arrow as typeof next));
    }
  });
  it('recognizes legacy generated arrows, preserves unchanged geometry, and never infers handdrawn arrows',()=>{
    let d=arrangeSelectedDocumentObjectsWithOptions(fixture(4),options({layout:'row'})).document;
    const arrows=d.pages[0].objects.filter(o=>o.arrangementConnection);
    d=applyPatches(d,arrows.map(o=>({op:'updateObject' as const,objectId:o.id,changes:{rotation:12,
      arrangementConnection:{fromObjectId:o.arrangementConnection!.fromObjectId,toObjectId:o.arrangementConnection!.toObjectId,bend:o.arrangementConnection!.bend}}})));
    const draft=selectedArrangementDraft(d);expect(draft.arrows).toBe(true);expect(draft.layout).toBe('row');
    const saved=arrangeSelectedDocumentObjectsWithOptions(d,draft);expect(saved.ok,saved.status).toBe(true);
    for(const arrow of d.pages[0].objects.filter(o=>o.arrangementConnection)) {
      const next=saved.document.pages[0].objects.find(o=>o.id===arrow.id)!;
      expect({...next,arrangementConnection:undefined}).toEqual({...arrow,arrangementConnection:undefined});
    }
    const noRelationships=applyPatches(d,arrows.map(o=>({op:'updateObject' as const,objectId:o.id,changes:{arrangementConnection:undefined}})));
    expect(selectedArrangementDraft(noRelationships).arrows).toBe(false);
  });
  it.each(ArrangementLayouts)('reopens %s options faithfully and edits arrow length without moving compounds or duplicating arrows',layout=>{
    const draft=options({layout,reverse:true,closeCycle:true,gridOrder:'snake',arrowLength:100});
    let d=arrangeSelectedDocumentObjectsWithOptions(fixture(4),draft).document;
    expect(selectedArrangementDraft(deserializeDocument(serializeDocument(d)))).toEqual(draft);
    const arrow=d.pages[0].objects.find(o=>o.arrangementConnection)!;
    d=attachReactionArrowOffshoot(d,arrow.id,'above');
    d=setReactionArrowConditions(d,arrow.id,{side:'below',spans:[{text:'THF',script:'normal'}]});
    d=selectDocumentObjects(d,d.pages[0].id,d.pages[0].objects.filter(o=>o.type==='molecule').map(o=>o.id));
    const before=serializeDocument(d),edited=arrangeSelectedDocumentObjectsWithOptions(d,{...selectedArrangementDraft(d),arrowLength:70});
    expect(edited.ok,edited.status).toBe(true);
    expect(edited.document.pages[0].objects.filter(o=>o.arrangementConnection).map(o=>o.id)).toEqual(d.pages[0].objects.filter(o=>o.arrangementConnection).map(o=>o.id));
    expect(edited.document.pages[0].objects.filter(o=>o.type==='molecule')).toEqual(d.pages[0].objects.filter(o=>o.type==='molecule'));
    const oldArrow=arrow as import('@chemdraft/chem-core').GraphicObject,newArrow=edited.document.pages[0].objects.find(o=>o.id===arrow.id)! as typeof oldArrow;
    expect(graphicPathEditPoints(newArrow)).not.toEqual(graphicPathEditPoints(oldArrow));expect(newArrow.style).toEqual(oldArrow.style);
    const length=(object:typeof oldArrow)=>{const points=graphicOpenStrokePageSamplePoints(object);return points.slice(1).reduce((sum,p,i)=>sum+Math.hypot(p.x-points[i].x,p.y-points[i].y),0);};
    expect(length(newArrow)).toBeLessThan(length(oldArrow)*.85);
    const spaced=adjustArrangementSpacing(edited.document,1.05);expect(spaced.ok,spaced.status).toBe(true);
    expect(selectedArrangementDraft(spaced.document).arrowLength).toBe(70);
    expect(edited.document.pages[0].objects.filter(o=>o.arrowAttachment).map(o=>o.id)).toEqual(d.pages[0].objects.filter(o=>o.arrowAttachment).map(o=>o.id));
    expect(serializeDocument(d)).toBe(before);
    const unrelated={...newArrow,id:'handdrawn',arrangementConnection:undefined,arrowAttachment:undefined};
    const source=applyPatches(edited.document,[{op:'addObject',pageId:d.pages[0].id,object:unrelated}]);
    const removed=arrangeSelectedDocumentObjectsWithOptions(source,{...selectedArrangementDraft(source),arrows:false});
    expect(removed.ok,removed.status).toBe(true);
    expect(removed.document.pages[0].objects.some(o=>o.arrangementConnection||o.arrowAttachment)).toBe(false);
    expect(removed.document.pages[0].objects.some(o=>o.id==='handdrawn')).toBe(true);
    expect(removed.document.pages[0].objects.filter(o=>o.type==='molecule')).toEqual(source.pages[0].objects.filter(o=>o.type==='molecule'));
  });
  it('uses a compact default gap without changing molecule dimensions',()=>{
    const d=fixture(2),result=arrangeSelectedDocumentObjectsWithOptions(d,options({layout:'row'}));
    expect(result.ok,result.status).toBe(true);
    const molecules=result.document.pages[0].objects.filter(o=>o.type==='molecule');
    expect(molecules[1].x-(molecules[0].x+molecules[0].width)).toBeLessThan(96);
    expect(molecules.map(o=>o.width)).toEqual(d.pages[0].objects.map(o=>o.width));
  });
  it('retains saved branch/conditions attachments when only compounds are selected for spacing',()=>{
    let d=arrangeSelectedDocumentObjectsWithOptions(fixture(2),options({layout:'row'})).document;
    const arrow=d.pages[0].objects.find(o=>o.arrangementConnection)!;
    d=attachReactionArrowOffshoot(d,arrow.id,'above');
    d=setReactionArrowConditions(d,arrow.id,{side:'below',spans:[{text:'THF',script:'normal'}]});
    const attachmentIds=d.pages[0].objects.filter(o=>o.arrowAttachment).map(o=>o.id);
    d=selectDocumentObjects(d,d.pages[0].id,d.pages[0].objects.filter(o=>o.type==='molecule').map(o=>o.id));
    const result=adjustArrangementSpacing(d,1.1);
    expect(result.ok,result.status).toBe(true);
    for(const id of attachmentIds)expect(result.document.pages[0].objects.find(o=>o.id===id)?.arrowAttachment?.parentObjectId).toBe(arrow.id);
    const copied=duplicateSelectedDocumentObjects(selectDocumentObjects(result.document,result.document.pages[0].id,
      result.document.pages[0].objects.map(o=>o.id)));
    const duplicate=copied.pages[0].objects.filter(o=>o.arrangementConnection).at(-1)!;
    expect(duplicate.arrangementConnection?.fromObjectId).not.toBe(arrow.arrangementConnection?.fromObjectId);
    expect(copied.pages[0].objects.some(o=>o.id===duplicate.arrangementConnection?.fromObjectId)).toBe(true);
  });
  it.each(ArrangementLayouts)('reroutes saved %s connections on spacing changes while retaining IDs, styles and chemistry', layout => {
    const arranged=arrangeSelectedDocumentObjectsWithOptions(fixture(4),options({layout,closeCycle:true}));
    expect(arranged.ok,arranged.status).toBe(true);
    const source=deserializeDocument(serializeDocument(arranged.document));
    const arrows=source.pages[0].objects.filter(o=>o.type==='graphic');
    for(const factor of [.9,1.1]) {
      const result=adjustArrangementSpacing(source,factor);
      expect(result.ok,result.status).toBe(true);
      const next=result.document.pages[0].objects.filter(o=>o.type==='graphic');
      expect(next.map(o=>o.id)).toEqual(arrows.map(o=>o.id));
      next.forEach((arrow,i)=>{expect(arrow.style).toEqual(arrows[i].style);expect(graphicPathEditPoints(arrow)).not.toEqual(graphicPathEditPoints(arrows[i]));});
      for(const old of source.pages[0].objects)if(old.type==='molecule') {
        const moved=result.document.pages[0].objects.find(o=>o.id===old.id)!;
        expect(moved.type==='molecule'&&moved.bonds).toEqual(old.bonds);
      }
    }
  });
  it.each(ArrangementLayouts)("creates editable, matching-headed %s arrows without changing chemistry", layout => {
    const source = fixture(), before = serializeDocument(source);
    const result = arrangeSelectedDocumentObjectsWithOptions(source, options({ layout, closeCycle: true }));
    expect(result.ok, result.status).toBe(true);
    const arrows = result.document.pages[0].objects.filter(o => o.type === "graphic");
    expect(arrows).toHaveLength(layout === "circle" || layout === "oval" ? 6 : layout === "grid" ? 4 : 5);
    for (const arrow of arrows) {
      expect(arrow.data.markerEnd).toEqual({ kind: "filled-arrow", sizePx: 9 });
      expect(graphicPathEditPoints(arrow)).toBeDefined();
      expect(planNativeArtVisual(arrow)).toBeDefined();
      expect(result.document.selection.objectIds).toContain(arrow.id);
    }
    for (const old of source.pages[0].objects) {
      const moved = result.document.pages[0].objects.find(o => o.id === old.id)!;
      expect(moved.type).toBe("molecule");
      if (old.type !== "molecule" || moved.type !== "molecule") throw new Error("fixture");
      expect(moved.atoms.map(({ x, y, ...atom }) => atom)).toEqual(old.atoms.map(({ x, y, ...atom }) => atom));
      expect(moved.bonds).toEqual(old.bonds);
      expect(moved.width).toBe(old.width); expect(moved.height).toBe(old.height);
      expect(moved.atoms[1].x-moved.atoms[0].x).toBeCloseTo(old.atoms[1].x-old.atoms[0].x);
    }
    expect(serializeDocument(source)).toBe(before);
    expect(deserializeDocument(serializeDocument(result.document))).toEqual(result.document);
    expect(exportDocumentToSvg(result.document).contents).toContain("<path");
    const branch = attachReactionArrowOffshoot(result.document, arrows[0].id, "above");
    const offshoot = branch.pages[0].objects.at(-1)!;
    expect(offshoot.type === "graphic" && offshoot.data.markerEnd?.sizePx).toBe(9);
  });
  it("starts off and does not add arrows to a plain arrangement", () => {
    const result = arrangeSelectedDocumentObjectsWithOptions(fixture(), { ...defaultArrangementDraft });
    expect(result.ok).toBe(true); expect(result.document.pages[0].objects).toHaveLength(6);
  });
  it("offers an open cycle, a closing arc, both directions and two opposite half-cycle arcs", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: String(i), bounds: { x: i*90, y: 200, width: 40, height: 30 } }));
    const plan = planObjectArrangement(items, "circle", { gap: 96 });
    if (!plan.ok) throw new Error("fixture");
    const open = planArrangementConnections(plan, options());
    const closed = planArrangementConnections(plan, options({ closeCycle: true }));
    const reverse = planArrangementConnections(plan, options({ reverse: true }));
    if (!open.ok || !closed.ok || !reverse.ok) throw new Error("route refused");
    expect(open.connections).toHaveLength(5); expect(closed.connections).toHaveLength(6);
    expect(reverse.connections[0]).toMatchObject({ start: open.connections[0].end, end: open.connections[0].start, middle: open.connections[0].middle });
    const two = arrangeSelectedDocumentObjectsWithOptions(fixture(2), options({ closeCycle: true }));
    expect(two.ok, two.status).toBe(true);
    expect(two.document.pages[0].objects.filter(o => o.type === "graphic")).toHaveLength(2);
  });
  it("offers a snake sequence instead of implicitly connecting separate grid rows", () => {
    const result = arrangeSelectedDocumentObjectsWithOptions(fixture(), options({ layout: "grid", gridOrder: "snake" }));
    expect(result.ok, result.status).toBe(true);
    expect(result.document.pages[0].objects.filter(o => o.type === "graphic")).toHaveLength(5);
  });
  it("refuses obstructed or off-page arrangements atomically", () => {
    const source = fixture(2);
    const plan = planObjectArrangement([{ id: "a", bounds: { x: 100, y: 100, width: 50, height: 30 } }, { id: "b", bounds: { x: 300, y: 100, width: 50, height: 30 } }], "row", { gap: 96 });
    if (!plan.ok) throw new Error("fixture");
    expect(planArrangementConnections(plan, options({ layout: "row" }), [{ x: 190, y: 90, width: 60, height: 50 }]).ok).toBe(false);
    const tiny = setDocumentCustomPageSize(source, { width: 60, height: 60, unit: "css-px" });
    const result = arrangeSelectedDocumentObjectsWithOptions(tiny, options());
    expect(result.ok).toBe(false); expect(result.document).toBe(tiny);
    expect(arrangeSelectedDocumentObjectsWithOptions(source, { ...options(), reverse: "bad" } as unknown as ArrangementDraft).document).toBe(source);
  });
  it("clears grouped rotated captions and refuses a nearby rotated caption crossing a route", () => {
    let source = fixture(2);
    const first = source.pages[0].objects[0];
    source = applyPatches(source, [{ op: "addObject", pageId: source.pages[0].id, object: {
      id: "caption", type: "text", text: "A wide grouped caption", spans: [], x: first.x, y: first.y+45,
      width: 150, height: 20, rotation: 90, style: {}
    } }]);
    source = groupSelectedDocumentObjects(selectDocumentObjects(source, source.pages[0].id, [first.id, "caption"]));
    source = selectDocumentObjects(source, source.pages[0].id, [...source.selection.objectIds, source.pages[0].objects[1].id]);
    const grouped = arrangeSelectedDocumentObjectsWithOptions(source, options({ layout: "row" }));
    expect(grouped.ok, grouped.status).toBe(true);
    const caption = grouped.document.pages[0].objects.find(o => o.id === "caption")!;
    expect(caption.rotation).toBe(90); expect(caption.width).toBe(150);
    expect(caption.x-grouped.document.pages[0].objects[0].x).toBeCloseTo(first.x-first.x);

    const plain = fixture(2), placed = arrangeSelectedDocumentObjectsWithOptions(plain, options({ layout: "row" }));
    const arrow = placed.document.pages[0].objects.find(o => o.type === "graphic")!;
    if (arrow.type !== "graphic") throw new Error("fixture");
    const middle = graphicPathEditPoints(arrow)!.middle;
    // Its stored narrow frame misses the shaft; rotating it makes a wide horizontal caption.
    const blocked = applyPatches(plain, [{ op: "addObject", pageId: plain.pages[0].id, object: {
      id: "nearby", type: "text", text: "Nearby caption", spans: [], x: middle.x+35, y: middle.y-90,
      width: 20, height: 180, rotation: 90, style: {}
    } }]);
    const result = arrangeSelectedDocumentObjectsWithOptions(blocked, options({ layout: "row" }));
    expect(result.ok).toBe(false); expect(result.document).toBe(blocked);
  });
});
