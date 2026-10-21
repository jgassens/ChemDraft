import {describe,expect,it} from "vitest";
import {applyPatches, type TextObject} from "@chemdraft/chem-core";
import {nativeSingleBondGraphSmiles} from "@chemdraft/document-workflow-core";
import {adjustArrangementSpacing,arrangementSpacingRange,arrangementSpacingPreviewBounds,arrangeSelectedDocumentObjects,
  createPhase4Document,createNativeSingleBondMolecule,selectDocumentObjects,
  createNativeSavePayload,openNativeDocument,setDocumentCustomPageSize} from "./documentWorkflow";
function fixture(layout:"circle"|"oval"|"row"|"column"|"grid") {
  let doc=createPhase4Document("Spacing");
  for(let i=0;i<5;i++) doc=applyPatches(doc,[{op:"addObject",pageId:doc.pages[0].id,
    object:createNativeSingleBondMolecule(doc,{x:230+(i%3)*80,y:260+Math.floor(i/3)*130})}]);
  doc=selectDocumentObjects(doc,doc.pages[0].id,doc.pages[0].objects.map(o=>o.id));
  return arrangeSelectedDocumentObjects(doc,layout,{gap:100}).document;
}
describe("arrangement spacing with fixed molecule sizes",()=>{
  it.each([12.2, 12.3])("matches the integer-spacing oracle for %s-pixel captions at every page edge", thickness => {
    for (const axis of ["horizontal", "vertical"] as const) for (const edge of ["low", "high"] as const) {
      let document = setDocumentCustomPageSize(createPhase4Document("Aligned decimal captions"), {
        width: (axis === "horizontal" ? 1000 : 350) / 96,
        height: (axis === "vertical" ? 1000 : 350) / 96, unit: "inch"
      });
      const position = edge === "low" ? 0 : 350 - thickness;
      const captions: TextObject[] = [100, 300, 500].map((p, i) => ({
        id: `edge-${i}`, type: "text", text: "Caption", spans: [], rotation: 0, style: {},
        x: axis === "horizontal" ? p : position, y: axis === "horizontal" ? position : p,
        width: axis === "horizontal" ? 60 : thickness, height: axis === "horizontal" ? thickness : 60
      }));
      document = applyPatches(document, captions.map(object => ({ op: "addObject" as const, pageId: document.pages[0].id, object })));
      document = selectDocumentObjects(document, document.pages[0].id, captions.map(caption => caption.id));
      // Exercise the same decimal coordinates after a native XML save/reopen.
      document = openNativeDocument(createNativeSavePayload(document).contents).document!;
      const valid = Array.from({ length: 126 }, (_, i) => i + 25).filter(percent => adjustArrangementSpacing(document, percent / 100).ok);
      expect(valid).toEqual(Array.from({ length: 115 }, (_, i) => i + 36));
      expect(arrangementSpacingRange(document)).toEqual({ min: Math.min(...valid) / 100, max: Math.max(...valid) / 100 });
    }
  });
  it("still refuses real page overflow and retains genuine tiny page-axis movement", () => {
    let document = setDocumentCustomPageSize(createPhase4Document("Small real movement"), { width: 1000 / 96, height: 350 / 96, unit: "inch" });
    const captions: TextObject[] = [12.2, 12.2, 12.200002].map((height, i) => ({
      id: `tiny-${i}`, type: "text", text: "Caption", spans: [], rotation: 0, style: {},
      x: 100 + i * 200, y: 350 - height, width: 60, height
    }));
    document = applyPatches(document, captions.map(object => ({ op: "addObject" as const, pageId: document.pages[0].id, object })));
    document = selectDocumentObjects(document, document.pages[0].id, captions.map(caption => caption.id));
    const valid = Array.from({ length: 126 }, (_, i) => i + 25).filter(percent => adjustArrangementSpacing(document, percent / 100).ok);
    const range = arrangementSpacingRange(document);
    expect(range).toEqual({ min: Math.min(...valid) / 100, max: Math.max(...valid) / 100 });
    expect(range.max).toBeLessThan(1.5);expect(adjustArrangementSpacing(document, 1.5).ok).toBe(false);
    const overflow = applyPatches(document, [{ op: "updateObject", objectId: captions[0].id, changes: { y: captions[0].y + 0.001 } }]);
    const result = adjustArrangementSpacing(overflow, 0.9);
    expect(result.ok).toBe(false);expect(result.document).toBe(overflow);
  });
  it.each(["horizontal", "vertical"] as const)("exposes a narrow valid expansion interval for overlapping %s molecules", axis => {
    let document = createPhase4Document("Overlapping compounds");
    const molecules = [8.5, 47.5].map((x, i) => {
      const molecule = createNativeSingleBondMolecule(document, { x: 40, y: 100 });
      const oldX = molecule.x, oldWidth = molecule.width;
      molecule.atoms = molecule.atoms.map(atom => ({ ...atom, x: x + (atom.x - oldX) * 40 / oldWidth }));
      molecule.id = `overlap-${i}`;molecule.x = x;molecule.width = 40;
      if (axis === "vertical") {
        molecule.atoms = molecule.atoms.map(atom => ({ ...atom, x: atom.y, y: atom.x }));
        const { x, y, width, height } = molecule;
        Object.assign(molecule, { x: y, y: x, width: height, height: width });
      }
      return molecule;
    });
    document = applyPatches(document, molecules.map(object => ({ op: "addObject" as const, pageId: document.pages[0].id, object })));
    document = setDocumentCustomPageSize(document, { width: axis === "horizontal" ? 1 : 11, height: axis === "vertical" ? 1 : 11, unit: "inch" });
    document = selectDocumentObjects(document, document.pages[0].id, molecules.map(molecule => molecule.id));
    const range = arrangementSpacingRange(document);
    expect(range).toEqual({ min: 1, max: 1.43 });
    const valid = Array.from({ length: 51 }, (_, i) => i + 100).filter(percent => adjustArrangementSpacing(document, percent / 100).ok);
    expect(valid).toEqual([100, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143]);
    for (const percent of valid) expect(percent / 100).toBeLessThanOrEqual(range.max);
    expect(adjustArrangementSpacing(document, 1.35).ok).toBe(true);
    expect(adjustArrangementSpacing(document, 1.5).ok).toBe(false);
  });
  it.each(["circle","oval","row","column","grid"] as const)("compacts %s by translation with chemistry, sizes preserved",layout=>{
    let before=fixture(layout);
    const range=arrangementSpacingRange(before);expect(range.min).toBeLessThan(1);
    const factor=(1+range.min)/2,result=adjustArrangementSpacing(before,factor);
    expect(result.ok).toBe(true);const after=result.document;
    const a=arrangementSpacingPreviewBounds(before)!,b=arrangementSpacingPreviewBounds(after)!;
    expect(b.width<=a.width && b.height<=a.height).toBe(true);
    expect(b.width<a.width || b.height<a.height).toBe(true);
    expect(after.selection).toEqual(before.selection);
    for(const old of before.pages[0].objects) if(old.type==="molecule") {
      const next=after.pages[0].objects.find(o=>o.id===old.id)!;
      if(next.type!=="molecule") throw new Error("Expected molecule");
      expect(next.width).toBe(old.width);expect(next.height).toBe(old.height);expect(next.rotation).toBe(old.rotation);
      expect(next.style).toEqual(old.style);expect(next.bonds).toEqual(old.bonds);
      expect(nativeSingleBondGraphSmiles(next.atoms,next.bonds)).toBe(nativeSingleBondGraphSmiles(old.atoms,old.bonds));
      const dx=next.atoms[0].x-old.atoms[0].x,dy=next.atoms[0].y-old.atoms[0].y;
      for(let i=0;i<old.atoms.length;i++) expect({...next.atoms[i],x:old.atoms[i].x,y:old.atoms[i].y}).toEqual(old.atoms[i]);
      for(let i=0;i<old.atoms.length;i++) {expect(next.atoms[i].x-old.atoms[i].x).toBeCloseTo(dx);expect(next.atoms[i].y-old.atoms[i].y).toBeCloseTo(dy);}
    }
    const reopened=openNativeDocument(createNativeSavePayload(after).contents).document!;
    expect(reopened).toBeDefined();expect(reopened.pages[0].objects).toEqual(after.pages[0].objects);
  });
  it("refuses overlap/page overflow atomically and leaves unchanged spacing as a no-op",()=>{
    const before=fixture("circle");
    for(const factor of [0.1,5,NaN]) {const result=adjustArrangementSpacing(before,factor);expect(result.ok).toBe(false);expect(result.document).toBe(before);}
    expect(adjustArrangementSpacing(before,1).document).toBe(before);
    const range=arrangementSpacingRange(before);
    expect(adjustArrangementSpacing(before,range.min).ok).toBe(true);
    expect(adjustArrangementSpacing(before,range.max).ok).toBe(true);
  });
});
