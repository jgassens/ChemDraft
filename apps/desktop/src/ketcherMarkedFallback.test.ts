// ChemDraft 1.2.2 fallback (AGENTS.md section 7): a molecule that carries any charge or radical mark
// is never rewritten from the structure editor: EVERY Apply on it is refused with one message and
// leaves the document, selection and undo untouched, even a save that looks chemically unchanged
// (comparing a save to the stored molecule could misread a real edit as no change).
// Molecules without marks save as before.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyPatch,
  moleculeToMolfileV3000,
  type ChemDraftDocument,
  type ElectronMarkObject,
  type MoleculeAtom,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import {
  applyChargeToolAtNativeAtom,
  applyEditorSaveResultWithLabelWarnings,
  createPhase4Document,
  EDITOR_SAVE_MARKED_MOLECULE_REFUSAL,
  moleculeHasElectronMarks,
  normalizeCommittedDocument
} from "./documentWorkflow";

const objectId = "mol_marked_fallback";
const REFUSAL =
  "This molecule has charge or radical marks; edit it on the canvas, or remove the marks first, then use the structure editor.";

/** Methylamine (C then N), laid out left to right, 30 px apart. */
function methylamine(): { document: ChemDraftDocument; nitrogenId: string } {
  const graph = testMoleculeFromSmiles("CN");
  const atoms: MoleculeAtom[] = graph.atoms.map((atom, index) => ({ ...atom, x: 100 + index * 30, y: 100 }));
  const molecule: MoleculeObject = {
    id: objectId, type: "molecule", x: 90, y: 80, width: 50, height: 40, rotation: 0, style: {},
    atoms, bonds: graph.bonds, structureFormat: "smiles",
    structure: nativeSingleBondGraphSmiles(atoms, graph.bonds),
    chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds),
    superatoms: [], rGroups: []
  };
  const base = createPhase4Document("Ketcher marked fallback");
  const document = applyPatch(base, { op: "addObject", pageId: base.pages[0].id, object: molecule });
  return { document: normalizeCommittedDocument(document), nitrogenId: atoms.find(atom => atom.element === "N")!.id };
}

const moleculeOf = (document: ChemDraftDocument) =>
  document.pages[0].objects.find((object): object is MoleculeObject => object.id === objectId)!;
const marksOf = (document: ChemDraftDocument) =>
  document.pages[0].objects.filter((object): object is ElectronMarkObject => object.type === "electron-mark");
const atomOf = (document: ChemDraftDocument, atomId: string) => moleculeOf(document).atoms.find(atom => atom.id === atomId)!;

function select(document: ChemDraftDocument): ChemDraftDocument {
  return applyPatch(document, { op: "setSelection", pageId: document.pages[0].id, objectIds: [objectId] });
}

function withChargeMark(document: ChemDraftDocument, atomId: string, charge: 1 | -1 = 1): ChemDraftDocument {
  return normalizeCommittedDocument(applyChargeToolAtNativeAtom(document, { kind: "charge", charge },
    { kind: "atom", objectId, atomId, distanceToPointer: 0 }));
}

/** Open in the editor, let `edit` change the V3000 it returns, and apply the save. */
function save(document: ChemDraftDocument, edit: (v3000: string) => string = v3000 => v3000) {
  const selected = select(document);
  const opened = moleculeOf(selected);
  const v3000 = edit(moleculeToMolfileV3000(opened, { kekuleBondOrders: new Map() }).contents);
  const applied = applyEditorSaveResultWithLabelWarnings(selected, {
    object: { ...opened, structureFormat: "molfile-v3000", structure: v3000 }, warnings: []
  });
  return { selected, applied, v3000 };
}

/** The editor re-centres the molecule: every atom's coordinates move by the same offset. */
const shifted = (v3000: string) => v3000.split(/\r?\n/).map(line => {
  const parts = line.trim().split(/\s+/);
  return /^M\s+V30\s+\d+\s+[A-Z][a-z]?\s/.test(line) && parts.length > 5
    ? `M  V30 ${parts[2]} ${parts[3]} ${(Number(parts[4]) + 3.5).toFixed(4)} ${(Number(parts[5]) - 1.25).toFixed(4)} ${parts.slice(6).join(" ")}`
    : line;
}).join("\n");

