import { describe, expect, it } from "vitest";
import { exportDocumentToSvg } from '@chemdraft/export-engine';
import { applyPatches, type GraphicObject, type TextObject } from "@chemdraft/chem-core";
import { attachReactionArrowOffshoot, setReactionArrowConditions, reactionConditionsDraft, nativeFormattedTextObjectSize } from "@chemdraft/document-workflow-core";
import { resolveArrowAttachments, arrowAttachmentFrame, nativeTextObjectLineMetrics, nativeTextSpanMetrics, reactionConditionsFrame, moleculeOutlineForArrangement, nearestArrowObjectAtPoint, planArrangementConnections, defaultArrangementDraft } from "@chemdraft/layout-engine";
import { artObstacleIntersectsBounds, graphicOpenStrokePageSamplePoints, graphicPathEditPoints, quadraticArrowGeometry, planNativeArtVisual } from "@chemdraft/art-engine";
import { createNativeArtLineGraphicObject, createNativeSingleBondMolecule, createPhase4Document, groupSelectedDocumentObjects,
  normalizeCommittedDocument, scaleDocumentObjectsAroundPoint, selectDocumentObjects, moveDocumentObjects,
  applyGraphicObjectColorToSelection, applyObjectColorToDocumentObjects, setDocumentCustomPageSize,
  rotateDocumentObjectsAroundPoint, updateNativeTextObjectStyleRange } from "./documentWorkflow";

function fixture() {
  let d=createPhase4Document('Arrow refinement');
  const arrow=createNativeArtLineGraphicObject(d,{x:150,y:300},{x:390,y:300},'tool.art.reactionArrow')!;
  d=applyPatches(d,[{op:'addObject',pageId:d.pages[0].id,object:arrow}]);
  d=attachReactionArrowOffshoot(d,arrow.id,'above');return {d,arrow};
}
const near=(a:{x:number;y:number},b:{x:number;y:number})=>{expect(a.x).toBeCloseTo(b.x,5);expect(a.y).toBeCloseTo(b.y,5);};

