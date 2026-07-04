import { describe, expect, it } from "vitest";
import {
  moleculeAtomLabelAlignmentCommandId,
  moleculeAtomLabelAlignmentForCommand,
  moleculeAtomLabelBackgroundColorCommandId,
  moleculeAtomLabelBackgroundCommandId,
  moleculeAtomLabelFontFaceCommandId,
  moleculeAtomLabelFontFaceForCommand,
  moleculeAtomLabelFontFamilyCommandId,
  moleculeAtomLabelFontFamilyForCommand,
  moleculeAtomLabelHideImplicitHydrogensCommandId,
  moleculeAtomLabelHideImplicitHydrogensForCommand,
  moleculeAtomLabelPlacementCommandId,
  moleculeAtomLabelPlacementForCommand,
  moleculeAtomLabelShowTerminalCarbonsCommandId,
  moleculeAtomLabelShowTerminalCarbonsForCommand,
  moleculeStructureAtomEnhancedStereochemistryCommandId,
  moleculeStructureAtomEnhancedStereochemistryForCommand,
  moleculeStructureBondBoldWidthCommandId,
  moleculeStructureBondBoldWidthForCommand,
  moleculeStructureBondHashSpacingCommandId,
  moleculeStructureBondHashSpacingForCommand,
  moleculeStructureBondLengthCommandId,
  moleculeStructureBondLengthForCommand,
  moleculeStructureBondLineCapCommandId,
  moleculeStructureBondLineCapForCommand,
  moleculeStructureBondReactionIndicatorsCommandId,
  moleculeStructureBondReactionIndicatorsForCommand,
  moleculeStructureBondSpacingModeCommandId,
  moleculeStructureBondSpacingModeForCommand,
  moleculeStructureBondSpacingPercentCommandId,
  moleculeStructureBondSpacingPercentForCommand,
  moleculeStructureBondStrokeWidthCommandId,
  moleculeStructureBondStrokeWidthForCommand,
  moleculeStructureChainAngleCommandId,
  moleculeStructureChainAngleForCommand
} from "./commands";

