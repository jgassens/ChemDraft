import { describe, expect, it } from "vitest";
import { DocumentMoleculeSizeStyle } from "@chemdraft/chem-core";
import { buildSmilesDocument } from "./document";

// Explicit pre-insertion-defaults values: CLI figures must retain their existing style.
const legacyStyle = {
  stylePresetId: "chemdraft.synthetic",
  chainAngleDegrees: 120,
  bondLengthPx: 28,
  bondStrokeWidthPx: 2,
  bondBoldWidthPx: 4.8,
  bondColor: "#000000",
  bondLineCap: "butt",
  bondSpacingMode: "absolute",
  bondSpacingPercent: 18,
  multipleBondGapPx: 4.8,
  doubleBondInsetPx: 4.5,
  bondMarginWidthPx: 6,
  bondHashSpacingPx: 9,
  bondOverlapClearancePx: 6,
  atomIndicatorShowQuery: true,
  atomIndicatorShowStereochemistry: false,
  atomIndicatorShowEnhancedStereochemistry: true,
  atomIndicatorShowAtomNumbers: false,
  bondIndicatorShowQuery: true,
  bondIndicatorShowStereochemistry: false,
  bondIndicatorShowReaction: true,
  atomLabelFontFamily: "Arial, Helvetica, sans-serif",
  atomLabelFontSizePx: 15,
  atomLabelFontWeight: 400,
  atomLabelFontStyle: "normal",
  atomLabelColor: "#000000",
  atomLabelBackgroundColor: "#ffffff",
  atomLabelPaddingPx: 2,
  atomLabelBondClearancePx: 7,
  atomLabelAlignment: "automatic",
  atomLabelPlacement: "automatic",
  atomLabelShowTerminalCarbons: false,
  atomLabelHideImplicitHydrogens: false,
  source: "clipboard-smiles"
};
const legacyDocumentDimensions = {
  stylePresetId: "chemdraft.document",
  chainAngleDegrees: 120,
  bondLengthPx: 22,
  bondStrokeWidthPx: 1.7325,
  bondBoldWidthPx: 3.465,
  bondSpacingMode: "percent",
  bondSpacingPercent: 18,
  multipleBondGapPx: 3.96,
  doubleBondInsetPx: 4.5,
  bondMarginWidthPx: 2.4444444444444446,
  bondHashSpacingPx: 3.8194444444444446,
  atomLabelFontFamily: "Arial, Helvetica, sans-serif",
  atomLabelFontSizePx: 15.277777777777779
};

describe("CLI insertion size compatibility", () => {
  it.each([undefined, "document"] as const)("retains legacy geometry and style with %s options", async style => {
    const { molecule } = await buildSmilesDocument("CC", style ? { style } : {});
    const atoms = new Map(molecule.atoms.map(atom => [atom.id, atom]));
    const lengths = molecule.bonds.map(bond => {
      const from = atoms.get(bond.fromAtomId)!;
      const to = atoms.get(bond.toAtomId)!;
      return Math.hypot(to.x - from.x, to.y - from.y);
    });
    expect(lengths.length).toBeGreaterThan(0);
    expect(Math.abs(lengths.reduce((sum, value) => sum + value, 0) / lengths.length - (style ? 22 : 28))).toBeLessThan(0.01);
    const expected = style ? { ...legacyStyle, ...legacyDocumentDimensions } : legacyStyle;
    expect(Object.keys(molecule.style).sort()).toEqual(Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected)) {
      if (typeof value === "number") expect(molecule.style[key], key).toBeCloseTo(value, 10);
      else expect(molecule.style[key], key).toEqual(value);
    }
    if (style) expect(molecule.style).toMatchObject(DocumentMoleculeSizeStyle);
  }, 60_000);
});
