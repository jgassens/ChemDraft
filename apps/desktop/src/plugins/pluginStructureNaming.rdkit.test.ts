import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { moleculeSmiles, verifyNameRoundTrip } from "@chemdraft/document-workflow-core";

import { createPhase4Document, createSmilesMolecule } from "../documentWorkflow";
import { registerRdkitWasmLoader } from "../rdkitWasmLoader";
import { loadNamingCanonicalizer, nameStructureForPlugin } from "./pluginStructureNaming";
import { fakeNamingEngine, namingInstalled, namingRaw } from "./structureNamingTestFixtures";

// Same loader substitution as pluginStructureRecognition.rdkit.test.ts: only the WASM source
// changes for Node. The host registers it and both sides use the real bundled RDKit canonicaliser.
vi.mock("../rdkitWasmLoader", async () => {
  const { installRealRdkitModuleLoader } = await import("@chemdraft/rdkit-adapter/testing");
  return { registerRdkitWasmLoader: vi.fn(() => installRealRdkitModuleLoader()) };
});

beforeEach(() => {
  resetRdkitForTesting();
  vi.mocked(registerRdkitWasmLoader).mockClear();
});

afterAll(() => resetRdkitForTesting());

function drawnMolecule(smiles: string) {
  const molecule = createSmilesMolecule(
    createPhase4Document(), { x: 200, y: 200 }, depictSmiles2D(smiles), smiles
  );
  if (molecule.type !== "molecule") throw new Error("Expected a native molecule.");
  return molecule;
}

function engineReading(smiles: string) {
  const engine = fakeNamingEngine();
  vi.mocked(engine.name).mockResolvedValue({
    ...namingRaw, opsinReadBack: { smiles, failureReason: null }
  });
  return engine;
}

