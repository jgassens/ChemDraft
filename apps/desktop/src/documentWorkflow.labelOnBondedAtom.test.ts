import { describe, expect, it } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatches, nativeDrawingStyleFromObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeAtomLabelReading, nativeBondOrderResolution } from "@chemdraft/document-workflow-core";
import {
  commitNativeAtomLabelTarget, convertNativeTextObjectToAtomLabel, createPhase4Document,
  insertNativeTemplateMolecule, insertNativeTextObject
} from "./documentWorkflow";

function molecule(d: ReturnType<typeof createPhase4Document>) {
  return d.pages[0].objects.find((o): o is MoleculeObject => o.type === "molecule")!;
}
function setup(template: "benzene" | "cyclohexane" = "cyclohexane") {
  const document = insertNativeTemplateMolecule(createPhase4Document(), { x: 300, y: 300 }, template);
  const m = molecule(document);
  return { document, m, target: { objectId: m.id, kind: "atom" as const, atomId: m.atoms[0]!.id, distanceToPointer: 0 } };
}

/** Test-only expansion from the shared reading/table into OCL. The native writer still warns
 * for unexpanded group labels; this checks the chemical graph the label actually names. */
function canonicalLabelGraph(m: MoleculeObject) {
  const engine = new Molecule(0, 0);
  const add = (element: string, charge = 0) => {
    const i = engine.addAtom(Molecule.getAtomicNoFromLabel(element)); engine.setAtomCharge(i, charge); return i;
  };
  type Definition = { atoms: readonly { element: string; charge?: number }[]; bonds: readonly (readonly [number, number, number])[] };
  function bond(from: number, to: number, order: number) { engine.setBondOrder(engine.addBond(from, to), order); }
  function group(definition: Definition) {
    const indices = definition.atoms.map(a => add(a.element, a.charge));
    for (const [from, to, order] of definition.bonds) bond(indices[from]!, indices[to]!, order);
    return indices[0]!;
  }
  const indices = new Map(m.atoms.map(a => {
    const reading = nativeAtomLabelReading(a.element, { bonded: true }); let head: number;
    if (reading.kind === "group") {
      const g = reading.group;
      if (g.kind === "abbreviation") head = group(g.definition);
      else {
        head = add(g.head, a.formalCharge);
        for (const definition of g.substituents) bond(head, group(definition), 1);
      }
    } else if (reading.kind === "element" || reading.kind === "spelled") head = add(reading.element, a.formalCharge);
    else throw new Error(`Unsupported test label ${a.element}`);
    return [a.id, head] as const;
  }));
  for (const b of nativeBondOrderResolution(m.atoms, m.bonds).bonds) {
    bond(indices.get(b.fromAtomId)!, indices.get(b.toAtomId)!, b.order === "double" ? 2 : b.order === "triple" ? 3 : 1);
  }
  return engine;
}

