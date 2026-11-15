import { describe, expect, it } from "vitest";
import { MoleculeBondSchema, MoleculeObjectSchema } from "./schemas";
import { createEmptyDocument, deserializeDocument, serializeDocument } from "./document";
import { moleculeToMolfileV2000, moleculeToMolfileV3000 } from "./molfile";
import { snapshotChemicalIdentity, diffChemicalIdentity } from "./identity";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { depictSmiles2D, perceiveStereoCentersFromMolfile, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import { computeStructureIdentifiers } from "../../rdkit-adapter/src/identifiers";
import { installNodeRdkitModuleLoader } from "../../rdkit-adapter/src/node";
import { flattenPerspectiveFrom3D } from "./perspective";

const options = { kekuleBondOrders: new Map<string, number>() };
function molecule() {
  return MoleculeObjectSchema.parse({
    id: "m", type: "molecule", x: 0, y: 0, width: 100, height: 100,
    structureFormat: "smiles", structure: "F[C@](Cl)(Br)I",
    atoms: [
      { id: "c", element: "C", x: 50, y: 50 },
      { id: "f", element: "F", x: 20, y: 50 },
      { id: "cl", element: "Cl", x: 50, y: 20 },
      { id: "br", element: "Br", x: 80, y: 50 },
      { id: "i", element: "I", x: 50, y: 80 }
    ],
    bonds: ["f", "cl", "br", "i"].map((id, index) => ({
      id: `b${index}`, fromAtomId: "c", toAtomId: id, order: "single",
      ...(index === 0 ? { display: { bondStyle: "wavy" } } : {})
    }))
  });
}

describe("wavy single-bond either stereo", () => {
  it.each(["CC", "CC(C)F"])("round-trips a wave on non-stereogenic %s without changing canonical SMILES", async smiles => {
    installNodeRdkitModuleLoader();
    const depiction = depictSmiles2D(smiles);
    const plain = MoleculeObjectSchema.parse({ ...molecule(), structure: smiles,
      atoms: depiction.atoms.map((atom, i) => ({ id: `a${i}`, element: atom.element, x: atom.x + 0, y: atom.y + 0 })),
      bonds: depiction.bonds.map((bond, i) => ({ id: `b${i}`, fromAtomId: `a${bond.from}`, toAtomId: `a${bond.to}`, order: bond.order }))
    });
    const carbon = plain.atoms.find(atom => atom.element === "C" &&
      plain.bonds.filter(bond => bond.fromAtomId === atom.id || bond.toAtomId === atom.id).length === (smiles === "CC" ? 1 : 3))!;
    const mol = structuredClone(plain);
    const marked = mol.bonds.find(bond => bond.fromAtomId === carbon.id || bond.toAtomId === carbon.id)!;
    if (marked.fromAtomId !== carbon.id) [marked.fromAtomId, marked.toAtomId] = [marked.toAtomId, marked.fromAtomId];
    marked.display = { bondStyle: "wavy" };
    const doc = createEmptyDocument();
    doc.pages[0]!.objects = [mol];
    expect(deserializeDocument(serializeDocument(doc)).pages[0]!.objects[0]).toEqual(mol);
    for (const write of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
      const contents = write(mol, options).contents;
      const reparsed = parseMolfileGraph(contents);
      const markedIndex = mol.bonds.indexOf(marked);
      expect(reparsed.bonds[markedIndex]).toMatchObject({
        fromAtomId: reparsed.atoms[mol.atoms.findIndex(atom => atom.id === marked.fromAtomId)]!.id,
        toAtomId: reparsed.atoms[mol.atoms.findIndex(atom => atom.id === marked.toAtomId)]!.id,
        order: "single", bondStyle: "wavy"
      });
      expect(perceiveStereoCentersFromMolfile(contents).every(atom => atom.descriptor === "unspecified")).toBe(true);
      const expected = (await computeStructureIdentifiers(write(plain, options).contents))?.smiles;
      expect(expected).toBeTruthy();
      expect((await computeStructureIdentifiers(contents))?.smiles).toBe(expected);
      const restored = MoleculeObjectSchema.parse({ ...mol,
        atoms: reparsed.atoms,
        bonds: reparsed.bonds.map(bond => ({ id: bond.id, fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, order: bond.order,
          ...(bond.bondStyle ? { display: { bondStyle: bond.bondStyle } } : {}) }))
      });
      expect(write(restored, options).contents).toBe(contents);
    }
  });

  it("rejects every other order at the style field, retaining additive v1 round trips", () => {
    const mol = molecule();
    const bond = mol.bonds[0]!;
    for (const order of ["double", "triple", "aromatic", "unknown"]) {
      const result = MoleculeBondSchema.safeParse({ ...bond, order });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ["display", "bondStyle"], message: 'Bond style "wavy" is valid only for a single bond.'
      }));
    }
    const doc = createEmptyDocument();
    doc.pages[0]!.objects = [mol];
    const saved = serializeDocument(doc);
    expect(saved).toContain('"chemdraft.document.v1"');
    expect(serializeDocument(deserializeDocument(saved))).toBe(saved);
    expect(deserializeDocument(saved).pages[0]!.objects[0]).toEqual(mol);
  });

  it("records the directed unknown marker in chemical identity", () => {
    const mol = molecule();
    const before = snapshotChemicalIdentity(mol);
    expect(before.graph.stereoMarkers[0]?.style).toBe("wavy");
    mol.bonds[0]!.display!.bondStyle = "wedge";
    expect(diffChemicalIdentity(before, snapshotChemicalIdentity(mol)).verdict).toBe("changed");
  });

  it.each(["V2000", "V3000"] as const)("writes %s either at from, reparses, and gives no CIP or SMILES chirality", async (format) => {
    installNodeRdkitModuleLoader();
    const mol = molecule();
    const write = format === "V2000" ? moleculeToMolfileV2000 : moleculeToMolfileV3000;
    const wave = write(mol, options).contents;
    if (format === "V2000") expect(wave.split("\n")[9]!.slice(0, 12)).toBe("  1  2  1  4");
    else expect(wave).toContain("M  V30 1 1 1 2 CFG=2");
    expect(parseMolfileGraph(wave).bonds[0]).toMatchObject({ bondStyle: "wavy", order: "single" });
    expect(perceiveStereoCentersFromMolfile(wave)[0]).toMatchObject({ descriptor: "unspecified" });
    const identifiers = await computeStructureIdentifiers(wave);
    expect(identifiers?.smiles).toBeTruthy();
    expect(identifiers!.smiles).not.toContain("@");
    mol.bonds[0]!.display!.bondStyle = "wedge";
    const wedge = write(mol, options).contents;
    expect(perceiveStereoCentersFromMolfile(wedge)[0]!.descriptor).toMatch(/^[RS]$/);
    expect((await computeStructureIdentifiers(wedge))?.smiles).toContain("@");
    mol.bonds[0]!.display!.bondStyle = "wavy";
    mol.bonds[0]!.display!.bondStyle = "wedge";
    expect(write(mol, options).contents).toBe(wedge);
  });

  it("keeps explicit unknown through OCL re-layout and overrides another wedge at that centre", async () => {
    installNodeRdkitModuleLoader();
    const mol = molecule();
    mol.bonds[1]!.display = { bondStyle: "hashed" };
    const source = moleculeToMolfileV2000(mol, options).contents;
    expect(perceiveStereoCentersFromMolfile(source)[0]!.descriptor).toBe("unspecified");
    expect((await computeStructureIdentifiers(source))?.smiles).not.toContain("@");
    const laidOut = relayoutMolfile2D(source);
    expect(laidOut.bonds.find((bond) => bond.wedge === "wavy")).toMatchObject({ from: 0, to: 1 });
    expect(perceiveStereoCentersFromMolfile(laidOut.molfile)[0]!.descriptor).toBe("unspecified");
  });

  it.each([false, true])("leaves another specified centre unchanged (wave between centres: %s)", async (betweenCentres) => {
    installNodeRdkitModuleLoader();
    const depiction = depictSmiles2D("F[C@H](Cl)[C@H](Br)I");
    const mol = MoleculeObjectSchema.parse({ ...molecule(),
      atoms: depiction.atoms.map((atom, i) => ({ id: `a${i}`, element: atom.element, x: atom.x, y: atom.y, formalCharge: atom.charge })),
      bonds: depiction.bonds.map((bond, i) => ({ id: `b${i}`, fromAtomId: `a${bond.from}`, toAtomId: `a${bond.to}`, order: bond.order,
        ...(bond.wedge ? { display: { bondStyle: bond.wedge } } : {}) }))
    });
    const before = perceiveStereoCentersFromMolfile(moleculeToMolfileV2000(mol, options).contents);
    const marked = betweenCentres ? mol.bonds.find(bond => {
      const from = mol.atoms.findIndex(atom => atom.id === bond.fromAtomId), to = mol.atoms.findIndex(atom => atom.id === bond.toAtomId);
      return before[from]?.descriptor !== "unspecified" && before[to]?.descriptor !== "unspecified";
    })! : mol.bonds.find(bond => bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed")!;
    const unknownIndex = mol.atoms.findIndex(atom => atom.id === marked.fromAtomId);
    marked.display = { bondStyle: "wavy" };
    const contents = moleculeToMolfileV2000(mol, options).contents;
    const after = perceiveStereoCentersFromMolfile(contents);
    expect(after[unknownIndex]!.descriptor).toBe("unspecified");
    expect(before.filter(a => a.descriptor !== "unspecified")).toHaveLength(2);
    after.forEach((a, index) => { if (index !== unknownIndex) expect(a).toEqual(before[index]); });
    expect((await computeStructureIdentifiers(contents))!.smiles!.match(/@@?/g)).toHaveLength(1);
  });

  it("never derives a wedge from 3D at an explicitly unknown centre", () => {
    const mol = molecule();
    mol.bonds[1]!.display = { bondStyle: "wedge" };
    const result = flattenPerspectiveFrom3D(mol,
      [0, 0, 0, -1, 0, 1, 0, 1, -1, 1, 0, 1, 0, -1, -1],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(result.status).toBe("committed");
    expect(result.mol2dProjected!.bonds[0]!.display?.bondStyle).toBe("wavy");
    expect(result.mol2dProjected!.bonds.some(bond => ["wedge", "hashed"].includes(bond.display?.bondStyle ?? ""))).toBe(false);
  });
});
