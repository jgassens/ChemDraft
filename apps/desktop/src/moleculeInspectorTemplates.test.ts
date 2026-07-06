import { DefaultNativeDrawingStyle } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
import {
  moleculeInspectorTemplateFilename,
  moleculeInspectorTemplateFormat,
  moleculeInspectorTemplatePatchFromDrawingStyle,
  parseMoleculeInspectorTemplate,
  serializeMoleculeInspectorTemplate
} from "./moleculeInspectorTemplates";

function syntheticCdsFixture(strings: readonly string[]): Uint8Array {
  const chunks = strings.flatMap((value) => [...new TextEncoder().encode(value), 0]);
  return new Uint8Array([
    ...new TextEncoder().encode("VjCD0100"),
    0,
    0,
    0,
    ...chunks,
    ...fixed16Property(0x0803, 120),
    ...uint16Property(0x0804, 180),
    ...fixed16Property(0x0805, 14.4),
    ...fixed16Property(0x0808, 1.5999908447265625),
    ...fixed16Property(0x0809, 2.5)
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

describe("Molecule Inspector templates", () => {
  it("serializes and parses ChemDraft .template files", () => {
    const drawing = {
      ...DefaultNativeDrawingStyle,
      stylePresetId: "template.custom",
      bondStrokeWidthPx: 3.25,
      atomLabelFontFamily: "Helvetica"
    };
    const serialized = serializeMoleculeInspectorTemplate("Custom Inspector", drawing, {
      exportedAt: "2026-06-28T00:00:00.000Z"
    });
    const parsedJson = JSON.parse(serialized) as { format: string };

    expect(parsedJson.format).toBe(moleculeInspectorTemplateFormat);
    const parsed = parseMoleculeInspectorTemplate(serialized, "Custom Inspector.template");
    expect(parsed).toMatchObject({
      name: "Custom Inspector",
      sourceFormat: "chemdraft-template",
      sourceName: "Custom Inspector.template",
      warnings: [],
      drawing: {
        stylePresetId: "template.custom",
        bondStrokeWidthPx: 3.25,
        atomLabelFontFamily: "Helvetica"
      }
    });
  });

  it("accepts ChemDraft style preset JSON as a template input", () => {
    const parsed = parseMoleculeInspectorTemplate(JSON.stringify({
      id: "preset.lab",
      name: "Lab Preset",
      drawing: {
        ...DefaultNativeDrawingStyle,
        bondHashSpacingPx: 12
      }
    }), "Lab Preset.template");

    expect(parsed.drawing).toMatchObject({
      stylePresetId: "preset.lab",
      bondHashSpacingPx: 12
    });
  });

  it("imports ChemDraw .cds inputs through style compatibility", () => {
    const parsed = parseMoleculeInspectorTemplate(
      syntheticCdsFixture(["ChemDraw 10.0", "Tot Syn Style.cds", "Arial"]),
      "Tot Syn Style.cds"
    );

    expect(parsed).toMatchObject({
      name: "Tot Syn Style",
      sourceFormat: "chemdraw-cds",
      sourceName: "Tot Syn Style.cds",
      drawing: {
        chainAngleDegrees: 120,
        bondLengthPx: 22,
        bondSpacingPercent: 18,
        bondMarginWidthPx: 6,
        bondHashSpacingPx: 9,
        atomLabelFontFamily: "Arial, Helvetica, sans-serif"
      }
    });
    expect(parsed.warnings).toContainEqual({
      code: "style.cds.binary_subset_decode",
      message: expect.stringContaining("unsupported binary .cds settings were ignored")
    });
  });

  it("exports a style patch without the preset id and creates .template filenames", () => {
    const patch = moleculeInspectorTemplatePatchFromDrawingStyle({
      ...DefaultNativeDrawingStyle,
      stylePresetId: "template.custom"
    });

    expect("stylePresetId" in patch).toBe(false);
    expect(patch.bondLengthPx).toBe(DefaultNativeDrawingStyle.bondLengthPx);
    expect(moleculeInspectorTemplateFilename("Tot Syn Style.cds")).toBe("Tot-Syn-Style.template");
  });
});
