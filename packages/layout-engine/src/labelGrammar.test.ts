// The atom-label grammar read from layout-engine itself, with nothing from document-workflow-core:
// every reading kind, the bond-side and typed-label rules, and a group's attachment atom. The full
// coverage (every table entry, composites, valence verdicts) is in document-workflow-core's
// labelReading and abbreviationTable tests, which read the same functions through its re-exports.

import { atomicNumberForElementSymbol, elementSymbols, isTableAbbreviationLabel } from "@chemdraft/chem-core";
import { abbreviationBondedSpellings, abbreviationSpellings } from "@chemdraft/template-library";
import { describe, expect, it } from "vitest";

import {
  nativeAtomLabelReading,
  nativeElementWithChargeLabel,
  nativeHoverAtomLabelCanContinue,
  nativeHoverAtomLabelCompletion,
  nativeLabelGroupAttachment,
  nativeLabelReadingDependsOnBondSide,
  nativeRelabelElementAndCharge,
  nativeSingleHeavyElementLabelValence,
  parseCondensedLabelFormula
} from "./index";
import { nativeElementSymbols } from "./valence";

it("requires explicit scheme metadata to read NaOH as an ion-pair group", () => {
  expect(nativeAtomLabelReading("NaOH").kind).toBe("formula");
  expect(nativeAtomLabelReading("NaOH", { typed: true }).kind).toBe("formula");
  expect(nativeAtomLabelReading("NaOH", { schemeAbbreviation: "NaOH" }).kind).toBe("group");
  expect(nativeAtomLabelReading("NaOH", { typed: true, schemeAbbreviation: "NaOH" }).kind).toBe("formula");
  expect(nativeAtomLabelReading("NaCl", { schemeAbbreviation: "NaOH" }).kind).toBe("formula");
});

const groupOf = (label: string, context: Parameters<typeof nativeAtomLabelReading>[1] = {}) => {
  const reading = nativeAtomLabelReading(label, context);
  if (reading.kind !== "group") throw new Error(`"${label}" read as ${reading.kind}, not a group.`);
  return reading.group;
};

