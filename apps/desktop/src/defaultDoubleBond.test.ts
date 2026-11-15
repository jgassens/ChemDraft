import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";
import { moleculeSmiles } from "@chemdraft/document-workflow-core";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import {
  applyFreeformSingleBondToolAtPoint, applyNativeAtomElementTarget, applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeBondOrderValueTarget, applySingleBondToolAtPoint, copyAsMolfile,
  createNativeMolfileMolecule, createNativeSavePayload, createNativeTemplateMolecule,
  createPhase4Document, createSelectionClipboardPayload, getSelectedMolecule, insertSmilesMolecule,
  nativeAtomSproutHotkeyTarget, nativeSingleBondHotkeyAtAtomTarget, openNativeDocument,
  pasteSelectionClipboardPayload, type NativeBondOrderTarget
} from "./documentWorkflow";
import { nativeOxoHotkeyTarget } from "./sproutHotkeys";
import { saveDrawingSettings, type DefaultDoubleBond } from "./drawingSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

beforeAll(() => installNodeRdkitModuleLoader());
beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));
afterEach(() => vi.unstubAllGlobals());

const molecule = (document: ChemDraftDocument) => getSelectedMolecule(document)!;
const seed = () => applySingleBondToolAtPoint(createPhase4Document("Double bond default"), { x: 300, y: 300 });
const atomTarget = (graph: MoleculeObject, index = 1) => ({
  objectId: graph.id, kind: "atom" as const, atomId: graph.atoms[index].id, distanceToPointer: 0
});
const bondTarget = (graph: MoleculeObject, bond = graph.bonds[0]): NativeBondOrderTarget => ({
  objectId: graph.id, kind: "bond", bondId: bond.id,
  fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0
});
const canonical = (graph: MoleculeObject) => moleculeSmiles(graph, 0, [], computeStructureIdentifiers);

function grow(document: ChemDraftDocument, bondOrder: "single" | "double" = "double") {
  const graph = molecule(document), source = graph.atoms[1];
  return applyFreeformSingleBondToolAtPoint(document, graph.id, source.id,
    { x: source.x + 40, y: source.y + 20 }, { bondOrder });
}

