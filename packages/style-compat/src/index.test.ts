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

describe("ChemDraw .cds style-sheet import", () => {
  it("extracts style-sheet identity metadata into an imported ChemDraft style preset", () => {
    const result = importChemDrawStyleSheet(
      syntheticCdsFixture(["ChemDraw 10.0", "Synthetic Style.cds", "Arial"])
    );

    expect(result.source).toMatchObject({
      format: "chemdraw-cds",
      applicationVersion: "ChemDraw 10.0",
      name: "Synthetic Style.cds",
      fontFamily: "Arial"
    });
    expect(result.preset).toMatchObject({
      id: "imported.chemdraw-cds.synthetic-style",
      name: "Synthetic Style",
      source: "imported",
      sourceFormat: "chemdraw-cds",
      applicationVersion: "ChemDraw 10.0",
      drawing: {
        stylePresetId: "imported.chemdraw-cds.synthetic-style",
        bondLengthPx: 22,
        atomLabelFontFamily: "Arial, Helvetica, sans-serif"
      }
    });
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