describe("the atom-label grammar", () => {
  it.each(["OTBDPS", "OTIPS", "OTES", "OPMB", "OMOM", "OSEM", "OTBS", "OTf"])("reads %s as a composite group", label => {
    expect(groupOf(label)).toMatchObject({ kind: "composite", head: "O" });
  });

  it.each(["No", "Co", "Nh", "Cf"])("declines the implicit hover capital in %s", label => {
    expect(nativeHoverAtomLabelCompletion(label)).toBeUndefined();
    expect(nativeAtomLabelReading(label).kind).toBe("element");
    expect(nativeHoverAtomLabelCanContinue(label)).toBe(true);
  });

  it.each([
    ["No2", "NO2"], ["Ome", "OMe"], ["Obn", "OBn"], ["Nme2", "NMe2"],
    ["Co2me", "CO2Me"], ["Si", "Si"], ["Cl", "Cl"], ["NO", "NO"], ["CONH2", "CONH2"]
  ])("completes hover %s as %s through the existing grammar", (typed, expected) => {
    expect(nativeHoverAtomLabelCompletion(typed)).toBe(expected);
    expect(nativeHoverAtomLabelCanContinue(typed)).toBe(true);
  });

  it.each(["Om", "Ob", "Nm", "Co2m"])("keeps the known hover prefix %s pending", label => {
    expect(nativeHoverAtomLabelCompletion(label)).toBeUndefined();
    expect(nativeHoverAtomLabelCanContinue(label)).toBe(true);
  });

  it.each(["Nq", "OMeq", "NMe0", "not-a-label"])("ends the exhausted hover prefix %s", label => {
    expect(nativeHoverAtomLabelCompletion(label)).toBeUndefined();
    expect(nativeHoverAtomLabelCanContinue(label)).toBe(false);
  });

  it("keeps long complete formulas and their final incomplete token within the same grammar", () => {
    const formula = "CH2".repeat(50);
    expect(nativeHoverAtomLabelCompletion(formula)).toBe(formula);
    expect(nativeHoverAtomLabelCanContinue(formula + "M")).toBe(true);
    expect(nativeHoverAtomLabelCanContinue(formula + "q")).toBe(false);
  });

  it("keeps an emptied editor open for a new label", () => {
    expect(nativeHoverAtomLabelCompletion("")).toBeUndefined();
    expect(nativeHoverAtomLabelCanContinue("")).toBe(true);
  });

  it("reads each kind of label", () => {
    expect(nativeAtomLabelReading("Cl")).toEqual({ kind: "element", element: "Cl" });
    expect(nativeAtomLabelReading("D")).toEqual({ kind: "heavy-hydrogen", element: "D" });
    expect(nativeAtomLabelReading("NH2")).toEqual({ kind: "spelled", element: "N", hydrogens: 2 });
    expect(groupOf("OMe")).toMatchObject({ kind: "abbreviation", label: "OMe" });
    expect(groupOf("NMe2")).toMatchObject({ kind: "composite", head: "N", hydrogens: 0 });
    expect(nativeAtomLabelReading("R")).toEqual({ kind: "generic" });
    expect(nativeAtomLabelReading("CONH2").kind).toBe("formula");
    expect(nativeAtomLabelReading("Ome")).toEqual({ kind: "unrecognized", suggestion: "OMe" });
  });

  it("reads a cyano label by the side its bond comes from", () => {
    expect(groupOf("SCN", { bondSide: "left" })).toMatchObject({ kind: "composite", head: "S" });
    expect(nativeAtomLabelReading("SCN", { bondSide: "right" }).kind).toBe("formula");
    expect(nativeLabelReadingDependsOnBondSide("SCN")).toBe(true);
    expect(nativeLabelReadingDependsOnBondSide("OMe")).toBe(false);
  });

  it("reads a typed bonded Ar or Ac as a group, and the element otherwise", () => {
    expect(nativeAtomLabelReading("Ar", { bonded: true })).toEqual({ kind: "generic" });
    expect(nativeAtomLabelReading("Ar")).toEqual({ kind: "element", element: "Ar" });
    expect(groupOf("Ac", { bonded: true })).toMatchObject({ kind: "abbreviation", label: "Ac" });
    expect(nativeAtomLabelReading("Ac", { bonded: true, typed: false })).toEqual({ kind: "element", element: "Ac" });
  });

  it("names the atom a group's bonds reach", () => {
    expect(nativeLabelGroupAttachment(groupOf("OMe"))).toMatchObject({ element: "O", internalValence: 1, charge: 0 });
    expect(nativeLabelGroupAttachment(groupOf("NMe2"))).toMatchObject({ element: "N", internalValence: 2, charge: 0 });
  });

  it("parses spelled labels and condensed formulas", () => {
    expect(nativeSingleHeavyElementLabelValence("OH")).toEqual({ element: "O", hydrogens: 1 });
    expect(nativeSingleHeavyElementLabelValence("CH2OH")).toBeUndefined();
    expect(Object.fromEntries(parseCondensedLabelFormula("CO2H")!)).toEqual({ C: 1, O: 2, H: 1 });
  });
});

describe("chem-core's abbreviation reading (isTableAbbreviationLabel) is this grammar's", () => {
  // chem-core flags a hydrogen count stated on an abbreviation (OMe, Ph) without importing this
  // grammar, by reading the abbreviation table the grammar reads. It must answer exactly as the
  // grammar's own reading of a stored label (no bond context) does, behind chem-core's element
  // guard, for every label: every table spelling, alias and bonded-only spelling, every element,
  // each of those in folded case, and spelled, composite, generic and blank labels.
  const grammarReadsAsAbbreviation = (label: string) => {
    const reading = nativeAtomLabelReading(label.trim());
    return atomicNumberForElementSymbol(label.trim()) === undefined && reading.kind === "group" && reading.group.kind === "abbreviation";
  };
  const labels = [...new Set([...abbreviationSpellings, ...abbreviationBondedSpellings, ...nativeElementSymbols, ...elementSymbols,
    "NH2", "CH3", "NHMe", "NMe2", "H2N", "OH", "CH2OH", "CO2H", "NaOH", "A", "Q", "M", "X", "R", "R1", "*", "", " ", " OMe ", "Ome", "D", "T"]
    .flatMap(label => [label, label.toLowerCase(), label.toUpperCase()]))];

  it("agrees on every label", () => {
    expect(labels.filter(label => isTableAbbreviationLabel(label) !== grammarReadsAsAbbreviation(label))).toEqual([]);
    // Not vacuous: the table's spellings are abbreviations, elements are not.
    expect(abbreviationSpellings.every(isTableAbbreviationLabel)).toBe(true);
    expect(["Ac", "Pr", "Ts", "C", "O"].some(isTableAbbreviationLabel)).toBe(false);
  });
});

