import { describe, expect, it } from "vitest";

import {
  abbreviationBondedSpellings,
  abbreviationDefinitions,
  abbreviationElementCounts,
  abbreviationForBondedElementLabel,
  abbreviationForLabel,
  abbreviationSpellings,
  abbreviationSpellingSuggestion,
  isGenericAtomLabel
} from "./index";

// The chemistry of these groups (valence, formula against RDKit, expansion) is tested in
// document-workflow-core, which owns the element tables; this file checks the data is well formed.

function hill(counts: ReadonlyMap<string, number>): string {
  const symbols = [...counts.keys()];
  const ordered = counts.has("C")
    ? ["C", ...(counts.has("H") ? ["H"] : []), ...symbols.filter((symbol) => symbol !== "C" && symbol !== "H").sort()]
    : symbols.sort();
  return ordered.map((symbol) => `${symbol}${counts.get(symbol) === 1 ? "" : counts.get(symbol)}`).join("");
}

describe("abbreviation table", () => {
  it("answers to every label and alias once", () => {
    const spellings = abbreviationDefinitions.flatMap((definition) => [definition.label, ...definition.aliases]);
    expect(new Set(spellings).size).toBe(spellings.length);
    expect([...abbreviationSpellings].sort()).toEqual([...spellings].sort());
  });

  it("keeps bonded-only spellings apart from every label and alias", () => {
    const spellings = new Set(abbreviationDefinitions.flatMap((definition) => [definition.label, ...definition.aliases]));
    const bonded = abbreviationDefinitions.flatMap((definition) => definition.bondedSpellings ?? []);
    expect([...bonded].sort()).toEqual(["Ac", "Pr", "Ts"]);
    expect(new Set(bonded).size).toBe(bonded.length);
    for (const spelling of bonded) {
      expect(spellings.has(spelling)).toBe(false);
      expect(abbreviationForLabel(spelling)).toBeUndefined();
    }
    expect([...abbreviationBondedSpellings].sort()).toEqual(["Ac", "Pr", "Ts"]);
    expect(abbreviationForBondedElementLabel("Ac")?.name).toBe("acetyl");
    expect(abbreviationForBondedElementLabel("Pr")?.name).toBe("n-propyl");
    expect(abbreviationForBondedElementLabel("Ts")?.label).toBe("Tos");
    expect(abbreviationForBondedElementLabel("ts")).toBeUndefined();
  });

  it("lists spellings longest first, so a tokenizer finds CO2Me before Me", () => {
    for (let index = 1; index < abbreviationSpellings.length; index += 1) {
      expect(abbreviationSpellings[index - 1]!.length).toBeGreaterThanOrEqual(abbreviationSpellings[index]!.length);
    }
  });

  it.each(abbreviationDefinitions.map((definition) => [definition.label, definition] as const))(
    "%s is a well-formed group",
    (_label, definition) => {
      expect(definition.smiles.startsWith("*")).toBe(true);
      expect(definition.attachmentCount).toBe(1);
      expect(definition.atoms.length).toBeGreaterThan(0);
      expect(definition.atoms[0]).toMatchObject({ x: 0, y: 0 });
      // The stated formula is what the atoms and their hydrogens add up to.
      expect(hill(abbreviationElementCounts(definition))).toBe(definition.formula);

      const pairs = new Set<string>();
      for (const [from, to, order] of definition.bonds) {
        expect(from).not.toBe(to);
        expect(definition.atoms[from]).toBeDefined();
        expect(definition.atoms[to]).toBeDefined();
        expect([1, 2, 3]).toContain(order);
        const key = [from, to].sort().join("-");
        expect(pairs.has(key)).toBe(false);
        pairs.add(key);
        // Layouts are in bond lengths.
        const a = definition.atoms[from]!;
        const b = definition.atoms[to]!;
        expect(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - 1)).toBeLessThan(0.05);
      }
      // Every atom is reachable from the attachment atom.
      const reached = new Set([0]);
      for (let pass = 0; pass < definition.atoms.length; pass += 1) {
        for (const [from, to] of definition.bonds) {
          if (reached.has(from)) reached.add(to);
          if (reached.has(to)) reached.add(from);
        }
      }
      expect(reached.size).toBe(definition.atoms.length);
      // No two atoms overlap, and none sits where the atom the group attaches to does.
      const points = [{ x: -1, y: 0 }, ...definition.atoms];
      for (let i = 0; i < points.length; i += 1) {
        for (let j = i + 1; j < points.length; j += 1) {
          expect(Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y)).toBeGreaterThan(0.5);
        }
      }
    }
  );
});

describe("abbreviation lookup", () => {
  it("matches case-sensitively: OMe is methoxy, Ome, OME and ome are not groups", () => {
    expect(abbreviationForLabel("OMe")?.name).toBe("methoxy");
    expect(abbreviationForLabel("MeO")?.name).toBe("methoxy");
    expect(abbreviationForLabel(" OMe ")?.name).toBe("methoxy");
    for (const variant of ["Ome", "OME", "ome", "oMe", "meO"]) {
      expect(abbreviationForLabel(variant)).toBeUndefined();
    }
  });

  it("suggests the intended spelling only as a hint", () => {
    expect(abbreviationSpellingSuggestion("Ome")).toBe("OMe");
    expect(abbreviationSpellingSuggestion("OME")).toBe("OMe");
    expect(abbreviationSpellingSuggestion("meo")).toBe("MeO");
    expect(abbreviationSpellingSuggestion("boc")).toBe("Boc");
    expect(abbreviationSpellingSuggestion("Xyz")).toBeUndefined();
  });

  it("never treats a group as a generic placeholder", () => {
    for (const spelling of abbreviationSpellings) {
      expect(isGenericAtomLabel(spelling)).toBe(false);
    }
  });

  it("accepts the deliberate placeholders, case-sensitively", () => {
    for (const label of ["R", "R'", "R''", "R1", "R12", "X", "A", "Q", "M", "Nu", "E", "LG", "PG", "?", "*", " R1 "]) {
      expect(isGenericAtomLabel(label), label).toBe(true);
    }
    // Z is Cbz's old name, so it is not waved through; case and spelling variants are not placeholders.
    for (const label of ["Z", "r", "nu", "R0", "R00", "R01", "R100", "R123", "R'''", "Rx", "Ome", ""]) {
      expect(isGenericAtomLabel(label), label).toBe(false);
    }
  });
});
