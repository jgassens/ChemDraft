import { describe, expect, it } from "vitest";

import {
  ChemDraftSyntheticStylePreset,
  createEmptyDocument,
  DefaultNativeDrawingStyle,
  stylePresetToObjectStyle,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject
} from "@chemdraft/chem-core";

import { atomDisplayLabel, atomLabelLayout, planMoleculeAtomLabels, planPageSvgRender } from "./index";
import { atomLabelGlyphBoxes, elementFragments } from "./testing";
import { nativeElementFromAtomLabel, nativeElementSymbols, normalizeNativeAtomElementLabel } from "./valence";

describe("inorganic display typography", () => {
  const molecule = (atoms: MoleculeAtom[], bonds: MoleculeBond[] = []): MoleculeObject => ({
    id: "inorganic", type: "molecule", x: 0, y: 0, width: 80, height: 40,
    rotation: 0, style: {}, structureFormat: "smiles", structure: "", atoms, bonds,
    superatoms: [], rGroups: []
  });
  const atom = (id: string, element: string, x: number, formalCharge = 0): MoleculeAtom =>
    ({ id, element, x, y: 0, formalCharge });

  it("spells free water H2O and keeps its glyphs apart", () => {
    const water = molecule([atom("o", "O", 0)]);
    const before = JSON.stringify(water);
    const plan = planMoleculeAtomLabels(water)[0]!;
    expect(plan.label).toBe("H2O");
    const boxes = atomLabelGlyphBoxes(plan.layout.runs, plan.drawingStyle);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.left).toBeGreaterThanOrEqual(boxes[i - 1]!.right);
    expect(JSON.stringify(water)).toBe(before);
  });

  it("combines only the specified sodium hydroxide ion pair and retains isotope labels", () => {
    const sodium = atom("na", "Na", 22, 1), hydroxide = atom("o", "O", 0, -1);
    const salt = molecule([sodium, hydroxide]);
    const before = JSON.stringify(salt);
    expect(planMoleculeAtomLabels(salt).map(plan => plan.label)).toEqual(["NaOH"]);
    expect(JSON.stringify(salt)).toBe(before);
    expect(planMoleculeAtomLabels(molecule([sodium, { ...hydroxide, isotope: 18 }])).map(plan => plan.label))
      .not.toContain("NaOH");
    expect(planMoleculeAtomLabels(molecule([sodium, { ...hydroxide, formalCharge: -2 }])).map(plan => plan.label))
      .not.toContain("NaOH");
  });

  it.each([1, -1])("spells a straight Mg-halide fragment toward its attachment (direction %s)", direction => {
    const atoms = [atom("br", "Br", -22 * direction), atom("mg", "Mg", 0), atom("c", "C", 22 * direction)];
    const bonds: MoleculeBond[] = [
      { id: "b0", fromAtomId: "br", toAtomId: "mg", order: "single" },
      { id: "b1", fromAtomId: "mg", toAtomId: "c", order: "single" }
    ];
    const fragment = molecule(atoms, bonds);
    const before = JSON.stringify(fragment);
    const plans = planMoleculeAtomLabels(fragment);
    expect(plans.map(plan => plan.label)).toContain(direction === 1 ? "BrMg" : "MgBr");
    expect(plans.some(plan => plan.atom.id === "br")).toBe(false);
    const page = { ...createEmptyDocument().pages[0]!, objects: [fragment] };
    const segments = planPageSvgRender(page).fragments.flatMap(elementFragments)
      .filter(part => part.attrs["data-bond-id"] === "b0");
    expect(segments).toHaveLength(0);
    expect(JSON.stringify(fragment)).toBe(before);
    const labelled = planMoleculeAtomLabels(molecule([{ ...atoms[0]!, isotope: 81 }, ...atoms.slice(1)], bonds));
    expect(labelled.some(plan => plan.atom.id === "br")).toBe(true);
  });
});

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

