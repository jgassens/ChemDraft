import { afterAll, describe, expect, it, vi } from "vitest";

import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import {
  MAX_RASTER_WIDTH,
  MIN_RASTER_WIDTH,
  assertCanonicalIdentity,
  depictSmiles,
  isRdkitNotConfiguredError,
  svgToPng,
  validateRasterWidth
} from "./document";

vi.setConfig({ testTimeout: 60_000 });

afterAll(() => {
  resetRdkitForTesting();
});

describe("CLI depiction boundary", () => {
  it("recognizes a duplicate-module RDKit configuration error by its typed name", () => {
    const error = new Error("loader unavailable");
    error.name = "RdkitNotConfiguredError";
    expect(isRdkitNotConfiguredError(error)).toBe(true);
  });

  it("rejects whitespace-only SMILES", async () => {
    await expect(depictSmiles("   ")).rejects.toThrow("input is empty");
  });

  it("rejects SMILES over 5000 characters before loading a chemistry engine", async () => {
    await expect(depictSmiles(`C${" ".repeat(5000)}`)).rejects.toThrow("5000-character limit");
  });

  it("rejects a 600-carbon chain before layout with an unprefixed input-limit error", async () => {
    const startedAt = performance.now();
    const error = await depictSmiles("C".repeat(600)).then(
      () => undefined,
      (reason: unknown) => reason
    );
    const elapsedMs = performance.now() - startedAt;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("600 heavy atoms; the limit is 500");
    expect((error as Error).message).not.toContain("RDKit:");
    expect((error as Error).message).not.toContain("OpenChemLib:");
    expect(elapsedMs).toBeLessThan(1_000);
  }, 60_000);

  it("reports both canonical structures when an identity check changes chemistry", async () => {
    await expect(assertCanonicalIdentity("CCO", "CCN"))
      .rejects.toThrow("identity changed: CCO -> CCN");
  }, 60_000);

  it.each([15, 4001])("rejects a raster width of %d pixels", (width) => {
    expect(() => svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', width))
      .toThrow("PNG width must be between 16 and 4000 pixels");
  });

  it("exports and applies the shared raster width limits", () => {
    expect([MIN_RASTER_WIDTH, MAX_RASTER_WIDTH]).toEqual([16, 4000]);
    expect(validateRasterWidth(600, "--width")).toBe(600);
    expect(() => validateRasterWidth(5000, "--width"))
      .toThrow("--width must be between 16 and 4000 pixels; received 5000.");
  });
});
