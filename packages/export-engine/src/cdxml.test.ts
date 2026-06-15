import { applyPatch, createEmptyDocument, type MechanismArrowObject, type MoleculeObject } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
import { exportDocumentToCdxml } from "./index";

const timestamp = "2026-06-13T00:00:00.000Z";

describe("exportDocumentToCdxml", () => {
  it("returns a text export result that delegates to the cdx-compat CDXML envelope", () => {
    const document = createEmptyDocument({ title: "CDXML Export", now: timestamp });

    const result = exportDocumentToCdxml(document, { creationProgram: "ChemDraft Export Test" });

    expect(result).toMatchObject({
      format: "cdxml",
      kind: "text",
      mimeType: "chemical/x-cdxml",
      extension: "cdxml",
      warnings: []
    });
    expect(result.contents).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(result.contents).toContain("<CDXML");
    expect(result.contents).toContain('CreationProgram="ChemDraft Export Test"');
    expect(result.contents).toContain('Name="org.chemdraft/native-document"');
  });

  it("maps cdx-compat warnings into export warnings with source object ids", () => {
    const mechanismArrow = {
      id: "mechanism_cdxml_001",
      type: "mechanism-arrow",
      x: 120,
      y: 160,
      width: 64,
      height: 40,
      rotation: 0,
      style: {},
      arrowKind: "full-headed",
      source: { kind: "point", point: { x: 120, y: 160 } },
      target: { kind: "point", point: { x: 184, y: 200 } },
      controlPoints: [],
      warnings: []
    } satisfies MechanismArrowObject;
    const document = applyPatch(
      createEmptyDocument({ title: "CDXML Warning Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: mechanismArrow },
      { now: timestamp }
    );

    const result = exportDocumentToCdxml(document);

    expect(result.warnings).toEqual([
      {
        code: "cdxml.mechanism_payload_only",
        message: "Editable mechanism annotations remain in the ChemDraft payload until CDXML mapping is implemented.",
        severity: "warning",
        objectId: "mechanism_cdxml_001"
      }
    ]);
  });

  it("preserves chemistry warnings from the CDXML compatibility writer", () => {
    const molecule = {
      id: "mol_aromatic_cdxml",
      type: "molecule",
      x: 92,
      y: 92,
      width: 72,
      height: 16,
      rotation: 0,
      style: {},
      structureFormat: "smiles",
      structure: "c1ccccc1",
      atoms: [
        { id: "atom_001", element: "C", x: 100, y: 100, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 148, y: 100, formalCharge: 0 }
      ],
      bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "aromatic" }],
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ title: "CDXML Aromatic Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: molecule },
      { now: timestamp }
    );

    const result = exportDocumentToCdxml(document);

    expect(result.contents).toContain("<fragment");
    expect(result.warnings.map((warning) => warning.code)).toContain("cdxml.aromatic_bond_approximation");
    expect(result.warnings[0].severity).toBe("warning");
  });
});
