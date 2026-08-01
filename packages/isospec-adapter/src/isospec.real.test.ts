/**
 * The vendored IsoSpec artifact, exercised against the real binary.
 *
 * A vendored WASM blob that nothing loads is not a dependency, it is a 234 KB file. These tests are
 * what make the artifact real: they prove it loads, that the abundance set inside it is the one the
 * provenance claims, and that its numbers agree with the other engine already in the repo.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ISOSPEC_ISOTOPIC_ENTRY_COUNT,
  PINNED_ISOSPEC_COMMIT,
  PINNED_ISOSPEC_VERSION,
  PINNED_ISOSPEC_WASM_SHA256,
  electronMass,
  ensureIsoSpec,
  envelopeFromThreshold,
  envelopeFromTotalProb,
  envelopeToTypedArrays,
  explicitFormulaCounts,
  isotopeTable,
  resetIsoSpecForTesting,
  type IsoSpecEnvelope,
  type IsoSpecModule
} from "./index";
import { installRealIsoSpecModuleLoader } from "./testing";

const buildDoc = readFileSync(new URL("../vendor/BUILD.md", import.meta.url), "utf8");

let module: IsoSpecModule;

beforeAll(async () => {
  installRealIsoSpecModuleLoader();
  module = await ensureIsoSpec();
});

afterAll(() => {
  resetIsoSpecForTesting();
});

function envelope(formula: string, threshold: number): IsoSpecEnvelope {
  const result = envelopeFromThreshold(module, formula, threshold);
  if (!result.ok) throw new Error(`expected an envelope, got: ${result.error}`);
  return result;
}

describe("the vendored artifact pin", () => {
  it("matches the bytes actually committed at vendor/IsoSpec.wasm", () => {
    const wasm = readFileSync(new URL("../vendor/IsoSpec.wasm", import.meta.url));
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(PINNED_ISOSPEC_WASM_SHA256);
  });

  it("matches the hash and commit recorded in vendor/BUILD.md", () => {
    expect(buildDoc).toContain(PINNED_ISOSPEC_WASM_SHA256);
    expect(buildDoc).toContain(PINNED_ISOSPEC_COMMIT);
  });

  it("reports the pinned version from the binary itself", () => {
    expect(module.version()).toBe(PINNED_ISOSPEC_VERSION);
  });
});

describe("the abundance set inside the artifact", () => {
  it("carries every isotopic entry the pin claims", () => {
    expect(isotopeTable(module)).toHaveLength(ISOSPEC_ISOTOPIC_ENTRY_COUNT);
  });

  it("normalises every element's abundances to exactly 1", () => {
    // Not cosmetic: intensities are read straight off these numbers, so an element summing to 0.998
    // would silently scale that element's whole envelope.
    const sums = new Map<string, number>();
    for (const entry of isotopeTable(module)) {
      sums.set(entry.element, (sums.get(entry.element) ?? 0) + entry.abundance);
    }
    for (const [element, sum] of sums) {
      expect(Math.abs(sum - 1), `${element} sums to ${sum}`).toBeLessThan(1e-12);
    }
  });

  it("uses an abundance set that differs measurably from the CIAAW representative values", () => {
    // 13C here is 0.010788, where the commonly quoted CIAAW representative value is 0.0107 — 0.82%
    // relatively higher. That is not an error: CIAAW publishes carbon as an interval (0.9884-0.9904)
    // because it genuinely varies by source. But it means the M+1 intensity this engine reports is
    // ~0.8% above what a reader reproducing it from a textbook table would get, which is a convention
    // to disclose, not a discrepancy to reconcile. Pinned so a table change is a visible failure.
    const c13 = isotopeTable(module).find((entry) => entry.element === "carbon" && entry.massNumber === 13);
    expect(c13?.abundance).toBe(0.010788058149533084);
    expect(Math.abs((c13!.abundance - 0.0107) / 0.0107)).toBeGreaterThan(0.008);
  });

  it("carries the electron mass an ion's envelope is corrected by", () => {
    // The table ships explicit `electron` / `missing electron` entries beside the isotopic ones, which
    // is why charge bookkeeping needs no constant written into TypeScript. Pinned to the binary, and
    // matching CODATA's 0.000548579909 u — an independent check on the table, since IsoSpec publishes
    // no provenance for it.
    expect(electronMass(module)).toBe(0.000548579909065);
    expect(electronMass(module)).toBeCloseTo(0.000548579909, 12);

    const missing = isotopeTable(module).find((entry) => entry.element === "missing electron");
    expect(missing?.mass).toBe(-electronMass(module));
  });
});

describe("formula syntax", () => {
  it("rejects an implicit trailing count instead of silently dropping the element", () => {
    // RDKit's Hill formula writes C10H11N3O3S with an implicit 1 on sulfur. If IsoSpec quietly
    // dropped it, every sulfur-containing envelope would be wrong with no error anywhere.
    const result = envelopeFromThreshold(module, "H2O", 0.001);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("every element must be followed by a number");
  });

  it("rejects an empty formula", () => {
    const result = envelopeFromThreshold(module, "", 0.001);
    expect(result.ok).toBe(false);
  });

  it("expands a Hill formula into the explicit-count form IsoSpec demands", () => {
    expect(explicitFormulaCounts("C10H11N3O3S")).toBe("C10H11N3O3S1");
    expect(explicitFormulaCounts("H2O")).toBe("H2O1");
    expect(explicitFormulaCounts("CCl4")).toBe("C1Cl4");
    // And the expansion has to actually satisfy the engine, not just look right.
    expect(envelopeFromThreshold(module, explicitFormulaCounts("H2O"), 0.001).ok).toBe(true);
  });
});

describe("envelopes against patterns that can be checked by hand", () => {
  it("gives bromine its ~1:1 doublet", () => {
    const br = envelope("Br1", 0.001);
    expect(br.peakCount).toBe(2);
    expect(br.probabilities[1] / br.probabilities[0]).toBeCloseTo(0.9729, 3);
  });

  it("gives chlorine its ~3:1 doublet", () => {
    const cl = envelope("Cl1", 0.001);
    expect(cl.peakCount).toBe(2);
    expect(cl.probabilities[1] / cl.probabilities[0]).toBeCloseTo(0.32, 3);
  });

  it("convolves Cl2 into exactly the binomial expansion of its own marginal", () => {
    // Deliberately NOT the "9:6:1" mnemonic, which assumes 35Cl:37Cl is exactly 3:1. The real
    // abundances are 75.76/24.24, giving 1 : 0.6399 : 0.1024. Deriving the expectation from the
    // shipped table makes this a test of the convolution rather than of a remembered ratio.
    const table = isotopeTable(module);
    const p35 = table.find((e) => e.element === "chlorine" && e.massNumber === 35)!.abundance;
    const p37 = table.find((e) => e.element === "chlorine" && e.massNumber === 37)!.abundance;
    const expected = [p35 * p35, 2 * p35 * p37, p37 * p37];

    const cl2 = envelope("Cl2", 0.0001);
    expect(cl2.peakCount).toBe(3);
    const byMass = cl2.masses
      .map((mass, index) => ({ mass, probability: cl2.probabilities[index]! }))
      .sort((a, b) => a.mass - b.mass);
    for (const [index, peak] of byMass.entries()) {
      expect(peak.probability).toBeCloseTo(expected[index]!, 12);
    }
  });

  it("agrees with RDKit's monoisotopic mass for sulfamethoxazole", () => {
    // The cross-engine check. The vendored RDKit artifact reports 253.05211 Da for this molecule,
    // computed from a different table by a different library. Two independent engines agreeing is
    // worth more than either matching a number typed into a test.
    const smx = envelope(explicitFormulaCounts("C10H11N3O3S"), 1e-6);
    expect(Math.min(...smx.masses)).toBeCloseTo(253.05211, 5);
  });
});

describe("truncation policies, as DistributionResult models them", () => {
  it("labels the relative-intensity policy and reports what it retained", () => {
    const smx = envelope(explicitFormulaCounts("C10H11N3O3S"), 1e-6);
    expect(smx.policy).toBe("relative-intensity-threshold");
    const sum = smx.probabilities.reduce((total, value) => total + value, 0);
    expect(sum).toBeCloseTo(smx.coveredProbability, 12);
  });

  it("reaches the cumulative-probability target it was asked for", () => {
    const result = envelopeFromTotalProb(module, explicitFormulaCounts("C10H11N3O3S"), 0.999);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy).toBe("cumulative-probability");
    expect(result.coveredProbability).toBeGreaterThanOrEqual(0.999);
  });

  it("never keeps more peaks at a looser threshold than a tighter one", () => {
    const tight = envelope(explicitFormulaCounts("C10H11N3O3S"), 1e-6);
    const loose = envelope(explicitFormulaCounts("C10H11N3O3S"), 0.01);
    expect(loose.peakCount).toBeLessThanOrEqual(tight.peakCount);
  });
});

describe("worker transport", () => {
  it("converts an envelope to the Float64Arrays §5 requires", () => {
    const smx = envelope(explicitFormulaCounts("C10H11N3O3S"), 0.01);
    const { positions, intensities } = envelopeToTypedArrays(smx);
    expect(positions).toBeInstanceOf(Float64Array);
    expect(intensities).toBeInstanceOf(Float64Array);
    expect(positions).toHaveLength(smx.peakCount);
    expect(structuredClone(positions)).toEqual(positions);
  });

  it("handles a protein-sized formula without falling over", () => {
    const insulin = envelopeFromTotalProb(module, "C254H377N65O75S6", 0.999);
    expect(insulin.ok).toBe(true);
    if (!insulin.ok) return;
    expect(insulin.peakCount).toBeGreaterThan(5);
    expect(insulin.coveredProbability).toBeGreaterThanOrEqual(0.999);
  });
});
