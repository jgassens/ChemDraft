import { applyPatch, createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
import { exportDocumentToSvg } from "./index";

const timestamp = "2026-05-29T00:00:00.000Z";

function moleculeObject(): MoleculeObject {
  return {
    id: "mol_export_001",
    type: "molecule",
    x: 120,
    y: 160,
    width: 180,
    height: 96,
    rotation: 0,
    style: {},
    structureFormat: "smiles",
    structure: "CCO",
    chemistry: {
      atomCount: 3,
      bondCount: 2,
      totalCharge: 0,
      radicalCount: 0,
      isotopeLabels: [],
      stereochemistry: [],
      warnings: []
    },
    superatoms: [],
    rGroups: []
  };
}

describe("exportDocumentToSvg", () => {
  it("exports the Phase 4 native document subset as SVG", () => {
    const document = applyPatch(
      createEmptyDocument({ title: "Export Fixture", now: timestamp }),
      {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);

    expect(result.format).toBe("svg");
    expect(result.warnings).toEqual([]);
    expect(result.contents).toContain('aria-label="Export Fixture"');
    expect(result.contents).toContain('data-object-id="mol_export_001"');
    expect(result.contents).toContain("CCO");
  });
});