describe('screenshot arrow refinements',()=>{
  it.each(['HHHH\nHHHH','HHHH\n\nHHHH'])('uses shared line baselines for normal font-size overrides (%s)',text=>{
    let {d,arrow}=fixture();
    d=setReactionArrowConditions(d,arrow.id,{side:'above',spans:[{text,script:'normal'}]});
    const id=d.pages[0].objects.find(o=>o.type==='text')!.id;
    d=normalizeCommittedDocument(updateNativeTextObjectStyleRange(d,id,{start:0,end:text.length},{fontSizePx:48}));
    const label=d.pages[0].objects.find(o=>o.id===id) as TextObject,metrics=nativeTextObjectLineMetrics(label);
    const svg=exportDocumentToSvg(d).contents!,fragment=svg.match(/<text[\s\S]*?<\/text>/)![0];
    const baselines=[...fragment.matchAll(/<tspan x="[^"]+" y="([^"]+)"\s*\/?>/g)].map(match=>Number(match[1]));
    expect(baselines).toHaveLength(metrics.lines.length);
    metrics.lines.forEach((line,i)=>expect(baselines[i]).toBeCloseTo(label.y+line.baseline,3));
    expect(fragment).not.toContain('dy="19.2"');expect(fragment).toContain('font-size="48"');
    expect(label.height).toBeGreaterThanOrEqual(metrics.height);
    expect(normalizeCommittedDocument(d)).toBe(d);
  });
  it('reserves real vertical space between H₂O and Zn²⁺ formatted lines and resets every run baseline',()=>{
    const object={text:'H2O\nZn2+\nSO42-',style:{fontSizePx:16,lineHeight:1.05},spans:[
      {text:'H',script:'normal' as const,style:{}},{text:'2',script:'subscript' as const,style:{}},
      {text:'O\nZn',script:'normal' as const,style:{}},{text:'2+',script:'superscript' as const,style:{}},
      {text:'\nSO',script:'normal' as const,style:{}},{text:'4',script:'subscript' as const,style:{}},{text:'2-',script:'superscript' as const,style:{}}]};
    const layout=nativeTextObjectLineMetrics(object),size=nativeFormattedTextObjectSize(object);
    expect(layout.lines).toHaveLength(3);
    for(let i=1;i<layout.lines.length;i++) {
      const a=layout.lines[i-1],b=layout.lines[i];
      expect(b.baseline-b.ascent-(a.baseline+a.descent)).toBeGreaterThanOrEqual(16*.18-1e-7);
    }
    expect(size.height).toBeGreaterThanOrEqual(layout.height);
    expect(nativeTextSpanMetrics(object.spans[1],object.style).offset).toBeGreaterThan(0);
    expect(nativeTextSpanMetrics(object.spans[3],object.style).offset).toBeLessThan(0);
  });
  function cycleBranch() {
    let d=setDocumentCustomPageSize(createPhase4Document('Upper-right cycle arrow'),{width:1600,height:1200,unit:'css-px'});
    const base=createNativeArtLineGraphicObject(d,{x:500,y:180},{x:850,y:500},'tool.art.reactionArrow')!;
    const parent=quadraticArrowGeometry(base,{x:500,y:180},{x:850,y:500},{x:750,y:270});
    d=applyPatches(d,[{op:'addObject',pageId:d.pages[0].id,object:parent}]);
    d=attachReactionArrowOffshoot(d,parent.id,'above');
    return {d,parent,branch:d.pages[0].objects[1] as GraphicObject};
  }
  it.each([false,true])('settles nested conditions in one pass after ancestor transforms and reversed object order (manual=%s)',manual=>{
    let {d,parent,branch}=cycleBranch();
    d=attachReactionArrowOffshoot(d,branch.id,'below');const nested=d.pages[0].objects.at(-1)!;
    d=setReactionArrowConditions(d,nested.id,{side:'below',spans:[{text:'THF',script:'normal'}]});
    if(manual)d=normalizeCommittedDocument(moveDocumentObjects(d,[d.pages[0].objects.at(-1)!.id],35,-20));
    d=applyPatches(d,[{op:'setObjectOrder',pageId:d.pages[0].id,objectIds:d.pages[0].objects.map(o=>o.id).reverse()}]);
    const scaled=scaleDocumentObjectsAroundPoint(d,[parent.id],{x:750,y:350},1.2,.8);
    const edited=rotateDocumentObjectsAroundPoint(scaled,[parent.id],{x:750,y:350},90);
    const once=normalizeCommittedDocument(edited);
    expect(normalizeCommittedDocument(once)).toBe(once);
    expect(resolveArrowAttachments(edited.pages[0]).objects).toEqual(once.pages[0].objects);
    expect(exportDocumentToSvg(edited).contents).toBe(exportDocumentToSvg(once).contents);
  });
  it('places default offshoot conditions on the free exterior and keeps explicit Below stable across toggles',()=>{
    const {d:source,branch}=cycleBranch();
    expect(reactionConditionsDraft(source,branch.id).side).toBe('above');
    const frame=reactionConditionsFrame(source.pages[0],branch)!,raw=arrowAttachmentFrame(source.pages[0],branch)!;
    expect(frame.normal.x*raw.normal.x+frame.normal.y*raw.normal.y).toBeLessThan(-.99);
    let d=source;
    for(const side of ['above','below','above','below'] as const) {
      d=normalizeCommittedDocument(setReactionArrowConditions(d,branch.id,{side,spans:[{text:'THF, 2 h',script:'normal'}]}));
      const label=d.pages[0].objects.find((o):o is TextObject=>o.type==='text')!;
      expect(label.arrowAttachment?.parentObjectId).toBe(branch.id);
      const signed=(label.x+label.width/2-frame.origin.x)*frame.normal.x+(label.y+label.height/2-frame.origin.y)*frame.normal.y;
      expect(side==='above'?signed:-signed).toBeGreaterThan(12);
      expect(side==='above'?label.y+label.height/2<frame.origin.y:label.y+label.height/2>frame.origin.y).toBe(true);
      expect(normalizeCommittedDocument(d)).toBe(d);
      for(const arrow of d.pages[0].objects.filter((o):o is GraphicObject=>o.type==='graphic')) {
        const points=graphicOpenStrokePageSamplePoints(arrow);
        expect(points.slice(1).some((point,i)=>artObstacleIntersectsBounds({outline:[points[i],point]},label,6))).toBe(false);
      }
    }
  });
  it.each(['move','rotate','scale'] as const)('keeps offshoot conditions outside after parent %s',transform=>{
    let {d,parent,branch}=cycleBranch();
    d=setReactionArrowConditions(d,branch.id,{side:'above',spans:[{text:'THF',script:'normal'}]});
    const pivot={x:750,y:350};
    d=normalizeCommittedDocument(transform==='move'?moveDocumentObjects(d,[parent.id],80,90):
      transform==='rotate'?rotateDocumentObjectsAroundPoint(d,[parent.id],pivot,75):scaleDocumentObjectsAroundPoint(d,[parent.id],pivot,1.4,.8));
    const nextBranch=d.pages[0].objects.find(o=>o.id===branch.id)!;
    const frame=reactionConditionsFrame(d.pages[0],nextBranch)!,label=d.pages[0].objects.find((o):o is TextObject=>o.type==='text')!;
    const signed=(label.x+label.width/2-frame.origin.x)*frame.normal.x+(label.y+label.height/2-frame.origin.y)*frame.normal.y;
    expect(signed).toBeGreaterThan(12);expect(normalizeCommittedDocument(d)).toBe(d);
  });
  it('preserves saved manual conditions when correcting an offshoot normal',()=>{
    let {d,branch}=cycleBranch();
    d=setReactionArrowConditions(d,branch.id,{side:'above',spans:[{text:'THF',script:'normal'}]});
    d=normalizeCommittedDocument(moveDocumentObjects(d,[d.pages[0].objects.at(-1)!.id],35,-20));
    const label=d.pages[0].objects.at(-1)! as TextObject,oldFrame=arrowAttachmentFrame(d.pages[0],branch)!;
    const center={x:label.x+label.width/2,y:label.y+label.height/2};
    if(label.arrowAttachment?.kind!=='conditions')throw new Error('fixture');
    d=applyPatches(d,[{op:'updateObject',objectId:label.id,changes:{arrowAttachment:{...label.arrowAttachment,frame:oldFrame,
      offset:{x:(center.x-oldFrame.origin.x)*oldFrame.tangent.x+(center.y-oldFrame.origin.y)*oldFrame.tangent.y,
        y:(center.x-oldFrame.origin.x)*oldFrame.normal.x+(center.y-oldFrame.origin.y)*oldFrame.normal.y},placement:'manual'}}}]);
    const normalized=normalizeCommittedDocument(d),next=normalized.pages[0].objects.find(o=>o.id===label.id)!;
    near(next,label);expect(normalizeCommittedDocument(normalized)).toBe(normalized);
  });
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
    const withConditions=setReactionArrowConditions(d,branches[1].id,{side:'below',spans:[{text:'THF, 2 h',script:'normal'}]});
    expect(withConditions.pages[0].objects.at(-1)!.arrowAttachment?.parentObjectId).toBe(branches[1].id);
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
  it('lengthens a route past the empty corner of a diagonal molecule frame',()=>{
    const d=createPhase4Document(),base=createNativeSingleBondMolecule(d,{x:200,y:200});
    const molecule={...base,x:200,y:200,width:120,height:120,atoms:base.atoms.map((a,i)=>({...a,x:200+i*120,y:200+i*120}))};
    const source={id:'source',bounds:{x:200,y:200,width:120,height:120},anchor:{x:260,y:260},dx:0,dy:0};
    const target={id:'target',bounds:{x:500,y:240,width:40,height:40},anchor:{x:520,y:260},dx:0,dy:0};
    const plan={ok:true as const,bounds:{x:200,y:200,width:340,height:120},placements:[source,target]};
    const draft={...defaultArrangementDraft,layout:'row' as const,arrows:true};
    const old=planArrangementConnections(plan,draft);
    const tight=planArrangementConnections({...plan,placements:[{...source,outlines:[moleculeOutlineForArrangement(molecule)]},target]},draft);
    if(!old.ok||!tight.ok)throw new Error('fixture route refused');
    expect(old.connections[0].start.x-tight.connections[0].start.x).toBeGreaterThan(35);
    expect(JSON.stringify(molecule.atoms)).toBe(JSON.stringify(base.atoms.map((a,i)=>({...a,x:200+i*120,y:200+i*120}))));
  });
  it('places formatted conditions clear of a vertical curved shaft and its offshoot, preserving a manual drag',()=>{
    let {d,arrow}=fixture();
    d=applyPatches(d,[{op:'removeObject',objectId:d.pages[0].objects[1].id},{op:'updateObject',objectId:arrow.id,
      changes:quadraticArrowGeometry(arrow,{x:610,y:160},{x:590,y:480},{x:630,y:320})}]);
    d=attachReactionArrowOffshoot(d,arrow.id,'above');
    d=setReactionArrowConditions(d,arrow.id,{side:'above',spans:[{text:'K',script:'normal'},{text:'2',script:'subscript'},{text:'CO₃, THF\n80 °C, 2 h\n85% yield',script:'normal'}]});
    const label=d.pages[0].objects.find((o):o is TextObject=>o.type==='text')!;
    expect(label.arrowAttachment?.kind==='conditions' && label.arrowAttachment.placement).toBe('auto');
    expect(label.x+label.width).toBeLessThan(d.pages[0].width);
    for(const obj of d.pages[0].objects.filter((o):o is GraphicObject=>o.type==='graphic')) {
      const points=graphicOpenStrokePageSamplePoints(obj);
      expect(points.slice(1).some((p,i)=>artObstacleIntersectsBounds({outline:[points[i],p]},label,6))).toBe(false);
    }
    const moved=normalizeCommittedDocument(moveDocumentObjects(d,[label.id],0,-25));
    const manual=moved.pages[0].objects.find(o=>o.id===label.id)!;
    expect(manual.arrowAttachment?.kind==='conditions' && manual.arrowAttachment.placement).toBe('manual');
    const parentMoved=normalizeCommittedDocument(moveDocumentObjects(moved,[arrow.id],-30,20));
    const next=parentMoved.pages[0].objects.find(o=>o.id===label.id)!;
    near(next,{x:manual.x-30,y:manual.y+20});
  });
  it('measures authored lines and script sizes without pretending SVG text wraps at 400 pixels',()=>{
    const base={style:{fontSizePx:16},text:'ABCDEFGHIJKLMNO',spans:[{text:'ABCDEFGHIJKLMNO',script:'normal' as const,style:{}}]};
    const normal=nativeFormattedTextObjectSize(base),small=nativeFormattedTextObjectSize({...base,spans:[{...base.spans[0],script:'subscript'}]});
    expect(small.width).toBeLessThan(normal.width);
    const long={...base,text:'M'.repeat(60),spans:[{...base.spans[0],text:'M'.repeat(60)}]};
    expect(nativeFormattedTextObjectSize(long).width).toBeGreaterThan(400);
  });
});
