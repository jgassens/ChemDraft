import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import { buildNmrDatabase } from "../providers/ocl/buildDatabase";

/** Construct a minimal single-record NMReDATA SD from a SMILES + ¹³C atom assignments (1-based). */
function makeSd(smiles: string, carbons: { atom: number; shift: number }[]): string {
  const molfile = OCL.Molecule.fromSmiles(smiles).toMolfile();
  const assignment = carbons.map((carbon, index) => `s${index}, ${carbon.shift}, ${carbon.atom}\\`).join("\n");
  const spectrum = carbons.map((carbon, index) => `${carbon.shift}, L=s${index}\\`).join("\n");
  return `${molfile}\n> <NMREDATA_ASSIGNMENT>\n${assignment}\n\n> <NMREDATA_1D_13C>\n${spectrum}\n\n$$$$\n`;
}

const PROVENANCE = { name: "test", version: "1", source: "test", license: "test", attribution: "test", note: "test" };

describe("buildNmrDatabase", () => {
  it("aggregates atom-assigned shifts by environment, merging equivalent atoms", () => {
    // Propane: two equivalent methyls (same environment) + one distinct CH2.
    const sd = makeSd("CCC", [
      { atom: 1, shift: 15.5 },
      { atom: 2, shift: 16.1 },
      { atom: 3, shift: 15.5 }
    ]);
    const database = buildNmrDatabase(sd, { provenance: PROVENANCE, now: () => "t" });

    expect(database.provenance.structureCount).toBe(1);
    expect(database.provenance.nuclei).toContain("13C");
    const entries = Object.values(database.entries);
    // The two equivalent methyls collapse to one environment with n = 2.
    expect(entries.some((entry) => entry.nucleus === "13C" && entry.median === 15.5 && entry.n === 2)).toBe(true);
    // The CH2 is its own environment.
    expect(entries.some((entry) => entry.nucleus === "13C" && entry.median === 16.1 && entry.n === 1)).toBe(true);
    // Every sphere depth 1..4 is represented for a carbon.
    expect(new Set(entries.map((entry) => entry.sphere))).toEqual(new Set([1, 2, 3, 4]));
  });

  it("skips records it cannot use without throwing", () => {
    const database = buildNmrDatabase("garbage not an sdf at all", { provenance: PROVENANCE, now: () => "t" });
    expect(database.provenance.structureCount).toBe(0);
    expect(Object.keys(database.entries)).toHaveLength(0);
  });
});
