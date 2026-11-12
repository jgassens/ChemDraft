import { describe, expect, it } from "vitest";
import { moleculeToMolfileV2000, moleculeToMolfileV3000, rGroupNumberFromLabel, type MoleculeObject } from "./index";

describe("native R-group label numbers", () => {
  it.each([["R1", 1], ["R2", 2], ["R99", 99], [" R12 ", 12]] as const)("reads %s as %s", (label, number) => {
    expect(rGroupNumberFromLabel(label)).toBe(number);
  });

  it.each(["R", "R'", "R''", "R0", "R01", "R100", "1829667708", "r1", "Arg", "R2x"])("does not invent a number for %s", (label) => {
    expect(rGroupNumberFromLabel(label)).toBeUndefined();
  });

  it("preserves drawn numbers in ranking mode and reserves them before assigning other placeholders", () => {
    const molecule: MoleculeObject = {
      id: "synthetic", type: "molecule", x: 0, y: 0, width: 90, height: 0, rotation: 0,
      style: {}, structure: "", structureFormat: "unknown", superatoms: [], rGroups: [],
      atoms: ["Ph", "R2", "R1", "Ph"].map((element, index) => ({
        id: `source_${1829667708 + index}`, element, x: 30 * index, y: 0, formalCharge: 0
      })), bonds: []
    };
    const options = { kekuleBondOrders: new Map<string, number>(), abbreviations: "rgroup" as const };
    const v2000 = moleculeToMolfileV2000(molecule, options).contents;
    expect(v2000).toContain("M  RGP  4   1   3   2   2   3   1   4   3");
    const atomLines = v2000.split("\n").slice(4, 8);
    expect(atomLines.map((line) => Number(line.slice(60, 63)))).toEqual([0, 2, 1, 0]);
    const v3000 = moleculeToMolfileV3000(molecule, options).contents;
    expect(v3000).toContain("M  V30 1 R# 0 0 0 0 RGROUPS=(1 3)");
    expect(v3000).toContain("M  V30 2 R# 30 0 0 2 RGROUPS=(1 2)");
    expect(v3000).toContain("M  V30 3 R# 60 0 0 1 RGROUPS=(1 1)");
    expect(v3000).toContain("M  V30 4 R# 90 0 0 0 RGROUPS=(1 3)");
  });
});
