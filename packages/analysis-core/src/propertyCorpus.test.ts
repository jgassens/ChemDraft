import { describe, expect, it } from "vitest";

import {
  corpusEntriesTagged,
  corpusEntry,
  methodsExpectedToDecline,
  propertyCorpus
} from "./propertyCorpus";

describe("property corpus", () => {
  it("has unique ids", () => {
    const ids = propertyCorpus.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("states why every entry is in the corpus", () => {
    // A corpus entry without a rationale is a fixture, and fixtures belong in the engine-regression
    // suite. This one exists to find structures where an engine is confidently wrong.
    for (const entry of propertyCorpus) {
      expect(entry.rationale.length, `${entry.id} needs a rationale`).toBeGreaterThan(40);
      expect(entry.tags.length, `${entry.id} needs at least one tag`).toBeGreaterThan(0);
      expect(entry.smiles.length).toBeGreaterThan(0);
    }
  });

  it("covers every adversarial category PLANS.md §10 names", () => {
    const required = [
      "salt",
      "disconnected",
      "zwitterion",
      "radical",
      "isotope-label",
      "sulfur-phosphorus",
      "boron",
      "silicon",
      "charged-heterocycle",
      "tautomer",
      "organometallic",
      "unsupported-atom"
    ] as const;

    for (const tag of required) {
      expect(corpusEntriesTagged(tag).length, `no corpus entry tagged "${tag}"`).toBeGreaterThan(0);
    }
  });

  it("agrees with itself about which entries are multi-component", () => {
    for (const entry of propertyCorpus) {
      const isDisconnected = entry.tags.includes("disconnected");
      if (isDisconnected) {
        expect(entry.expectedComponentCount, `${entry.id} is tagged disconnected`).toBeGreaterThan(1);
      } else {
        expect(entry.expectedComponentCount, `${entry.id} is not tagged disconnected`).toBe(1);
      }
      // Component count must match the SMILES the entry actually carries, or the expectation drifts
      // from the input the moment someone edits one of them.
      expect(entry.smiles.split(".").length, `${entry.id} SMILES component count`).toBe(
        entry.expectedComponentCount
      );
    }
  });

  it("names concrete method ids where it expects a decline", () => {
    for (const entry of propertyCorpus) {
      for (const methodId of entry.mustDecline ?? []) {
        expect(methodId, `${entry.id} mustDecline entry`).toMatch(/^[a-z0-9-]+\.[a-z0-9.-]+$/);
      }
    }
    // The sharp end of the corpus: Phase 2 has to make each of these decline rather than fall through
    // to a default atom contribution.
    expect(methodsExpectedToDecline()).toEqual(["rdkit.crippen-logp", "rdkit.crippen-mr", "rdkit.tpsa"]);
  });

  it("keeps the sodium-benzoate case source-preserving", () => {
    const salt = corpusEntry("sodium-benzoate");
    expect(salt.expectedSourceFormula).toBe("C7H5NaO2");
    expect(salt.expectedSourceCharge).toBe(0);
    expect(salt.expectedComponentCount).toBe(2);
  });

  it("throws for an unknown id rather than returning undefined", () => {
    expect(() => corpusEntry("not-a-molecule")).toThrowError(/no property-corpus entry/i);
  });
});
