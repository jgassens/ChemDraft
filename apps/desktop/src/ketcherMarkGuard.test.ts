// A Ketcher (structure-editor) save reuses atom and bond ids by array index (`parseV3000MoleculeGraph`),
// so an edit that adds, removes or rewires atoms could silently put a charge or radical mark on a
// different atom. 1.2.2 fallback: any chemical edit of a marked molecule is refused with one message
// (see ketcherMarkedFallback.test.ts); unmarked molecules commit as before.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { applyPatch, type ChemDraftDocument, type MoleculeAtom, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";
import { phase4Timestamp } from "@chemdraft/document-workflow-core";
import {
  applyEditorSaveResultWithLabelWarnings,
  EDITOR_SAVE_MARKED_MOLECULE_REFUSAL,
  normalizeCommittedDocument,
  selectDocumentObject
} from "./documentWorkflow";
import { dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";
import { applyKetcherSave } from "./KetcherEditorHost";
import type { EditorSaveResult } from "@chemdraft/editor-adapter";

const v3000Order: Record<MoleculeBond["order"], string> = { single: "1", double: "2", triple: "3", aromatic: "4" } as Record<MoleculeBond["order"], string>;

/**
 * The molecule as the structure editor saves it: a V3000 of these atoms and bonds in order, y up.
 * The editor is handed each atom's total formal charge and returns it as CHG.
 */
function editorV3000(atoms: readonly MoleculeAtom[], bonds: readonly MoleculeBond[]): string {
  return [
    "-INDIGO-", "", "  0  0  0  0  0  0  0  0  0  0  0 V3000",
    "M  V30 BEGIN CTAB",
    `M  V30 COUNTS ${atoms.length} ${bonds.length} 0 0 0`,
    "M  V30 BEGIN ATOM",
    ...atoms.map((atom, index) => `M  V30 ${index + 1} ${atom.element} ${(atom.x / 30).toFixed(4)} ${(-atom.y / 30).toFixed(4)} 0.0 0${atom.formalCharge ? ` CHG=${atom.formalCharge}` : ""}`),
    "M  V30 END ATOM",
    "M  V30 BEGIN BOND",
    ...bonds.map((bond, index) => {
      const from = atoms.findIndex((atom) => atom.id === bond.fromAtomId) + 1;
      const to = atoms.findIndex((atom) => atom.id === bond.toAtomId) + 1;
      return `M  V30 ${index + 1} ${v3000Order[bond.order] ?? "1"} ${from} ${to}`;
    }),
    "M  V30 END BOND", "M  V30 END CTAB", "M  END"
  ].join("\n");
}

function save(document: ChemDraftDocument, atoms: readonly MoleculeAtom[], bonds: readonly MoleculeBond[]) {
  const molecule = dropMolecule(document);
  const selected = selectDocumentObject(document, molecule.id);
  return { selected, applied: applyEditorSaveResultWithLabelWarnings(selected, {
    object: { ...molecule, structureFormat: "molfile-v3000", structure: editorV3000(atoms, bonds) },
    warnings: []
  }) };
}

function withoutFirstAtom(molecule: MoleculeObject) {
  const [gone, ...atoms] = molecule.atoms;
  return { atoms, bonds: molecule.bonds.filter((bond) => bond.fromAtomId !== gone!.id && bond.toAtomId !== gone!.id) };
}

/** Boc-glycine N+ with its charge mark re-stored as a legacy bond-anchored mark on an N bond. */
function bondAnchoredCharge() {
  const { document, nitrogen } = electronMarkDropFixture();
  const molecule = dropMolecule(document), mark = dropMark(document);
  const bond = molecule.bonds.find((candidate) => candidate.fromAtomId === nitrogen.id || candidate.toAtomId === nitrogen.id)!;
  return normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
    anchor: { kind: "bond", objectId: molecule.id, bondId: bond.id }, atomAssociation: undefined
  } }, { now: phase4Timestamp }));
}

