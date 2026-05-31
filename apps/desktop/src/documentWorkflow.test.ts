import { describe, expect, it } from "vitest";
import {
  applyAnalysisToSelectedMolecule,
  createNativeSavePayload,
  createPhase4Document,
  exportPhase4Svg,
  getSelectedMolecule,
  insertAdapterFallbackMolecule,
  openNativeDocument
} from "./documentWorkflow";

describe("Phase 4 document workflow", () => {
  it("creates a real blank native document and inserts an adapter-backed fallback molecule", () => {
    const document = createPhase4Document("Phase 4 Fixture.chemdraft");
    const withObject = insertAdapterFallbackMolecule(document);

    expect(document.pages[0].objects).toEqual([]);
    expect(withObject.pages[0].objects).toHaveLength(1);
    expect(withObject.pages[0].objects[0]).toMatchObject({
      type: "molecule",
      structureFormat: "smiles",
      structure: "CCO",
      compatibility: {
        sourceFormat: "editor-adapter-fallback"
      }
    });
    expect(withObject.selection.objectIds).toEqual([withObject.pages[0].objects[0].id]);
    expect(getSelectedMolecule(withObject)?.structure).toBe("CCO");
  });

  it("saves and opens the Phase 4 native document subset", () => {
    const document = insertAdapterFallbackMolecule(createPhase4Document("Round Trip"));
    const payload = createNativeSavePayload(document);
    const reopened = openNativeDocument(payload.contents);

    expect(payload.filename).toBe("Round-Trip.chemdraft");
    expect(payload.mimeType).toBe("application/vnd.chemdraft+json");
    expect(reopened).toEqual(document);
  });

  it("exports the Phase 4 subset as SVG", () => {
    const document = insertAdapterFallbackMolecule(createPhase4Document("SVG Fixture"));
    const result = exportPhase4Svg(document);

    expect(result.format).toBe("svg");
    expect(result.contents).toContain('aria-label="SVG Fixture"');
    expect(result.contents).toContain('data-object-type="molecule"');
    expect(result.contents).toContain("CCO");
  });

  it("applies Phase 5 chemistry analysis to the selected molecule through a document patch", () => {
    const document = insertAdapterFallbackMolecule(createPhase4Document("Analysis Fixture"));
    const analyzed = applyAnalysisToSelectedMolecule(document, {
      input: { format: "smiles", value: "CCO" },
      validation: { valid: true, errors: [], warnings: [] },
      properties: {
        formula: "C2H6O",
        averageMass: 46.069,
        exactMass: 46.0419,
        totalCharge: 0,
        atomCount: 3,
        bondCount: 2,
        stereochemistry: []
      },
      warnings: []
    });

    expect(getSelectedMolecule(analyzed)?.chemistry).toMatchObject({
      formula: "C2H6O",
      averageMass: 46.069,
      exactMass: 46.0419,
      atomCount: 3,
      bondCount: 2,
      totalCharge: 0
    });
    expect(getSelectedMolecule(document)?.chemistry).toBeUndefined();
  });
});