describe("commitNativeAtomLabelTarget", () => {
  it.each([
    ["benzene", "OMe", "COc1ccccc1", 7],
    ["cyclohexane", "NMe", "CN1CCCCC1", 6],
    ["cyclohexane", "OH", "OC1CCCCC1", 7]
  ] as const)("%s + %s has the expected canonical chemical graph", (template, label, smiles, atomCount) => {
    const { document, target } = setup(template);
    const result = commitNativeAtomLabelTarget(document, target, label, { literal: true });
    const m = molecule(result.document);
    expect(m.atoms).toHaveLength(atomCount); expect(m.bonds).toHaveLength(atomCount);
    const actual = canonicalLabelGraph(m), expected = Molecule.fromSmiles(smiles);
    expect(actual.getIDCode()).toBe(expected.getIDCode());
    expect(actual.getMolecularFormula().formula).toBe(expected.getMolecularFormula().formula);
  });
  it("places at style bond length in the largest gap, retaining every old atom and bond", () => {
    const { document, m, target } = setup();
    const result = commitNativeAtomLabelTarget(document, target, "OMe", { literal: true });
    const after = molecule(result.document), source = m.atoms[0]!, added = after.atoms[6]!;
    const length = nativeDrawingStyleFromObjectStyle(m.style).bondLengthPx;
    expect(after.atoms.slice(0, 6)).toEqual(m.atoms); expect(after.bonds.slice(0, 6)).toEqual(m.bonds);
    expect(Math.hypot(added.x - source.x, added.y - source.y)).toBeCloseTo(length, 8);
    const center = { x: m.atoms.reduce((s, a) => s + a.x, 0) / 6, y: m.atoms.reduce((s, a) => s + a.y, 0) / 6 };
    const outward = { x: source.x - center.x, y: source.y - center.y };
    expect((added.x - source.x) * outward.y - (added.y - source.y) * outward.x).toBeCloseTo(0, 8);
    expect((added.x - source.x) * outward.x + (added.y - source.y) * outward.y).toBeGreaterThan(0);
    expect(result.target).toMatchObject({ atomId: added.id }); expect(result.message).toContain("already has 2");
  });
  it("uses page-wide unique ids, the source's style, and keeps an edge attachment on the page", () => {
    let { document, m, target } = setup();
    const dx = Math.min(...m.atoms.map(a => a.x));
    const shifted = { ...m, atoms: m.atoms.map(a => ({ ...a, x: a.x - dx + 1 })), style: { ...m.style, bondLengthPx: 32 } };
    const other: MoleculeObject = { ...m, id: "other", atoms: [{ ...m.atoms[0]!, id: "atom_013", x: 700, y: 500 }], bonds: [] };
    document = applyPatches(document, [{ op: "updateObject", objectId: m.id, changes: shifted }, { op: "addObject", pageId: document.pages[0].id, object: other }]);
    const result = commitNativeAtomLabelTarget(document, target, "Me");
    const after = molecule(result.document), added = after.atoms[6]!;
    expect(after.atoms).toHaveLength(7);
    expect(Math.hypot(added.x - shifted.atoms[0]!.x, added.y - shifted.atoms[0]!.y)).toBeCloseTo(32, 8);
    expect(added.x).toBeGreaterThanOrEqual(0); expect(added.x).toBeLessThanOrEqual(document.pages[0].width);
    expect(added.y).toBeGreaterThanOrEqual(0); expect(added.y).toBeLessThanOrEqual(document.pages[0].height);
    const ids = result.document.pages[0].objects.filter((o): o is MoleculeObject => o.type === "molecule").flatMap(o => o.atoms.map(a => a.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.document.pages[0].objects[1]).toEqual(other);
  });
  it("restores original label visibility and literal flag after a draft relabel", () => {
    let { document, m, target } = setup();
    const original = { ...m.atoms[0]!, element: "C", labelVisible: true, labelLiteral: false };
    const before = { ...m, atoms: m.atoms.map(a => a.id === original.id ? original : a) };
    document = applyPatches(document, [{ op: "updateObject", objectId: m.id, changes: { ...before, atoms: before.atoms.map(a => a.id === original.id ? { ...a, element: "OMe", labelLiteral: true } : a) } }]);
    const result = commitNativeAtomLabelTarget(document, target, "OMe", { literal: true, beforeAtom: original, beforeMolecule: before });
    expect(molecule(result.document).atoms[0]).toEqual(original);
    expect(molecule(result.document).atoms[6]).toMatchObject({ element: "OMe", labelLiteral: true, formalCharge: 0 });
  });
  it("text conversion removes only the text and targets its new substituent", () => {
    const { document, m } = setup("benzene");
    const text = insertNativeTextObject(document, m.atoms[0]!, "OMe");
    const result = convertNativeTextObjectToAtomLabel(text, text.selection.objectIds[0]!);
    expect(result.document.pages[0].objects).toHaveLength(1);
    expect(molecule(result.document).atoms.slice(0, 6)).toEqual(m.atoms);
    expect(result.target).toMatchObject({ atomId: molecule(result.document).atoms[6]!.id });
  });
});
