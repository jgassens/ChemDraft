import { describe, expect, it } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatches, nativeDrawingStyleFromObjectStyle, type MoleculeAtom, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeAtomLabelReading, nativeAtomValidationState, nativeBondOrderResolution, nativeLabelBondSide } from "@chemdraft/document-workflow-core";
import { atomDisplayLabelPlacement } from "@chemdraft/layout-engine";
import {
  applyNativeAtomElementTarget, applyNativeAtomLabelDraft, commitNativeAtomLabelTarget,
  convertNativeTextObjectToAtomLabel, createPhase4Document, insertNativeSingleBondMolecule,
  insertNativeTemplateMolecule, insertNativeTextObject, nativeBondLengthPx
} from "./documentWorkflow";

function molecule(d: ReturnType<typeof createPhase4Document>) {
  return d.pages[0].objects.find((o): o is MoleculeObject => o.type === "molecule")!;
}
function setup(template: "benzene" | "cyclohexane" = "cyclohexane") {
  const document = insertNativeTemplateMolecule(createPhase4Document(), { x: 300, y: 300 }, template);
  const m = molecule(document);
  return { document, m, target: { objectId: m.id, kind: "atom" as const, atomId: m.atoms[0]!.id, distanceToPointer: 0 } };
}

// Two bond-length-spaced neighbours, matching the reported label-edit reproductions.
function bondedLabelFixture(element: string, neighbors: string[], orders?: MoleculeBond["order"][]) {
  const seed = insertNativeSingleBondMolecule(createPhase4Document(), { x: 300, y: 300 });
  const original = molecule(seed);
  const source: MoleculeAtom = { id: "atom_001", element, formalCharge: 0, x: 300, y: 300 };
  const atoms = [source, ...neighbors.map((neighbor, i) => ({
    id: `atom_00${i + 2}`, element: neighbor, formalCharge: 0,
    x: source.x + nativeBondLengthPx * Math.cos([Math.PI, -Math.PI / 3][i]!),
    y: source.y + nativeBondLengthPx * Math.sin([Math.PI, -Math.PI / 3][i]!)
  }))];
  const bonds: MoleculeBond[] = neighbors.map((_neighbor, i) => ({
    id: `bond_00${i + 1}`, fromAtomId: source.id, toAtomId: atoms[i + 1]!.id, order: orders?.[i] ?? "single"
  }));
  const document = applyPatches(seed, [{ op: "updateObject", objectId: original.id, changes: { atoms, bonds } }]);
  return { document, target: { objectId: original.id, kind: "atom" as const, atomId: source.id, distanceToPointer: 0 } };
}

function expectSameAtom(before: MoleculeObject, after: MoleculeObject, label: string) {
  expect(after.atoms.map(a => a.id)).toEqual(before.atoms.map(a => a.id));
  expect(after.bonds).toEqual(before.bonds);
  expect(after.atoms[0]).toMatchObject({ ...before.atoms[0], element: label });
  expect(after.atoms.slice(1)).toEqual(before.atoms.slice(1));
}

