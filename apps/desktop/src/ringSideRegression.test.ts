import { describe, expect, it, vi } from "vitest";
import { exportDocumentToCdx, importCdx, openChemDraftPayload } from "@chemdraft/cdx-compat";
import { applyPatch, deserializeDocument, serializeDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { cleanUpMoleculeSelections2d } from "@chemdraft/document-workflow-core";
import * as layoutEngine from "@chemdraft/layout-engine";
import { planPageSvgRender, type PageSvgElementFragment } from "@chemdraft/layout-engine";
import { assertConstrainedLayoutIdentity, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import {
  applyMoleculeDoubleBondPosition,
  applyNativeMoleculeEngineRelayout,
  cleanUpNativeMolecules2d,
  doubleBondSideForPoint,
  flattenSpunMolecule,
  moveNativeMoleculeParts
} from "./documentWorkflow";
import { quatFromAxisAngle, quatToViewMatrix } from "./interaction/rotation3d";
import { projectSpin, spinJoinedBondFragments } from "./interaction/spinOverlay";

// The ring traversal runs in the opposite direction to Clean Up's regular polygon.
// The second double is listed E-to-B, so its inward offset has the opposite sign.
function importedBenzene(position: "Center" | "Right", format: "CDX" | "CDXML" = "CDXML") {
  const cdxml = `<CDXML><page id="1"><fragment id="2">
    <n id="11" p="100 100"/><n id="12" p="80 110"/><n id="13" p="80 130"/>
    <n id="14" p="100 140"/><n id="15" p="120 130"/><n id="16" p="120 110"/>
    <n id="17" p="100 79"/><n id="18" p="82 68"/><n id="19" p="118 68"/>
    <n id="20" p="62 141"/><n id="21" p="138 141"/>
    <n id="31" p="190 100" Element="8"/><n id="32" p="210 100"/><n id="33" p="221 119"/>
    <b id="41" B="11" E="12" Order="2" DoublePosition="${position}"/>
    <b id="42" B="12" E="13"/>
    <b id="43" B="14" E="13" Order="2" DoublePosition="Left"/>
    <b id="44" B="14" E="15"/>
    <b id="45" B="15" E="16" Order="2" DoublePosition="Right"/>
    <b id="46" B="16" E="11"/>
    <b id="47" B="11" E="17"/><b id="48" B="17" E="18"/><b id="49" B="17" E="19"/>
    <b id="50" B="13" E="20"/><b id="51" B="15" E="21"/>
    <b id="52" B="31" E="32" Order="2" DoublePosition="Right"/><b id="53" B="32" E="33"/>
  </fragment></page></CDXML>`;
  const opened = openChemDraftPayload(cdxml);
  expect(opened.source).toBe("external-cdxml");
  if (format === "CDXML") return opened.document!;
  const binary = importCdx(exportDocumentToCdx(opened.document!, { embedNativePayload: false }).bytes);
  expect(binary.source).toBe("external-cdxml");
  return binary.document!;
}

function importedCyclopropene() {
  const opened = openChemDraftPayload(`<CDXML><page id="1"><fragment id="2">
    <n id="11" p="100 100"/><n id="12" p="120 100"/><n id="13" p="110 120"/>
    <b id="21" B="11" E="12" Order="2" DoublePosition="Left"/>
    <b id="22" B="12" E="13"/><b id="23" B="13" E="11"/>
  </fragment></page></CDXML>`);
  expect(opened.source).toBe("external-cdxml");
  return opened.document!;
}

function molecule(document: ChemDraftDocument): MoleculeObject {
  const object = document.pages[0]!.objects[0];
  if (object?.type !== "molecule") throw new Error("Expected imported molecule");
  return object;
}

function chemistry(object: MoleculeObject) {
  return {
    atoms: object.atoms.map(({ x: _x, y: _y, z: _z, ...atom }) => atom),
    bonds: object.bonds.map(({ display: _display, ...bond }) => bond)
  };
}

function expectSecondaryStrokeTowardCenter(
  object: MoleculeObject, fragments: readonly PageSvgElementFragment[], centered = false
) {
  const ringAtoms = object.atoms.slice(0, 6);
  const ringIds = new Set(ringAtoms.map(atom => atom.id));
  const doubles = object.bonds.filter(bond =>
    bond.order === "double" && ringIds.has(bond.fromAtomId) && ringIds.has(bond.toAtomId));
  expect(doubles).toHaveLength(3);
  const center = ringAtoms.reduce((sum, atom) => ({
    x: sum.x + atom.x / ringAtoms.length, y: sum.y + atom.y / ringAtoms.length
  }), { x: 0, y: 0 });
  const layers = new Map<string, PageSvgElementFragment>();
  function collect(fragment: PageSvgElementFragment) {
    const id = fragment.attrs["data-bond-layer-id"];
    if (typeof id === "string") layers.set(id, fragment);
    for (const child of fragment.children) if (child.kind === "element") collect(child);
  }
  fragments.forEach(collect);
  for (const [index, bond] of doubles.entries()) {
    const layer = layers.get(bond.id)!;
    const strokes = layer.children.filter(child => child.kind === "element" && child.tag === "line" &&
      child.attrs["data-bond-segment"] === "secondary" && child.attrs["data-bond-order"] === "double");
    expect(strokes, bond.id).toHaveLength(1);
    const stroke = strokes[0] as PageSvgElementFragment;
    if (centered && index === 0) {
      expect(stroke.attrs["data-double-bond-side"]).toBe("center");
      continue;
    }
    const from = ringAtoms.find(atom => atom.id === bond.fromAtomId)!;
    const to = ringAtoms.find(atom => atom.id === bond.toAtomId)!;
    const side = (x: number, y: number) => (to.x - from.x) * (y - from.y) - (to.y - from.y) * (x - from.x);
    const midpointX = (Number(stroke.attrs.x1) + Number(stroke.attrs.x2)) / 2;
    const midpointY = (Number(stroke.attrs.y1) + Number(stroke.attrs.y2)) / 2;
    expect(stroke.attrs["data-double-bond-side"], bond.id).not.toBe("center");
    expect(side(midpointX, midpointY) * side(center.x, center.y), bond.id).toBeGreaterThan(0);
  }
}

function canvasFragments(document: ChemDraftDocument) {
  return planPageSvgRender(document.pages[0]!).fragments.filter(fragment => fragment.kind === "element");
}

function spin(document: ChemDraftDocument, checkOverlay = false) {
  const object = molecule(document);
  const coords = object.atoms.flatMap(atom => [atom.x / 22, -atom.y / 22, 0]);
  const quat = quatFromAxisAngle([0, 1, 0], Math.PI / 6);
  const placement = { centerX: 350, centerY: 300, scale: 22 };
  if (checkOverlay) {
    const pairs: [number, number][] = object.bonds.map(bond => [
      object.atoms.findIndex(atom => atom.id === bond.fromAtomId),
      object.atoms.findIndex(atom => atom.id === bond.toAtomId)
    ]);
    const projection = projectSpin(coords, pairs, quat, placement);
    const projected = { ...object, atoms: object.atoms.map((atom, index) => ({
      ...atom, x: projection.atoms[index]!.sx, y: projection.atoms[index]!.sy
    })) };
    expectSecondaryStrokeTowardCenter(projected, spinJoinedBondFragments(object, projection, []));
  }
  const result = flattenSpunMolecule(document, object.id, coords, quatToViewMatrix(quat), { placement });
  expect(result.status, result.refusalReasons.join(", ")).toBe("committed");
  return result.document;
}

function cleanUp(document: ChemDraftDocument) {
  return cleanUpNativeMolecules2d(document, [molecule(document).id]);
}

function expectInwardUnchangedChemistry(before: ChemDraftDocument, after: ChemDraftDocument) {
  const original = molecule(before), result = molecule(after);
  expect(result.atoms.map(atom => [atom.x, atom.y])).not.toEqual(original.atoms.map(atom => [atom.x, atom.y]));
  expect(chemistry(result)).toEqual(chemistry(original));
  expect(result.bonds.at(-2)!.display?.doubleBondSide).toBe("right");
  expectSecondaryStrokeTowardCenter(result, canvasFragments(after));
}

describe("imported ring double-bond strokes", () => {
  it("uses the ring interior after Spin 3D releases an imported centered double bond", () => {
    const original = importedBenzene("Center");
    expectSecondaryStrokeTowardCenter(molecule(original), canvasFragments(original), true);
    expectInwardUnchangedChemistry(original, spin(original));
    spin(original, true);
  });

  it("revalidates every offset on Clean Up after Spin 3D", () => {
    const original = importedBenzene("Right");
    const flattened = spin(original);
    expectInwardUnchangedChemistry(original, flattened);
    expectInwardUnchangedChemistry(flattened, cleanUp(flattened));
  });

  it.each(["CDXML", "CDX"] as const)("revalidates imported Left and Right offsets on %s Clean Up", format => {
    const original = importedBenzene("Right", format);
    expectSecondaryStrokeTowardCenter(molecule(original), canvasFragments(original));
    expectInwardUnchangedChemistry(original, cleanUp(original));
  });

  it.each([undefined, "imported", "user"] as const)("checks a saved outward offset without moving atoms (source %s)", source => {
    const tidy = cleanUp(importedCyclopropene());
    const object = molecule(tidy);
    const bond = object.bonds[0]!;
    const inside = bond.display?.doubleBondSide;
    expect(inside).toMatch(/^(left|right)$/);
    const outside = inside === "left" ? "right" : "left";
    const saved = applyPatch(tidy, {
      op: "updateObject", objectId: object.id, changes: {
        bonds: [{ ...bond, display: { doubleBondSide: outside, doubleBondSideSource: source } }, ...object.bonds.slice(1)]
      }
    });
    const reopened = deserializeDocument(serializeDocument(saved));
    const repaired = molecule(cleanUp(reopened));
    expect(repaired.atoms).toEqual(molecule(reopened).atoms);
    expect(chemistry(repaired)).toEqual(chemistry(object));
    expect(repaired.bonds[0]!.display?.doubleBondSide).toBe(source === "user" ? outside : inside);
  });

  it("turns the stored offset inward when dragging the third ring atom across the double bond", () => {
    const document = importedCyclopropene();
    const object = molecule(document);
    const [from, to, movedAtom] = object.atoms;
    expect(object.bonds[0]!.display?.doubleBondSide).toBe("left");
    const result = molecule(moveNativeMoleculeParts(document, {
      objectId: object.id, kind: "atom", atomId: movedAtom!.id
    }, { x: 0, y: 2 * (from!.y - movedAtom!.y) }));
    expect(result.atoms.slice(0, 2)).toEqual([from, to]);
    expect(result.atoms[2]!.y).toBeLessThan(from!.y);
    expect(result.bonds[0]!.display?.doubleBondSide).toBe("right");
    expect(chemistry(result)).toEqual(chemistry(object));
  });

  it("delegates offset hit geometry to layout-engine with the desktop Center radius", () => {
    const object = molecule(importedCyclopropene());
    const bond = object.bonds[0]!;
    const [from, to] = object.atoms;
    const x = (from!.x + to!.x) / 2;
    const bondHitRadius = 10;
    const point = { x, y: from!.y - bondHitRadius - 1 };
    const sideTowardPoint = vi.spyOn(layoutEngine, "offsetDoubleBondSideTowardPoint");
    try {
      expect(doubleBondSideForPoint(object, bond, point, { bondHitRadius })).toBe("right");
      expect(sideTowardPoint).toHaveBeenCalledWith(from, to, point, bondHitRadius);
      expect(doubleBondSideForPoint(object, bond, { x, y: from!.y - bondHitRadius }, { bondHitRadius })).toBe("center");
    } finally {
      sideTowardPoint.mockRestore();
    }
  });

  it("revalidates imported Center in the engine Clean Up path", () => {
    const document = importedBenzene("Center");
    const result = applyNativeMoleculeEngineRelayout(document, molecule(document).id, relayoutMolfile2D);
    expectInwardUnchangedChemistry(document, result);
  });

  it("revalidates imported Center in Clean Up Selection after a native save and reopen", () => {
    const document = deserializeDocument(serializeDocument(importedBenzene("Center")));
    const object = molecule(document);
    const result = cleanUpMoleculeSelections2d(document, [{
      objectId: object.id, atomIds: object.atoms.slice(0, 11).map(atom => atom.id), bondIds: []
    }], { relayout: relayoutMolfile2D, assertIdentity: assertConstrainedLayoutIdentity });
    expectInwardUnchangedChemistry(document, result);
    expect(molecule(result).atoms.slice(11)).toEqual(object.atoms.slice(11));
  });

  it("retains imported Center when Clean Up Selection moves only the other fragment", () => {
    const document = importedBenzene("Center");
    const object = molecule(document);
    const result = cleanUpMoleculeSelections2d(document, [{
      objectId: object.id, atomIds: object.atoms.slice(11).map(atom => atom.id), bondIds: []
    }], { relayout: relayoutMolfile2D, assertIdentity: assertConstrainedLayoutIdentity });
    expect(molecule(result).atoms.slice(11)).not.toEqual(object.atoms.slice(11));
    expect(molecule(result).atoms.slice(0, 11)).toEqual(object.atoms.slice(0, 11));
    expectSecondaryStrokeTowardCenter(molecule(result), canvasFragments(result), true);
  });

  it("keeps Center when the user explicitly chooses it in ChemDraft", () => {
    const document = importedBenzene("Center");
    const object = molecule(document);
    const authored = applyMoleculeDoubleBondPosition(document, [{ objectId: object.id, bondId: object.bonds[0]!.id }], "center");
    const result = spin(authored);
    expectSecondaryStrokeTowardCenter(molecule(result), canvasFragments(result), true);
  });
});
