import { describe, expect, it } from "vitest";
import { applyPatches, type GraphicObject } from "@chemdraft/chem-core";
import { attachReactionArrowOffshoot } from "@chemdraft/document-workflow-core";
import { arrowAttachmentFrame, nearestArrowObjectAtPoint } from "@chemdraft/layout-engine";
import { graphicPathEditPoints, quadraticArrowGeometry, planNativeArtVisual } from "@chemdraft/art-engine";
import { createNativeArtLineGraphicObject, createPhase4Document, groupSelectedDocumentObjects,
 normalizeCommittedDocument, scaleDocumentObjectsAroundPoint, selectDocumentObjects,
 applyGraphicObjectColorToSelection, applyObjectColorToDocumentObjects } from "./documentWorkflow";
function fixture() {
  let d=createPhase4Document('Arrow refinement');
  const arrow=createNativeArtLineGraphicObject(d,{x:150,y:300},{x:390,y:300},'tool.art.reactionArrow')!;
  d=applyPatches(d,[{op:'addObject',pageId:d.pages[0].id,object:arrow}]);
  d=attachReactionArrowOffshoot(d,arrow.id,'above');return {d,arrow};
}
const near=(a:{x:number;y:number},b:{x:number;y:number})=>{expect(a.x).toBeCloseTo(b.x,5);expect(a.y).toBeCloseTo(b.y,5);};

describe('arrow offshoot refinements',()=>{
  it('separates inward and outward offshoot tips equally from a curved parent shaft',()=>{
    let {d,arrow}=fixture();
    d=applyPatches(d,[{op:'removeObject',objectId:d.pages[0].objects[1].id},{op:'updateObject',objectId:arrow.id,
      changes:quadraticArrowGeometry(arrow,{x:150,y:200},{x:450,y:400},{x:335,y:255})}]);
    const parent=d.pages[0].objects[0],frame=arrowAttachmentFrame(d.pages[0],parent)!;
    d=attachReactionArrowOffshoot(d,arrow.id,'above');d=attachReactionArrowOffshoot(d,arrow.id,'below');
    const branches=d.pages[0].objects.slice(1) as GraphicObject[];
    const offsets=branches.map(o=>o.arrowAttachment?.kind==='offshoot'?o.arrowAttachment.endOffset:undefined);
    expect(offsets[0]!.x).toBeCloseTo(offsets[1]!.x);
    const baseline=(offsets[0]!.y+offsets[1]!.y)/2;
    expect(Math.abs(baseline)).toBeGreaterThan(1);
    expect(offsets[0]!.y-baseline).toBeCloseTo(baseline-offsets[1]!.y);
    expect(branches[0].data.markerEnd).toEqual(branches[1].data.markerEnd);
    const tip=graphicPathEditPoints(branches[1])!.end;
    expect(nearestArrowObjectAtPoint(d.pages[0],tip,8)?.id).toBe(branches[1].id);
    expect(frame.length).toBeGreaterThan(100);
  });
  it('colors selected arrow shafts and heads, carries branch styling, and respects a branch-only target',()=>{
    const {d,arrow}=fixture();
    const child=d.pages[0].objects[1] as GraphicObject;
    const colored=applyGraphicObjectColorToSelection(d,'fill','#cc0000',[arrow.id]);
    for(const object of colored.pages[0].objects as GraphicObject[])expect(planNativeArtVisual(object).stroke.color).toBe('#cc0000');
    const branchOnly=applyGraphicObjectColorToSelection(colored,'stroke','#0000cc',[child.id]);
    expect(planNativeArtVisual(branchOnly.pages[0].objects[0] as GraphicObject).stroke.color).toBe('#cc0000');
    expect(planNativeArtVisual(branchOnly.pages[0].objects[1] as GraphicObject).stroke.color).toBe('#0000cc');
    const toolbar=applyObjectColorToDocumentObjects(branchOnly,'#00cc00',[arrow.id]);
    for(const object of toolbar.pages[0].objects as GraphicObject[])expect(planNativeArtVisual(object).stroke.color).toBe('#00cc00');
  });
  it.each(['parent','both','group'] as const)('keeps the branch and head separation proportional while scaling %s',mode=>{
    let {d,arrow}=fixture();const branch=d.pages[0].objects[1] as GraphicObject;
    const old=graphicPathEditPoints(branch)!, center={x:270,y:300};
    let ids=[arrow.id];
    if(mode==='both')ids.push(branch.id);
    if(mode==='group'){d=groupSelectedDocumentObjects(selectDocumentObjects(d,d.pages[0].id,[arrow.id,branch.id]));ids=d.selection.objectIds;}
    const after=normalizeCommittedDocument(scaleDocumentObjectsAroundPoint(d,ids,center,2,2));
    const main=after.pages[0].objects.find(o=>o.id===arrow.id)!, child=after.pages[0].objects.find(o=>o.id===branch.id)! as GraphicObject;
    const next=graphicPathEditPoints(child)!;
    near(next.start,arrowAttachmentFrame(after.pages[0],main)!.origin);
    near(next.end,{x:center.x+(old.end.x-center.x)*2,y:center.y+(old.end.y-center.y)*2});
    near(next.middle,{x:center.x+(old.middle.x-center.x)*2,y:center.y+(old.middle.y-center.y)*2});
    expect(main.type==='graphic' && main.data.markerEnd?.sizePx).toBe(child.data.markerEnd?.sizePx);
    expect(normalizeCommittedDocument(after)).toBe(after);
    const restored=normalizeCommittedDocument(scaleDocumentObjectsAroundPoint(after,ids,center,.5,.5));
    near(graphicPathEditPoints(restored.pages[0].objects.find(o=>o.id===branch.id)! as GraphicObject)!.end,old.end);
  });
  it('scales the offshoot bend and rise with different horizontal and vertical resize factors',()=>{
    const {d,arrow}=fixture(),old=graphicPathEditPoints(d.pages[0].objects[1] as GraphicObject)!;
    const after=normalizeCommittedDocument(scaleDocumentObjectsAroundPoint(d,[arrow.id],{x:270,y:300},3,.75));
    const next=graphicPathEditPoints(after.pages[0].objects[1] as GraphicObject)!;
    near({x:next.end.x-next.start.x,y:next.end.y-next.start.y},{x:(old.end.x-old.start.x)*3,y:(old.end.y-old.start.y)*.75});
  });

});