describe.each(["offset", "centred"] as const)("new double bonds with %s preference", preference => {
  beforeEach(() => saveDrawingSettings({ defaultDoubleBond: preference }));

  function expectNewDouble(bond: MoleculeBond, offsetSide?: "left" | "right") {
    expect(bond.order).toBe("double");
    expect(bond.display?.doubleBondSide).toBe(preference === "centred" ? "center" : offsetSide);
  }

  it("applies to empty-page drawing while keeping the previous Offset value", () => {
    const next = applySingleBondToolAtPoint(createPhase4Document(), { x: 300, y: 300 }, { bondOrder: "double" });
    expectNewDouble(molecule(next).bonds[0]);
    expect(molecule(next).structure).toBe("C=C");
  });

  it("applies to click growth, freeform growth and order cycling, preserving old atoms and bonds", () => {
    const document = seed(), graph = molecule(document);
    const singleGrowth = grow(document, "single"), singleGraph = molecule(singleGrowth);
    saveDrawingSettings({ defaultDoubleBond: "offset" });
    const baseline = molecule(grow(document));
    const offsetSide = baseline.bonds[1].display?.doubleBondSide as "left" | "right";
    expect(["left", "right"]).toContain(offsetSide);
    saveDrawingSettings({ defaultDoubleBond: preference });
    const cycled = applyNativeMoleculeBondOrderTarget(singleGrowth, bondTarget(singleGraph, singleGraph.bonds[1]));
    const hovered = applyNativeMoleculeBondOrderValueTarget(singleGrowth, bondTarget(singleGraph, singleGraph.bonds[1]), "double");
    for (const next of [grow(document), cycled, hovered]) {
      expectNewDouble(molecule(next).bonds[1], offsetSide);
      expect(molecule(next).bonds[0]).toEqual(graph.bonds[0]);
      expect(molecule(next).atoms.slice(0, 2)).toEqual(graph.atoms);
    }
    const click = applySingleBondToolAtPoint(document, graph.atoms[1], { bondOrder: "double" });
    expect(molecule(click).bonds.at(-1)?.display?.doubleBondSide === "center").toBe(preference === "centred");
  });

  it.each(["C", "S", "P"])("applies to hover key 2 oxygen creation at %s", element => {
    let document = seed();
    const target = atomTarget(molecule(document), 0);
    if (element === "S") document = nativeSingleBondHotkeyAtAtomTarget(document, target).document;
    if (element === "P") document = nativeAtomSproutHotkeyTarget(document, target, "gemDimethyl").document;
    if (element !== "C") document = applyNativeAtomElementTarget(document, target, element);
    const before = molecule(document);
    const result = nativeOxoHotkeyTarget(document, target);
    expect(result.refusal).toBeUndefined();
    const after = molecule(result.document);
    expect(after.atoms.at(-1)?.element).toBe("O");
    expect(after.bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
    expect(after.bonds.at(-1)?.order).toBe("double");
    if (preference === "centred") expect(after.bonds.at(-1)?.display?.doubleBondSide).toBe("center");
  });
});

it("changes only display: canonical SMILES, formula, charges, counts and coordinates match", async () => {
  const document = seed();
  const results = (["offset", "centred"] as DefaultDoubleBond[]).map(defaultDoubleBond => {
    saveDrawingSettings({ defaultDoubleBond });
    return molecule(grow(document));
  });
  expect(await canonical(results[1])).toBe(await canonical(results[0]));
  expect(results[1].chemistry).toEqual(results[0].chemistry);
  expect(results[1].atoms).toEqual(results[0].atoms);
  expect(results[1].bonds.map(({ display: _display, ...bond }) => bond))
    .toEqual(results[0].bonds.map(({ display: _display, ...bond }) => bond));
});

it("does not rewrite existing bonds on a preference change, drawing another bond, or save/open", () => {
  const document = grow(seed()), before = molecule(document);
  const saved = createNativeSavePayload(document).contents;
  saveDrawingSettings({ defaultDoubleBond: "centred" });
  expect(openNativeDocument(saved).document).toEqual(document);
  const atom = before.atoms.at(-1)!;
  const next = applyFreeformSingleBondToolAtPoint(document, before.id, atom.id,
    { x: atom.x + 40, y: atom.y + 20 }, { bondOrder: "double" });
  expect(molecule(next).bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
  expect(molecule(next).bonds.at(-1)?.display?.doubleBondSide).toBe("center");
  expect(molecule(document)).toEqual(before);
});

it("does not apply the drawing default when clearing stereo on an existing double bond", () => {
  const document = structuredClone(applySingleBondToolAtPoint(createPhase4Document(), { x: 300, y: 300 }, { bondOrder: "double" }));
  const graph = molecule(document);
  graph.bonds[0].stereo = "either";
  const results = (["offset", "centred"] as DefaultDoubleBond[]).map(defaultDoubleBond => {
    saveDrawingSettings({ defaultDoubleBond });
    return applyNativeMoleculeBondOrderValueTarget(document, bondTarget(graph), "double");
  });
  expect(results[1]).toEqual(results[0]);
});

it.each([false, true])("applies the preference to connections (separate molecules: %s) and leaves previous bonds intact", separate => {
  const first = seed();
  const document = separate
    ? applySingleBondToolAtPoint(first, { x: 500, y: 300 })
    : grow(first, "single");
  const source = molecule(document);
  const targetGraph = separate ? document.pages[0].objects[0] as MoleculeObject : source;
  const target = targetGraph.atoms[0];
  const results = (["offset", "centred"] as DefaultDoubleBond[]).map(defaultDoubleBond => {
    saveDrawingSettings({ defaultDoubleBond });
    return molecule(applyFreeformSingleBondToolAtPoint(document, source.id, source.atoms.at(-1)!.id, target, { bondOrder: "double" }));
  });
  expect(results[1].bonds.at(-1)).toMatchObject({ order: "double", display: { doubleBondSide: "center" } });
  expect(results[1].bonds.slice(0, source.bonds.length)).toEqual(source.bonds);
  expect(results[1].atoms).toEqual(results[0].atoms);
  expect(results[1].structure).toEqual(results[0].structure);
});

it("keeps ring/template placements, MOL import, SMILES insertion and native paste independent of the preference", () => {
  const document = grow(seed());
  const payload = createSelectionClipboardPayload(document)!;
  const molfile = copyAsMolfile(document, "v2000")!;
  const base = createPhase4Document();
  const outputs = (["offset", "centred"] as DefaultDoubleBond[]).map(defaultDoubleBond => {
    saveDrawingSettings({ defaultDoubleBond });
    return {
      ring: createNativeTemplateMolecule(base, { x: 300, y: 300 }, "benzene"),
      mol: createNativeMolfileMolecule(base, { x: 300, y: 300 }, molfile, "molfile-v2000"),
      smiles: insertSmilesMolecule(base, { x: 300, y: 300 }, {
        atoms: [{ element: "C", x: 0, y: 0, charge: 0 }, { element: "C", x: 1, y: 0, charge: 0 }],
        bonds: [{ from: 0, to: 1, order: "double", wedge: null }]
      }, "C=C"),
      paste: pasteSelectionClipboardPayload(base, payload, { x: 300, y: 300 })
    };
  });
  expect(outputs[1]).toEqual(outputs[0]);
  expect(outputs[1].ring.bonds.filter(bond => bond.order === "double")
    .every(bond => ["left", "right"].includes(bond.display?.doubleBondSide ?? ""))).toBe(true);
});
