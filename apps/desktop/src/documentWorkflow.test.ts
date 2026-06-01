import { describe, expect, it } from "vitest";
import {
  applyAnalysisToSelectedMolecule,
  applyEditorSaveResultToSelectedObject,
  applySingleBondToolAtPoint,
  createNativeSavePayload,
  createNativeSingleBondMolecule,
  createPhase4Document,
  exportPhase4Svg,
  getSelectedMolecule,
  insertAdapterFallbackMolecule,
  insertNativeSingleBondMolecule,
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
    const document = applySingleBondToolAtPoint(
      insertAdapterFallbackMolecule(createPhase4Document("Round Trip")),
      { x: 600, y: 600 }
    );
    const payload = createNativeSavePayload(document);
    const reopened = openNativeDocument(payload.contents);

    expect(payload.filename).toBe("Round-Trip.chemdraft");
    expect(payload.mimeType).toBe("application/vnd.chemdraft+json");
    expect(reopened).toEqual(document);
  });

  it("creates and inserts a real native single-bond molecule through document patches", () => {
    const document = createPhase4Document("Bond Fixture");
    const molecule = createNativeSingleBondMolecule(document, { x: 200, y: 220 });
    const withBond = insertNativeSingleBondMolecule(document, { x: 200, y: 220 });

    expect(molecule).toMatchObject({
      type: "molecule",
      structureFormat: "smiles",
      structure: "CC",
      atoms: [
        { id: "atom_001", element: "C", x: 160, y: 220, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 240, y: 220, formalCharge: 0 }
      ],
      bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }],
      chemistry: {
        formula: "C2H6",
        atomCount: 2,
        bondCount: 1,
        totalCharge: 0
      },
      style: {
        source: "chemdraft-native-drawing",
        drawingPrimitive: "single-bond"
      }
    });
    expect(document.pages[0].objects).toEqual([]);
    expect(withBond.pages[0].objects).toHaveLength(1);
    expect(withBond.pages[0].objects[0]).toMatchObject({ id: "mol_bond_001", structure: "CC" });
    expect(withBond.selection.objectIds).toEqual(["mol_bond_001"]);
  });

  it("extends the selected native single bond into one connected molecule graph", () => {
    const withBond = insertNativeSingleBondMolecule(createPhase4Document("Chain Fixture"), { x: 200, y: 220 });
    const extended = applySingleBondToolAtPoint(withBond, { x: 300, y: 220 });

    expect(extended.pages[0].objects).toHaveLength(1);
    expect(extended.selection.objectIds).toEqual(["mol_bond_001"]);
    expect(getSelectedMolecule(extended)).toMatchObject({
      id: "mol_bond_001",
      structure: "CCC",
      atoms: [
        { id: "atom_001", element: "C", x: 160, y: 220 },
        { id: "atom_002", element: "C", x: 240, y: 220 },
        { id: "atom_003", element: "C", x: 320, y: 220 }
      ],
      bonds: [
        { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
        { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" }
      ],
      chemistry: {
        formula: "C3H8",
        atomCount: 3,
        bondCount: 2,
        totalCharge: 0
      }
    });
    expect(getSelectedMolecule(withBond)?.structure).toBe("CC");
  });

  it("starts a separate bond when the click is away from the selected molecule terminals", () => {
    const withBond = insertNativeSingleBondMolecule(createPhase4Document("Separate Bonds"), { x: 200, y: 220 });
    const next = applySingleBondToolAtPoint(withBond, { x: 600, y: 600 });

    expect(next.pages[0].objects).toHaveLength(2);
    expect(next.pages[0].objects.map((object) => object.id)).toEqual(["mol_bond_001", "mol_bond_002"]);
    expect(next.selection.objectIds).toEqual(["mol_bond_002"]);
  });

  it("exports the Phase 4 subset as SVG", () => {
    const document = insertAdapterFallbackMolecule(createPhase4Document("SVG Fixture"));
    const result = exportPhase4Svg(document);

    expect(result.format).toBe("svg");
    expect(result.contents).toContain('aria-label="SVG Fixture"');
    expect(result.contents).toContain('data-object-type="molecule"');
    expect(result.contents).toContain("CCO");
  });

  it("exports native single-bond molecules as bond geometry", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Bond SVG"), { x: 200, y: 220 });
    const result = exportPhase4Svg(document);

    expect(result.contents).toContain('data-chem-primitive="single-bond"');
    expect(result.contents).toContain('data-structure="CC"');
    expect(result.contents).toContain("<line");
    expect(result.contents).not.toContain(">CC</text>");
  });

  it("exports connected native molecule graphs as connected bond geometry", () => {
    const document = applySingleBondToolAtPoint(
      insertNativeSingleBondMolecule(createPhase4Document("Chain SVG"), { x: 200, y: 220 }),
      { x: 300, y: 220 }
    );
    const result = exportPhase4Svg(document);

    expect(result.contents).toContain('data-chem-primitive="connected-carbon-chain"');
    expect(result.contents).toContain('data-structure="CCC"');
    expect(result.contents).toContain('data-atom-count="3"');
    expect(result.contents).toContain('data-bond-count="2"');
    expect(result.contents.match(/<line/g)?.length).toBe(2);
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

  it("applies an editor adapter save result through a selected-object document patch", () => {
    const document = insertAdapterFallbackMolecule(createPhase4Document("Editor Fixture"));
    const selected = getSelectedMolecule(document);
    if (!selected) {
      throw new Error("Expected fixture molecule to be selected.");
    }

    const updated = applyEditorSaveResultToSelectedObject(document, {
      object: {
        ...selected,
        structureFormat: "molfile-v3000",
        structure: "updated-molfile"
      },
      warnings: []
    });

    expect(getSelectedMolecule(updated)).toMatchObject({
      id: selected.id,
      structureFormat: "molfile-v3000",
      structure: "updated-molfile"
    });
    expect(getSelectedMolecule(document)).toMatchObject({
      id: selected.id,
      structureFormat: "smiles",
      structure: "CCO"
    });
  });
});