const doubleBond = (v3000: string) => v3000.replace(/^(M\s+V30\s+1\s+)1(\s+1\s+2)\s*$/m, "$12$2");

/** A methyl bonded to N, appended after the existing atoms and bonds. */
const addMethylOnNitrogen = (v3000: string) => v3000
  .replace(/^(M\s+V30\s+COUNTS\s+)2 1/m, "$13 2")
  .replace(/^M\s+V30\s+END ATOM/m, "M  V30 3 C 3.0 -1.0 0 0\nM  V30 END ATOM")
  .replace(/^M\s+V30\s+END BOND/m, "M  V30 2 1 2 3\nM  V30 END BOND");

const withNitrogenCharge = (charge: number) => (v3000: string) => v3000.split(/\r?\n/).map(line =>
  /^M\s+V30\s+\d+\s+N\s/.test(line.trim()) ? `${line.replace(/\s+CHG=-?\d+/, "")}${charge ? ` CHG=${charge}` : ""}` : line).join("\n");

describe("1.2.2 fallback: a marked molecule's editor save", () => {
  it("uses the exact refusal message", () => {
    expect(EDITOR_SAVE_MARKED_MOLECULE_REFUSAL).toBe(REFUSAL);
  });

  it("an unchanged save of N+ with a + mark is refused: the document is the same object, N stays +1", () => {
    const { document: plain, nitrogenId } = methylamine();
    const charged = withChargeMark(plain, nitrogenId);
    expect(atomOf(charged, nitrogenId)).toMatchObject({ formalCharge: 1, markCharge: 1 });
    expect(marksOf(charged)).toHaveLength(1);

    const { selected, applied, v3000 } = save(charged);
    expect(v3000).toMatch(/\bN\b.*CHG=1/);
    expect(applied.refusal).toBe(REFUSAL);
    expect(applied).not.toHaveProperty("unchanged");
    expect(applied.document).toBe(selected);
    expect(applied.document.selection).toEqual(selected.selection);
    expect(atomOf(applied.document, nitrogenId).formalCharge).toBe(1);
    expect(marksOf(applied.document)).toEqual(marksOf(selected));
    expect(moleculeOf(applied.document)).toBe(moleculeOf(selected));
  });

  it("moving atoms only is refused too: the editor's re-centred result leaves the document untouched", () => {
    const { document: plain, nitrogenId } = methylamine();
    const { selected, applied } = save(withChargeMark(plain, nitrogenId), shifted);
    expect(applied.refusal).toBe(REFUSAL);
    expect(applied.document).toBe(selected);
  });

  it.each([
    ["a bond order changed", doubleBond],
    ["an atom added", addMethylOnNitrogen],
    ["N's charge changed to 2+", withNitrogenCharge(2)],
    ["N's charge cleared while its + mark stays", withNitrogenCharge(0)]
  ])("refuses a marked molecule when %s; document, selection and marks untouched", (_name, edit) => {
    const { document: plain, nitrogenId } = methylamine();
    const charged = withChargeMark(plain, nitrogenId);
    const { selected, applied } = save(charged, edit);
    expect(applied.refusal).toBe(REFUSAL);
    expect(applied.document).toBe(selected);
    expect(applied.document.selection).toEqual(selected.selection);
    expect(atomOf(applied.document, nitrogenId)).toMatchObject({ formalCharge: 1, markCharge: 1 });
  });

  it("refuses a move, an element change and a changed bond order on a radical-marked molecule", () => {
    const { document: plain, nitrogenId } = methylamine();
    const radical = normalizeCommittedDocument(applyChargeToolAtNativeAtom(plain, { kind: "radical-dot" },
      { kind: "atom", objectId, atomId: nitrogenId, distanceToPointer: 0 }));
    expect(atomOf(radical, nitrogenId).markRadicals).toBe(1);

    const moved = save(radical, shifted);
    expect(moved.applied.refusal).toBe(REFUSAL);
    expect(moved.applied.document).toBe(moved.selected);

    const element = save(radical, v3000 => v3000.replace(/^(M\s+V30\s+2\s+)N(\s)/m, "$1O$2"));
    expect(element.applied.refusal).toBe(REFUSAL);
    const bond = save(radical, doubleBond);
    expect(bond.applied.refusal).toBe(REFUSAL);
  });

  it("an unchanged save of a radical-marked molecule (V3000 without RAD) is refused", () => {
    const { document: plain, nitrogenId } = methylamine();
    const radical = normalizeCommittedDocument(applyChargeToolAtNativeAtom(plain, { kind: "radical-dot" },
      { kind: "atom", objectId, atomId: nitrogenId, distanceToPointer: 0 }));
    // The stored SMILES carries no radicals, so Ketcher returns none.
    const { selected, applied, v3000 } = save(radical, v3000 => v3000.replace(/\s+RAD=\d+/, ""));
    expect(v3000).not.toMatch(/RAD=/);
    expect(applied.refusal).toBe(REFUSAL);
    expect(applied.document).toBe(selected);
  });

  it("refuses a V3000 that adds RAD to an atom of a radical-marked molecule", () => {
    const { document: plain, nitrogenId } = methylamine();
    const radical = normalizeCommittedDocument(applyChargeToolAtNativeAtom(plain, { kind: "radical-dot" },
      { kind: "atom", objectId, atomId: nitrogenId, distanceToPointer: 0 }));
    // RAD=3 (triplet) where the marks say one dot, and RAD on the carbon that has none.
    const changed = save(radical, v3000 => v3000.replace(/RAD=\d+/, "RAD=3"));
    expect(changed.applied.refusal).toBe(REFUSAL);
    expect(changed.applied.document).toBe(changed.selected);
    const added = save(radical, v3000 => v3000.replace(/^(M\s+V30\s+1\s+C\s.*)$/m, "$1 RAD=2"));
    expect(added.applied.refusal).toBe(REFUSAL);
    expect(added.applied.document).toBe(added.selected);
    // And RAD added to a charge-marked molecule that had none.
    const charged = withChargeMark(plain, nitrogenId);
    const onCharged = save(charged, v3000 => v3000.replace(/^(M\s+V30\s+1\s+C\s.*)$/m, "$1 RAD=2"));
    expect(onCharged.applied.refusal).toBe(REFUSAL);
  });

  it("treats a legacy loose mark that normalization assigns to an atom as a mark", () => {
    const { document: plain, nitrogenId } = methylamine();
    const anchored = withChargeMark(plain, nitrogenId);
    const mark = marksOf(anchored)[0]!;
    const loose = applyPatch(anchored, { op: "updateObject", objectId: mark.id, changes: {
      anchor: { kind: "point", point: { x: mark.x + mark.width / 2, y: mark.y + mark.height / 2 } }, atomAssociation: undefined
    } });
    expect(moleculeHasElectronMarks(loose.pages[0], moleculeOf(loose))).toBe(true);
    const same = save(loose);
    expect(same.applied.refusal).toBe(REFUSAL);
    expect(same.applied.document).toBe(same.selected);
    const edited = save(loose, doubleBond);
    expect(edited.applied.refusal).toBe(REFUSAL);
  });

  it("moleculeHasElectronMarks is false without marks", () => {
    const { document } = methylamine();
    expect(moleculeHasElectronMarks(document.pages[0], moleculeOf(document))).toBe(false);
  });

  it("MainWindow returns false on a refusal, so the host never reports Applied, and has no unchanged branch", () => {
    const source = readFileSync(new URL("./MainWindow.tsx", import.meta.url), "utf8");
    const start = source.indexOf("const handleApplyKetcherEdit = useCallback(");
    const body = source.slice(start, source.indexOf("}, [commitDocumentChangeWithPageFit]);", start));
    expect(body).toMatch(/if \(applied\.refusal\) \{\s*setStatus\(applied\.refusal\);\s*return false;\s*\}/);
    expect(body.indexOf("applied.refusal")).toBeLessThan(body.indexOf("commitDocumentChangeWithPageFit(applied.document"));
    expect(body).not.toContain(".unchanged");
    expect(body).not.toContain("unchanged:");
    expect(body).not.toContain("No changes from the structure editor");
    expect(source).not.toContain("No changes from the structure editor");
  });
});

