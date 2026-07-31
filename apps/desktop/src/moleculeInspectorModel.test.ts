import { describe, expect, it } from "vitest";
import { createEmptyDocument, type ChemDraftDocument, type GraphicObject, type MoleculeObject } from "@chemdraft/chem-core";
import { createMoleculeInspectorModel, resolveMoleculeInspectorTargets } from "./moleculeInspectorModel";

describe("moleculeInspectorModel", () => {
  it("resolves selected molecules and parent part molecules in stable document order", () => {
    const first = singleBondMolecule("mol_a", 100);
    const second = singleBondMolecule("mol_b", 220);
    const art: GraphicObject = {
      id: "graphic_ignored",
      type: "graphic",
      graphicKind: "rect",
      x: 20,
      y: 20,
      width: 32,
      height: 24,
      rotation: 0,
      style: {},
      data: {}
    };
    const document = documentWithObjects([first, art, second]);

    const targets = resolveMoleculeInspectorTargets(document, {
      selectedObjectIds: [second.id, art.id, first.id],
      selectedPart: { objectId: second.id, kind: "atom", atomId: "mol_b_atom_1" }
    });

    expect(targets).toEqual({
      moleculeObjectIds: [first.id, second.id],
      ringTargets: [],
      atomTargets: [{ objectId: second.id, atomId: "mol_b_atom_1" }],
      bondTargets: [],
      atomLabelTargets: [{ objectId: second.id, atomId: "mol_b_atom_1" }],
      context: "atom"
    });
  });

  it("scopes Atom Labels values to selected atom targets before molecule defaults", () => {
    const molecule = singleBondMolecule("mol_labels", 100, {
      atoms: [
        { id: "atom_oh", element: "O", x: 100, y: 100, formalCharge: 0 },
        { id: "atom_nh", element: "N", x: 172, y: 100, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_001", fromAtomId: "atom_oh", toAtomId: "atom_nh", order: "single" }
      ],
      style: {
        atomLabelFontSizePx: 12,
        atomLabelColor: "#111111",
        atomLabelFontSizes: { atom_oh: 18, atom_nh: 9 },
        atomLabelColors: { atom_oh: "#1f5fbf", atom_nh: "#b3261e" },
        atomLabelPlacements: { atom_oh: "above", atom_nh: "below" }
      }
    });
    const document = documentWithObjects([molecule]);

    const model = createMoleculeInspectorModel(document, {
      selectedObjectIds: [],
      selectedPart: { objectId: molecule.id, kind: "atom", atomId: "atom_oh" }
    });

    expect(model.targets.atomLabelTargets).toEqual([{ objectId: molecule.id, atomId: "atom_oh" }]);
    expect(model.atomLabels.targetKind).toBe("atom");
    expect(model.atomLabels.targetCount).toBe(1);
    expect(model.atomLabels.values.fontSizePx).toEqual({ value: 18, mixed: false });
    expect(model.atomLabels.values.color).toEqual({ value: "#1f5fbf", mixed: false });
    expect(model.atomLabels.values.placement).toEqual({ value: "above", mixed: false });
    expect(model.suggestedTab).toBe("atom-labels");
  });

  it("keeps selected rings separate from molecule targets and keeps Molecule Inspector on Structure", () => {
    const molecule = benzeneMolecule();
    const document = documentWithObjects([molecule]);

    const model = createMoleculeInspectorModel(document, {
      selectedObjectIds: [molecule.id],
      selectedPart: {
        objectId: molecule.id,
        kind: "ring",
        ringKey: "bond_001|bond_002|bond_003|bond_004|bond_005|bond_006"
      }
    });

    expect(model.targets.moleculeObjectIds).toEqual([molecule.id]);
    expect(model.targets.ringTargets).toHaveLength(1);
    expect(model.targets.context).toBe("ring");
    expect(model.suggestedTab).toBe("structure");
    expect(model.rings.selectedCount).toBe(1);
    expect(model.structure.targetCount).toBe(1);
    expect(model.structure.targetKind).toBe("molecule");
    expect(model.atomLabels.targetCount).toBe(1);
  });

  it("scopes Structure values to selected bond targets before molecule defaults", () => {
    const molecule = singleBondMolecule("mol_bonds", 100, {
      bonds: [
        { id: "bond_a", fromAtomId: "mol_bonds_atom_1", toAtomId: "mol_bonds_atom_2", order: "single" },
        { id: "bond_b", fromAtomId: "mol_bonds_atom_2", toAtomId: "mol_bonds_atom_3", order: "single" }
      ],
      atoms: [
        { id: "mol_bonds_atom_1", element: "C", x: 100, y: 100, formalCharge: 0 },
        { id: "mol_bonds_atom_2", element: "C", x: 172, y: 100, formalCharge: 0 },
        { id: "mol_bonds_atom_3", element: "C", x: 244, y: 100, formalCharge: 0 }
      ],
      style: {
        bondStrokeWidthPx: 2,
        bondColor: "#111111",
        bondStrokeWidths: { bond_a: 5 },
        bondColors: { bond_a: "#1f5fbf" },
        bondLineCaps: { bond_a: "round" }
      }
    });
    const document = documentWithObjects([molecule]);

    const model = createMoleculeInspectorModel(document, {
      selectedObjectIds: [],
      selectedPart: { objectId: molecule.id, kind: "bond", bondId: "bond_a" }
    });

    expect(model.targets.bondTargets).toEqual([{ objectId: molecule.id, bondId: "bond_a" }]);
    expect(model.structure.targetKind).toBe("bond");
    expect(model.structure.targetCount).toBe(1);
    expect(model.structure.values.bondStrokeWidthPx).toEqual({ value: 5, mixed: false });
    expect(model.structure.values.bondColor).toEqual({ value: "#1f5fbf", mixed: false });
    expect(model.structure.values.bondLineCap).toEqual({ value: "round", mixed: false });
    expect(model.suggestedTab).toBe("structure");
  });

  it("resolves ring targets from every selected native molecule part", () => {
    const first = benzeneMolecule();
    const second = benzeneMolecule();
    second.id = "mol_ring_b";
    second.atoms = second.atoms.map((atom) => ({ ...atom, id: `${atom.id}_b` }));
    second.bonds = second.bonds.map((bond) => ({
      ...bond,
      id: `${bond.id}_b`,
      fromAtomId: `${bond.fromAtomId}_b`,
      toAtomId: `${bond.toAtomId}_b`
    }));
    const document = documentWithObjects([first, second]);

    const model = createMoleculeInspectorModel(document, {
      selectedObjectIds: [],
      selectedPart: {
        objectId: second.id,
        kind: "ring",
        ringKey: "bond_001_b|bond_002_b|bond_003_b|bond_004_b|bond_005_b|bond_006_b"
      },
      selectedParts: [
        {
          objectId: first.id,
          kind: "ring",
          ringKey: "bond_001|bond_002|bond_003|bond_004|bond_005|bond_006"
        },
        {
          objectId: second.id,
          kind: "ring",
          ringKey: "bond_001_b|bond_002_b|bond_003_b|bond_004_b|bond_005_b|bond_006_b"
        }
      ]
    });

    expect(model.targets.moleculeObjectIds).toEqual([first.id, second.id]);
    expect(model.targets.ringTargets.map((target) => `${target.objectId}:${target.ringKey}`)).toEqual([
      "mol_ring:bond_001|bond_002|bond_003|bond_004|bond_005|bond_006",
      "mol_ring_b:bond_001_b|bond_002_b|bond_003_b|bond_004_b|bond_005_b|bond_006_b"
    ]);
    expect(model.rings.selectedCount).toBe(2);
  });

  it("reports mixed Structure and Atom Label values across molecule targets", () => {
    const first = singleBondMolecule("mol_a", 100, {
      style: {
        chainAngleDegrees: 120,
        bondColor: "#111111",
        bondSpacingMode: "percent",
        bondSpacingPercent: 18,
        bondBoldWidthPx: 4.8,
        atomIndicatorShowQuery: true,
        atomLabelFontFamily: "Arial"
      }
    });
    const second = singleBondMolecule("mol_b", 220, {
      style: {
        chainAngleDegrees: 109.5,
        bondColor: "#222222",
        bondSpacingMode: "percent",
        bondSpacingPercent: 18,
        bondBoldWidthPx: 5.2,
        atomIndicatorShowQuery: false,
        atomLabelFontFamily: "Arial"
      }
    });
    const document = documentWithObjects([first, second]);

    const model = createMoleculeInspectorModel(document, {
      selectedObjectIds: [first.id, second.id]
    });

    expect(model.structure.values.bondColor).toEqual({ value: null, mixed: true });
    expect(model.structure.values.chainAngleDegrees).toEqual({ value: null, mixed: true });
    expect(model.structure.values.bondSpacingMode).toEqual({ value: "percent", mixed: false });
    expect(model.structure.values.bondSpacingPercent).toEqual({ value: 18, mixed: false });
    expect(model.structure.values.bondBoldWidthPx).toEqual({ value: null, mixed: true });
    expect(model.structure.values.atomIndicatorShowQuery).toEqual({ value: null, mixed: true });
    expect(model.atomLabels.values.fontFamily).toEqual({ value: "Arial", mixed: false });
    expect(model.suggestedTab).toBe("structure");
  });
});

function documentWithObjects(objects: Array<MoleculeObject | GraphicObject>): ChemDraftDocument {
  const document = createEmptyDocument({
    id: "doc_molecule_inspector",
    pageId: "page_molecule_inspector",
    title: "Drawn Structure Settings"
  });
  return {
    ...document,
    pages: [{ ...document.pages[0], objects }]
  };
}

function singleBondMolecule(
  id: string,
  x: number,
  overrides: Partial<MoleculeObject> = {}
): MoleculeObject {
  return {
    id,
    type: "molecule",
    x,
    y: 100,
    width: 72,
    height: 32,
    rotation: 0,
    structureFormat: "smiles",
    structure: "CC",
    atoms: [
      { id: `${id}_atom_1`, element: "C", x, y: 100, formalCharge: 0 },
      { id: `${id}_atom_2`, element: "C", x: x + 72, y: 100, formalCharge: 0 }
    ],
    bonds: [
      { id: `${id}_bond_1`, fromAtomId: `${id}_atom_1`, toAtomId: `${id}_atom_2`, order: "single" }
    ],
    superatoms: [],
    rGroups: [],
    ...overrides,
    style: {
      ...overrides.style
    }
  };
}

function benzeneMolecule(): MoleculeObject {
  return {
    id: "mol_ring",
    type: "molecule",
    x: 150,
    y: 120,
    width: 120,
    height: 104,
    rotation: 0,
    style: {},
    structureFormat: "smiles",
    structure: "c1ccccc1",
    atoms: [
      { id: "atom_001", element: "C", x: 210, y: 120, formalCharge: 0 },
      { id: "atom_002", element: "C", x: 262, y: 150, formalCharge: 0 },
      { id: "atom_003", element: "C", x: 262, y: 210, formalCharge: 0 },
      { id: "atom_004", element: "C", x: 210, y: 240, formalCharge: 0 },
      { id: "atom_005", element: "C", x: 158, y: 210, formalCharge: 0 },
      { id: "atom_006", element: "C", x: 158, y: 150, formalCharge: 0 }
    ],
    bonds: [
      { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
      { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" },
      { id: "bond_003", fromAtomId: "atom_003", toAtomId: "atom_004", order: "single" },
      { id: "bond_004", fromAtomId: "atom_004", toAtomId: "atom_005", order: "single" },
      { id: "bond_005", fromAtomId: "atom_005", toAtomId: "atom_006", order: "single" },
      { id: "bond_006", fromAtomId: "atom_006", toAtomId: "atom_001", order: "single" }
    ],
    superatoms: [],
    rGroups: []
  };
}
