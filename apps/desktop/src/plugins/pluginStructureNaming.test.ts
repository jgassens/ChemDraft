import { describe, expect, it, vi } from "vitest";
import { PluginStructureToNameResultSchema } from "@chemdraft/plugin-api";
import { nameStructure, verifyNameRoundTrip } from "@chemdraft/document-workflow-core";
import { createPhase4Document } from "../documentWorkflow";
import { nameStructureForPlugin, namingReadBack, scopedNamingMolecule } from "./pluginStructureNaming";
import { fakeNamingEngine, namingInstalled, namingMolecule, namingRaw } from "./structureNamingTestFixtures";

describe("pluginStructureNaming uses the real naming policy", () => {
  it("returns a named PIN with host labels and exact provenance", async () => {
    const result = await nameStructureForPlugin(namingMolecule, fakeNamingEngine(), namingInstalled,
      { canonicalize: async () => "CCO", version: "loaded-version" });
    expect(result).toMatchObject({ status: "named", name: "ethanol", kindLabel: "Preferred IUPAC name",
      engine: { commit: namingInstalled.installed!.orthonymCommit },
      verification: { canonicalizer: { version: "loaded-version" } } });
    expect(PluginStructureToNameResultSchema.safeParse(result).success).toBe(true);
  });
  it("declines the glycine zwitterion when OPSIN reads neutral glycine", async () => {
    const engine = fakeNamingEngine();
    vi.mocked(engine.name).mockResolvedValue({ ...namingRaw, name: "glycine", opsinReadBack: { smiles: "NCC(=O)O", failureReason: null } });
    const result = await nameStructureForPlugin(namingMolecule, engine, namingInstalled, {
      version: "loaded-version", canonicalize: async structure => structure === "NCC(=O)O" ? structure : "[NH3+]CC(=O)[O-]"
    });
    expect(result).toMatchObject({ status: "declined", code: "noVerifiedName" });
    expect(result).not.toHaveProperty("name");
  });
  it("a read-back cannot be used for any other name", async () => {
    const result = await nameStructure({ canonicalize: async () => "CCO", name: async () => namingRaw,
      readName: async name => namingReadBack({ ...namingRaw, name: "another name" }, name) }, namingMolecule);
    expect(result).toMatchObject({ status: "declined", code: "noVerifiedName" });
    expect(await verifyNameRoundTrip({ drawnCanonicalSmiles: "CCO", name: "other", canonicalize: async () => "CCO",
      readName: async name => namingReadBack(namingRaw, name) })).toMatchObject({ verified: false });
  });
  it("native failure stays a failure, not a chemical decline", async () => {
    const engine = fakeNamingEngine();
    vi.mocked(engine.name).mockRejectedValue({ code: "timeout", message: "Timed out" });
    await expect(nameStructureForPlugin(namingMolecule, engine, namingInstalled, { canonicalize: async () => "CCO", version: "test" })).rejects.toMatchObject({ code: "timeout" });
  });
  it("refuses out-of-scope ids, nonmolecules and ambiguous empty selections", () => {
    const doc = createPhase4Document();
    doc.pages[0]!.objects = [namingMolecule];
    expect(scopedNamingMolecule(doc, { objectIds: [], molecules: [] }, "m1")).toBe(namingMolecule);
    expect(() => scopedNamingMolecule(doc, { objectIds: ["another"], molecules: [] }, "m1")).toThrow(/current selection/);
    expect(() => scopedNamingMolecule(doc, undefined, "unknown")).toThrow();
    doc.pages[0]!.objects.push({ ...namingMolecule, id: "m2" });
    expect(() => scopedNamingMolecule(doc, undefined, "m1")).toThrow();
    expect(scopedNamingMolecule(doc, { objectIds: ["m1"], molecules: [] }, "m1")).toBe(namingMolecule);
  });
});
