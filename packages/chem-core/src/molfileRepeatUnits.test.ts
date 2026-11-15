import { afterAll, describe, expect, it } from "vitest";
import { moleculeToMolfileV2000, moleculeToMolfileV3000 } from "./molfile";
import type { MoleculeObject } from "./schemas";
import { ensureRdkit, resetRdkitForTesting } from "../../rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";

const chain: MoleculeObject = { id: "chain", type: "molecule", x: 0, y: 0, width: 90, height: 20,
  rotation: 0, style: {}, structureFormat: "smiles", structure: "CCCC", superatoms: [], rGroups: [],
  atoms: [0, 1, 2, 3].map(i => ({ id: `a${i}`, element: "C", x: i * 30, y: 10, formalCharge: 0 })),
  bonds: [0, 1, 2].map(i => ({ id: `b${i}`, fromAtomId: `a${i}`, toAtomId: `a${i + 1}`, order: "single" })) };
const repeatUnitGroups = [{ objectId: "bracket_pair", label: "n", atomIds: ["a1", "a2"] }];
const options = { kekuleBondOrders: new Map<string, number>() };
afterAll(() => resetRdkitForTesting());

describe.each([
  ["V2000", moleculeToMolfileV2000], ["V3000", moleculeToMolfileV3000]
] as const)("%s repeat unit SGroups", (format, write) => {
  it("writes the actual atom membership, crossing bonds, label, and default EU connectivity", () => {
    const { contents, warnings } = write(chain, { ...options, repeatUnitGroups });
    expect(warnings).toEqual([]);
    if (format === "V3000") {
      expect(contents).toContain("COUNTS 4 3 1 0 0");
      expect(contents.replace(/ -\nM  V30 /g, " ")).toContain("1 SRU 0 ATOMS=(2 2 3) XBONDS=(2 1 3) LABEL=n CONNECT=EU");
    } else {
      expect(contents).toContain("M  STY  1   1 SRU");
      expect(contents).toContain("M  SAL   1  2   2   3");
      expect(contents).toContain("M  SBL   1  2   1   3");
      expect(contents).toContain("M  SMT   1 n");
      expect(contents).toContain("M  SCN  1   1 EU");
    }
  });
  it("coexists with superatom groups and honors explicit connectivity", () => {
    const { contents, warnings } = write(chain, { ...options,
      superatomGroups: [{ label: "Et", atomIds: ["a1", "a2"] }],
      repeatUnitGroups: [{ ...repeatUnitGroups[0], connectivity: "ht" }] });
    expect(warnings).toEqual([]);
    expect(contents).toContain(format === "V3000" ? "2 SRU" : "  2 SRU");
    expect(contents).toContain(format === "V3000" ? "CONNECT=HT" : "M  SCN  1   2 HT");
  });
  it("warns naming the bracket rather than writing an incomplete group", () => {
    const result = write(chain, { ...options, repeatUnitGroups: [{ ...repeatUnitGroups[0], atomIds: ["a1", "missing"] }] });
    expect(result.contents).toBe(write(chain, options).contents);
    expect(result.warnings).toEqual([expect.stringContaining("bracket_pair")]);
  });
  it("leaves documents without repeat units byte-identical", () => {
    expect(write(chain, { ...options, repeatUnitGroups: [] })).toEqual(write(chain, options));
  });
  it("preserves canonical atom chemistry, including ethylene without crossing bonds", async () => {
    installRealRdkitModuleLoader();
    const rdkit = await ensureRdkit();
    const ethylene = { ...chain, atoms: chain.atoms.slice(0, 2), bonds: [{ ...chain.bonds[0], order: "double" as const }] };
    for (const [molecule, groups, expected] of [
      [chain, repeatUnitGroups, "CCCC"],
      [ethylene, [{ ...repeatUnitGroups[0], atomIds: ["a0", "a1"] }], "C=C"]
    ] as const) {
      const file = write(molecule, { ...options, repeatUnitGroups: groups });
      const parsed = rdkit.get_mol(file.contents);
      try {
        expect(parsed).toBeTruthy();
        expect(parsed!.get_smiles?.()).toBe(expected);
        const json = JSON.parse(parsed!.get_json!()) as { molecules: { substanceGroups?: { properties: { TYPE: string }; atoms: number[] }[] }[] };
        expect(json.molecules[0].substanceGroups).toEqual(expect.arrayContaining([expect.objectContaining({
          properties: expect.objectContaining({ TYPE: "SRU", CONNECT: "EU", LABEL: "n" }),
          atoms: [0, 1].map(i => molecule === chain ? i + 1 : i)
        })]));
      } finally { parsed?.delete(); }
    }
  });
});
