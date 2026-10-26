import { expect, it } from 'vitest';
import { applyPatches, type ChemDraftDocument } from '@chemdraft/chem-core';
import { defaultArrangementDraft } from '@chemdraft/layout-engine';
import { graphicPathEditPoints } from '@chemdraft/art-engine';
import { attachReactionArrowOffshoot, setReactionArrowConditions } from '@chemdraft/document-workflow-core';
import { createNativeArtLineGraphicObject, normalizeCommittedDocument, rotateDocumentObjectsAroundPoint,
  duplicateSelectedDocumentObjects, createSelectionClipboardPayload, pasteSelectionClipboardPayload } from './documentWorkflow';
import { arrangeSelectedDocumentObjectsWithOptions, createNativeSingleBondMolecule, createPhase4Document, selectDocumentObjects, selectedArrangementDraft, setDocumentCustomPageSize } from './documentWorkflow';

function add(d: ChemDraftDocument, x: number, y: number) {
  return applyPatches(d, [{op:'addObject', pageId:d.pages[0].id, object:createNativeSingleBondMolecule(d,{x,y})}]);
}
function selected(d: ChemDraftDocument, ids: string[]) { return selectDocumentObjects(d,d.pages[0].id,ids); }
function fixture() {
  let d=setDocumentCustomPageSize(createPhase4Document('Independent audit'),{width:1800,height:1400,unit:'css-px'});
  d=add(d,300,300); d=add(d,500,300);
  return selected(d,d.pages[0].objects.map(o=>o.id));
}
const row={...defaultArrangementDraft,layout:'row' as const,arrows:true};

it('audit: adding a compound to a saved arrangement includes it in the selected row',()=>{
  let d=arrangeSelectedDocumentObjectsWithOptions(fixture(),row).document;
  d=add(d,900,700);
  d=selected(d,d.pages[0].objects.filter(o=>o.type==='molecule').map(o=>o.id));
  const result=arrangeSelectedDocumentObjectsWithOptions(d,selectedArrangementDraft(d));
  expect(result.ok,result.status).toBe(true);
  expect(result.document.pages[0].objects.filter(o=>o.arrangementConnection)).toHaveLength(2);
});

it('audit: a common 100 percent slider value updates a second independently shortened arrangement',()=>{
  let d=arrangeSelectedDocumentObjectsWithOptions(fixture(),row).document;
  const firstIds=d.pages[0].objects.filter(o=>o.type==='molecule').map(o=>o.id);
  d=add(d,300,900);d=add(d,500,900);
  const secondIds=d.pages[0].objects.filter(o=>o.type==='molecule'&&!firstIds.includes(o.id)).map(o=>o.id);
  let result=arrangeSelectedDocumentObjectsWithOptions(selected(d,secondIds),{...row,arrowLength:30});
  expect(result.ok,result.status).toBe(true); d=result.document;
  const secondArrow=d.pages[0].objects.find(o=>o.arrangementConnection?.fromObjectId===secondIds[0])!;
  const before=graphicPathEditPoints(secondArrow as import('@chemdraft/chem-core').GraphicObject)!;
  d=selected(d,[...firstIds,...secondIds]);
  result=arrangeSelectedDocumentObjectsWithOptions(d,{...selectedArrangementDraft(d),arrowLength:100});
  expect(result.ok,result.status).toBe(true);
  const after=result.document.pages[0].objects.find(o=>o.id===secondArrow.id)!;
  expect(after.arrangementConnection?.settings?.arrowLength).toBe(100);
  expect(graphicPathEditPoints(after as import('@chemdraft/chem-core').GraphicObject)).not.toEqual(before);
});

it('audit: nested condition orientation settles after one normalization of a rotated ancestor',()=>{
  let d=setDocumentCustomPageSize(createPhase4Document('Nested audit'),{width:1800,height:1400,unit:'css-px'});
  const root=createNativeArtLineGraphicObject(d,{x:500,y:600},{x:900,y:600},'tool.art.reactionArrow')!;
  d=applyPatches(d,[{op:'addObject',pageId:d.pages[0].id,object:root}]);
  d=attachReactionArrowOffshoot(d,root.id,'above');
  const branch=d.pages[0].objects.at(-1)!;
  d=attachReactionArrowOffshoot(d,branch.id,'above');
  const nested=d.pages[0].objects.at(-1)!;
  d=setReactionArrowConditions(d,nested.id,{side:'above',spans:[{text:'THF',script:'normal'}]});
  for (const rotation of [90,180,270]) {
    const edited=rotateDocumentObjectsAroundPoint(d,[root.id],{x:700,y:600},rotation);
    const once=normalizeCommittedDocument(edited);
    expect(normalizeCommittedDocument(once).pages[0].objects).toEqual(once.pages[0].objects);
  }
});

it('audit control: removing generated connections removes nested descendants and keeps handdrawn art and chemistry',()=>{
  let d=arrangeSelectedDocumentObjectsWithOptions(fixture(),row).document;
  const generated=d.pages[0].objects.find(o=>o.arrangementConnection)!;
  d=attachReactionArrowOffshoot(d,generated.id,'above');
  const branch=d.pages[0].objects.at(-1)!;
  d=attachReactionArrowOffshoot(d,branch.id,'below');
  d=setReactionArrowConditions(d,branch.id,{side:'above',spans:[{text:'THF',script:'normal'}]});
  const unrelated=createNativeArtLineGraphicObject(d,{x:100,y:100},{x:300,y:100},'tool.art.reactionArrow')!;
  d=applyPatches(d,[{op:'addObject',pageId:d.pages[0].id,object:unrelated}]);
  const molecules=d.pages[0].objects.filter(o=>o.type==='molecule');
  d=selected(d,molecules.map(o=>o.id));
  const result=arrangeSelectedDocumentObjectsWithOptions(d,{...selectedArrangementDraft(d),arrows:false});
  expect(result.ok,result.status).toBe(true);
  expect(result.document.pages[0].objects.filter(o=>o.arrowAttachment||o.arrangementConnection)).toHaveLength(0);
  expect(result.document.pages[0].objects.filter(o=>o.type==='molecule')).toEqual(molecules);
  expect(result.document.pages[0].objects.find(o=>o.id===unrelated.id)).toEqual(unrelated);
});

it('audit control: duplicate and paste only an arrow tree detach generated endpoints without contaminating originals',()=>{
  let d=arrangeSelectedDocumentObjectsWithOptions(fixture(),row).document;
  const arrow=d.pages[0].objects.find(o=>o.arrangementConnection)!;
  d=attachReactionArrowOffshoot(d,arrow.id,'above');
  d=selected(d,[arrow.id]);
  const original=d.pages[0].objects,originalIds=new Set(original.map(o=>o.id));
  const payload=createSelectionClipboardPayload(d)!;
  for(const next of [duplicateSelectedDocumentObjects(d),pasteSelectionClipboardPayload(d,payload,{x:800,y:800})]) {
    const cloned=next.pages[0].objects.filter(o=>!originalIds.has(o.id));
    expect(cloned).toHaveLength(2);
    const cloneRoot=cloned.find(o=>!o.arrowAttachment)!;
    expect(cloneRoot.arrangementConnection).toBeUndefined();
    expect(cloned.find(o=>o.arrowAttachment)?.arrowAttachment?.parentObjectId).toBe(cloneRoot.id);
    expect(next.pages[0].objects.filter(o=>originalIds.has(o.id))).toEqual(original);
  }
});