describe("same-head labels on bonded atoms", () => {
  it.each([false, true])("keeps the original P when PH is edited to PPh2 (stored PH: %s)", literal => {
    const fixture = bondedLabelFixture("P", ["Fe", "C"]);
    const document = literal ? applyNativeAtomElementTarget(fixture.document, fixture.target, "PH", { literal: true }) : fixture.document;
    const before = molecule(document);
    const result = commitNativeAtomLabelTarget(document, fixture.target, "PPh2", { literal: true });
    const after = molecule(result.document);
    expectSameAtom(before, after, "PPh2");
    expect(result.target).toEqual(fixture.target);
    expect(result.message).toBeUndefined();
    // Four solid bonds at neutral P remain flagged; relabelling must not change charge or the metal bond.
    expect(nativeAtomValidationState(after.atoms[0]!, after.bonds, 0, after.atoms).valid).toBe(false);
    expect(after.chemistry?.warnings?.some(w => w.code === "chemistry.invalid_valence")).toBe(true);
    expect(canonicalLabelGraph(after).getIDCode()).toBe(Molecule.fromSmiles("[Fe]P(C)(c1ccccc1)c1ccccc1").getIDCode());
  });

  it("preserves charge and bond stereo for a valid same-head PPh2 edit", () => {
    const { document, target } = bondedLabelFixture("P", ["C", "C"]);
    const original = molecule(document);
    const charged = applyPatches(document, [{ op: "updateObject", objectId: original.id, changes: {
      atoms: original.atoms.map((atom, i) => i === 0 ? { ...atom, formalCharge: 1 } : atom),
      bonds: original.bonds.map((bond, i) => i === 0 ? { ...bond, display: { bondStyle: "wedge" as const } } : bond)
    } }]);
    const after = molecule(commitNativeAtomLabelTarget(charged, target, "PPh2", { literal: true }).document);
    expectSameAtom(molecule(charged), after, "PPh2");
    expect(nativeAtomValidationState(after.atoms[0]!, after.bonds, 1, after.atoms).valid).toBe(true);
    expect(after.chemistry?.formula).toBe("C14H16P");
    expect(after.chemistry?.totalCharge).toBe(1);
    expect(Molecule.fromSmiles(after.structure).toSmiles()).toBe(Molecule.fromSmiles("C[P+](C)(c1ccccc1)c1ccccc1").toSmiles());
  });

  it("declines a same-head label that cannot represent the original isotope", () => {
    const { document, target } = bondedLabelFixture("S", ["C", "O"], ["single", "double"]);
    const original = molecule(document);
    const isotopic = applyPatches(document, [{ op: "updateObject", objectId: original.id, changes: {
      atoms: original.atoms.map((atom, i) => i === 0 ? { ...atom, isotope: 34 } : atom)
    } }]);
    expect(applyNativeAtomLabelDraft(isotopic, target, "SH", { element: "S", literal: false })).toBe(isotopic);
    const result = commitNativeAtomLabelTarget(isotopic, target, "SH", { literal: true });
    expect(result.document).toBe(isotopic);
    expect(result.message).toBe("Cannot relabel 34S as SH: the label cannot keep isotope 34; clear the isotope first to relabel");
    const text = insertNativeTextObject(isotopic, molecule(isotopic).atoms[0]!, "SH");
    const converted = convertNativeTextObjectToAtomLabel(text, text.selection.objectIds[0]!);
    expect(converted.document).toBe(text);
    expect(converted.disabledReason).toBe("Cannot relabel 34S as SH: the label cannot keep isotope 34; clear the isotope first to relabel");
  });

  it.each(["NMe2", "NHMe"])("keeps neutral N's identity, bonds and charge when relabeled %s", label => {
    const { document, target } = bondedLabelFixture("N", ["C", "C"]);
    const before = molecule(document);
    const draft = applyNativeAtomLabelDraft(document, target, label, { element: "N", literal: false });
    const result = commitNativeAtomLabelTarget(draft, target, label, {
      literal: true, beforeAtom: before.atoms[0], beforeMolecule: before
    });
    const after = molecule(result.document);
    expectSameAtom(before, after, label);
    expect(result.target).toEqual(target);
    expect(nativeAtomValidationState(after.atoms[0]!, after.bonds, 0, after.atoms).valid).toBe(false);
    expect(after.chemistry?.warnings?.some(w => w.code === "chemistry.invalid_valence")).toBe(true);
  });

  it("keeps S(=O)'s identity when relabeled SMe", () => {
    const { document, target } = bondedLabelFixture("S", ["C", "O"], ["single", "double"]);
    const after = molecule(commitNativeAtomLabelTarget(document, target, "SMe", { literal: true }).document);
    expectSameAtom(molecule(document), after, "SMe");
    expect(canonicalLabelGraph(after).getIDCode()).toBe(Molecule.fromSmiles("CS(=O)C").getIDCode());
  });

  it.each([["O", "OMe", 1], ["O", "OEt", 1], ["N", "NO2", 0]] as const)(
    "attaches table abbreviation %s → %s without relabeling its head", (element, label, charge) => {
      const fixture = bondedLabelFixture(element, ["C", "C"]);
      const original = molecule(fixture.document);
      // O needs its ordinary oxonium charge to admit a third bond.
      const document = applyPatches(fixture.document, [{ op: "updateObject", objectId: original.id, changes: {
        atoms: original.atoms.map((a, i) => i === 0 ? { ...a, formalCharge: charge } : a)
      } }]);
      const before = molecule(document);
      const result = commitNativeAtomLabelTarget(document, fixture.target, label, { literal: true });
      const after = molecule(result.document);
      expect(after.atoms.slice(0, before.atoms.length)).toEqual(before.atoms);
      expect(after.bonds.slice(0, before.bonds.length)).toEqual(before.bonds);
      expect(after.atoms).toHaveLength(before.atoms.length + 1);
      expect(after.atoms.at(-1)).toMatchObject({ element: label, formalCharge: 0 });
      expect(result.message).toContain(`Attached ${label} as a substituent`);
    }
  );

  it("still attaches Ph to an isotopic carbon", () => {
    const { document, target } = bondedLabelFixture("C", ["C", "C"]);
    const before = molecule(document);
    const isotopic = applyPatches(document, [{ op: "updateObject", objectId: before.id, changes: {
      atoms: before.atoms.map((atom, i) => i === 0 ? { ...atom, isotope: 13 } : atom)
    } }]);
    const after = molecule(commitNativeAtomLabelTarget(isotopic, target, "Ph", { literal: true }).document);
    expect(after.atoms.slice(0, 3)).toEqual(molecule(isotopic).atoms);
    expect(after.atoms[3]).toMatchObject({ element: "Ph" });
  });

  it.each(["editor", "hover", "text"] as const)("SH keeps CH3-S(=O) in place through %s", entry => {
    const fixture = bondedLabelFixture("C", ["C", "O"], ["single", "double"]);
    const document = applyNativeAtomElementTarget(fixture.document, fixture.target, "S");
    const before = molecule(document);
    let after: MoleculeObject;
    if (entry === "text") {
      const text = insertNativeTextObject(document, before.atoms[0]!, "SH");
      const result = convertNativeTextObjectToAtomLabel(text, text.selection.objectIds[0]!);
      expect(result.disabledReason).toBeUndefined();
      expect(result.document.pages[0].objects).toHaveLength(1);
      after = molecule(result.document);
    } else {
      const draft = applyNativeAtomLabelDraft(document, fixture.target, "SH", { element: "S", literal: false });
      after = molecule(commitNativeAtomLabelTarget(entry === "editor" ? draft : document, fixture.target, "SH", {
        literal: entry === "editor", beforeAtom: before.atoms[0], beforeMolecule: before
      }).document);
    }
    expectSameAtom(before, after, "SH");
    expect(nativeAtomValidationState(after.atoms[0]!, after.bonds, 0, after.atoms).valid).toBe(true);
    expect(after.chemistry?.formula).toBe("CH4OS");
    expect(Molecule.fromSmiles(after.structure).toSmiles()).toBe(Molecule.fromSmiles("C[SH]=O").toSmiles());
    expect(Molecule.fromSmiles(after.structure).getMolecularFormula().formula).toBe("CH4OS");
  });
});

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
    ["NH2", "NC1CCCCC1"], ["NO2", "[O-][N+](=O)C1CCCCC1"],
    ["CF3", "FC(F)(F)C1CCCCC1"], ["COOH", "O=C(O)C1CCCCC1"],
    ["CN", "N#CC1CCCCC1"], ["NMe2", "CN(C)C1CCCCC1"],
    ["OH", "OC1CCCCC1"], ["OMe", "COC1CCCCC1"]
  ])("retains %s substituent attachment and chemistry on bonded carbon", (label, smiles) => {
    const { document, m, target } = setup();
    const result = commitNativeAtomLabelTarget(document, target, label, { literal: true });
    const after = molecule(result.document);
    expect(after.atoms.slice(0, m.atoms.length)).toEqual(m.atoms);
    expect(after.bonds.slice(0, m.bonds.length)).toEqual(m.bonds);
    expect(after.atoms).toHaveLength(m.atoms.length + 1);
    expect(after.bonds).toHaveLength(m.bonds.length + 1);
    expect(after.atoms.at(-1)).toMatchObject({ element: label, formalCharge: 0 });
    expect(result.target).toMatchObject({ atomId: after.atoms.at(-1)!.id });
    expect(result.message).toContain(`Attached ${label} as a substituent`);
    const actual = canonicalLabelGraph(after), expected = Molecule.fromSmiles(smiles);
    expect(actual.getIDCode()).toBe(expected.getIDCode());
    expect(actual.getMolecularFormula().formula).toBe(expected.getMolecularFormula().formula);
  });

  it.each(["SH", "Ac", "Pr", "Ts"])("refuses %s on a one-bond 13C without losing the isotope or text", label => {
    const fixture = bondedLabelFixture("C", ["C"]);
    const original = molecule(fixture.document);
    const document = applyPatches(fixture.document, [{ op: "updateObject", objectId: original.id, changes: {
      atoms: original.atoms.map((a, i) => i === 0 ? { ...a, isotope: 13 } : a)
    } }]);
    const message = `Cannot relabel 13C as ${label}: the label cannot keep isotope 13; clear the isotope first to relabel`;
    expect(applyNativeAtomLabelDraft(document, fixture.target, label, { element: "C", literal: false })).toBe(document);
    const result = commitNativeAtomLabelTarget(document, fixture.target, label, { literal: true });
    expect(result.document).toBe(document);
    expect(result.message).toBe(message);
    expect(result.refusal).toBe(message);
    const text = insertNativeTextObject(document, molecule(document).atoms[0]!, label);
    const converted = convertNativeTextObjectToAtomLabel(text, text.selection.objectIds[0]!);
    expect(converted.document).toBe(text);
    expect(converted.disabledReason).toBe(message);
    expect(converted.message).toBe(`Text kept: ${message}`);
  });

  it.each(["crowded", "declined"] as const)("keeps the isotope and text when a substituent is %s", failure => {
    const fixture = setup("benzene");
    const source = fixture.m.atoms[4]!;
    const target = { ...fixture.target, atomId: source.id };
    const label = failure === "crowded" ? "Ph" : "CH2CN";
    const length = nativeDrawingStyleFromObjectStyle(fixture.m.style).bondLengthPx;
    const blockers = failure === "crowded" ? Array.from({ length: 24 }, (_, i) => ({
      ...source, id: `blocker${i}`, element: "C",
      x: source.x + length * Math.cos(i * Math.PI / 12), y: source.y + length * Math.sin(i * Math.PI / 12)
    })) : [];
    const document = applyPatches(fixture.document, [{ op: "updateObject", objectId: fixture.m.id, changes: {
      atoms: [...fixture.m.atoms.map(a => a.id === source.id ? { ...a, isotope: 13 } : a), ...blockers]
    } }]);
    const result = commitNativeAtomLabelTarget(document, target, label, { literal: true });
    const message = `Cannot relabel 13C as ${label}: the label cannot keep isotope 13; clear the isotope first to relabel`;
    expect(result.document).toBe(document);
    expect(result.target).toEqual(target);
    expect(result.message).toBe(message);
    expect(result.refusal).toBe(message);
    const text = insertNativeTextObject(document, source, label);
    const textId = text.selection.objectIds[0]!;
    const converted = convertNativeTextObjectToAtomLabel(text, textId);
    expect(converted.document).toBe(text);
    expect(converted.disabledReason).toBe(message);
    expect(converted.message).toBe(`Text kept: ${message}`);
    expect(converted.document.pages[0].objects.find(o => o.id === textId)).toMatchObject({ type: "text", text: label });
  });

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
  it("keeps a bold piperidine nitrogen and gives its typed OMe attachment the same weight", () => {
    const { document, m, target } = setup();
    const nitrogen = { ...m.atoms[0]!, element: "N" };
    const styled = applyPatches(document, [{
      op: "updateObject",
      objectId: m.id,
      changes: {
        atoms: m.atoms.map((atom) => atom.id === nitrogen.id ? nitrogen : atom),
        style: { ...m.style, atomLabelFontWeights: { [nitrogen.id]: 700 } }
      }
    }]);

    const result = commitNativeAtomLabelTarget(styled, target, "OMe", { literal: true });
    const after = molecule(result.document);
    const ringNitrogen = after.atoms.find((atom) => atom.id === nitrogen.id)!;
    const attachment = after.atoms.find((atom) => atom.id !== nitrogen.id && atom.element === "OMe")!;

    expect(ringNitrogen).toEqual(nitrogen);
    expect(after.bonds.filter((bond) => bond.fromAtomId === nitrogen.id || bond.toAtomId === nitrogen.id)).toHaveLength(3);
    expect(after.bonds.filter((bond) => bond.fromAtomId === nitrogen.id || bond.toAtomId === nitrogen.id).filter((bond) =>
      bond.fromAtomId === attachment.id || bond.toAtomId === attachment.id
    )).toHaveLength(1);
    expect(after.style.atomLabelFontWeights).toEqual({ [nitrogen.id]: 700, [attachment.id]: 700 });
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
  it("declines an attachment blocked only by an atom in another molecule", () => {
    const { document, m, target } = setup();
    const clear = commitNativeAtomLabelTarget(document, target, "OMe", { literal: true });
    const point = molecule(clear.document).atoms[6]!;
    const other: MoleculeObject = { ...m, id: "blocking_molecule", atoms: [{ ...point, id: "blocking_atom", element: "C" }], bonds: [] };
    const blocked = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: other }]);
    const result = commitNativeAtomLabelTarget(blocked, target, "OMe", { literal: true });
    expect(molecule(result.document).atoms).toHaveLength(6);
    expect(molecule(result.document).atoms[0]!.element).toBe("OMe");
    expect(result.target).toBe(target);
    expect(result.message).toBe("Relabeled OMe: no clear substituent position on the page");
    expect(result.document.pages[0].objects[1]).toEqual(other);
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

// The reviewer's probe: benzene atoms 5 and 6 open to the left, so a substituent lands left of its
// ring atom with its bond on the label's right; atoms 2 and 3 are their mirror. A cyano label keeps
// the reading it was typed with (bond on its left) on either side, and is drawn turned on the left.
describe("a cyano substituent keeps its typed reading on either side of the ring", () => {
  const groups = [["CN", "C(#N)", "NC"], ["SCN", "S(C(#N))", "NCS"], ["OCN", "O(C(#N))", "NCO"]] as const;
  const atoms = [[4, "left"], [5, "left"], [1, "right"], [2, "right"]] as const;
  it.each(groups.flatMap(([label, smiles, turned]) => atoms.map(([index, facing]) => [label, smiles, turned, index, facing] as const)))(
    "%s stays its group %s (turned %s) on benzene atom index %i, facing %s",
    (label, smiles, turned, index, facing) => {
      const { document, m } = setup("benzene");
      const source = m.atoms[index]!;
      const result = commitNativeAtomLabelTarget(document, { objectId: m.id, kind: "atom", atomId: source.id, distanceToPointer: 0 }, label, { literal: true });
      const after = molecule(result.document), added = after.atoms[6]!;
      expect(Math.sign(added.x - source.x)).toBe(facing === "left" ? -1 : 1);
      expect(result.message).toBe(`Attached ${label} as a substituent: ${label} takes one bond and this atom already has 2`);
      expect(after.structure).toContain(smiles);
      expect(after.structure).not.toContain("*");
      expect(added.labelBondSide).toEqual({ side: "left", atomId: source.id });
      const addedBonds = after.bonds.filter(b => b.fromAtomId === added.id || b.toAtomId === added.id);
      const side = nativeLabelBondSide(added, addedBonds, after.atoms);
      expect(side).toBe("left");
      expect(nativeAtomLabelReading(added.element, { bonded: true, typed: true, bondSide: side! }).kind).toBe("group");
      expect(nativeAtomValidationState(added, after.bonds, added.formalCharge, after.atoms).valid).toBe(true);
      expect(atomDisplayLabelPlacement(added, after.bonds, nativeDrawingStyleFromObjectStyle(after.style), after.atoms)).toEqual(
        facing === "left" ? { label: turned, anchor: { side: "end", length: 1 } } : { label, anchor: { side: "start", length: 1 } }
      );
    }
  );
  it.each([4, 5])("OMe on left-facing benzene atom %i still reads OMe, drawn MeO, with no recorded side", index => {
    const { document, m } = setup("benzene");
    const source = m.atoms[index]!;
    const result = commitNativeAtomLabelTarget(document, { objectId: m.id, kind: "atom", atomId: source.id, distanceToPointer: 0 }, "OMe", { literal: true });
    const after = molecule(result.document), added = after.atoms[6]!;
    expect(added).toMatchObject({ element: "OMe", labelLiteral: true });
    expect(added.labelBondSide).toBeUndefined();
    expect(after.structure).toContain("O(C)"); expect(after.structure).not.toContain("*");
    expect(nativeAtomValidationState(added, after.bonds, added.formalCharge, after.atoms).valid).toBe(true);
    expect(atomDisplayLabelPlacement(added, after.bonds, nativeDrawingStyleFromObjectStyle(after.style), after.atoms)).toEqual({
      label: "MeO", anchor: { side: "end", length: 1 }
    });
    expect(result.message).toBe("Attached OMe as a substituent: OMe takes one bond and this atom already has 2");
  });
  it("refuses CH2CN where it cannot be drawn turned, relabelling with a specific status, and attaches it facing right", () => {
    const { document, m } = setup("benzene");
    const left = commitNativeAtomLabelTarget(document, { objectId: m.id, kind: "atom", atomId: m.atoms[4]!.id, distanceToPointer: 0 }, "CH2CN", { literal: true });
    expect(molecule(left.document).atoms).toHaveLength(6);
    expect(molecule(left.document).atoms[4]).toMatchObject({ element: "CH2CN" });
    expect(left.target).toMatchObject({ kind: "atom", atomId: m.atoms[4]!.id });
    expect(left.message).toBe(
      "Relabeled CH2CN: the open position puts the bond on the label's right, and CH2CN cannot be drawn turned to meet it there without reading as the N-bonded isomer"
    );
    const right = commitNativeAtomLabelTarget(document, { objectId: m.id, kind: "atom", atomId: m.atoms[1]!.id, distanceToPointer: 0 }, "CH2CN", { literal: true });
    expect(molecule(right.document).atoms[6]).toMatchObject({ element: "CH2CN", labelBondSide: { side: "left", atomId: m.atoms[1]!.id } });
    expect(molecule(right.document).structure).toContain("C(C(#N))");
  });
});
