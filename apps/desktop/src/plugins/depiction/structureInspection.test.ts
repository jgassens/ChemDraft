import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BracketObjectSchema, createEmptyDocument, moleculeToMolfileV2000, moleculeToMolfileV3000,
  type MoleculeObject } from "@chemdraft/chem-core";
import { chemicalIdentitySource, createSmilesMolecule, pastedStructureDepictionFromMolfile } from "@chemdraft/document-workflow-core";
import { nativeMoleculeRings } from "@chemdraft/layout-engine";
import { PluginInspectStructureResultSchema, PluginRingsResultSchema } from "@chemdraft/plugin-api";
import { ensureRdkit, generateSmiles2DMolfile, resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import type { RequestDepictionBinding } from "@chemdraft/plugin-host";
import { inspectStructureInWorker } from "../../depiction2d/identityInspect";
import { IdentityWorkerUnavailableError } from "../../depiction2d/identityWorkerClient";
import { createStructureInspection } from "./structureInspection";

const providers = createStructureInspection(async (_format, value, reference, _signal, details) =>
  inspectStructureInWorker(await ensureRdkit(), value, reference, details));
const signal = new AbortController().signal;

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

function bindingFor(molecule: MoleculeObject): RequestDepictionBinding {
  const document = createEmptyDocument();
  return { document: { ...document, pages: [{ ...document.pages[0]!, objects: [molecule] }] },
    signal, revision: () => "graph-revision", check: () => {} };
}

async function draw(smiles: string) {
  const molfile = await generateSmiles2DMolfile(smiles);
  return createSmilesMolecule(createEmptyDocument(), { x: 140, y: 140 },
    pastedStructureDepictionFromMolfile(molfile), smiles);
}

describe("request structure inspection", () => {
  it("reports RDKit composition and preserves isotope, tetrahedral and alkene stereo in both source formats", async () => {
    const smiles = "[13CH3][C@H](F)/C=C/Br";
    const source = { format: "smiles", structure: smiles } as const;
    const result = await providers.inspectStructure({ kind: "serialized", source }, signal);
    expect(PluginInspectStructureResultSchema.safeParse(result).success).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toMatchObject({ source, heavyAtoms: 6, stereochemistry: [
      expect.stringMatching(/^atom \d+ \([RS]\)$/), expect.stringMatching(/^bond \d+-\d+ \(E\)$/)
    ] });
    expect(result.value.canonicalIsomericSmiles).toMatch(/13C/);
    expect(result.value.canonicalIsomericSmiles).toMatch(/@/);
    const molecule = await draw(smiles);
    const binding = bindingFor(molecule);
    const pinned = await providers.inspectStructure({ kind: "molecule", requestId: "r", pageId: binding.document.pages[0]!.id,
      objectId: molecule.id }, signal, binding);
    expect(PluginInspectStructureResultSchema.safeParse(pinned).success).toBe(true);
    expect(pinned).toMatchObject({ ok: true, value: { source: { format: "molfile-v3000", structure: expect.stringContaining("MASS=13") },
      canonicalIsomericSmiles: result.value.canonicalIsomericSmiles, formula: result.value.formula, heavyAtoms: 6 } });
    await expect(providers.inspectStructure({ kind: "serialized", source: { format: "smiles", structure: "CCO" } }, signal))
      .resolves.toMatchObject({ ok: true, value: { formula: "C2H6O", stereochemistry: [] } });
  });

  it.each(["or1", "and1"])("declines a pinned %s stereogroup before reporting absolute configuration", async group => {
    const molecule = await draw("F[C@H](Cl)C");
    molecule.compatibility = { warnings: [], unknown: { enhancedStereoByAtomId: { [molecule.atoms[1]!.id]: group } } };
    const binding = bindingFor(molecule);
    await expect(providers.inspectStructure({ kind: "molecule", requestId: "r", pageId: binding.document.pages[0]!.id,
      objectId: molecule.id }, signal, binding)).rejects.toMatchObject({ code: "unsupported", message: /stereo/i });
  });

  it("declines relative stereo retained only in an imported structure source", async () => {
    const smiles = "F[C@H](Cl)C |&1:1|";
    const original = await draw("F[C@H](Cl)C");
    const molfile = chemicalIdentitySource(original, [], "v3000").molfile.replace("M  V30 END CTAB",
      "M  V30 BEGIN COLLECTION\nM  V30 MDLV30/STERAC1 ATOMS=(1 2)\nM  V30 END COLLECTION\nM  V30 END CTAB");
    for (const source of [{ structureFormat: "molfile-v3000" as const, structure: molfile },
      { structureFormat: "smiles" as const, structure: smiles }]) {
      const binding = bindingFor({ ...original, ...source });
      await expect(providers.inspectStructure({ kind: "molecule", requestId: "r", pageId: binding.document.pages[0]!.id,
        objectId: original.id }, signal, binding)).rejects.toMatchObject({ code: "unsupported" });
    }
  });

  it("declines the repeat unit on the pinned page even when an earlier page reuses the molecule ID", async () => {
    const molecule = await draw("CCCCC");
    const binding = bindingFor(molecule);
    const page = binding.document.pages[0]!;
    const atoms = molecule.atoms.map((atom, i) => ({ ...atom, x: i * 20, y: 20 }));
    const open = BracketObjectSchema.parse({ id: "open", type: "bracket", bracketKind: "square", side: "open",
      pairId: "pair", repeatUnit: true, x: 10, y: 10, width: 2, height: 20 });
    binding.document.pages.push({ ...page, id: "polymer-page", objects: [
      { ...molecule, atoms }, open, { ...open, id: "close", side: "close", x: 70, label: "n" }
    ] });
    const input = { kind: "molecule" as const, requestId: "r", pageId: page.id, objectId: molecule.id };
    await expect(providers.inspectStructure(input, signal, binding)).resolves.toMatchObject({ ok: true, value: { formula: "C5H12" } });
    await expect(providers.inspectStructure({ ...input, pageId: "polymer-page" }, signal, binding))
      .rejects.toMatchObject({ code: "unsupported", message: /repeat unit/i });
  });

  it.each([
    ["molfile-v2000", moleculeToMolfileV2000],
    ["molfile-v3000", moleculeToMolfileV3000]
  ] as const)("declines a serialized %s repeat unit and still inspects plain pentane", async (format, writeMolfile) => {
    const molecule = await draw("CCCCC");
    molecule.atoms = molecule.atoms.map((atom, i) => ({ ...atom, x: i * 20, y: 20 }));
    const inspect = (structure: string) => providers.inspectStructure({ kind: "serialized", source: { format, structure } }, signal);
    const options = { kekuleBondOrders: new Map() };
    const repeatUnitGroups = [{ objectId: "repeat", label: "n", atomIds: molecule.atoms.slice(1, 4).map(atom => atom.id) }];
    await expect(inspect(writeMolfile(molecule, { ...options, repeatUnitGroups }).contents)).rejects.toMatchObject({ code: "unsupported",
      message: expect.stringContaining("repeat unit n; polymer formula not computed") });
    await expect(inspect(writeMolfile(molecule, options).contents))
      .resolves.toMatchObject({ ok: true, value: { formula: "C5H12" } });
  });

  it.each([
    ["COP", "ATOMS=(3 2 3 4) XBONDS=(2 1 4) LABEL=n", "copolymer group"],
    ["MUL", "ATOMS=(3 2 3 4) PATOMS=(3 2 3 4) MULT=3", "multiple group x3"]
  ])("declines a serialized V3000 %s group", async (type, attributes, description) => {
    const molecule = await draw("CCCCC");
    const structure = chemicalIdentitySource(molecule, [], "v3000").molfile
      .replace("COUNTS 5 4 0", "COUNTS 5 4 1")
      .replace("M  V30 END CTAB", `M  V30 BEGIN SGROUP\nM  V30 1 ${type} 0 ${attributes}\nM  V30 END SGROUP\nM  V30 END CTAB`);
    await expect(providers.inspectStructure({ kind: "serialized", source: { format: "molfile-v3000", structure } }, signal))
      .rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining(description) });
  });

  it("refuses mismatched molfile formats and structures above 500 heavy atoms", async () => {
    const structure = await generateSmiles2DMolfile("CO");
    await expect(providers.inspectStructure({ kind: "serialized", source: { format: "molfile-v3000", structure } }, signal))
      .rejects.toMatchObject({ code: "invalid" });
    await expect(providers.inspectStructure({ kind: "serialized", source: { format: "smiles", structure: "C.".repeat(500) + "C" } }, signal))
      .rejects.toMatchObject({ code: "limit" });
  });

  it("refuses relative stereo that canonical isomeric SMILES cannot represent", async () => {
    await expect(providers.inspectStructure({
      kind: "serialized", source: { format: "smiles", structure: "F[C@H](Cl)C |&1:1|" }
    }, signal)).rejects.toMatchObject({ code: "chemistry", message: expect.stringContaining("relative stereochemistry") });
  });

  it("rejects other serialized formats declared as SMILES before asking RDKit", async () => {
    const mol = (await ensureRdkit()).get_mol("CCO")!;
    let json: string;
    try { json = mol.get_json!(); } finally { mol.delete(); }
    const inspect = vi.fn();
    for (const structure of [json, "InChI=1S/CH4/h1H4", await generateSmiles2DMolfile("CO")]) {
      await expect(createStructureInspection(inspect).inspectStructure({ kind: "serialized",
        source: { format: "smiles", structure } }, signal)).rejects.toMatchObject({ code: "invalid" });
    }
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(["2501 0", "1 5001"])("preflights oversized V3000 counts %s before the worker", async counts => {
    const structure = ["molecule", "", "", "  0  0  0  0  0  0            999 V3000",
      "M  V30 BEGIN CTAB", `M  V30 COUNTS ${counts} 0 0 0`, "M  V30 END CTAB", "M  END"].join("\n");
    const inspect = vi.fn();
    await expect(createStructureInspection(inspect).inspectStructure({ kind: "serialized",
      source: { format: "molfile-v3000", structure } }, signal)).rejects.toMatchObject({ code: "limit" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(["atoms", "bonds"] as const)("refuses ring mappings with duplicate IDs in %s", async field => {
    const molecule = await draw("c1ccc2ccccc2c1");
    molecule[field][1]!.id = molecule[field][0]!.id;
    const binding = bindingFor(molecule);
    for (const representation of ["chemical", "drawable", "both"] as const) {
      await expect(providers.rings({ requestId: "r", pageId: binding.document.pages[0]!.id,
        objectId: molecule.id, representation }, binding)).rejects.toMatchObject({ code: "chemistry", message: /unique/ });
    }
  });

  it("returns an unavailable error when the identity worker cannot load RDKit", async () => {
    const unavailable = createStructureInspection(async () => { throw new IdentityWorkerUnavailableError("Engine could not load."); });
    await expect(unavailable.inspectStructure({ kind: "serialized", source: { format: "smiles", structure: "C" } }, signal))
      .rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("RDKit") });
  });

  it("gets inspection details through the shared off-thread transport", async () => {
    const result = await createStructureInspection().inspectStructure({
      kind: "serialized", source: { format: "smiles", structure: "CCO" }
    }, signal);
    expect(result).toMatchObject({ ok: true, value: { formula: "C2H6O", heavyAtoms: 3, stereochemistry: [] } });
  });

  it.each([
    ["naphthalene", "c1ccc2ccccc2c1", [6, 6]],
    ["steroid core", "C1CCC2C3CCC4CCCCC4C3CCC12", [5, 6, 6, 6]]
  ] as const)("returns chemical cycles and independently styleable faces for %s", async (_name, smiles, sizes) => {
    const original = await draw(smiles);
    const molecule = { ...original, bonds: [...original.bonds].reverse() };
    const binding = bindingFor(molecule);
    const input = { requestId: "r", pageId: binding.document.pages[0]!.id, objectId: molecule.id };
    const result = await providers.rings(input, binding);
    expect(PluginRingsResultSchema.safeParse(result).success).toBe(true);
    if (!result.ok || result.value.representation !== "both") throw new Error("Expected both ring representations.");
    const { chemicalRings, drawableRings, revision } = result.value;
    expect(revision).toBe("graph-revision");
    expect(chemicalRings.map(ring => ring.atomIds.length).sort()).toEqual(sizes);
    const nativeBond = new Map(molecule.bonds.map(bond => [bond.id, bond]));
    for (const ring of chemicalRings) {
      expect(ring).not.toHaveProperty("key");
      for (const [index, id] of ring.bondIds.entries()) {
        const bond = nativeBond.get(id)!;
        expect([bond.fromAtomId, bond.toAtomId].sort())
          .toEqual([ring.atomIds[index], ring.atomIds[(index + 1) % ring.atomIds.length]].sort());
      }
    }
    expect(drawableRings).toEqual(nativeMoleculeRings(molecule).map(({ ringKey, atomIds, bondIds }) =>
      ({ key: ringKey, atomIds, bondIds })));
    expect(drawableRings.every(ring => ring.key === [...ring.bondIds].sort().join("|"))).toBe(true);
    expect(chemicalRings.some((ring, index) => chemicalRings.some((other, otherIndex) =>
      index !== otherIndex && other.bondIds.some(id => ring.bondIds.includes(id))))).toBe(true);
    await expect(providers.rings({ ...input, representation: "drawable" }, binding))
      .resolves.toMatchObject({ ok: true, value: { representation: "drawable", rings: drawableRings } });
  });

  it("does not invent a drawable key for the sixth RDKit ring in cubane", async () => {
    const molecule = await draw("C12C3C4C1C5C2C3C45");
    const binding = bindingFor(molecule);
    const result = await providers.rings({ requestId: "r", pageId: binding.document.pages[0]!.id,
      objectId: molecule.id }, binding);
    if (!result.ok || result.value.representation !== "both") throw new Error("Expected both ring representations.");
    expect(result.value.chemicalRings).toHaveLength(6);
    expect(result.value.drawableRings).toHaveLength(5);
  });
});
