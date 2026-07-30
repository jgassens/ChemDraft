import { describe, expect, it } from "vitest";

import { formatWithUnit, isComparable, unit, UnitIds, UnitIdSchema } from "./units";
import { UncertaintySchema, unknownUncertainty } from "./provenance";

describe("units", () => {
  it("keeps daltons and grams per mole in different dimensions", () => {
    // The whole reason units are structured: 180.042 Da (monoisotopic) and 180.159 g/mol (average)
    // describe different things and must never share an axis, a comparison, or a tooltip.
    expect(isComparable("dalton", "gram-per-mole")).toBe(false);
    expect(unit("dalton").dimension).toBe("mass");
    expect(unit("gram-per-mole").dimension).toBe("molar-mass");
    expect(unit("dalton").note).toMatch(/NOT g\/mol/);
  });

  it("treats units of the same dimension as comparable", () => {
    expect(isComparable("kilocalorie-per-mole", "kilojoule-per-mole")).toBe(true);
    expect(isComparable("square-angstrom", "square-angstrom")).toBe(true);
  });

  it("throws for an unregistered id instead of inventing a unit", () => {
    // @ts-expect-error — the literal union is the first line of defence; this is the runtime one.
    expect(() => unit("furlongs-per-fortnight")).toThrowError(/Unknown unit id/);
  });

  it("exposes every registered id to the schema", () => {
    for (const id of UnitIds) {
      expect(UnitIdSchema.safeParse(id).success).toBe(true);
    }
    expect(UnitIdSchema.safeParse("g/mol").success).toBe(false);
  });

  it("omits the symbol for dimensionless quantities", () => {
    expect(formatWithUnit(2, "count")).toBe("2");
    expect(formatWithUnit(63.6, "square-angstrom")).toBe("63.6 Å²");
  });
});

describe("uncertainty", () => {
  it('forbids a number on metric "unknown"', () => {
    // Where redistributable validation data is scarce, "no quantified uncertainty, here is the
    // citation" is the honest answer — and the schema makes inventing one impossible.
    expect(UncertaintySchema.safeParse(unknownUncertainty("log10-unit", "no redistributable corpus")).success).toBe(
      true
    );
    expect(
      UncertaintySchema.safeParse({
        metric: "unknown",
        value: 0.5,
        unit: "log10-unit",
        basis: "vibes"
      }).success
    ).toBe(false);
  });

  it("requires a value or an interval for every quantified metric", () => {
    expect(
      UncertaintySchema.safeParse({ metric: "rmse", unit: "log10-unit", basis: "validation set" }).success
    ).toBe(false);
    expect(
      UncertaintySchema.safeParse({ metric: "rmse", value: 0.9, unit: "log10-unit", basis: "n=1128 measured logP" })
        .success
    ).toBe(true);
  });

  it("requires both interval bounds, in order", () => {
    const shared = { metric: "confidence-interval" as const, unit: "log10-unit" as const, basis: "bootstrap" };
    expect(UncertaintySchema.safeParse({ ...shared, lower: 0.1 }).success).toBe(false);
    expect(UncertaintySchema.safeParse({ ...shared, lower: 0.9, upper: 0.1 }).success).toBe(false);
    expect(
      UncertaintySchema.safeParse({ ...shared, lower: 0.1, upper: 0.9, coverageProbability: 0.95 }).success
    ).toBe(true);
  });
});
