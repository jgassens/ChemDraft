import { beforeEach, describe, expect, it, vi } from "vitest";
import { moleculeToMolfileV2000, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { copyAsMolfile, copyAsSmiles, createPhase4Document } from "./documentWorkflow";
import { moleculeSmiles } from "./moleculeSmiles";
import type { ExportWarning } from "@chemdraft/export-engine";
import { registerRdkitWasmLoader } from "./rdkitWasmLoader";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@chemdraft/rdkit-adapter/identifiers", () => ({ computeStructureIdentifiers: vi.fn() }));

function molecule(elements = ["C", "Phe"]): MoleculeObject {
  return {
    id: "mol", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: 0, style: {},
    structureFormat: "unknown", structure: "", superatoms: [], rGroups: [],
    atoms: elements.map((element, i) => ({ id: `a${i}`, element, x: i * 20, y: 0, formalCharge: 0 })),
    bonds: elements.slice(1).map((_, i) => ({ id: `b${i}`, fromAtomId: `a${i}`, toAtomId: `a${i + 1}`, order: "single" }))
  };
}
function documentWith(mol: MoleculeObject): ChemDraftDocument {
  const doc = createPhase4Document("Copy SMILES wording");
  return { ...doc, pages: [{ ...doc.pages[0], objects: [mol] }] };
}
function assertSmilesMessages(messages: string[]) {
  expect(messages.join(" ")).not.toMatch(/molfile|\bMOL\b|V2000|V3000|bond type|valence field/i);
}
beforeEach(() => {
  vi.mocked(computeStructureIdentifiers).mockReset().mockResolvedValue({ smiles: "*C" });
  vi.mocked(registerRdkitWasmLoader).mockReset();
});

describe("Copy As SMILES messages", () => {
  it("discloses the engine's placeholder loss as SMILES, while molfile wording stays unchanged", async () => {
    const doc = documentWith(molecule());
    const before = structuredClone(doc);
    const warnings: string[] = [];
    expect(await copyAsSmiles(doc, warnings)).toBe("*C");
    expect(warnings).toEqual([
      'Atom label "Phe" cannot be spelled as a single SMILES atom; written as a dummy atom [*].',
      'Atom label "Phe" is not an element symbol; written as a dummy atom (*) — the label\'s group is not represented in SMILES.'
    ]);
    assertSmilesMessages(warnings);
    for (const flavor of ["v2000", "v3000"] as const) {
      const molWarnings: string[] = [];
      copyAsMolfile(doc, flavor, molWarnings);
      expect(molWarnings).toEqual(['Atom label "Phe" is not an element symbol; written as a dummy atom (*) — the label\'s group is not represented in the molfile.']);
    }
    expect(doc).toEqual(before);
  });

  it.each(["NH2", "Ar"])("discloses the engine's %s placeholder loss", async (label) => {
    const mol = molecule(["C", label]);
    mol.atoms[1].labelLiteral = true;
    const warnings: string[] = [];
    expect(await copyAsSmiles(documentWith(mol), warnings)).toBe("*C");
    expect(warnings).toContainEqual(expect.stringContaining(`Atom label "${label}"`));
    expect(warnings).toContainEqual(expect.stringContaining("group is not represented in SMILES"));
    assertSmilesMessages(warnings);
  });

  it("reports the dative loss exactly once in terms of SMILES", async () => {
    const mol = molecule(["Zn", "C"]);
    mol.bonds[0].display = { bondStyle: "dashed" };
    const warnings: string[] = [];
    await copyAsSmiles(documentWith(mol), warnings);
    expect(warnings).toEqual([
      "SMILES has no dative/coordination bond: 1 dashed bond(s) written as plain single."
    ]);
    assertSmilesMessages(warnings);
  });

  it("changes only messages in the engine input writer", () => {
    const mol = molecule(["C", "Phe", "Zn"]);
    mol.bonds[1].display = { bondStyle: "dashed" };
    const options = { kekuleBondOrders: new Map<string, number>(), fromDocFrame: true };
    const original = moleculeToMolfileV2000(mol, options);
    const forSmiles = moleculeToMolfileV2000(mol, { ...options, messageFormat: "SMILES" });
    expect(forSmiles.contents).toBe(original.contents);
    expect(original.warnings).toEqual([
      "V2000 has no coordination bond type: 1 dative (dashed) bond written as plain single. Export V3000 to preserve it.",
      'Atom label "Phe" is not an element symbol; written as a dummy atom (*) — the label\'s group is not represented in the molfile.'
    ]);
    assertSmilesMessages(forSmiles.warnings);
  });

  it("reports dashed multiple-bond display without internal bond type codes", async () => {
    const mol = molecule(["C", "C"]);
    mol.bonds[0] = { ...mol.bonds[0], order: "double", display: { bondStyle: "dashed" } };
    const warnings: string[] = [];
    await copyAsSmiles(documentWith(mol), warnings);
    expect(warnings).toEqual(["Dashed display on a double bond is not a coordination bond; written to SMILES as double, dashed style not preserved."]);
  });

  it("reports unresolved aromatic interpretation and literal hydrogen uncertainty", async () => {
    const mol = molecule(["C", "C", "C", "C", "C"]);
    mol.atoms[0].labelLiteral = true;
    mol.bonds = mol.atoms.map((atom, i) => ({ id: `b${i}`, fromAtomId: atom.id, toAtomId: mol.atoms[(i + 1) % 5].id, order: "aromatic" }));
    const warnings: string[] = [];
    await copyAsSmiles(documentWith(mol), warnings);
    expect(warnings).toEqual([
      "Aromatic bonds at atoms a0, a1, a2, a3, a4 have no resolved Kekulé order; the structure engine interpreted them for SMILES. Hydrogen counts at literal atoms a0 could not be specified; the structure engine may add hydrogens."
    ]);
    assertSmilesMessages(warnings);
    vi.mocked(computeStructureIdentifiers).mockResolvedValue(undefined);
    const fallback: string[] = [];
    await copyAsSmiles(documentWith(mol), fallback);
    expect(fallback).toEqual(["5 aromatic bonds could not be resolved into alternating single and double bonds; written to SMILES as single."]);
  });

  it("reports a literal valence overflow as a hydrogen-count problem", async () => {
    const mol = molecule(Array.from({ length: 16 }, () => "C"));
    mol.atoms[0].labelLiteral = true;
    mol.bonds = mol.atoms.slice(1).map((atom, i) => ({ id: `b${i}`, fromAtomId: "a0", toAtomId: atom.id, order: "single" }));
    const warnings: string[] = [];
    await copyAsSmiles(documentWith(mol), warnings);
    expect(warnings).toEqual(['Literal atom "C" has a bond-order sum of 15, which the structure engine cannot receive exactly for SMILES; the engine may add hydrogens.']);
    assertSmilesMessages(warnings);
  });

  it.each(["engine load", "engine parse", "no identifiers", "no SMILES"])("keeps %s errors internal and reports fallback stereo loss", async (failure) => {
    if (failure === "engine load") vi.mocked(registerRdkitWasmLoader).mockImplementation(() => { throw new Error("V3000 molfile loader failure"); });
    if (failure === "engine parse") vi.mocked(computeStructureIdentifiers).mockRejectedValue(new Error("Invalid MOL file"));
    if (failure === "no identifiers") vi.mocked(computeStructureIdentifiers).mockResolvedValue(undefined);
    if (failure === "no SMILES") vi.mocked(computeStructureIdentifiers).mockResolvedValue({ inchi: "value" });
    const mol = molecule(["C", "C"]);
    mol.bonds[0].display = { bondStyle: "wedge" };
    const warnings: string[] = [];
    expect(await copyAsSmiles(documentWith(mol), warnings)).toBe("CC");
    expect(warnings).toEqual(["Stereochemistry could not be written to SMILES for molecule 1; the structure engine was unavailable."]);
    assertSmilesMessages(warnings);
  });

  it("refuses unknown orders before calling the engine", async () => {
    const mol = molecule(["C", "C"]);
    mol.bonds[0].order = "unknown";
    await expect(copyAsSmiles(documentWith(mol), [])).rejects.toThrow("Cannot write SMILES: bond b0 has an unknown bond order.");
    expect(computeStructureIdentifiers).not.toHaveBeenCalled();
  });

  it("preserves earlier warnings when the second molecule refuses conversion", async () => {
    const doc = documentWith(molecule());
    const refused = { ...molecule(["C", "C"]), id: "refused" };
    refused.bonds[0].order = "unknown";
    doc.pages[0].objects.push(refused);
    const warnings: string[] = [];
    await expect(copyAsSmiles(doc, warnings)).rejects.toThrow("Cannot write SMILES:");
    expect(warnings).toEqual([
      'Atom label "Phe" cannot be spelled as a single SMILES atom; written as a dummy atom [*].',
      'Atom label "Phe" is not an element symbol; written as a dummy atom (*) — the label\'s group is not represented in SMILES.'
    ]);
  });

  it("reports native double-bond stereo loss for the correct molecule index", async () => {
    const mol = molecule(["F", "C", "C", "F"]);
    mol.bonds[1].order = "double";
    const warnings: ExportWarning[] = [];
    expect(await moleculeSmiles(mol, 1, warnings, undefined)).toBe("FC=CF");
    expect(warnings.map((warning) => warning.message)).toEqual([
      "Stereochemistry could not be written to SMILES for molecule 2; the structure engine was unavailable."
    ]);
  });

  it("keeps the writer size error internal and returns the same native SMILES", async () => {
    const mol = molecule(Array.from({ length: 1000 }, () => "C"));
    mol.bonds = [];
    const warnings: string[] = [];
    expect(await copyAsSmiles(documentWith(mol), warnings)).toBe(Array.from({ length: 1000 }, () => "C").join("."));
    expect(warnings).toEqual([]);
    expect(computeStructureIdentifiers).not.toHaveBeenCalled();
  });

  it("reports expanded abbreviations and preserves engine output", async () => {
    const warnings: string[] = [];
    vi.mocked(computeStructureIdentifiers).mockResolvedValue({ smiles: "Cc1ccccc1" });
    expect(await copyAsSmiles(documentWith(molecule(["C", "Ph"])), warnings)).toBe("Cc1ccccc1");
    expect(warnings).toEqual(['Abbreviation "Ph" was written out as the atoms it stands for.']);
  });

  it.each([
    ["c1ccnc1", "Hydrogen count at aromatic atom a3 was inferred (not stated in the source; the only closed-shell reading) and written to SMILES."],
    ["c1cncn1", "Hydrogen counts at aromatic atoms a2, a4 were guessed using a closed-shell reading and written to SMILES."]
  ])("reports aromatic hydrogen interpretation for %s on native fallback", async (smiles, message) => {
    const graph = testMoleculeFromSmiles(smiles);
    const mol = { ...molecule(), atoms: graph.atoms, bonds: graph.bonds };
    const warnings: ExportWarning[] = [];
    expect(await moleculeSmiles(mol, 0, warnings, undefined)).toBeTruthy();
    expect(warnings.map((warning) => warning.message)).toEqual([message]);
  });

  it("reports a non-ring aromatic fallback and handles empty/stored SMILES silently", async () => {
    const mol = molecule(["C", "C"]);
    mol.bonds[0].order = "aromatic";
    const warnings: ExportWarning[] = [];
    expect(await moleculeSmiles(mol, 0, warnings, undefined)).toBe("CC");
    expect(warnings.map((warning) => warning.message)).toEqual(["1 aromatic bond outside any aromatic ring written to SMILES as single."]);
    const stored = { ...molecule(["C", "C"]), structureFormat: "smiles" as const, structure: "CC" };
    expect(await moleculeSmiles(stored, 0, [], undefined)).toBe("CC");
    const out: string[] = [];
    expect(await copyAsSmiles(createPhase4Document("Empty"), out)).toBeUndefined();
    expect(out).toEqual([]);
  });
});
