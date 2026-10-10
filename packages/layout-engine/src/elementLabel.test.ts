import { describe, expect, it } from "vitest";

import { nativeElementFromAtomLabel, nativeElementSymbols, normalizeNativeAtomElementLabel } from "./valence";

const twoLetterSymbols = nativeElementSymbols.filter((symbol) => symbol.length === 2);
const oneLetterSymbols = nativeElementSymbols.filter((symbol) => symbol.length === 1);

/** Whether a label in capitals splits into two exact element symbols: "NH" → N + H. */
function capitalsSplit(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  return (nativeElementSymbols as readonly string[]).includes(upper[0]!) &&
    (nativeElementSymbols as readonly string[]).includes(upper[1]!);
}

describe("element label case folding", () => {
  it.each(nativeElementSymbols.map((symbol) => [symbol]))("reads the exact symbol %s as its element", (symbol) => {
    expect(normalizeNativeAtomElementLabel(symbol)).toBe(symbol);
    expect(nativeElementFromAtomLabel(symbol)).toBe(symbol);
    expect(nativeElementFromAtomLabel(` ${symbol} `)).toBe(symbol);
  });

  it.each(oneLetterSymbols.map((symbol) => [symbol]))("folds lower-case %s to its element", (symbol) => {
    expect(nativeElementFromAtomLabel(symbol.toLowerCase())).toBe(symbol);
  });

  it.each(twoLetterSymbols.map((symbol) => [symbol]))(
    "folds %s in capitals or lower case only when it cannot be two elements",
    (symbol) => {
      for (const variant of [symbol.toUpperCase(), symbol.toLowerCase()]) {
        if (capitalsSplit(symbol)) {
          // "NH", "nh", "CO", "co": a formula (N + H, C + O), never nihonium or cobalt.
          expect(normalizeNativeAtomElementLabel(variant), variant).toBe(variant);
          expect(nativeElementFromAtomLabel(variant), variant).toBeUndefined();
        } else {
          // "CL", "cl", "BR", "br": nothing else fits, so the element.
          expect(nativeElementFromAtomLabel(variant), variant).toBe(symbol);
        }
      }
    }
  );

  it("reads the labels that used to turn into elements by accident as formulas", () => {
    for (const label of ["NH", "nh", "CO", "CN", "NO", "HS", "PO", "SN", "HO", "CS", "NI", "SI", "CU", "PB", "IN", "HF"]) {
      expect(nativeElementFromAtomLabel(label), label).toBeUndefined();
      expect(normalizeNativeAtomElementLabel(label), label).toBe(label);
    }
  });

  it("keeps the convenience where nothing else fits", () => {
    const folded: Record<string, string> = {
      cl: "Cl", CL: "Cl", br: "Br", BR: "Br", na: "Na", NA: "Na", mg: "Mg", MG: "Mg",
      fe: "Fe", FE: "Fe", zn: "Zn", ZN: "Zn", ca: "Ca", CA: "Ca", li: "Li", LI: "Li",
      al: "Al", AL: "Al", ar: "Ar", AR: "Ar", pt: "Pt", PT: "Pt", n: "N", c: "C", o: "O"
    };
    for (const [label, element] of Object.entries(folded)) {
      expect(nativeElementFromAtomLabel(label), label).toBe(element);
    }
  });

  it("leaves non-element labels alone", () => {
    for (const label of ["NH2", "OMe", "Ome", "CO2H", "R", "?", "Ph"]) {
      expect(normalizeNativeAtomElementLabel(label)).toBe(label);
      expect(nativeElementFromAtomLabel(label)).toBeUndefined();
    }
    expect(normalizeNativeAtomElementLabel("   ")).toBe("");
  });
});
