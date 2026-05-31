import {
  applyPatch,
  createEmptyDocument,
  createPageLayout,
  inchesToCssPx,
  mmToCssPx,
  type MoleculeObject
} from "@chemdraft/chem-core";
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
    expect(result.contents).toContain('width="8.5in" height="11in"');
    expect(result.contents).toContain('viewBox="0 0 816 1056"');
    expect(result.contents).toContain('data-object-id="mol_export_001"');
    expect(result.contents).toContain("CCO");
  });

  it("preserves ISO physical page units while keeping the internal CSS-px viewBox", () => {
    const a4Layout = createPageLayout("a4");
    const document = applyPatch(
      createEmptyDocument({ title: "A4 Export", now: timestamp }),
      {
        op: "updatePageLayout",
        pageId: "page_001",
        layout: a4Layout
      },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);

    expect(result.contents).toContain('width="210mm" height="297mm"');
    expect(result.contents).toContain(`viewBox="0 0 ${mmToCssPx(210)} ${mmToCssPx(297)}"`);
  });

  it("preserves US Legal physical page units while keeping the internal CSS-px viewBox", () => {
    const legalLayout = createPageLayout("legal");
    const document = applyPatch(
      createEmptyDocument({ title: "Legal Export", now: timestamp }),
      {
        op: "updatePageLayout",
        pageId: "page_001",
        layout: legalLayout
      },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);

    expect(result.contents).toContain('width="8.5in" height="14in"');
    expect(result.contents).toContain(`viewBox="0 0 ${inchesToCssPx(8.5)} ${inchesToCssPx(14)}"`);
  });
});