describe("hydrogens lead a terminal label whose bond leaves to the right", () => {
  const terminal = (element: string, neighborX: number, extra: Partial<MoleculeAtom> = {}) => {
    const atoms: MoleculeAtom[] = [
      { id: "a", element, x: 0, y: 0, formalCharge: 0, labelVisible: true, ...extra },
      { id: "b", element: "C", x: neighborX, y: 0, formalCharge: 0, labelVisible: false }
    ];
    const bonds: MoleculeBond[] = [{ id: "bond", fromAtomId: "a", toAtomId: "b", order: "single" }];
    return { atoms, bonds };
  };

  it.each([["C", "H3C", "CH3"], ["N", "H2N", "NH2"], ["B", "H2B", "BH2"], ["P", "H2P", "PH2"], ["O", "HO", "OH"], ["S", "HS", "SH"]])(
    "draws terminal %s as %s with its bond on the right and %s with it on the left",
    (element, leading, trailing) => {
      const right = terminal(element, 40);
      expect(atomDisplayLabel(right.atoms[0]!, right.bonds, DefaultNativeDrawingStyle, right.atoms)).toBe(leading);
      const left = terminal(element, -40);
      expect(atomDisplayLabel(left.atoms[0]!, left.bonds, DefaultNativeDrawingStyle, left.atoms))
        .toBe(trailing);
    }
  );

  it("keeps the charge after the element and an isotope label element-first", () => {
    const ammonium = terminal("N", 40, { formalCharge: 1 });
    expect(atomDisplayLabel(ammonium.atoms[0]!, ammonium.bonds, DefaultNativeDrawingStyle, ammonium.atoms)).toBe("H3N+");
    const labelled = terminal("C", 40, { isotope: 13 });
    expect(atomDisplayLabel(labelled.atoms[0]!, labelled.bonds, DefaultNativeDrawingStyle, labelled.atoms)).toBe("13CH3");
  });

  it.each([["H3C", "C", "3"], ["H2N", "N", "2"], ["H3N+", "N", "3"]])(
    "lays out %s with the element on the atom and H and its count to the left",
    (label, element, count) => {
      const layout = atomLabelLayout(label, DefaultNativeDrawingStyle);
      const [hydrogen, subscript, symbol] = layout.runs;
      expect(symbol).toMatchObject({ text: element, script: "normal", x: 0, textAnchor: "middle" });
      expect(subscript).toMatchObject({ text: count, script: "subscript", textAnchor: "end" });
      expect(hydrogen).toMatchObject({ text: "H", script: "normal", textAnchor: "end" });
      expect(subscript!.x).toBeLessThan(0);
      expect(hydrogen!.x).toBeLessThan(subscript!.x);
      expect(layout.bounds.x).toBeLessThan(hydrogen!.x - 1);
      expect(layout.bounds.x + layout.bounds.width).toBeGreaterThan(0);
    }
  );

  // The gap a reader sees between two neighbouring letters: the space between their glyph boxes.
  const glyphGap = (label: string, leftText: string, rightText: string) => {
    const boxes = atomLabelGlyphBoxes(atomLabelLayout(label, DefaultNativeDrawingStyle).runs, DefaultNativeDrawingStyle);
    const index = boxes.findIndex((box, at) => box.text === leftText && boxes[at + 1]?.text === rightText);
    expect(index, `${label}: ${leftText} then ${rightText}`).toBeGreaterThanOrEqual(0);
    return boxes[index + 1]!.left - boxes[index]!.right;
  };

  it.each([["O", "HO", "OH"], ["S", "HS", "SH"]])(
    "sets %s's leading H exactly as tight as its trailing H (%s and %s)",
    (element, leading, trailing) => {
      const leftSide = glyphGap(leading, "H", element);
      const rightSide = glyphGap(trailing, element, "H");
      expect(Math.abs(leftSide - rightSide)).toBeLessThanOrEqual(0.5);
      expect(leftSide).toBeCloseTo(rightSide, 6);
    }
  );

  it("no longer opens the 0.15 em gap that drew HO as 'H O'", () => {
    const fontSize = DefaultNativeDrawingStyle.atomLabelFontSizePx;
    // Before: the H ended 0.12 em before a 0.38 em minimum half-width, 0.11 em clear of the O.
    expect(glyphGap("HO", "H", "O")).toBeLessThan(fontSize * 0.02);
  });

  it.each([["C", "H3C", "CH3", "3"], ["N", "H2N", "NH2", "2"], ["B", "H2B", "BH2", "2"], ["P", "H2P", "PH2", "2"]])(
    "sets %s's leading hydrogens as tightly as its trailing ones (%s and %s), subscript included",
    (element, leading, trailing, count) => {
      const trailingGap = glyphGap(trailing, element, "H");
      // Leaving the subscript out, H sits as close to the element in "H2N" as in "NH2".
      const boxes = atomLabelGlyphBoxes(atomLabelLayout(leading, DefaultNativeDrawingStyle).runs, DefaultNativeDrawingStyle);
      const [hydrogen, subscript, symbol] = boxes;
      expect(boxes.map((box) => box.text)).toEqual(["H", count, element]);
      const leadingGap = symbol!.left - hydrogen!.right - (subscript!.right - subscript!.left);
      expect(Math.abs(leadingGap - trailingGap)).toBeLessThanOrEqual(0.5);
      // And no letter crowds or leaves room around the subscript: each pair is set like "NH".
      expect(glyphGap(leading, count, element)).toBeCloseTo(trailingGap, 6);
      expect(glyphGap(leading, "H", count)).toBeCloseTo(trailingGap, 6);
      // The subscript keeps the trailing label's size and drop.
      const leadingCount = atomLabelLayout(leading, DefaultNativeDrawingStyle).runs.find((run) => run.text === count)!;
      const trailingCount = atomLabelLayout(trailing, DefaultNativeDrawingStyle).runs.find((run) => run.text === count)!;
      expect(leadingCount).toMatchObject({ script: "subscript", y: trailingCount.y });
      expect(leadingCount.y).toBeGreaterThan(0);
    }
  );

  it("keeps the left-side gaps equal at other sizes, weights and slants", () => {
    const style = { ...DefaultNativeDrawingStyle, atomLabelFontSizePx: 31, atomLabelFontWeight: 700, atomLabelFontStyle: "italic" as const };
    const gap = (label: string, leftText: string, rightText: string) => {
      const boxes = atomLabelGlyphBoxes(atomLabelLayout(label, style).runs, style);
      const index = boxes.findIndex((box, at) => box.text === leftText && boxes[at + 1]?.text === rightText);
      return boxes[index + 1]!.left - boxes[index]!.right;
    };
    expect(gap("HO", "H", "O")).toBeCloseTo(gap("OH", "O", "H"), 6);
    expect(gap("H2N", "2", "N")).toBeCloseTo(gap("NH2", "N", "H"), 6);
    expect(gap("H2N", "H", "2")).toBeCloseTo(gap("NH2", "N", "H"), 6);
  });

  it("places the page SVG's H-first runs exactly where the shared layout puts them", () => {
    const { atoms, bonds } = terminal("O", 40);
    const molecule: MoleculeObject = {
      id: "mol", type: "molecule", x: 0, y: 0, width: 40, height: 1, rotation: 0,
      style: { ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset), source: "chemdraft-native-drawing" },
      structureFormat: "smiles", structure: "OC", atoms, bonds, superatoms: [], rGroups: []
    };
    const page = { ...createEmptyDocument().pages[0]!, objects: [molecule] };
    const label = planPageSvgRender(page).fragments.flatMap(elementFragments)
      .find((fragment) => fragment.attrs["data-atom-label"] === "HO")!;
    expect(label).toBeDefined();
    const runs = label.children.flatMap(elementFragments).filter((fragment) => fragment.attrs.class === "native-atom-label-run");
    expect(runs.map((run) => run.children.map((child) => (child.kind === "text" ? child.text : "")).join(""))).toEqual(["H", "O"]);
    expect(runs.map((run) => run.attrs["text-anchor"])).toEqual(["end", "middle"]);
    // The page draws the layout's own runs, shifted by the atom position and nothing else.
    const plan = planMoleculeAtomLabels(molecule).find((candidate) => candidate.label === "HO")!;
    const shift = Number(runs[1]!.attrs.x) - plan.layout.runs[1]!.x;
    runs.forEach((run, index) => expect(Number(run.attrs.x) - shift).toBeCloseTo(plan.layout.runs[index]!.x, 6));
    const boxes = atomLabelGlyphBoxes(
      runs.map((run, index) => ({ ...plan.layout.runs[index]!, x: Number(run.attrs.x) })),
      plan.drawingStyle
    );
    // "OH" is one run: its two glyph boxes.
    const trailing = atomLabelGlyphBoxes(atomLabelLayout("OH", plan.drawingStyle).runs, plan.drawingStyle);
    expect(boxes[1]!.left - boxes[0]!.right).toBeCloseTo(trailing[1]!.left - trailing[0]!.right, 6);
  });

  it("draws the same H-first runs on the page SVG the canvas and the exports share", () => {
    const { atoms, bonds } = terminal("N", 40);
    const molecule: MoleculeObject = {
      id: "mol",
      type: "molecule",
      x: 0,
      y: 0,
      width: 40,
      height: 1,
      rotation: 0,
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing",
        atomLabelHideImplicitHydrogens: false
      },
      structureFormat: "smiles",
      structure: "NC",
      atoms,
      bonds,
      superatoms: [],
      rGroups: []
    };
    const page = { ...createEmptyDocument().pages[0]!, objects: [molecule] };
    const text = planPageSvgRender(page).fragments.flatMap(elementFragments)
      .filter((fragment) => fragment.attrs.class === "native-atom-label-run")
      .flatMap((fragment) => fragment.children)
      .filter((fragment) => fragment.kind === "text")
      .map((fragment) => fragment.text)
      .join("");
    expect(text).toBe("H2N");
  });
});
