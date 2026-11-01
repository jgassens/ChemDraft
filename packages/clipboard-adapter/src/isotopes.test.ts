import { describe, expect, it } from "vitest";
import { extractRxnMolfileBlocks, parseMolfileGraph } from "./index";

function v2000(element: string, difference = 0, properties = ""): string {
  return [
    "Isotope", "  ChemDraft", "", "  1  0  0  0  0  0  0  0  0  0999 V2000",
    `${"0.0000".padStart(10).repeat(3)} ${element.padEnd(3)}${String(difference).padStart(2)}  0`,
    properties, "M  END"
  ].join("\n");
}

function v3000(symbol: string, mass: number): string {
  return [
    "Isotope", "", "", "  0  0  0  0  0  0            999 V3000", "M  V30 BEGIN CTAB",
    "M  V30 COUNTS 1 0 0 0 0", "M  V30 BEGIN ATOM",
    `M  V30 1 ${symbol} 0 0 0 0 MASS=${mass}`, "M  V30 END ATOM", "M  V30 END CTAB", "M  END"
  ].join("\n");
}

describe("CTfile isotope parsing", () => {
  it.each([["H", 1, "D", undefined], ["H", 2, "T", undefined], ["H", 0, "H", undefined],
    ["C", 1, "C", 13], ["N", 1, "N", 15], ["O", 2, "O", 18], ["Cl", 2, "Cl", 37]] as const)(
    "reads atom-block mass difference on %s (%s)", (symbol, difference, element, isotope) => {
      const graph = parseMolfileGraph(v2000(symbol, difference));
      expect(graph.atoms[0]).toMatchObject({ element });
      expect(graph.atoms[0]!.isotope).toBe(isotope);
      expect(graph.warnings).toEqual([]);
    }
  );

  it("uses M ISO instead of the mass difference for the same atom", () => {
    const graph = parseMolfileGraph(v2000("C", 1, "M  ISO  1   1  14"));
    expect(graph.atoms[0]).toMatchObject({ element: "C", isotope: 14 });
  });

  it("still reads mass differences on atoms not named by M ISO", () => {
    const lines = v2000("C", 1, "M  ISO  1   1  14").split("\n");
    lines[3] = lines[3]!.replace(/^  1/, "  2");
    lines.splice(5, 0, lines[4]!);
    expect(parseMolfileGraph(lines.join("\n")).atoms).toMatchObject([
      { element: "C", isotope: 14 }, { element: "C", isotope: 13 }
    ]);
  });

  it.each([["H", 2, "D", undefined], ["H", 3, "T", undefined], ["H", 1, "H", 1],
    ["D", 2, "D", undefined], ["T", 3, "T", undefined],
    ["C", 13, "C", 13], ["O", 18, "O", 18]] as const)(
    "normalizes M ISO and V3000 MASS for %s-%s", (symbol, mass, element, isotope) => {
      const mol3000 = v3000(symbol, mass);
      for (const mol of [v2000(symbol, 0, `M  ISO  1   1 ${mass}`), mol3000]) {
        const atom = parseMolfileGraph(mol).atoms[0]!;
        expect(atom.element).toBe(element);
        expect(atom.isotope).toBe(isotope);
        if (isotope === undefined) expect(atom).not.toHaveProperty("isotope");
      }
      // An SDF data field or later record must not be treated as part of this CTAB.
      expect(parseMolfileGraph(`${mol3000}\n$$$$\n${mol3000}`).atoms).toHaveLength(1);
    }
  );

  it.each([["D", 3], ["D", 1], ["D", 0], ["T", 2], ["T", 4], ["T", -1]] as const)(
    "refuses inconsistent %s mass %s with the atom and mass named", (symbol, mass) => {
      for (const molfile of [v2000(symbol, 0, `M  ISO  1   1 ${mass}`), v3000(symbol, mass)]) {
        expect(() => parseMolfileGraph(molfile)).toThrow(
          new RegExp(`Atom .*1 \\(${symbol}\\) has isotope mass ${mass}; expected`)
        );
      }
    }
  );

  it.each(["D", "T"])("accepts native %s symbols", (symbol) => {
    expect(parseMolfileGraph(v2000(symbol)).atoms[0]).toMatchObject({ element: symbol });
  });

  it("warns rather than guessing an unlisted MDL reference mass", () => {
    const graph = parseMolfileGraph(v2000("R#", 1));
    expect(graph.atoms[0]).not.toHaveProperty("isotope");
    expect(graph.warnings[0]!.message).toContain("MDL default mass is unknown");
  });

  it("reads SDF records independently, ignoring property data after M END", () => {
    const records = [v2000("H", 0, "M  ISO  1   1   2"),
      v2000("C", 0, "M  ISO  1   1  13"), v2000("O", 0, "M  ISO  1   1  18")];
    const sdf = records.map((mol) => `${mol}\n> <NOTE>\nM  ISO  1   1  99\n\n$$$$`).join("\n");
    expect(sdf.split("$$$$").filter((record) => record.trim()).map((record) =>
      parseMolfileGraph(record).atoms[0]).map(({ element, isotope }) => ({ element, isotope }))).toEqual([
      { element: "D", isotope: undefined }, { element: "C", isotope: 13 }, { element: "O", isotope: 18 }
    ]);
    expect(parseMolfileGraph(sdf).atoms[0]!.element).toBe("D");
  });

  it("preserves isotopes in extracted RXN components", () => {
    const rxn = `$RXN\n\n\n\n  1  1\n$MOL\n${v2000("H", 1)}\n$MOL\n` +
      v2000("N", 0, "M  ISO  1   1  15");
    expect(extractRxnMolfileBlocks(rxn).map(({ text }) => parseMolfileGraph(text).atoms[0]))
      .toMatchObject([{ element: "D" }, { element: "N", isotope: 15 }]);
  });
});
