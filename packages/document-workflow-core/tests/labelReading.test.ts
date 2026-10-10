// How an atom label reads, and how many bonds it takes. Pure label grammar: no molecule, no
// engine. The table's data is checked in abbreviationTable.test.ts.

import { describe, expect, it } from "vitest";
import { abbreviationDefinitions } from "@chemdraft/template-library";

import {
  nativeAtomLabelFreeValence,
  nativeAtomLabelReading,
  nativeLabelGroupFreeValence,
  nativeLabelGroupVerdict
} from "../src/index";

function groupOf(label: string) {
  const reading = nativeAtomLabelReading(label);
  if (reading.kind !== "group") throw new Error(`"${label}" did not read as a group (${reading.kind}).`);
  return reading.group;
}

describe("nativeAtomLabelReading", () => {
  it("reads elements first, folding case, so Ac, Pr and Y stay elements", () => {
    expect(nativeAtomLabelReading("N")).toEqual({ kind: "element", element: "N" });
    expect(nativeAtomLabelReading("cl")).toEqual({ kind: "element", element: "Cl" });
    expect(nativeAtomLabelReading("Ac")).toEqual({ kind: "element", element: "Ac" });
    expect(nativeAtomLabelReading("Y")).toEqual({ kind: "element", element: "Y" });
  });

  it("reads CN as cyano: folding leaves it as typed, and only the exact Cn is copernicium", () => {
    expect(nativeAtomLabelReading("CN")).toMatchObject({
      kind: "group", group: { kind: "abbreviation", label: "CN", definition: { name: "cyano" } }
    });
    expect(nativeAtomLabelFreeValence("CN")).toBe(1);
    expect(nativeAtomLabelReading("Cn")).toEqual({ kind: "element", element: "Cn" });
    // Case-sensitive like every group: lower case is text, with the intended spelling offered.
    expect(nativeAtomLabelReading("cn")).toEqual({ kind: "unrecognized", suggestion: "CN" });
    // A lone CN is an open fragment until a −1 charge makes it cyanide.
    expect(nativeLabelGroupVerdict(groupOf("CN"), 0, 0)).toMatchObject({ valid: false, expectedBondCount: 1 });
    expect(nativeLabelGroupVerdict(groupOf("CN"), 0, -1)).toEqual({ valid: true });
  });

  it("reads a bonded Ar as an aryl placeholder and an unbonded Ar as argon", () => {
    expect(nativeAtomLabelReading("Ar")).toEqual({ kind: "element", element: "Ar" });
    expect(nativeAtomLabelReading("Ar", { bonded: false })).toEqual({ kind: "element", element: "Ar" });
    expect(nativeAtomLabelReading("Ar", { bonded: true })).toEqual({ kind: "generic" });
    expect(nativeAtomLabelReading(" Ar ", { bonded: true })).toEqual({ kind: "generic" });
    // Exact case only, like every other reading of a group: "AR" and "ar" are still argon.
    expect(nativeAtomLabelReading("AR", { bonded: true })).toEqual({ kind: "element", element: "Ar" });
    expect(nativeAtomLabelFreeValence("Ar", 0, { bonded: true })).toBeUndefined();
    // No other element changes with bonding.
    expect(nativeAtomLabelReading("Y", { bonded: true })).toEqual({ kind: "element", element: "Y" });
  });

  it("reads a bonded Ac, Pr or Ts as acetyl, n-propyl or tosyl, and an unbonded one as the element", () => {
    const expected = { Ac: "acetyl", Pr: "n-propyl", Ts: "p-toluenesulfonyl (tosyl)" } as const;
    for (const [label, name] of Object.entries(expected)) {
      expect(nativeAtomLabelReading(label)).toEqual({ kind: "element", element: label });
      expect(nativeAtomLabelReading(label, { bonded: false })).toEqual({ kind: "element", element: label });
      expect(nativeAtomLabelReading(label, { bonded: true })).toMatchObject({
        kind: "group", group: { kind: "abbreviation", label, definition: { name } }
      });
      expect(nativeAtomLabelFreeValence(label, 0, { bonded: true })).toBe(1);
      expect(nativeAtomLabelFreeValence(label)).toBeUndefined();
    }
  });

  it("reads Ac, Pr and Ts inside composites as their groups: NHAc, OTs, NTs, NPr2", () => {
    const substituentNames = (label: string) => {
      const group = groupOf(label);
      return group.kind === "composite" ? [group.head, ...group.substituents.map((substituent) => substituent.name)] : [];
    };
    expect(substituentNames("NHAc")).toEqual(["N", "acetyl"]);
    expect(substituentNames("AcHN")).toEqual(["N", "acetyl"]);
    expect(substituentNames("OTs")).toEqual(["O", "p-toluenesulfonyl (tosyl)"]);
    expect(substituentNames("TsO")).toEqual(["O", "p-toluenesulfonyl (tosyl)"]);
    expect(substituentNames("NTs")).toEqual(["N", "p-toluenesulfonyl (tosyl)"]);
    expect(substituentNames("NHTs")).toEqual(["N", "p-toluenesulfonyl (tosyl)"]);
    expect(substituentNames("NPr2")).toEqual(["N", "n-propyl", "n-propyl"]);
    expect(substituentNames("OPr")).toEqual(["O", "n-propyl"]);
    // OAc is the table's own acetoxy entry.
    expect(groupOf("OAc")).toMatchObject({ kind: "abbreviation", definition: { name: "acetoxy" } });
    // Free valence through the composite: an N-tosyl ring N takes two, a tosylate O one.
    expect(nativeAtomLabelFreeValence("NTs")).toBe(2);
    expect(nativeAtomLabelFreeValence("OTs")).toBe(1);
    expect(nativeAtomLabelFreeValence("NHAc")).toBe(1);
  });

  it("gives a lower-case-led abbreviation its letter after a one-letter head: NiPr2 is not nickel", () => {
    expect(groupOf("NiPr2")).toMatchObject({ kind: "composite", head: "N", substituents: [{ label: "iPr" }, { label: "iPr" }] });
    expect(groupOf("OtBu")).toMatchObject({ kind: "composite", head: "O", substituents: [{ label: "tBu" }] });
    expect(groupOf("NnBu2")).toMatchObject({ kind: "composite", head: "N" });
    expect(nativeAtomLabelFreeValence("NiPr2")).toBe(1);
  });

  it("never splits a symbol that can be a head: tin and silicon stay tin and silicon", () => {
    expect(groupOf("SnMe3")).toMatchObject({ kind: "composite", head: "Sn", substituents: [{ label: "Me" }, { label: "Me" }, { label: "Me" }] });
    expect(groupOf("SiMe3")).toMatchObject({ kind: "composite", head: "Si" });
    expect(groupOf("SiPr3")).toMatchObject({ kind: "composite", head: "Si", substituents: [{ name: "n-propyl" }, { name: "n-propyl" }, { name: "n-propyl" }] });
    expect(groupOf("SnPr3")).toMatchObject({ kind: "composite", head: "Sn" });
    expect(nativeAtomLabelFreeValence("SnMe3")).toBe(1);
    expect(nativeAtomLabelFreeValence("SiPr3")).toBe(1);
    // Bare "Bu" is n-butyl, so tributylstannyl reads as tin carrying three n-butyls, either way round,
    // and never as sulfur.
    for (const label of ["SnBu3", "Bu3Sn"]) {
      expect(groupOf(label), label).toMatchObject({
        kind: "composite", head: "Sn",
        substituents: [{ name: "n-butyl" }, { name: "n-butyl" }, { name: "n-butyl" }]
      });
      expect(nativeAtomLabelFreeValence(label), label).toBe(1);
    }
    // Tetrabutylammonium needs its + charge: then it is complete with no bond. Neutral, no number of
    // bonds completes an N with four carbons. Tributylamine takes none; as NBu3⁺ it takes one.
    expect(groupOf("NBu4")).toMatchObject({ kind: "composite", head: "N" });
    expect(nativeAtomLabelFreeValence("NBu4", 1)).toBe(0);
    expect(nativeAtomLabelFreeValence("NBu4")).toBeUndefined();
    expect(nativeAtomLabelFreeValence("NBu3")).toBe(0);
    expect(nativeAtomLabelFreeValence("NBu3", 1)).toBe(1);
    // Indium is no covalent head either, but a halogen never takes its place: "InBu3" is not an
    // iodine carrying three butyls.
    for (const label of ["InBu", "InnBu3"]) {
      const reading = nativeAtomLabelReading(label);
      expect(reading.kind === "group" && reading.group.kind === "composite" ? reading.group.head : undefined, label).not.toBe("I");
    }
    // P + tBu2: di-tert-butylphosphino, not platinum.
    expect(groupOf("PtBu2")).toMatchObject({ kind: "composite", head: "P", substituents: [{ label: "tBu" }, { label: "tBu" }] });
  });

  it("reads heavy hydrogen", () => {
    expect(nativeAtomLabelReading("D")).toEqual({ kind: "heavy-hydrogen", element: "D" });
    expect(nativeAtomLabelReading("T")).toEqual({ kind: "heavy-hydrogen", element: "T" });
  });

  it("reads the table case-sensitively, label and right-to-left alias alike", () => {
    expect(groupOf("OMe")).toMatchObject({ kind: "abbreviation", label: "OMe", definition: { name: "methoxy" } });
    expect(groupOf("MeO")).toMatchObject({ kind: "abbreviation", label: "MeO", definition: { name: "methoxy" } });
    expect(groupOf(" OMe ")).toMatchObject({ label: "OMe" });
    for (const variant of ["Ome", "OME", "ome"]) {
      expect(nativeAtomLabelReading(variant)).toEqual({ kind: "unrecognized", suggestion: "OMe" });
    }
  });

  it("reads one heavy element with its hydrogens as spelled", () => {
    expect(nativeAtomLabelReading("OH")).toEqual({ kind: "spelled", element: "O", hydrogens: 1 });
    expect(nativeAtomLabelReading("NH2")).toEqual({ kind: "spelled", element: "N", hydrogens: 2 });
    expect(nativeAtomLabelReading("H2N")).toEqual({ kind: "spelled", element: "N", hydrogens: 2 });
  });

  it("reads an element carrying abbreviations as a composite group", () => {
    expect(groupOf("NMe2")).toMatchObject({ kind: "composite", head: "N", hydrogens: 0 });
    expect(groupOf("NMe2").kind === "composite" && groupOf("NMe2")).toMatchObject({ substituents: [{ label: "Me" }, { label: "Me" }] });
    expect(groupOf("BocHN")).toMatchObject({ kind: "composite", head: "N", hydrogens: 1 });
    expect(groupOf("CH2OMe")).toMatchObject({ kind: "composite", head: "C", hydrogens: 2 });
    // A head written before O is an oxo spelling the grammar does not model; never C–OEt.
    expect(nativeAtomLabelReading("COEt").kind).toBe("unrecognized");
    // Two heavy elements, or a count on the head, are not a composite.
    expect(nativeAtomLabelReading("SO2Ph").kind).toBe("unrecognized");
    expect(nativeAtomLabelReading("C2H4Ph").kind).toBe("unrecognized");
  });

  it("reads placeholders, blank labels and bare formulas without flagging them", () => {
    for (const label of ["R", "R1", "R'", "X", "?", "*", "Nu", "", "   "]) {
      expect(nativeAtomLabelReading(label), JSON.stringify(label)).toEqual({ kind: "generic" });
    }
    const formula = nativeAtomLabelReading("CONH2");
    expect(formula.kind).toBe("formula");
    expect(formula.kind === "formula" && Object.fromEntries(formula.counts)).toEqual({ C: 1, O: 1, N: 1, H: 2 });
  });

  it("treats charge and isotope text inside a label as unrecognized: those belong on the atom", () => {
    // A charge is the atom's own property (the + and − tools); an isotope is not a label token.
    for (const label of ["NMe3+", "OMe-", "O-", "13CH3", "CD3", "[13C]"]) {
      expect(nativeAtomLabelReading(label).kind, label).toBe("unrecognized");
    }
  });
});

