import { afterAll, describe, expect, it, vi } from "vitest";

import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import {
  assertCanonicalIdentity,
  depictSmiles,
  isRdkitNotConfiguredError,
  svgToPng
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

  it("rejects structures with more than 500 heavy atoms", async () => {
    await expect(depictSmiles(Array.from({ length: 501 }, () => "C").join(".")))
      .rejects.toThrow("501 heavy atoms; the limit is 500");
  }, 60_000);

  it("reports both canonical structures when an identity check changes chemistry", async () => {
    await expect(assertCanonicalIdentity("CCO", "CCN"))
      .rejects.toThrow("identity changed: CCO -> CCN");
  }, 60_000);

  it.each([15, 4001])("rejects a raster width of %d pixels", (width) => {
    expect(() => svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', width))
      .toThrow("PNG width must be between 16 and 4000 pixels");
  });
});
