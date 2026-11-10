// The atom-label grammar read from layout-engine itself, with nothing from document-workflow-core:
// every reading kind, the bond-side and typed-label rules, and a group's attachment atom. The full
// coverage (every table entry, composites, valence verdicts) is in document-workflow-core's
// labelReading and abbreviationTable tests, which read the same functions through its re-exports.

import { describe, expect, it } from "vitest";

import {
  nativeAtomLabelReading,
  nativeHoverAtomLabelCanContinue,
  nativeHoverAtomLabelCompletion,
  nativeLabelGroupAttachment,
  nativeLabelReadingDependsOnBondSide,
  nativeSingleHeavyElementLabelValence,
  parseCondensedLabelFormula
} from "./index";

const groupOf = (label: string, context: Parameters<typeof nativeAtomLabelReading>[1] = {}) => {
  const reading = nativeAtomLabelReading(label, context);
  if (reading.kind !== "group") throw new Error(`"${label}" read as ${reading.kind}, not a group.`);
  return reading.group;
};

describe("the atom-label grammar", () => {
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
