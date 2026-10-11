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
  it("inherits every per-atom label style without changing the source entries", () => {
    const { document, m, target } = setup();
    const values = {
      atomLabelFontFamilies: "Georgia", atomLabelFontSizes: 20, atomLabelFontWeights: 700,
      atomLabelFontStyles: "italic", atomLabelColors: "#123456", atomLabelBackgroundColors: "#abcdef",
      atomLabelPaddings: 4, atomLabelBondClearances: 3, atomLabelAlignments: "right",
      atomLabelPlacements: "above", atomLabelShowTerminalCarbonsByAtomId: false,
      atomLabelHideImplicitHydrogensByAtomId: true
    };
    const style = { ...m.style, ...Object.fromEntries(Object.entries(values).map(([key, value]) =>
      [key, { [target.atomId]: value, unrelated: value }])) };
    const styled = applyPatches(document, [{ op: "updateObject", objectId: m.id, changes: { style } }]);
    const result = commitNativeAtomLabelTarget(styled, target, "OMe", { literal: true });
    const after = molecule(result.document), added = after.atoms[6]!;
    for (const [key, value] of Object.entries(values)) {
      expect(after.style[key]).toEqual({ [target.atomId]: value, unrelated: value, [added.id]: value });
      expect(molecule(styled).style[key]).toEqual({ [target.atomId]: value, unrelated: value });
    }
    expect(after.atoms[0]).toEqual(molecule(styled).atoms[0]);
  });
  it("relabels with a specific warning when all attachment positions are crowded", () => {
    const { document, m, target } = setup();
    const source = m.atoms[0]!, length = nativeDrawingStyleFromObjectStyle(m.style).bondLengthPx;
    // Every point at one bond length is within half a bond length of a blocker.
    const blockers = Array.from({ length: 24 }, (_, i) => ({ ...source, id: `blocker${i}`,
      x: source.x + length * Math.cos(i * Math.PI / 12), y: source.y + length * Math.sin(i * Math.PI / 12) }));
    const crowded = applyPatches(document, [{ op: "updateObject", objectId: m.id, changes: { atoms: [...m.atoms, ...blockers] } }]);
    const result = commitNativeAtomLabelTarget(crowded, target, "OMe", { literal: true });
    expect(result.target).toBe(target);
    expect(molecule(result.document).atoms).toHaveLength(30);
    expect(molecule(result.document).atoms[0]!.element).toBe("OMe");
    expect(result.message).toBe("Relabeled OMe: no clear substituent position on the page");
  });
  it.each([1, 13])("clamps an outward attachment at an edge with %s px remaining, falling back if too short", remaining => {
    const { document, m, target } = setup();
    const source = m.atoms[0]!;
    const center = { x: m.atoms.reduce((sum, a) => sum + a.x, 0) / 6, y: m.atoms.reduce((sum, a) => sum + a.y, 0) / 6 };
    const length = nativeDrawingStyleFromObjectStyle(m.style).bondLengthPx;
    const dx = source.x - center.x, dy = source.y - center.y;
    // Put the source at the boundary its ring's outward normal points toward.
    const shift = Math.abs(dx) > Math.abs(dy)
      ? { x: (dx > 0 ? document.pages[0].width - remaining : remaining) - source.x, y: 0 }
      : { x: 0, y: (dy > 0 ? document.pages[0].height - remaining : remaining) - source.y };
    const shifted = { ...m, atoms: m.atoms.map(a => ({ ...a, x: a.x + shift.x, y: a.y + shift.y })) };
    const edge = applyPatches(document, [{ op: "updateObject", objectId: m.id, changes: shifted }]);
    const result = commitNativeAtomLabelTarget(edge, target, "OMe", { literal: true });
    if (remaining < length * 0.5) {
      expect(molecule(result.document).atoms).toHaveLength(6);
      expect(molecule(result.document).atoms[0]!.element).toBe("OMe");
      expect(result.message).toBe("Relabeled OMe: no clear substituent position on the page");
    } else {
      const added = molecule(result.document).atoms[6]!;
      expect(Math.hypot(added.x - shifted.atoms[0]!.x, added.y - shifted.atoms[0]!.y)).toBeCloseTo(remaining, 8);
      expect(result.message).toContain("Attached OMe");
    }
  });
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