describe("free valence", () => {
  it.each(abbreviationDefinitions.map((definition) => [definition.label, definition] as const))(
    "%s takes its stated one bond, label and aliases alike",
    (_label, definition) => {
      for (const spelling of [definition.label, ...definition.aliases]) {
        expect(nativeAtomLabelFreeValence(spelling), spelling).toBe(definition.attachmentCount);
      }
    }
  );

  it("follows a composite's head", () => {
    const expected: Record<string, number> = {
      NMe: 2, NMe2: 1, NHMe: 1, NBoc: 2, CMe2: 2, SiMe2: 2, SiMe3: 1, CH2Ph: 1, CHPh2: 1, OTBS: 1, NTf2: 1, PPh2: 1,
      // Cyano as a substituent: cyanomethyl and thiocyanato.
      CH2CN: 1, SCN: 1
    };
    for (const [label, bonds] of Object.entries(expected)) {
      expect(nativeAtomLabelFreeValence(label), label).toBe(bonds);
    }
  });

  it("moves with the label's charge", () => {
    expect(nativeAtomLabelFreeValence("NMe3")).toBe(0);
    expect(nativeAtomLabelFreeValence("NMe3", 1)).toBe(1);
    expect(nativeAtomLabelFreeValence("OMe", -1)).toBe(0);
    expect(nativeAtomLabelFreeValence("OMe", 1)).toBe(2);
    expect(nativeAtomLabelFreeValence("PPh3", 1)).toBe(1);
  });

  it("counts a spelled label's open bonds", () => {
    expect(nativeAtomLabelFreeValence("OH")).toBe(1);
    expect(nativeAtomLabelFreeValence("NH2")).toBe(1);
    expect(nativeAtomLabelFreeValence("HN")).toBe(2);
    expect(nativeAtomLabelFreeValence("CH2")).toBe(2);
    // A ring N–H, not nihonium: case folding leaves "NH" as typed, and only the exact "Nh" is
    // the element.
    expect(nativeAtomLabelReading("NH")).toEqual({ kind: "spelled", element: "N", hydrogens: 1 });
    expect(nativeAtomLabelFreeValence("NH")).toBe(2);
    expect(nativeAtomLabelReading("Nh")).toEqual({ kind: "element", element: "Nh" });
  });

  it("has none for an element or for a label that is not structure", () => {
    for (const label of ["N", "C", "R", "?", "Ome", "CONH2", ""]) {
      expect(nativeAtomLabelFreeValence(label), JSON.stringify(label)).toBeUndefined();
    }
  });

  it("judges a metal attachment by the table's count", () => {
    expect(nativeLabelGroupFreeValence(groupOf("MgBr"))).toBe(1);
    expect(nativeLabelGroupVerdict(groupOf("MgBr"), 0, 0)).toEqual({ valid: true });
    expect(nativeLabelGroupVerdict(groupOf("MgBr"), 2, 0)).toMatchObject({ valid: false, expectedBondCount: 1 });
  });

  it("names the bonds and the charge that would fix a group", () => {
    expect(nativeLabelGroupVerdict(groupOf("OMe"), 1, 0)).toEqual({ valid: true });
    expect(nativeLabelGroupVerdict(groupOf("OMe"), 2, 0)).toEqual({ valid: false, expectedBondCount: 1, expectedFormalCharge: 1 });
    expect(nativeLabelGroupVerdict(groupOf("OMe"), 0, 0)).toEqual({ valid: false, expectedBondCount: 1, expectedFormalCharge: -1 });
    expect(nativeLabelGroupVerdict(groupOf("OMe"), 0, -1)).toEqual({ valid: true });
  });
});
