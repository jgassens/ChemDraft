import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyDocument, nativeDrawingStyleFromObjectStyle, type ChemDraftDocument, type MoleculeObject, type ReactionObject } from "@chemdraft/chem-core";
import { chemicalIdentityMolfile } from "@chemdraft/document-workflow-core";
import { planBondExtension } from "@chemdraft/layout-engine";
import { ensureRdkit, resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import { PluginHandoffGraphResultSchema } from "@chemdraft/plugin-api";
import { createChemistry3dProviders } from "../chemistry3d/client";
import { runChemistry3dJob } from "../chemistry3d/protocol";
import { prepareHandoffGraph, suggestConnectionPointsForPlugin } from "./handoffGraph";

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

const request = { objectId: "m1" };
const signal = () => new AbortController().signal;
const providers = createChemistry3dProviders(job => runChemistry3dJob(job));
const frame = { x: 50, y: 50, width: 200, height: 160, rotation: 0, style: {} };

function molecule(elements: string[], links: [number, number, MoleculeObject["bonds"][number]["order"]?][] = []): MoleculeObject {
  return { ...frame, id: request.objectId, type: "molecule", structure: "CC", structureFormat: "smiles",
    atoms: elements.map((element, i) => ({ id: `a${i}`, x: 80 + 30 * i, y: i % 2 ? 80 : 100, element, formalCharge: 0 })),
    bonds: links.map(([a, b, order = "single"], i) => ({ id: `b${i}`, fromAtomId: `a${a}`, toAtomId: `a${b}`, order })),
    superatoms: [], rGroups: [] };
}

function selected(mol: MoleculeObject, ...additional: ReactionObject[]): ChemDraftDocument {
  const doc = createEmptyDocument({ id: "d1", pageId: "p1" });
  doc.pages[0]!.objects.push(mol, ...additional);
  doc.selection = { objectIds: [mol.id], pageId: doc.pages[0]!.id };
  return doc;
}

async function audit(doc: ChemDraftDocument) {
  const result = await runChemistry3dJob({ method: "handoffGraph", request: prepareHandoffGraph(request, doc) });
  return PluginHandoffGraphResultSchema.parse(result);
}

describe("selected handoff graph from the live drawing", () => {
  it("reports RDKit's unspecified centers and either double bonds in graph order", async () => {
    const mol = molecule(["C", "F", "Cl", "Br", "C", "C", "C", "C"], [[0, 1], [0, 2], [0, 3], [4, 5], [5, 6, "double"], [6, 7]]);
    mol.bonds[4]!.stereo = "either";
    mol.bonds[0]!.display = { bondStyle: "wavy" };
    const result = await audit(selected(mol));
    expect(result.unspecifiedStereocenters).toEqual([0]);
    expect(result.unspecifiedDoubleBonds).toEqual([4]);
    expect(result.graph.bonds[0]).toMatchObject({ drawnStereo: { style: "wavy", from: 0 } });
    expect(result.graph.bonds[4]).toMatchObject({ a: 5, b: 6, order: 2, stereo: "either" });
  });

  it("uses RDKit to find a potential double bond with no explicit either flag", async () => {
    const mol = molecule(["C", "C", "C", "C"], [[0, 1], [1, 2, "double"], [2, 3]]);
    mol.atoms.forEach(atom => { atom.y = 100; });
    expect((await audit(selected(mol))).unspecifiedDoubleBonds).toEqual([1]);
    const symmetric = molecule(["C", "C", "C"], [[0, 1], [1, 2, "double"]]);
    expect((await audit(selected(symmetric))).unspecifiedDoubleBonds).toEqual([]);
  });

  it("retains native reaction roles, opaque CDXML mappings, and CTAB map numbers with source indices", async () => {
    const mol = molecule(["C", "O"], [[0, 1]]);
    const ctab = chemicalIdentityMolfile(mol).split("\n");
    ctab[4] = ctab[4]!.slice(0, 60) + "  7" + ctab[4]!.slice(63);
    mol.structureFormat = "molfile-v2000";
    mol.structure = ctab.join("\n");
    const reaction: ReactionObject = { ...frame, type: "reaction", id: "reaction", mappingState: "unknown",
      components: [{ objectId: mol.id, role: "reactant" }, { objectId: "other", role: "product" }],
      conditionsTextObjectIds: ["condition"], compatibility: { warnings: [], unknown: {
        cdxmlStepAttributes: { ReactionStepAtomMap: "101 301", ReactionStepAtomMapManual: "101 301" }
      } } };
    const result = await audit(selected(mol, reaction));
    expect(result.reactionMembership).toEqual([{ reactionId: "reaction", role: "reactant", mappingState: "unknown",
      atomMaps: [{ attribute: "ReactionStepAtomMap", value: "101 301" }, { attribute: "ReactionStepAtomMapManual", value: "101 301" }]
    }]);
    expect(result.sourceAtomMaps).toEqual([{ atom: 1, map: 7 }]);
    expect(result.canonicalSmiles).toBe("CO");
  });

  it("refuses radical, unknown-bond and writer losses with specific reasons", () => {
    const radical = molecule(["C"]);
    radical.atoms[0]!.markRadicals = 3;
    expect(() => prepareHandoffGraph(request, selected(radical))).toThrow(/a0 has 3 radical electrons/);
    const unknown = molecule(["C", "O"], [[0, 1, "unknown"]]);
    expect(() => prepareHandoffGraph(request, selected(unknown))).toThrow(/b0/);
    expect(() => prepareHandoffGraph(request, selected(molecule(["C", "Ome"], [[0, 1]])))).toThrow(/"Ome"/);
    expect(() => prepareHandoffGraph(request, selected(molecule([])))).toThrow(/no live drawn graph.*fallback/);
    expect(() => prepareHandoffGraph(request, selected(molecule(Array.from({ length: 1000 }, () => "C")))))
      .toThrow(/V2000 supports at most 999 atoms.*fallback/);
  });

  it("expands known labels, preserves isotopes, H counts, charges and radicals, and matches drawn canonical SMILES", async () => {
    const mol = molecule(["C", "OMe", "D", "Na", "O", "C"], [[0, 1], [0, 2]]);
    mol.atoms[3]!.formalCharge = 1;
    mol.atoms[4]!.formalCharge = -1;
    mol.atoms[5]!.markRadicals = 1;
    const result = await audit(selected(mol));
    const independent = (await ensureRdkit()).get_mol(chemicalIdentityMolfile(mol), '{"removeHs":false}')!;
    try { expect(result.canonicalSmiles).toBe(independent.get_smiles!()); }
    finally { independent.delete(); }
    expect(result.canonicalSmiles).not.toBe(mol.structure);
    expect(result.expandedLabels).toEqual([{ label: "OMe", atomId: "a1" }]);
    expect(result.graph.atoms).toHaveLength(7);
    expect(result.graph.atoms[0]).toMatchObject({ explicitHydrogenCount: 1, hydrogenCount: 2 });
    expect(result.graph.atoms[1]).toMatchObject({ drawnLabel: "OMe", element: "O" });
    expect(result.graph.atoms[2]).toMatchObject({ drawnLabel: "D", element: "H", isotope: 2 });
    expect(result.graph.atoms[3]).toMatchObject({ element: "Na", charge: 1 });
    expect(result.graph.atoms[5]).toMatchObject({ radicalElectrons: 1 });
  });

  it("keeps exact X placeholders separate from R-groups and preserves replacements through graph embedding", async () => {
    const mol = molecule(["C", "C", "C", "C", "C", "C", "X", "X"],
      [[0, 1, "aromatic"], [1, 2, "aromatic"], [2, 3, "aromatic"], [3, 4, "aromatic"],
        [4, 5, "aromatic"], [5, 0, "aromatic"], [0, 6], [3, 7]]);
    const graph = (await audit(selected(mol))).graph;
    expect(graph.atoms.filter(atom => atom.isConnectionPoint).map(atom => atom.drawnLabel)).toEqual(["X", "X"]);
    await expect(providers.embed3d({ components: [{ graph }] }, signal())).rejects.toThrow(/replace connection point/);
    const input = { ...graph, atoms: graph.atoms.map(atom => atom.isConnectionPoint ? { ...atom, element: "H" } : atom) };
    const embedded = await providers.embed3d({ components: [{ graph: input }, { smiles: "O" }] }, signal());
    expect(embedded.model.atoms.slice(0, 8).map(atom => [atom.element, atom.addedHydrogen]))
      .toEqual([...Array.from({ length: 6 }, () => ["C", false]), ["H", false], ["H", false]]);
    expect(embedded.model.bonds.filter(bond => bond.order === "aromatic")).toHaveLength(6);
    const minimized = await providers.minimize3d({ model: embedded.model, interfragment: false }, signal());
    expect(minimized.model.atoms).toEqual(embedded.model.atoms);
    expect(minimized.model.bonds).toEqual(embedded.model.bonds);
    mol.atoms[7]!.element = "R1";
    expect(() => prepareHandoffGraph(request, selected(mol))).toThrow(/"R1"/);
  });

  it("preserves assigned stereo when graph order is different from canonical SMILES traversal", async () => {
    const mol = molecule(["Br", "Cl", "F", "C"], [[3, 0], [3, 1], [3, 2]]);
    mol.atoms[0] = { ...mol.atoms[0]!, x: 50, y: 140 };
    mol.atoms[1] = { ...mol.atoms[1]!, x: 115, y: 140 };
    mol.atoms[2] = { ...mol.atoms[2]!, x: 80, y: 65 };
    mol.atoms[3] = { ...mol.atoms[3]!, x: 80, y: 100 };
    mol.bonds[0]!.display = { bondStyle: "wedge" };
    const result = await audit(selected(mol));
    expect(result.canonicalSmiles).toContain("@");
    expect(result.graph.atoms[3]!.stereo).toBeDefined();
    const embedded = await providers.embed3d({ components: [{ graph: result.graph }] }, signal());
    expect(embedded.model.atoms.slice(0, 4).map(atom => atom.element)).toEqual(["Br", "Cl", "F", "C"]);
    const flat = await providers.flatten3d({ model: embedded.model, view: "auto" }, signal());
    expect(flat.objects[0]).toMatchObject({ type: "molecule" });
  });

  it("refuses a graph that RDKit cannot sanitize", async () => {
    const atom = { element: "C", charge: 0, radicalElectrons: 0, hydrogenCount: 5 };
    await expect(providers.embed3d({ components: [{ graph: { atoms: [atom], bonds: [] } }] }, signal()))
      .rejects.toThrow(/could not sanitize/);
  });

  it("carries specified E/Z through graph embedding and minimization", async () => {
    const mol = molecule(["C", "C", "C", "C"], [[0, 1], [1, 2, "double"], [2, 3]]);
    ([[50, 140], [80, 110], [110, 110], [140, 80]] as const).forEach(([x, y], i) => Object.assign(mol.atoms[i]!, { x, y }));
    const result = await audit(selected(mol));
    expect(result.canonicalSmiles).toBe("C/C=C/C");
    expect(result.unspecifiedDoubleBonds).toEqual([]);
    expect(result.graph.bonds[1]).toMatchObject({ stereo: "trans", stereoAtoms: [0, 3] });
    const embedded = await providers.embed3d({ components: [{ graph: result.graph }] }, signal());
    const minimized = await providers.minimize3d({ model: embedded.model, interfragment: false }, signal());
    expect(minimized.model.components[0]!.smiles).toBe(result.canonicalSmiles);
  });

  it("places new X atoms with the bond tool's styled click direction and rejects unknown anchors", () => {
    const mol = molecule(["C", "C"], [[0, 1]]);
    const doc = selected(mol);
    const page = doc.pages[0]!;
    const style = nativeDrawingStyleFromObjectStyle(mol.style);
    const plan = planBondExtension({ atoms: mol.atoms, bonds: mol.bonds, clickPoint: mol.atoms[1]!,
      bondLength: style.bondLengthPx, targetBondAngleDegrees: style.chainAngleDegrees,
      preferredAtomId: "a1", hitRadius: 8, pageBounds: { x: 0, y: 0, width: page.width, height: page.height } });
    const result = suggestConnectionPointsForPlugin({ ...request, anchors: ["a1", "a0"] }, doc);
    expect(result.points[0]).toEqual({ anchorAtomId: "a1", ...plan!.newAtomPoint });
    expect(result.points[1]!.anchorAtomId).toBe("a0");
    expect(() => suggestConnectionPointsForPlugin({ ...request, anchors: ["unknown"] }, doc)).toThrow(/unknown/);
    expect(mol.atoms).toHaveLength(2);
  });
});
