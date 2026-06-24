import { afterEach, describe, expect, it } from "vitest";
import { generate3DConformerProgressive, resetRdkitForTesting, setRdkitModuleLoader, type RdkitJsMol, type RdkitMinimalModule } from "./conformer";

function inputV2000(): string {
  return [
    "", "  tug", "",
    "  2  1  0  0  0  0  0  0  0  0999 V2000",
    "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
    "    1.0000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
    "  1  2  1  0  0  0  0",
    "M  END"
  ].join("\n");
}

function embeddedWithGeneratedHydrogenV2000(): string {
  return [
    "", "  tug-embed", "",
    "  3  2  0  0  0  0  0  0  0  0999 V2000",
    "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
    "    1.0000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
    "    1.5000    0.0000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0",
    "  1  2  1  0  0  0  0",
    "  2  3  1  0  0  0  0",
    "M  END"
  ].join("\n");
}

afterEach(() => resetRdkitForTesting());

describe("RDKit tug relaxation", () => {
  it("relaxes from supplied deformed coordinates without changing refineFromEmbedded", async () => {
    const seenMolblocks: string[] = [];
    installMock({ seenMolblocks });
    const { relaxFromCoordinates, refineFromEmbedded } = await generate3DConformerProgressive(
      { molfile: inputV2000(), originalAtomCount: 2 },
      { optimize: "mmff94" }
    );
    expect(refineFromEmbedded).toBeDefined();

    const relaxed = relaxFromCoordinates!(new Float64Array([0, 0, 0, 3, 0, 0]), 50, { forceField: "mmff94" });
    expect(relaxed.mapping.coords3dByOriginalAtom[3]).toBeCloseTo(2.5, 6);
    expect(seenMolblocks.some((molblock) => molblock.includes("3.0000"))).toBe(true);
  });

  it("carries generated hydrogens with the tugged heavy atom before relaxation", async () => {
    const seenMolblocks: string[] = [];
    installMock({ seenMolblocks, includeGeneratedHydrogen: true });
    const { relaxFromCoordinates } = await generate3DConformerProgressive(
      { molfile: inputV2000(), originalAtomCount: 2 },
      { optimize: "mmff94" }
    );

    relaxFromCoordinates!(new Float64Array([0, 0, 0, 3, 0, 0]), 50, { forceField: "mmff94" });
    const deformed = seenMolblocks.find((molblock) => molblock.includes("tug-embed") && molblock.includes("3.0000"));
    expect(deformed).toBeDefined();
    expect(deformed).toContain("    3.0000    0.0000    0.0000 O");
    expect(deformed).toContain("    3.5000    0.0000    0.0000 H");
  });

  it("keeps the requested coordinates when optimization payload is malformed", async () => {
    installMock({ malformedOptimize: true });
    const { relaxFromCoordinates } = await generate3DConformerProgressive(
      { molfile: inputV2000(), originalAtomCount: 2 },
      { optimize: "mmff94" }
    );
    const relaxed = relaxFromCoordinates!(new Float64Array([0, 0, 0, 3, 0, 0]), 50, { forceField: "mmff94" });
    expect([...relaxed.mapping.coords3dByOriginalAtom]).toEqual([0, 0, 0, 3, 0, 0]);
    expect(relaxed.forceField?.status).toBe("setup-failed");
  });
});

function installMock(options: { malformedOptimize?: boolean; seenMolblocks?: string[]; includeGeneratedHydrogen?: boolean } = {}) {
  const module: RdkitMinimalModule = {
    version: () => "test-rdkit",
    get_mol(molblock: string): RdkitJsMol | null {
      options.seenMolblocks?.push(molblock);
      return {
        generate_3d_embed() {
          const includeH = options.includeGeneratedHydrogen === true;
          return JSON.stringify({
            embedOk: true,
            coords3dByEngineAtom: includeH
              ? [0, 0, 0, 1, 0, 0, 1.5, 0, 0]
              : [0, 0, 0, 1, 0, 0],
            engineToOriginalAtom: includeH ? [0, 1, -1] : [0, 1],
            generatedHydrogenEngineAtoms: includeH ? [2] : [],
            molblock: includeH ? embeddedWithGeneratedHydrogenV2000() : inputV2000()
          });
        },
        optimize_3d_conformer() {
          if (options.malformedOptimize) return JSON.stringify({ embedOk: true });
          return JSON.stringify({
            embedOk: true,
            coords3dByEngineAtom: options.includeGeneratedHydrogen
              ? [0, 0, 0, 2.5, 0, 0, 3, 0, 0]
              : [0, 0, 0, 2.5, 0, 0],
            forceField: { name: "mmff94", status: "converged", iterations: 12 }
          });
        },
        delete() { /* noop */ }
      };
    }
  };
  setRdkitModuleLoader(() => Promise.resolve(module));
}
