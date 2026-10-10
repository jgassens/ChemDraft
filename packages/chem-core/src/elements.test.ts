import { describe, expect, it } from "vitest";
import { atomicNumberForElementSymbol, elementSymbolForAtomicNumber, elementSymbols } from "./elements";

describe("element table", () => {
  it("lists all 118 elements once, in atomic-number order", () => {
    expect(elementSymbols).toHaveLength(118);
    expect(new Set(elementSymbols).size).toBe(118);
    expect([elementSymbols[0], elementSymbols[5], elementSymbols[25], elementSymbols[78], elementSymbols[117]])
      .toEqual(["H", "C", "Fe", "Au", "Og"]);
  });

  it("maps every atomic number to its symbol and back", () => {
    elementSymbols.forEach((symbol, index) => {
      expect(elementSymbolForAtomicNumber(index + 1)).toBe(symbol);
      expect(atomicNumberForElementSymbol(symbol)).toBe(index + 1);
    });
  });

  it("names no element outside 1–118, for a fraction, or for a non-symbol", () => {
    for (const number of [0, -1, 119, 26.5, Number.NaN]) {
      expect(elementSymbolForAtomicNumber(number)).toBeUndefined();
    }
    for (const symbol of ["", "fe", "FE", "Xx", "D", "T", "*", "OMe"]) {
      expect(atomicNumberForElementSymbol(symbol)).toBeUndefined();
    }
  });
});