describe("Molecule Inspector commands", () => {
  it("canonicalizes and strictly parses Structure numeric commands", () => {
    expect(moleculeStructureBondLengthCommandId(96.123456)).toBe("molecule.structure.bondLength:96.123");
    expect(moleculeStructureBondLengthForCommand("molecule.structure.bondLength:96.123")).toEqual({ value: 96.123 });
    expect(moleculeStructureBondStrokeWidthCommandId(2)).toBe("molecule.structure.bondStrokeWidth:2");
    expect(moleculeStructureBondStrokeWidthForCommand("molecule.structure.bondStrokeWidth:2")).toEqual({ value: 2 });
    expect(moleculeStructureChainAngleCommandId(119.999)).toBe("molecule.structure.chainAngle:119.999");
    expect(moleculeStructureChainAngleForCommand("molecule.structure.chainAngle:119.999")).toEqual({ value: 119.999 });
    expect(moleculeStructureBondBoldWidthCommandId(2.01)).toBe("molecule.structure.bondBoldWidth:2.01");
    expect(moleculeStructureBondBoldWidthForCommand("molecule.structure.bondBoldWidth:2.01")).toEqual({ value: 2.01 });
    expect(moleculeStructureBondSpacingPercentCommandId(18)).toBe("molecule.structure.bondSpacingPercent:18");
    expect(moleculeStructureBondSpacingPercentForCommand("molecule.structure.bondSpacingPercent:18")).toEqual({ value: 18 });
    expect(moleculeStructureBondHashSpacingCommandId(2.49)).toBe("molecule.structure.bondHashSpacing:2.49");
    expect(moleculeStructureBondHashSpacingForCommand("molecule.structure.bondHashSpacing:2.49")).toEqual({ value: 2.49 });
    expect(moleculeStructureBondLengthForCommand("molecule.structure.bondLength:0")).toBeUndefined();
    expect(moleculeStructureBondLengthForCommand("molecule.structure.bondLength:999")).toBeUndefined();
    expect(moleculeStructureChainAngleForCommand("molecule.structure.chainAngle:180")).toBeUndefined();
    expect(moleculeStructureBondSpacingPercentForCommand("molecule.structure.bondSpacingPercent:0")).toBeUndefined();
    expect(moleculeStructureBondStrokeWidthForCommand("molecule.structure.bondStrokeWidth:2px")).toBeUndefined();
  });

  it("strictly parses Structure enum commands", () => {
    expect(moleculeStructureBondLineCapCommandId("round")).toBe("molecule.structure.bondLineCap:round");
    expect(moleculeStructureBondLineCapForCommand("molecule.structure.bondLineCap:round")).toEqual({ value: "round" });
    expect(moleculeStructureBondLineCapForCommand("molecule.structure.bondLineCap:triangle")).toBeUndefined();
    expect(moleculeStructureBondSpacingModeCommandId("percent")).toBe("molecule.structure.bondSpacingMode:percent");
    expect(moleculeStructureBondSpacingModeForCommand("molecule.structure.bondSpacingMode:percent")).toEqual({
      value: "percent"
    });
    expect(moleculeStructureBondSpacingModeForCommand("molecule.structure.bondSpacingMode:relative")).toBeUndefined();
  });

  it("keeps Structure indicator commands explicit", () => {
    expect(moleculeStructureAtomEnhancedStereochemistryCommandId(false)).toBe(
      "molecule.structure.atomIndicators.enhancedStereochemistry:false"
    );
    expect(moleculeStructureAtomEnhancedStereochemistryForCommand(
      "molecule.structure.atomIndicators.enhancedStereochemistry:false"
    )).toEqual({ value: false });
    expect(moleculeStructureBondReactionIndicatorsCommandId(true)).toBe(
      "molecule.structure.bondIndicators.reaction:true"
    );
    expect(moleculeStructureBondReactionIndicatorsForCommand(
      "molecule.structure.bondIndicators.reaction:true"
    )).toEqual({ value: true });
    expect(moleculeStructureBondReactionIndicatorsForCommand(
      "molecule.structure.bondIndicators.reaction:toggle"
    )).toBeUndefined();
  });

  it("keeps the atom-label Background control reversible (Transparent <-> Solid)", () => {
    const transparent = moleculeAtomLabelBackgroundColorCommandId("transparent");

    // Selecting Transparent commits the transparent background.
    expect(moleculeAtomLabelBackgroundCommandId("transparent", "#123456", "#abcdef")).toBe(transparent);

    // Solid with a live color keeps that color.
    expect(moleculeAtomLabelBackgroundCommandId("solid", "#ff0000", "#abcdef")).toBe(
      moleculeAtomLabelBackgroundColorCommandId("#ff0000")
    );

    // Regression: Solid while currently transparent must NOT stay transparent; it
    // restores the last remembered solid color instead.
    const restored = moleculeAtomLabelBackgroundCommandId("solid", "transparent", "#123456");
    expect(restored).toBe(moleculeAtomLabelBackgroundColorCommandId("#123456"));
    expect(restored).not.toBe(transparent);

    // No live or remembered color falls back to a white solid, never transparent.
    const fallback = moleculeAtomLabelBackgroundCommandId("solid", "transparent", undefined);
    expect(fallback).toBe(moleculeAtomLabelBackgroundColorCommandId("#ffffff"));
    expect(fallback).not.toBe(transparent);
  });

  it("encodes arbitrary font families and atom-label font faces", () => {
    const familyCommand = moleculeAtomLabelFontFamilyCommandId("Avenir Next Condensed");

    expect(familyCommand).toBe("molecule.atomLabel.fontFamily:Avenir%20Next%20Condensed");
    expect(moleculeAtomLabelFontFamilyForCommand(familyCommand)).toEqual({ fontFamily: "Avenir Next Condensed" });
    expect(moleculeAtomLabelFontFaceCommandId(700, "italic")).toBe("molecule.atomLabel.fontFace:700:italic");
    expect(moleculeAtomLabelFontFaceForCommand("molecule.atomLabel.fontFace:700:italic")).toEqual({
      weight: 700,
      style: "italic"
    });
    expect(moleculeAtomLabelFontFaceForCommand("molecule.atomLabel.fontFace:0:italic")).toBeUndefined();
    expect(moleculeAtomLabelFontFaceForCommand("molecule.atomLabel.fontFace:700:oblique")).toBeUndefined();
  });

  it("keeps atom-label alignment, placement, and display toggles explicit", () => {
    expect(moleculeAtomLabelAlignmentCommandId("center")).toBe("molecule.atomLabel.alignment:center");
    expect(moleculeAtomLabelAlignmentForCommand("molecule.atomLabel.alignment:center")).toEqual({ value: "center" });
    expect(moleculeAtomLabelAlignmentForCommand("molecule.atomLabel.alignment:flush-left")).toBeUndefined();
    expect(moleculeAtomLabelPlacementCommandId("above")).toBe("molecule.atomLabel.placement:above");
    expect(moleculeAtomLabelPlacementForCommand("molecule.atomLabel.placement:above")).toEqual({ value: "above" });
    expect(moleculeAtomLabelShowTerminalCarbonsCommandId(true)).toBe("molecule.atomLabel.showTerminalCarbons:true");
    expect(moleculeAtomLabelShowTerminalCarbonsForCommand("molecule.atomLabel.showTerminalCarbons:true")).toEqual({
      value: true
    });
    expect(moleculeAtomLabelHideImplicitHydrogensCommandId(false)).toBe("molecule.atomLabel.hideImplicitHydrogens:false");
    expect(moleculeAtomLabelHideImplicitHydrogensForCommand("molecule.atomLabel.hideImplicitHydrogens:false")).toEqual({
      value: false
    });
    expect(moleculeAtomLabelHideImplicitHydrogensForCommand("molecule.atomLabel.hideImplicitHydrogens:toggle")).toBeUndefined();
  });
});
