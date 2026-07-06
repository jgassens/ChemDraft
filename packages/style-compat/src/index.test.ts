import { describe, expect, it } from "vitest";
import { importChemDrawStyleSheet } from "./index";

function syntheticCdsFixture(strings: readonly string[]): Uint8Array {
  const chunks = strings.flatMap((value) => [...new TextEncoder().encode(value), 0]);
  return new Uint8Array([
    ...new TextEncoder().encode("VjCD0100"),
    0,
    0,
    0,
    ...chunks
  ]);
}

function syntheticCdsStyleFixture(strings: readonly string[]): Uint8Array {
  return new Uint8Array([
    ...syntheticCdsFixture(strings),
    ...fixed16Property(0x0803, 120),
    ...uint16Property(0x0804, 180),
    ...fixed16Property(0x0805, 14.4),
    ...fixed16Property(0x0806, 2.2677154541015625),
    ...fixed16Property(0x0807, 1.13385009765625),
    ...fixed16Property(0x0808, 1.5999908447265625),
    ...fixed16Property(0x0809, 2.5),
    ...fixed16Property(0x0816, 35.99998474121094)
  ]);
}

function fixed16Property(tag: number, value: number): number[] {
  const scaled = Math.round(value * 65536);
  return [
    tag & 0xff,
    tag >> 8,
    4,
    0,
    scaled & 0xff,
    (scaled >> 8) & 0xff,
    (scaled >> 16) & 0xff,
    (scaled >> 24) & 0xff
  ];
}

function uint16Property(tag: number, value: number): number[] {
  return [
    tag & 0xff,
    tag >> 8,
    2,
    0,
    value & 0xff,
    value >> 8
  ];
}

describe("ChemDraw .cds style-sheet import", () => {
  it("imports supported style-sheet metadata and drawing fields into a ChemDraft style preset", () => {
    const result = importChemDrawStyleSheet(
      syntheticCdsStyleFixture(["ChemDraw 10.0", "Synthetic Style.cds", "Arial"])
    );

    expect(result.source).toMatchObject({
      format: "chemdraw-cds",
      applicationVersion: "ChemDraw 10.0",
      name: "Synthetic Style.cds",
      fontFamily: "Arial",
      decodedFields: [
        "chainAngleDegrees",
        "bondLengthPx",
        "bondStrokeWidthPx",
        "bondBoldWidthPx",
        "bondSpacingPercent",
        "bondSpacingMode",
        "multipleBondGapPx",
        "bondMarginWidthPx",
        "bondHashSpacingPx"
      ]
    });
    expect(result.preset).toMatchObject({
      id: "imported.chemdraw-cds.synthetic-style",
      name: "Synthetic Style",
      source: "imported",
      sourceFormat: "chemdraw-cds",
      applicationVersion: "ChemDraw 10.0",
      drawing: {
        stylePresetId: "imported.chemdraw-cds.synthetic-style",
        chainAngleDegrees: 120,
        bondLengthPx: 22,
        bondStrokeWidthPx: 2,
        bondBoldWidthPx: 4.8,
        bondSpacingPercent: 18,
        bondSpacingMode: "percent",
        multipleBondGapPx: 4.8,
        bondMarginWidthPx: 6,
        bondHashSpacingPx: 9,
        atomLabelFontFamily: "Arial, Helvetica, sans-serif"
      }
    });
    expect(result.warnings).toContainEqual({
      code: "style.cds.binary_subset_decode",
      message: expect.stringContaining("unsupported binary .cds settings were ignored")
    });
  });

  it("keeps the metadata-only fallback for .cds files without supported drawing records", () => {
    const result = importChemDrawStyleSheet(
      syntheticCdsFixture(["ChemDraw 10.0", "Synthetic Style.cds", "Arial"])
    );

    expect(result.source.decodedFields).toEqual([]);
    expect(result.warnings).toContainEqual({
      code: "style.cds.partial_binary_decode",
      message: expect.stringContaining("unsupported binary .cds settings were not decoded")
    });
  });

  it("rejects inputs without the ChemDraw style-sheet header", () => {
    expect(() => importChemDrawStyleSheet("not a cds file")).toThrow(
      "Unsupported style sheet: expected a ChemDraw .cds header."
    );
  });
});
