import { describe, expect, it } from "vitest";
import type { ChemDraftDocument, GraphicObject } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { aimNativeOrbitalPlacement, createNativeArtGraphicObject, createNativeSavePayload,
  createPhase4Document, insertNativeArtGraphicObject, insertNativeSingleBondMolecule,
  nativeOrbitalAnchorPoint, openNativeDocument, rotateDocumentObject } from "./documentWorkflow";
const graphics = (doc: ChemDraftDocument) => doc.pages[0].objects.filter((o): o is GraphicObject => o.type === "graphic");
const expectNode = (object: GraphicObject, point: {x:number;y:number}) => {
  const actual = nativeOrbitalAnchorPoint(object)!; expect(actual.x).toBeCloseTo(point.x, 7); expect(actual.y).toBeCloseTo(point.y, 7);
};
describe("orbital nodes and overlapping axes", () => {
  it("makes a visible three-axis cluster at one exact centre and round-trips it", () => {
    const node = {x:320,y:300}; let doc = createPhase4Document("Shared orbital centre");
    for (let i=0;i<3;i++) doc=insertNativeArtGraphicObject(doc,{x:node.x+2,y:node.y-1},"tool.pOrbital");
    const cluster=graphics(doc); expect(cluster).toHaveLength(3);
    cluster.forEach(o=>expectNode(o,{x:322,y:299}));
    expect(new Set(cluster.map(o=>o.rotation % 180)).size).toBe(3);
    expect(openNativeDocument(createNativeSavePayload(doc).contents).document).toEqual(doc);
    expect(exportDocumentToSvg(doc).contents).toContain("<path");
  });
  it.each(["tool.lobe","tool.shadedLobe"])("places %s from its pointed end, including near page edges", tool => {
    const node={x:5,y:8}; const first=insertNativeArtGraphicObject(createPhase4Document("Lobes"),node,tool);
    const rotated=rotateDocumentObject(first,first.selection.objectIds[0],37.25);
    const pair=insertNativeArtGraphicObject(rotated,{x:node.x+4,y:node.y-3},tool);
    graphics(pair).forEach(o=>expectNode(o,node)); expect(graphics(pair)[0]).toEqual(graphics(rotated)[0]);
    expect((graphics(pair)[1].rotation-graphics(pair)[0].rotation+360)%360).toBeCloseTo(180,7);
  });
  it("uses an unoccupied axis when several orbitals share a molecule atom", () => {
    let doc=insertNativeSingleBondMolecule(createPhase4Document("On atom"),{x:320,y:300});
    const molecule=doc.pages[0].objects.find(o=>o.type==="molecule")!;
    if(molecule.type!=="molecule") throw Error("Expected molecule"); const node=molecule.atoms[0];
    for(let i=0;i<3;i++)doc=insertNativeArtGraphicObject(doc,node,"tool.pOrbital");
    graphics(doc).forEach(o=>expectNode(o,node)); expect(new Set(graphics(doc).map(o=>o.rotation%180)).size).toBe(3);
    expect(doc.pages[0].objects.find(o=>o.id===molecule.id)).toEqual(molecule);
  });
  it("keeps s orbitals centred on atoms", () => {
    const doc=insertNativeSingleBondMolecule(createPhase4Document("s on atom"),{x:320,y:300});
    const molecule=doc.pages[0].objects.find(o=>o.type==="molecule")!;
    if(molecule.type!=="molecule") throw Error("Expected molecule"); const node=molecule.atoms[0];
    expectNode(createNativeArtGraphicObject(doc,node,"tool.sOrbital")!,node);
  });
  it("aims an orbital to an exact angle without changing its dimensions or node", () => {
    const node={x:320,y:300};const doc=insertNativeArtGraphicObject(createPhase4Document("Aim"),node,"tool.pOrbital");
    const point={x:node.x+100*Math.cos(-1.2),y:node.y+100*Math.sin(-1.2)};
    const result=aimNativeOrbitalPlacement(doc,doc.selection.objectIds[0],point);
    expectNode(graphics(result)[0],node); expect(graphics(result)[0].rotation).toBeCloseTo(90-1.2*180/Math.PI,3);
    expect(graphics(result)[0].width).toBe(graphics(doc)[0].width);expect(graphics(result)[0].height).toBe(graphics(doc)[0].height);
  });
});
