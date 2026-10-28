import { describe, it, expect } from "vitest";
import type { TextSpan } from "@chemdraft/chem-core";
import { formulaSpansForMixedText, formulaSpansFromText } from "./formulaText";

describe("formula text", () => {
  it("leaves trailing punctuation plain after formulas", () => {
    for (const punctuation of [",", ";", ":", ".", "!", "?", "*", "†", "‡"]) {
      const spans = formulaSpansForMixedText(`NaBH4${punctuation}`);
      expect(spans?.map(span => `${span.text}:${span.script}`)).toEqual([
        "NaBH:normal", "4:subscript", `${punctuation}:normal`
      ]);
    }
    for (const text of ["1.", "1.00", "Step2.", "TBHP*"]) {
      expect(formulaSpansForMixedText(text), text).toBeUndefined();
    }
  });

  it("formats hydrogen isotopes and decimal hydrate coefficients", () => {
    const scripts = (text: string) =>
      formulaSpansForMixedText(text)?.map(span => `${span.text}:${span.script}`);
    expect(scripts("D2O")).toEqual(["D:normal", "2:subscript", "O:normal"]);
    expect(scripts("T2O")).toEqual(["T:normal", "2:subscript", "O:normal"]);
    expect(scripts("CDCl3")).toEqual(["CDCl:normal", "3:subscript"]);
    expect(scripts("CD3OD")).toEqual(["CD:normal", "3:subscript", "OD:normal"]);
    expect(scripts("CaSO4·0.5H2O")).toEqual([
      "CaSO:normal", "4:subscript", "·0.5H:normal", "2:subscript", "O:normal"
    ]);
    expect(formulaSpansForMixedText("CaSO4.5H2O")).toBeUndefined();
  });

  it("classifies a long formula token in linear time", () => {
    const tokens = [50_000, 200_000].map(n => `${"H".repeat(n - 2)}2x`);
    for (const token of tokens) formulaSpansForMixedText(token);
    const times = tokens.map(token => Math.min(...Array.from({ length: 3 }, () => {
      const started = performance.now();
      const result = formulaSpansForMixedText(token);
      const elapsed = performance.now() - started;
      expect(result).toBeUndefined();
      return elapsed;
    })));
    // A linear scan grows about 4x for a 4x longer token; the old quadratic scan grew about 16x.
    // The ratio separates them on any machine, unlike the absolute limit that failed on loaded CI runners.
    expect(times[1] / Math.max(times[0], 0.5)).toBeLessThan(10);
  // Eight scans of up to 200,000 characters can exceed the 5 s default on a heavily loaded machine; the assertion is the ratio, not the time.
  }, 30_000);

  it("formats formula-like tokens in mixed text", () => {
    for (const text of ["CH2Cl2", "Ti(OiPr)4", "Pd(PPh3)4", "Et3N", "Pd2(dba)3", "CuSO4·5H2O", "SO42-"]) {
      expect(formulaSpansForMixedText(text)?.some(span => span.script === "subscript"), text).toBe(true);
    }
    for (const text of ["1.00", "5.5 M", "(+)-DET", "Step2", "TBHP", "MW (g/mol)", "10%", "allyl alcohol"]) {
      expect(formulaSpansForMixedText(text), text).toBeUndefined();
    }
    expect(formulaSpansForMixedText("SO42-")?.map(span => `${span.text}:${span.script}`)).toEqual(["SO:normal", "4:subscript", "2-:superscript"]);
    const source: TextSpan[] = [{ text: "Step2 ", script: "superscript", style: { color: "red" } }, { text: "H2O,", script: "normal", style: { color: "blue" } }];
    expect(formulaSpansForMixedText("Step2 H2O,", source)?.slice(0, 2).map(span => span.text).join("")).toBe("Step2 ");
    expect(formulaSpansForMixedText("Step2 H2O,", source)?.[0]).toMatchObject({ script: "superscript", style: { color: "red" } });
    const subscripts = (text: string) => formulaSpansForMixedText(text)?.filter(span => span.script === "subscript").map(span => span.text);
    expect(subscripts("1. Ti(OiPr)4 (5 mol%)")).toEqual(["4"]);
    expect(subscripts("CH2Cl2, −20 °C, 4 h")).toEqual(["2", "2"]);
    expect(subscripts("NaBH4, MeOH, 0 °C")).toEqual(["4"]);
    expect(subscripts("Pd(PPh3)4 (10 mol%)")).toEqual(["3", "4"]);
    expect(subscripts("13CH3I")).toEqual(["3"]);
    expect(formulaSpansForMixedText("13CH3I")?.[0]).toMatchObject({ text: "13CH", script: "normal" });
    for (const text of ["3 equiv", "5 mol%", "−78 °C", "2 h", "(+)-DET", "1.00"]) {
      expect(formulaSpansForMixedText(text), text).toBeUndefined();
    }
  });
  it("classifies a long digit run in linear time", () => {
    // The body pattern used to offer two ways to match a digit — `[A-Z][a-z]?\d*` and a standalone
    // `\d+` — so an n-digit run had 2^(n-1) parses. A trailing character that fails the match sent
    // the engine through all of them: pasting a 40-digit label froze the app outright.
    const pathological = `C${"1".repeat(40)}!-`;
    const started = performance.now();
    expect(formulaSpansFromText(pathological).map((span) => span.text).join("")).toBe(pathological);
    expect(performance.now() - started).toBeLessThan(100);

    // Same language as before: the shapes that were formulas still are.
    // A leading coefficient stays normal text; only a digit run *after* an element or a closing
    // bracket is a count.
    expect(formulaSpansFromText("2H2O").map((span) => `${span.text}:${span.script}`)).toEqual([
      "2H:normal",
      "2:subscript",
      "O:normal"
    ]);
    expect(formulaSpansFromText("(CH3)3C+").at(-1)).toMatchObject({ text: "+", script: "superscript" });
    expect(formulaSpansFromText("Fe(CN)63-").at(-1)).toMatchObject({ text: "3-", script: "superscript" });
    // And a bare sign is still not a charge.
    expect(formulaSpansFromText("-")).toEqual([{ text: "-", script: "normal", style: {} }]);
  });

  it("formats formula text spans with subscripts and a superscript charge", () => {
    expect(formulaSpansFromText("H2O")).toEqual([
      { text: "H", script: "normal", style: {} },
      { text: "2", script: "subscript", style: {} },
      { text: "O", script: "normal", style: {} }
    ]);
    expect(formulaSpansFromText("C6H12O6")).toEqual([
      { text: "C", script: "normal", style: {} },
      { text: "6", script: "subscript", style: {} },
      { text: "H", script: "normal", style: {} },
      { text: "12", script: "subscript", style: {} },
      { text: "O", script: "normal", style: {} },
      { text: "6", script: "subscript", style: {} }
    ]);
    expect(formulaSpansFromText("SO42-")).toEqual([
      { text: "SO", script: "normal", style: {} },
      { text: "4", script: "subscript", style: {} },
      { text: "2-", script: "superscript", style: {} }
    ]);
    expect(formulaSpansFromText("Ca2+")).toEqual([
      { text: "Ca", script: "normal", style: {} },
      { text: "2+", script: "superscript", style: {} }
    ]);
    expect(formulaSpansFromText("plain")).toEqual([
      { text: "plain", script: "normal", style: {} }
    ]);
  });

  it("separates a charge magnitude from an atom count in common ions", () => {
    // "Ca2+" and "NH4+" are spelled the same way but the digit means different things: a lone
    // element symbol takes the digit as its charge, a polyatomic body keeps it as a count.
    const scripts = (formula: string) =>
      formulaSpansFromText(formula).map((span) => `${span.text}:${span.script}`);

    expect(scripts("NH4+")).toEqual(["NH:normal", "4:subscript", "+:superscript"]);
    expect(scripts("NO3-")).toEqual(["NO:normal", "3:subscript", "-:superscript"]);
    expect(scripts("ClO4-")).toEqual(["ClO:normal", "4:subscript", "-:superscript"]);
    expect(scripts("MnO4-")).toEqual(["MnO:normal", "4:subscript", "-:superscript"]);
    expect(scripts("PO43-")).toEqual(["PO:normal", "4:subscript", "3-:superscript"]);
    expect(scripts("Ca2+")).toEqual(["Ca:normal", "2+:superscript"]);
    expect(scripts("Fe3+")).toEqual(["Fe:normal", "3+:superscript"]);
    expect(scripts("Na+")).toEqual(["Na:normal", "+:superscript"]);

    // A trailing hyphen on a prefix is not a charge.
    expect(scripts("trans-")).toEqual(["trans-:normal"]);
    expect(scripts("Boc-")).toEqual(["Boc-:normal"]);
    expect(scripts("tert-")).toEqual(["tert-:normal"]);
  });

  it("preserves source span styling when reformatting a formula", () => {
    const styled: TextSpan[] = [
      { text: "H2", script: "normal", style: { color: "#b3261e", fontWeight: 700 } },
      { text: "O", script: "normal", style: { color: "#1b5e20" } }
    ];
    const spans = formulaSpansFromText("H2O", styled);

    expect(spans.map((span) => `${span.text}:${span.script}`)).toEqual([
      "H:normal",
      "2:subscript",
      "O:normal"
    ]);
    expect(spans[0].style).toMatchObject({ color: "#b3261e", fontWeight: 700 });
    expect(spans[1].style).toMatchObject({ color: "#b3261e", fontWeight: 700 });
    expect(spans[2].style).toMatchObject({ color: "#1b5e20" });
  });

});
