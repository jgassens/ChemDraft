import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import type { AnalysisRun } from "@chemdraft/analysis-core";
import { analyzeStructure, type AnalysisInputFormat } from "../../../packages/rdkit-adapter/src/analysis";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import { resetRdkitForTesting } from "../../../packages/rdkit-adapter/src/conformer";
import { analysisFacingStructure, analysisSubjectKey } from "./documentWorkflow";

// What the Molecular Inspector hands the property analysis, run through the real vendored RDKit.

beforeAll(() => {
  installRealRdkitModuleLoader();
});

afterAll(() => {
  resetRdkitForTesting();
});

type Order = MoleculeObject["bonds"][number]["order"];

function molecule(
  elements: string[],
  bonds: [number, number, Order][],
  structure = ""
): MoleculeObject {
  return {
    id: "m1",
    type: "molecule",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    style: {},
    structureFormat: "smiles",
    structure,
    atoms: elements.map((element, index) => ({
      id: `a${index}`,
      element,
      x: 20 * Math.cos(index),
      y: 20 * Math.sin(index),
      formalCharge: 0
    })),
    bonds: bonds.map(([from, to, order], index) => ({ id: `b${index}`, fromAtomId: `a${from}`, toAtomId: `a${to}`, order }))
  } as MoleculeObject;
}

let runCounter = 0;
async function formulaOf(target: MoleculeObject): Promise<string | null> {
  const { structureFormat, structure } = analysisFacingStructure(target);
  runCounter += 1;
  const run: AnalysisRun = await analyzeStructure({
    format: structureFormat as AnalysisInputFormat,
    value: structure,
    runId: `facing-${runCounter}`,
    startedAt: "2026-09-26T12:00:00.000Z"
  });
  const composition = run.results.find((entry) => entry.id === "rdkit.composition");
  if (composition?.kind !== "composition") throw new Error(`no composition result (run status ${run.status})`);
  return composition.formula;
}

describe("the structure the property analysis reads", () => {
  it("analyses an imported molecule, whose own structure string is empty", async () => {
    expect(await formulaOf(molecule(["C", "C", "O"], [[0, 1, "single"], [1, 2, "single"]]))).toBe("C2H6O");
  });

  it("spells a condensed label with its stated hydrogens instead of a placeholder: C–C–OH is ethanol", async () => {
    expect(await formulaOf(molecule(["C", "C", "OH"], [[0, 1, "single"], [1, 2, "single"]]))).toBe("C2H6O");
    expect(await formulaOf(molecule(["CH3", "NH2"], [[0, 1, "single"]]))).toBe("CH5N");
  });

  it("reads a fused ring system as drawn, not as the lossy SMILES that made naphthalene decane", async () => {
    const naphthalene = molecule(
      Array.from({ length: 10 }, () => "C"),
      [
        [0, 1, "double"], [1, 2, "single"], [2, 3, "double"], [3, 4, "single"], [4, 5, "double"], [5, 0, "single"],
        [4, 6, "single"], [6, 7, "double"], [7, 8, "single"], [8, 9, "double"], [9, 5, "single"]
      ],
      "CCCCCCCCCC"
    );
    expect(await formulaOf(naphthalene)).toBe("C10H8");
  });
});

describe("the analysis subject key", () => {
  const ethanol = molecule(["C", "C", "OH"], [[0, 1, "single"], [1, 2, "single"]]);

  it("ignores where the molecule sits, so a move never makes a report stale", () => {
    const moved = { ...ethanol, atoms: ethanol.atoms.map((atom) => ({ ...atom, x: atom.x + 40, y: atom.y - 10 })) };
    expect(analysisSubjectKey(moved)).toBe(analysisSubjectKey(ethanol));
  });

  it("changes with the chemistry", () => {
    const charged = { ...ethanol, atoms: ethanol.atoms.map((atom, index) => (index === 2 ? { ...atom, formalCharge: -1 } : atom)) };
    const relabelled = { ...ethanol, atoms: ethanol.atoms.map((atom, index) => (index === 2 ? { ...atom, element: "SH" } : atom)) };
    expect(analysisSubjectKey(charged)).not.toBe(analysisSubjectKey(ethanol));
    expect(analysisSubjectKey(relabelled)).not.toBe(analysisSubjectKey(ethanol));
  });
});
