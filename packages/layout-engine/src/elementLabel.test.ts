import { describe, expect, it } from "vitest";

import { nativeElementFromAtomLabel, nativeElementSymbols, normalizeNativeAtomElementLabel } from "./valence";

const oneLetterSymbols = nativeElementSymbols.filter((symbol) => symbol.length === 1);

/**
 * Every two-letter symbol whose capitals split into two one-letter symbols, and how each reads when
 * typed in capitals or lower case: the two atoms (a group label chemists type) or the element.
 */
const splittingSymbols: Record<string, "formula" | "element"> = {
  Bh: "formula", Cf: "formula", Cn: "formula", Co: "formula", Cs: "formula", Hf: "formula",
  Ho: "formula", Hs: "formula", Nh: "formula", No: "formula", Po: "formula",
  Bi: "element", Bk: "element", Cu: "element", In: "element", Nb: "element", Ni: "element",
  Np: "element", Os: "element", Pb: "element", Pu: "element", Sb: "element", Sc: "element",
  Si: "element", Sn: "element", Yb: "element"
};

describe("element label case folding", () => {
  it.each(nativeElementSymbols.map((symbol) => [symbol]))("reads the exact symbol %s as its element", (symbol) => {
    expect(normalizeNativeAtomElementLabel(symbol)).toBe(symbol);
    expect(nativeElementFromAtomLabel(symbol)).toBe(symbol);
    expect(nativeElementFromAtomLabel(` ${symbol} `)).toBe(symbol);
  });

  it.each(oneLetterSymbols.map((symbol) => [symbol]))("folds lower-case %s to its element", (symbol) => {
    expect(nativeElementFromAtomLabel(symbol.toLowerCase())).toBe(symbol);
  });

  it("lists exactly the two-letter symbols whose capitals split into two one-letter symbols", () => {
    const oneLetter = new Set<string>(oneLetterSymbols);
    const splitting = nativeElementSymbols.filter((symbol) =>
      symbol.length === 2 && oneLetter.has(symbol[0]!) && oneLetter.has(symbol[1]!.toUpperCase())
    );
    expect([...splitting].sort()).toEqual(Object.keys(splittingSymbols).sort());
  });

  it.each(Object.entries(splittingSymbols))("reads %s in capitals and lower case as its %s", (symbol, reading) => {
    for (const variant of [symbol.toUpperCase(), symbol.toLowerCase()]) {
      if (reading === "formula") {
        // "NH", "nh", "CO", "co": the two atoms, never nihonium or cobalt.
        expect(normalizeNativeAtomElementLabel(variant), variant).toBe(variant);
        expect(nativeElementFromAtomLabel(variant), variant).toBeUndefined();
      } else {
        // "SI", "si", "CU", "PB": nothing a chemist writes as two atoms, so the element.
        expect(nativeElementFromAtomLabel(variant), variant).toBe(symbol);
      }
    }
  });

  it("folds every other two-letter symbol in capitals and lower case", () => {
    for (const symbol of nativeElementSymbols.filter((candidate) => candidate.length === 2 && !(candidate in splittingSymbols))) {
      expect(nativeElementFromAtomLabel(symbol.toUpperCase()), symbol).toBe(symbol);
      expect(nativeElementFromAtomLabel(symbol.toLowerCase()), symbol).toBe(symbol);
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
