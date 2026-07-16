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

  it("prunes environments below minObservations and records the rule + pre-prune count", () => {
    // Propane ¹³C: the equivalent methyls aggregate to n = 2 per sphere, the CH2 to n = 1.
    const sd = makeSd("CCC", [
      { atom: 1, shift: 15.5 },
      { atom: 2, shift: 16.1 },
      { atom: 3, shift: 15.5 }
    ]);
    const database = buildNmrDatabase(sd, { provenance: PROVENANCE, now: () => "t", minObservations: 2 });

    const entries = Object.values(database.entries);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.n >= 2)).toBe(true);
    expect(entries.some((entry) => entry.median === 16.1)).toBe(false); // the n=1 CH2 is gone
    expect(database.provenance.minObservations).toBe(2);
    // rawEntryCount is the pre-prune environment count: methyl + CH2 at each of 4 sphere depths.
    expect(database.provenance.rawEntryCount).toBe(8);
    expect(database.provenance.entryCount).toBe(entries.length);
    expect(database.provenance.rawEntryCount).toBeGreaterThan(database.provenance.entryCount);
  });

  it("keeps every environment and records no prune metadata by default", () => {
    const sd = makeSd("CCC", [
      { atom: 1, shift: 15.5 },
      { atom: 2, shift: 16.1 },
      { atom: 3, shift: 15.5 }
    ]);
    const database = buildNmrDatabase(sd, { provenance: PROVENANCE, now: () => "t" });

    expect(Object.values(database.entries).some((entry) => entry.n === 1)).toBe(true);
    expect(database.provenance.minObservations).toBeUndefined();
    expect(database.provenance.rawEntryCount).toBeUndefined();
  });

  it("passes raw-input identity (sha256 + byte length) through provenance untouched", () => {
    const sd = makeSd("CC", [{ atom: 1, shift: 7.1 }]);
    const database = buildNmrDatabase(sd, {
      provenance: { ...PROVENANCE, inputSha256: "ab".repeat(32), inputBytes: 1234 },
      now: () => "t"
    });

    expect(database.provenance.inputSha256).toBe("ab".repeat(32));
    expect(database.provenance.inputBytes).toBe(1234);
  });
});