describe("structure naming with the real host RDKit canonicaliser", () => {
  it.each([
    ["charge: glycine zwitterion versus neutral glycine", "[NH3+]CC(=O)[O-]", "NCC(=O)O"],
    ["stereo: L-alanine versus D-alanine", "N[C@@H](C)C(=O)O", "N[C@H](C)C(=O)O"],
    ["fragments: sodium benzoate versus benzoic acid", "[Na+].[O-]C(=O)c1ccccc1", "O=C(O)c1ccccc1"]
  ])("declines %s", async (_label, drawn, readBack) => {
    const molecule = drawnMolecule(drawn);
    const engine = engineReading(readBack);
    const result = await nameStructureForPlugin(molecule, engine, namingInstalled);

    expect(registerRdkitWasmLoader).toHaveBeenCalled();
    expect(engine.name).toHaveBeenCalledTimes(1);
    const canonical = await loadNamingCanonicalizer();
    // Check the reference itself, so an import/export loss cannot make a mismatch test pass
    // for an unrelated reason (especially an inverted wedge or a missing counterion).
    expect(engine.name).toHaveBeenCalledWith(await canonical.canonicalize(drawn));
    expect(result).toMatchObject({ status: "declined", code: "noVerifiedName" });
    expect(result).not.toHaveProperty("name");
  }, 60_000);

  it("names neutral pentavalent nitrobenzene using its verified charge-separated reference", async () => {
    const readBack = "O=[N+]([O-])c1ccccc1";
    const molecule = drawnMolecule(readBack);
    const nitrogen = molecule.atoms.find(atom => atom.element === "N")!;
    for (const atom of molecule.atoms) atom.formalCharge = 0;
    for (const bond of molecule.bonds) {
      const neighborId = bond.fromAtomId === nitrogen.id ? bond.toAtomId :
        bond.toAtomId === nitrogen.id ? bond.fromAtomId : undefined;
      if (molecule.atoms.some(atom => atom.id === neighborId && atom.element === "O")) {
        bond.order = "double";
      }
    }
    const engine = engineReading(readBack);
    vi.mocked(engine.name).mockResolvedValue({
      ...namingRaw, name: "nitrobenzene", opsinReadBack: { smiles: readBack, failureReason: null }
    });
    const canonical = await loadNamingCanonicalizer();
    const warnings: Parameters<typeof moleculeSmiles>[2] = [];
    const reference = await moleculeSmiles(molecule, 0, warnings, canonical.computeStructureIdentifiers);
    expect(reference).toBe(await canonical.canonicalize(readBack));
    expect(warnings).toEqual([expect.objectContaining({ code: "export.smiles_charge_separated", severity: "info" })]);

    const result = await nameStructureForPlugin(molecule, engine, namingInstalled);
    expect(engine.name).toHaveBeenCalledExactlyOnceWith(reference);
    expect(result).toMatchObject({ status: "named", name: "nitrobenzene" });
  }, 60_000);

  it("verifies a drawn methyl radical but declines a methane name read-back", async () => {
    const molecule = drawnMolecule("C");
    // The drawing tool records an associated radical dot as markRadicals; the SMILES depiction
    // interface does not carry radicals. Exercise that real native representation and M RAD write.
    molecule.atoms[0] = { ...molecule.atoms[0]!, markRadicals: 1 };
    const engine = engineReading("C");
    const result = await nameStructureForPlugin(molecule, engine, namingInstalled);

    const canonical = await loadNamingCanonicalizer();
    const warnings: Parameters<typeof moleculeSmiles>[2] = [];
    // M RAD carries one electron and RDKit's correspondence proves C / 3 H / 1 radical.
    expect(await moleculeSmiles(molecule, 0, warnings, canonical.computeStructureIdentifiers)).toBe("[CH3]");
    expect(warnings).toEqual([]);
    expect(engine.name).toHaveBeenCalledExactlyOnceWith("[CH3]");
    expect(result).toMatchObject({ status: "declined", code: "noVerifiedName" });
    expect(result).not.toHaveProperty("name");
  }, 60_000);

  it("declines [13CH3]O versus CO rather than naming a lost isotope", async () => {
    const canonical = await loadNamingCanonicalizer();
    const drawnCanonicalSmiles = await canonical.canonicalize("[13CH3]O");
    expect(drawnCanonicalSmiles).toBe("[13CH3]O");
    const readName = vi.fn(async () => ({ smiles: "CO" }));
    await expect(verifyNameRoundTrip({
      drawnCanonicalSmiles: drawnCanonicalSmiles!, name: "methanol", readName,
      canonicalize: canonical.canonicalize
    })).resolves.toMatchObject({ verified: false });
    expect(readName).toHaveBeenCalledWith("methanol");

    // MoleculeAtom has no isotope field. Keep the isotope visible as a typed atom label, as on
    // the canvas; pretending that the SMILES depiction retained it would test ordinary methanol.
    // The whole naming policy must refuse this unrepresentable label before requesting a name.
    const molecule = drawnMolecule("CO");
    molecule.atoms[0] = { ...molecule.atoms[0]!, element: "[13CH3]", labelLiteral: true };
    const engine = engineReading("CO");
    const result = await nameStructureForPlugin(molecule, engine, namingInstalled);
    expect(result).toMatchObject({ status: "declined", code: "structureNotExact" });
    expect(result).not.toHaveProperty("name");
    expect(engine.name).not.toHaveBeenCalled();
  }, 60_000);

  it("names ethanol when read-back OCC has different text but the same exact molecule", async () => {
    const molecule = drawnMolecule("CCO");
    const engine = engineReading("OCC");
    const result = await nameStructureForPlugin(molecule, engine, namingInstalled);

    expect(registerRdkitWasmLoader).toHaveBeenCalled();
    expect(engine.name).toHaveBeenCalledWith("CCO");
    expect(result).toMatchObject({ status: "named", name: "ethanol", warnings: [] });
    expect(result).toHaveProperty("verification.canonicalizer.id", "rdkit-minimallib");
  }, 60_000);
});