/** Put a wedge (narrow end at the first atom) on the C-N bond of the stored molecule. */
function withWedge(document: ChemDraftDocument): ChemDraftDocument {
  const molecule = moleculeOf(document);
  return normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId, changes: {
    bonds: molecule.bonds.map((bond, index) => index === 0 ? { ...bond, display: { ...bond.display, bondStyle: "wedge" } } : bond)
  } }));
}

/** The editor returning the bond as a wedge (CFG=1) or a hash (CFG=3). */
const addCfg = (cfg: number) => (v3000: string) => v3000.replace(/^(M\s+V30\s+1\s+1\s+1\s+2)\s*$/m, `$1 CFG=${cfg}`);

describe("1.2.2 fallback: bond stereo on a marked molecule", () => {
  it("a stereo-only edit (a wedge added) is refused", () => {
    const { document: plain, nitrogenId } = methylamine();
    const charged = withChargeMark(plain, nitrogenId);
    const { selected, applied, v3000 } = save(charged, addCfg(1));
    expect(v3000).toMatch(/CFG=1/);
    expect(applied.refusal).toBe(REFUSAL);
    expect(applied.document).toBe(selected);
    const hashed = save(charged, addCfg(3));
    expect(hashed.applied.refusal).toBe(REFUSAL);
  });

  it("an unchanged save of a marked molecule with an existing wedge is refused", () => {
    const { document: plain, nitrogenId } = methylamine();
    const wedged = withChargeMark(withWedge(plain), nitrogenId);
    expect(moleculeOf(wedged).bonds[0]!.display?.bondStyle).toBe("wedge");
    const { selected, applied, v3000 } = save(wedged);
    expect(v3000).toMatch(/CFG=1/);
    expect(applied.refusal).toBe(REFUSAL);
    expect(applied.document).toBe(selected);
    expect(save(wedged, shifted).applied.refusal).toBe(REFUSAL);
  });

  it("removing or flipping an existing wedge on a marked molecule is refused", () => {
    const { document: plain, nitrogenId } = methylamine();
    const wedged = withChargeMark(withWedge(plain), nitrogenId);
    const removed = save(wedged, v3000 => v3000.replace(/\s+CFG=1/, ""));
    expect(removed.applied.refusal).toBe(REFUSAL);
    const hashed = save(wedged, v3000 => v3000.replace(/CFG=1/, "CFG=3"));
    expect(hashed.applied.refusal).toBe(REFUSAL);
    const flipped = save(wedged, v3000 => v3000.replace(/^(M\s+V30\s+1\s+1\s+)1(\s+)2(\s+CFG=1)/m, "$12$21$3"));
    expect(flipped.applied.refusal).toBe(REFUSAL);
  });
});

describe("1.2.2 fallback: a molecule without marks saves as before", () => {
  it("a bond-order edit commits and is not refused", () => {
    const { document } = methylamine();
    const { applied } = save(document, doubleBond);
    expect(applied.refusal).toBeUndefined();
    expect(moleculeOf(normalizeCommittedDocument(applied.document)).bonds[0]!.order).toBe("double");
  });

  it("an added atom commits", () => {
    const { document } = methylamine();
    const { applied } = save(document, addMethylOnNitrogen);
    expect(applied.refusal).toBeUndefined();
    expect(moleculeOf(applied.document).atoms).toHaveLength(3);
  });

  it("an unchanged save still goes through the existing save path (no no-op shortcut)", () => {
    const { document } = methylamine();
    const { selected, applied } = save(document);
    expect(applied.refusal).toBeUndefined();
    expect(applied.document).not.toBe(selected);
  });
});
