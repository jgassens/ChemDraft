import {expect,it} from 'vitest';
import {applyPatches,serializeDocument,deserializeDocument,type GraphicObject} from '@chemdraft/chem-core';
import {attachReactionArrowOffshoot} from '@chemdraft/document-workflow-core';
import {arrowAttachmentFrame,arrowAttachmentFractionAtPoint,arrowShaftSamplePoints,nearestArrowObjectAtPoint} from '@chemdraft/layout-engine';
import {graphicPathEditPoints,graphicOpenStrokePageSamplePoints,quadraticArrowGeometry,planNativeArtVisual} from '@chemdraft/art-engine';
import {exportDocumentToSvg} from '@chemdraft/export-engine';
import {createPhase4Document,createNativeArtLineGraphicObject,normalizeCommittedDocument,updateNativeGraphicPathHandle,
  rotateDocumentObjectsAroundPoint,scaleDocumentObjectsAroundPoint,moveDocumentObjects,selectDocumentObjects,
  duplicateSelectedDocumentObjects,createSelectionClipboardPayload,pasteSelectionClipboardPayload} from './documentWorkflow';
const near=(p:{x:number;y:number},q:{x:number;y:number})=>{expect(p.x).toBeCloseTo(q.x,6);expect(p.y).toBeCloseTo(q.y,6);};
function fixture(curved=false,reversed=false,side:'above'|'below'='above',full=true){
  let d=createPhase4Document('Tether regression');
  let parent=createNativeArtLineGraphicObject(d,reversed?{x:520,y:350}:{x:180,y:350},reversed?{x:180,y:350}:{x:520,y:350},'tool.art.reactionArrow')!;
  if(curved)parent=quadraticArrowGeometry(parent,{x:180,y:350},{x:520,y:470},{x:360,y:355});
  d=applyPatches(d,[{op:'addObject',pageId:d.pages[0].id,object:parent}]);
  d=attachReactionArrowOffshoot(d,parent.id,side,full?'fullCurve':undefined);
  return {d,parent,id:d.selection.objectIds[0]};
}
function graphic(d:ReturnType<typeof fixture>['d'],id:string){return d.pages[0].objects.find(o=>o.id===id) as GraphicObject;}
function assertJunction(d:ReturnType<typeof fixture>['d'],id:string){
  const branch=graphic(d,id),a=branch.arrowAttachment!;if(a.kind!=='offshoot')throw Error('Expected offshoot');
  const frame=arrowAttachmentFrame(d.pages[0],graphic(d,a.parentObjectId),a.tetherFraction??.5)!;
  near(graphicPathEditPoints(branch)!.middle,frame.origin);
  const nodes=branch.data.pathNodes!;near(nodes[1].point,frame.origin);
  const before=nodes[1].inControl!,after=nodes[1].outControl!;
  expect((after.x-before.x)*frame.tangent.y-(after.y-before.y)*frame.tangent.x).toBeCloseTo(0,5);
  expect((after.x-before.x)*frame.tangent.x+(after.y-before.y)*frame.tangent.y).toBeGreaterThan(0);
  expect(nearestArrowObjectAtPoint(d.pages[0],graphicOpenStrokePageSamplePoints(branch)[8],2)?.id).toBe(id);
  const plan=planNativeArtVisual(branch);
  expect(exportDocumentToSvg(d).contents).toContain(plan.visiblePathD??plan.pathD);
  expect(normalizeCommittedDocument(d)).toBe(d);
}
for(const full of [false,true])for(const reversed of [false,true])for(const side of ['above','below'] as const)
it(`keeps visual ${side} on straight ${reversed?'RTL':'LTR'} ${full?'full':'half'} curves`,()=>{
  const {d,id}=fixture(false,reversed,side,full),points=graphicPathEditPoints(graphic(d,id))!;
  expect(side==='above'?points.end.y<350:points.end.y>350).toBe(true);
  if(full)expect(side==='above'?points.start.y<350:points.start.y>350).toBe(true);
  expect(normalizeCommittedDocument(d)).toBe(d);
});
it('slides the tether on a rotated curved shaft and keeps that exact junction during independent and paired endpoint edits',()=>{
  let {d,parent,id}=fixture(true);
  d=normalizeCommittedDocument(rotateDocumentObjectsAroundPoint(d,[parent.id],{x:350,y:350},-38));
  const shaft=arrowShaftSamplePoints(d.pages[0],graphic(d,parent.id)),pointer={x:shaft[9].x+9,y:shaft[9].y-12};
  const fraction=arrowAttachmentFractionAtPoint(d.pages[0],graphic(d,parent.id),pointer);
  d=normalizeCommittedDocument(updateNativeGraphicPathHandle(d,id,'tether',pointer));
  expect(graphic(d,id).arrowAttachment).toMatchObject({tetherFraction:fraction});
  const anchor=graphicPathEditPoints(graphic(d,id))!.middle;
  for(const [handle,point,paired] of [['end',{x:450,y:170},false],['start',{x:160,y:210},false],['end',{x:470,y:120},true],['start',{x:190,y:130},true]] as const){
    const before=graphicPathEditPoints(graphic(d,id))!;
    d=normalizeCommittedDocument(updateNativeGraphicPathHandle(d,id,handle,point,{paired}));
    const after=graphicPathEditPoints(graphic(d,id))!;near(after.middle,anchor);
    if(!paired)near(handle==='end'?after.start:after.end,handle==='end'?before.start:before.end);
    else {const a=graphic(d,id).arrowAttachment!;if(a.kind==='offshoot'){expect(a.startOffset!.x).toBeCloseTo(-a.endOffset.x,6);expect(a.startOffset!.y).toBeCloseTo(a.endOffset.y,6);}}
    assertJunction(d,id);
  }
  // Dragging across the junction retains forward tangent reach rather than creating a loop.
  d=normalizeCommittedDocument(updateNativeGraphicPathHandle(d,id,'end',{x:anchor.x-500,y:anchor.y}));assertJunction(d,id);
  expect(deserializeDocument(serializeDocument(d)).pages[0].objects).toEqual(d.pages[0].objects);
});
it('retains a slid tether through ancestor translation, rotation and nonuniform scaling',()=>{
  let {d,parent,id}=fixture(true,false,'below');
  d=normalizeCommittedDocument(updateNativeGraphicPathHandle(d,id,'tether',{x:450,y:400}));
  const fraction=(graphic(d,id).arrowAttachment as {tetherFraction:number}).tetherFraction;
  d=normalizeCommittedDocument(moveDocumentObjects(d,[parent.id],15,-20));
  d=normalizeCommittedDocument(rotateDocumentObjectsAroundPoint(d,[parent.id],{x:350,y:350},48));
  d=normalizeCommittedDocument(scaleDocumentObjectsAroundPoint(d,[parent.id],{x:350,y:350},1.3,.75));
  expect(graphic(d,id).arrowAttachment).toMatchObject({tetherFraction:fraction});assertJunction(d,id);
  d=selectDocumentObjects(d,d.pages[0].id,[parent.id]);const originalIds=new Set(d.pages[0].objects.map(o=>o.id));
  for(const copy of [duplicateSelectedDocumentObjects(d),pasteSelectionClipboardPayload(d,createSelectionClipboardPayload(d)!,{x:500,y:600})]){
    const settled=normalizeCommittedDocument(copy),branch=settled.pages[0].objects.find(o=>!originalIds.has(o.id)&&o.arrowAttachment?.kind==='offshoot')!;
    expect(branch.arrowAttachment).toMatchObject({tetherFraction:fraction});assertJunction(settled,branch.id);
  }
});
it('upgrades saved midpoint quadratic full curves without losing their attachment or endpoint positions',()=>{
  let {d,id}=fixture(),branch=graphic(d,id),p=graphicPathEditPoints(branch)!;
  const a=branch.arrowAttachment!;if(a.kind!=='offshoot')throw Error('Expected offshoot');
  const {tetherFraction:_fraction,normalSign:_normal,...legacyAttachment}=a;
  const legacy=quadraticArrowGeometry({...branch,arrowAttachment:legacyAttachment},p.start,p.end,p.middle);
  d=applyPatches(d,[{op:'updateObject',objectId:id,changes:legacy}]);
  d=normalizeCommittedDocument(deserializeDocument(serializeDocument(d)));
  const next=graphicPathEditPoints(graphic(d,id))!;near(next.start,p.start);near(next.end,p.end);near(next.middle,p.middle);
  expect(graphic(d,id).data.artPathKind).toBe('bezier');assertJunction(d,id);
});
