import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEmptyDocument, moleculeToMolfileV2000, moleculeToMolfileV3000,
  readDocument, type MoleculeObject
} from "@chemdraft/chem-core";
import { AnalysisRunSchema } from "@chemdraft/analysis-core";
import { analyzeStructureDetailed } from "./analysis";
import { createRdkitAdapter } from "./adapter";
import { resetRdkitForTesting } from "./conformer";
import { computeStructureIdentifiers } from "./identifiers";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(installRealRdkitModuleLoader);
afterAll(resetRdkitForTesting);

describe("real RDKit declines indeterminate bond orders", () => {
  it.each([undefined, "1.3.0"])("declines a forward-read molecule through both molfile formats with version %s", async version => {
    const raw = { ...createEmptyDocument(), ...(version ? { formatVersion: version, minAppVersion: version } : {}) };
    const document = JSON.parse(JSON.stringify(raw));
    document.pages[0].objects = [{ id: "m", type: "molecule", x: 0, y: 0, width: 30, height: 30,
      rotation: 0, style: {}, structureFormat: "smiles", structure: "CC",
      atoms: [{ id: "a", element: "C", x: 0, y: 0 }, { id: "b", element: "C", x: 22, y: 0 }],
      bonds: [{ id: "bond", fromAtomId: "a", toAtomId: "b", order: "future-order" }] }];
    const molecule = readDocument(document).document.pages[0]!.objects[0] as MoleculeObject;
    for (const [format, write] of [["molfile-v2000", moleculeToMolfileV2000], ["molfile-v3000", moleculeToMolfileV3000]] as const) {
      const value = write(molecule, { kekuleBondOrders: new Map() }).contents;
      const detailed = await analyzeStructureDetailed({ format, value, runId: "unknown", startedAt: "2026-11-09T00:00:00.000Z" });
      expect(detailed.composition).toBeUndefined();
      expect(detailed.run.status).toBe("unsupported");
      expect(detailed.run.warnings).toContainEqual(expect.objectContaining({ code: "structure.unknown_bond_order" }));
      expect(detailed.run.results.length).toBeGreaterThan(50);
      expect(detailed.run.results.every(result => result.status === "unsupported")).toBe(true);
      expect(AnalysisRunSchema.safeParse(detailed.run).success).toBe(true);
      expect(await computeStructureIdentifiers(value)).toBeUndefined();
      const legacy = await createRdkitAdapter().analyzeStructure({ format, value });
      expect(legacy.properties.formula).toBeUndefined();
      expect(legacy.properties.averageMass).toBeUndefined();
      expect(legacy.properties.exactMass).toBeUndefined();
      expect(legacy.warnings).toContainEqual(expect.objectContaining({ code: "structure.unknown_bond_order" }));
    }
  });

  it("declines SMILES any bonds used by CLI/MCP but keeps known single-bond results", async () => {
    const request = { format: "smiles" as const, runId: "query", startedAt: "2026-11-09T00:00:00.000Z",
      methodIds: ["rdkit.composition", "rdkit.average-mass", "rdkit.monoisotopic-mass", "rdkit.canonical-smiles"] };
    const unknown = await analyzeStructureDetailed({ ...request, value: "C~C" });
    expect(unknown.run.status).toBe("unsupported");
    expect(unknown.run.results).toHaveLength(4);
    expect(unknown.run.results.every(result => result.status === "unsupported")).toBe(true);
    const known = await analyzeStructureDetailed({ ...request, value: "CC" });
    expect(known.run.status).toBe("ok");
    expect(known.composition?.formula).toBe("C2H6");
    expect(known.run.results.find(result => result.methodId === "rdkit.average-mass")).toMatchObject({ status: "ok", value: 30.07 });
  });
});