describe("Ketcher saves of a molecule with charge or radical marks", () => {
  it("refuses deleting an earlier atom: the marked N's id would name another atom", () => {
    const { document } = electronMarkDropFixture();
    const { atoms, bonds } = withoutFirstAtom(dropMolecule(document));
    const { selected, applied } = save(document, atoms, bonds);
    expect(applied.refusal).toBe(EDITOR_SAVE_MARKED_MOLECULE_REFUSAL);
    expect(applied.refusal).toMatch(/^This molecule has charge or radical marks; edit it on the canvas/);
    expect(applied.document).toBe(selected);
  });

  it("refuses the same edit when the mark is a legacy bond-anchored mark", () => {
    const document = bondAnchoredCharge();
    const { atoms, bonds } = withoutFirstAtom(dropMolecule(document));
    const { selected, applied } = save(document, atoms, bonds);
    expect(applied.refusal).toBe(EDITOR_SAVE_MARKED_MOLECULE_REFUSAL);
    expect(applied.document).toBe(selected);
  });

  it("refuses a delete-one-add-one edit that keeps the counts and N's element but changes its neighbours", () => {
    const { document, nitrogen } = electronMarkDropFixture();
    const molecule = dropMolecule(document);
    // Delete the hydroxyl O (last atom) and draw a new O bonded to N: counts and every element by
    // index are unchanged, but the atom at N's id now has an O neighbour.
    const gone = molecule.atoms[molecule.atoms.length - 1]!;
    expect(gone.element).toBe("O");
    const added: MoleculeAtom = { id: "new_o", element: "O", x: nitrogen.x, y: nitrogen.y + 22, formalCharge: 0 };
    const atoms = [...molecule.atoms.slice(0, -1), added];
    const bonds = [
      ...molecule.bonds.filter((bond) => bond.fromAtomId !== gone.id && bond.toAtomId !== gone.id),
      { id: "new_bond", fromAtomId: nitrogen.id, toAtomId: added.id, order: "single" } satisfies MoleculeBond
    ];
    expect(atoms).toHaveLength(molecule.atoms.length);
    expect(bonds).toHaveLength(molecule.bonds.length);
    const { selected, applied } = save(document, atoms, bonds);
    expect(applied.refusal).toBe(EDITOR_SAVE_MARKED_MOLECULE_REFUSAL);
    expect(applied.document).toBe(selected);
  });

  it("1.2.2 fallback: refuses a same-count bond-order change (was committed before the fallback)", () => {
    const { document, nitrogen } = electronMarkDropFixture();
    const molecule = dropMolecule(document);
    const before = molecule.atoms.find((atom) => atom.id === nitrogen.id)!;
    // The acid C=O becomes C–O: only a bond order changes.
    const target = molecule.bonds.find((bond) => bond.order === "double" &&
      molecule.atoms.findIndex((atom) => atom.id === bond.fromAtomId) > 7)!;
    expect(target).toBeDefined();
    const bonds = molecule.bonds.map((bond) => bond.id === target.id ? { ...bond, order: "single" as const } : bond);
    const { selected, applied } = save(document, molecule.atoms, bonds);
    expect(applied.refusal).toBe(EDITOR_SAVE_MARKED_MOLECULE_REFUSAL);
    expect(applied.document).toBe(selected);
    const after = dropMolecule(applied.document);
    expect(after.bonds.find((bond) => bond.id === target.id)?.order).toBe("double");
    expect(after.atoms.find((atom) => atom.id === nitrogen.id)).toMatchObject({ formalCharge: before.formalCharge, markCharge: 1 });
    expect(dropMark(applied.document).anchor).toMatchObject({ kind: "atom", atomId: nitrogen.id });
  });

  it("lets a molecule without marks delete atoms freely", () => {
    const { document: marked } = electronMarkDropFixture();
    const document = applyPatch(marked, { op: "removeObject", objectId: dropMark(marked).id }, { now: phase4Timestamp });
    const molecule = dropMolecule(document);
    const { atoms, bonds } = withoutFirstAtom(molecule);
    const { applied } = save(document, atoms, bonds);
    expect(applied.refusal).toBeUndefined();
    expect(dropMolecule(applied.document).atoms).toHaveLength(molecule.atoms.length - 1);
  });
});

describe("Ketcher Apply status", () => {
  const saved = { object: { id: "mol" }, warnings: [] } as unknown as EditorSaveResult;

  it("keeps a refusal on the status line: no success message after a refused edit", async () => {
    const statuses: string[] = [];
    const onApply = vi.fn(() => {
      statuses.push(EDITOR_SAVE_MARKED_MOLECULE_REFUSAL);
      return false;
    });
    const error = await applyKetcherSave({ saveObject: async () => saved }, onApply, (message) => statuses.push(message));
    expect(onApply).toHaveBeenCalledWith(saved);
    expect(error).toBeUndefined();
    expect(statuses).toEqual([EDITOR_SAVE_MARKED_MOLECULE_REFUSAL]);
  });

  it("reports success when the edit was applied", async () => {
    const statuses: string[] = [];
    await applyKetcherSave({ saveObject: async () => saved }, () => true, (message) => statuses.push(message));
    expect(statuses).toEqual(["Applied Ketcher molecule edit"]);
  });

  it("MainWindow reports the edit applied only when its commit went through (a page-size question or a refusal keeps its own status)", () => {
    const source = readFileSync(new URL("./MainWindow.tsx", import.meta.url), "utf8");
    const start = source.indexOf("const handleApplyKetcherEdit = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("}, [commitDocumentChangeWithPageFit]);", start));
    expect(body).toMatch(/const committed = commitDocumentChangeWithPageFit\(applied\.document,/);
    expect(body).toMatch(/if \(!committed\) return false;/);
    expect(body.indexOf("if (!committed) return false;")).toBeLessThan(body.lastIndexOf("return true;"));
  });

  it("reports a failed save and returns its message", async () => {
    const statuses: string[] = [];
    const onApply = vi.fn(() => true);
    const error = await applyKetcherSave({ saveObject: async () => { throw new Error("boom"); } }, onApply,
      (message) => statuses.push(message));
    expect(onApply).not.toHaveBeenCalled();
    expect(error).toBe("boom");
    expect(statuses).toEqual(["Ketcher save failed: boom"]);
  });
});