describe("an element symbol with a typed charge (nativeElementWithChargeLabel)", () => {
  it.each([
    ["Zn", "Zn", 0], ["Zn2+", "Zn", 2], ["Zn+2", "Zn", 2], ["Fe3+", "Fe", 3], ["Fe+3", "Fe", 3],
    ["Cl-", "Cl", -1], ["Na+", "Na", 1], ["O2-", "O", -2], ["O-2", "O", -2], ["S2-", "S", -2],
    ["Cu+", "Cu", 1], ["N", "N", 0], ["C", "C", 0], ["O", "O", 0], ["H+", "H", 1], ["H-", "H", -1],
    ["Zn\u00B2\u207A", "Zn", 2], ["Cl\u207B", "Cl", -1], ["Cl\u2212", "Cl", -1], ["Fe\u207A\u00B3", "Fe", 3]
  ] as const)("reads '%s' as %s with charge %d", (label, element, charge) => {
    expect(nativeElementWithChargeLabel(label)).toEqual({ element, charge });
  });

  it.each([
    "", "hello", "H2O", "CO2", "CO", "NH", "OH-", "NH4+", "OMe", "Me", "Ph", "R", "Xx", "Xx2+", "zn", "ZN", "zn2+",
    " Zn", "Zn ", "Zn 2+", "Zn\n", "Zn2+\nZn", "Zn++", "Zn--", "Zn+-", "Zn0+", "Zn+0", "Zn10+", "Zn2", "2+", "+",
    "Zn2+2", "H2+", "C5+", "N6-", "H+2"
  ])("keeps '%s' as not an element with a charge", label => {
    expect(nativeElementWithChargeLabel(label)).toBeUndefined();
  });

  it("names the same element the grammar's element reading does, for every exact symbol", () => {
    for (const symbol of nativeElementSymbols) {
      const reading = nativeAtomLabelReading(symbol);
      expect(nativeElementWithChargeLabel(symbol), symbol)
        .toEqual(reading.kind === "element" && reading.element === symbol ? { element: symbol, charge: 0 } : undefined);
    }
  });
});

describe("what relabelling an atom with typed text sets (nativeRelabelElementAndCharge)", () => {
  it.each([
    ["Zn2+", "Zn", 2], ["Zn+2", "Zn", 2], ["Fe3+", "Fe", 3], ["Cl-", "Cl", -1], ["Na+", "Na", 1],
    ["N+", "N", 1], ["O-", "O", -1], ["Zn\u00B2\u207A", "Zn", 2], ["Cl\u2212", "Cl", -1], [" Zn2+ ", "Zn", 2]
  ] as const)("relabels '%s' as %s with exactly charge %d, whatever the atom had", (label, element, charge) => {
    for (const start of [0, 1, -2]) {
      expect(nativeRelabelElementAndCharge(label, start)).toEqual({ element, formalCharge: charge });
    }
  });

  it.each([
    ["Zn", "Zn"], ["N", "N"], ["n", "N"], ["cl", "Cl"], ["Xx", "Xx"], ["Xx2+", "Xx2+"], ["OMe", "OMe"],
    ["NH4+", "NH4+"], ["OH-", "OH-"], ["zn2+", "zn2+"], ["Zn++", "Zn++"], ["C5+", "C5+"], ["Zn2", "Zn2"]
  ] as const)("keeps today's relabel for '%s' (%s) and the starting charge", (label, element) => {
    expect(nativeRelabelElementAndCharge(label, 0)).toEqual({ element, formalCharge: 0 });
    expect(nativeRelabelElementAndCharge(label, 1)).toEqual({ element, formalCharge: 1 });
  });

  it("reads every charged label the free text box reads, to the same element and charge", () => {
    for (const label of ["Zn2+", "Zn+2", "Fe3+", "Cl-", "Na+", "N+", "H+", "H-", "O2-", "Zn\u00B2\u207A"]) {
      const free = nativeElementWithChargeLabel(label)!;
      expect(nativeRelabelElementAndCharge(label, 0), label).toEqual({ element: free.element, formalCharge: free.charge });
    }
  });
});
