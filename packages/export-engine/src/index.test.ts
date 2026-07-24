import {
  applyPatch,
  ChemDraftSyntheticStylePreset,
  createEmptyDocument,
  createPageLayout,
  inchesToCssPx,
  mmToCssPx,
  stylePresetToObjectStyle,
  type DocumentObject,
  type ElectronMarkObject,
  type MoleculeObject,
  type TextObject
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
    atoms: [],
    bonds: [],
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

function svgLineNumberAttribute(lineMarkup: string, attribute: "x1" | "y1" | "x2" | "y2"): number {
  const match = lineMarkup.match(new RegExp(`${attribute}="([^"]+)"`));
  return Number(match?.[1]);
}

function svgLineLength(lineMarkup: string): number {
  return Math.hypot(
    svgLineNumberAttribute(lineMarkup, "x2") - svgLineNumberAttribute(lineMarkup, "x1"),
    svgLineNumberAttribute(lineMarkup, "y2") - svgLineNumberAttribute(lineMarkup, "y1")
  );
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

  it("exports native molecule graphs with the resolved drawing style", () => {
    const styledMolecule = {
      ...moleculeObject(),
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing",
        bondColors: { bond_001: "#b3261e" },
        atomLabelColors: { atom_002: "#c75c12" }
      },
      structure: "CO",
      atoms: [
        { id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0 },
        { id: "atom_002", element: "O", x: 142, y: 160, formalCharge: 0 }
      ],
      bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }]
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ title: "Style Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: styledMolecule },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);

    expect(result.contents).toContain('data-style-preset-id="chemdraft.synthetic"');
    expect(result.contents).toContain('stroke-width="2"');
    expect(result.contents).toContain('stroke="#b3261e"');
    expect(result.contents).toContain('stroke-linecap="butt"');
    expect(result.contents).toContain('font-family="Arial, Helvetica, sans-serif"');
    expect(result.contents).toContain('fill="#c75c12"');
    expect(result.contents).toContain('data-atom-label="OH"');
    expect(result.contents).toContain('data-atom-label-run="normal"');
    expect(result.contents).toContain(">OH</text>");
    expect(result.contents).toContain("<rect");
  });

  it("exports flattened depth cues as greyed far bonds", () => {
    const depthMolecule = {
      ...moleculeObject(),
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structure: "CC",
      atoms: [
        { id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 160, y: 160, formalCharge: 0 }
      ],
      bonds: [{
        id: "bond_001",
        fromAtomId: "atom_001",
        toAtomId: "atom_002",
        order: "single",
        display: { depthWeight: 0 }
      }]
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ title: "Depth Cue Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: depthMolecule },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);

    expect(result.contents).toContain('stroke="#969696"');
    expect(result.contents).toContain('stroke-width="1.2"');
  });

  it("exports native stereobond display styles as SVG geometry", () => {
    const styledMolecule = {
      ...moleculeObject(),
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structure: "CCCCC",
      atoms: [
        { id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 160, y: 160, formalCharge: 0 },
        { id: "atom_003", element: "C", x: 200, y: 160, formalCharge: 0 },
        { id: "atom_004", element: "C", x: 240, y: 160, formalCharge: 0 },
        { id: "atom_005", element: "C", x: 280, y: 160, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single", display: { bondStyle: "wedge" } },
        { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single", display: { bondStyle: "hashed" } },
        { id: "bond_003", fromAtomId: "atom_003", toAtomId: "atom_004", order: "single", display: { bondStyle: "dashed" } },
        { id: "bond_004", fromAtomId: "atom_004", toAtomId: "atom_005", order: "single", display: { bondStyle: "bold" } }
      ]
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ title: "Stereobond Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: styledMolecule },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);

    expect(result.contents).toContain("<polygon");
    expect(result.contents).toContain('data-bond-style="wedge"');
    expect(result.contents).toContain('data-bond-style="hashed"');
    expect(result.contents).toContain('data-bond-hash-index="0"');
    expect(result.contents).toContain('data-bond-style="dashed"');
    expect(result.contents).toContain("stroke-dasharray");
    expect(result.contents).toContain('data-bond-style="bold"');
    expect(result.contents).toContain('stroke-width="4.8"');
  });

  it("exports native charge marks without falling back to placeholder text", () => {
    const chargeMark = {
      id: "charge_export_001",
      type: "electron-mark",
      x: 200,
      y: 180,
      width: 18,
      height: 18,
      rotation: 0,
      style: { source: "test-charge" },
      markKind: "charge",
      anchor: { kind: "point", point: { x: 209, y: 189 } },
      charge: -1
    } satisfies ElectronMarkObject;
    const document = applyPatch(
      createEmptyDocument({ title: "Charge Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: chargeMark },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);

    expect(result.warnings).toEqual([]);
    expect(result.contents).toContain('data-object-id="charge_export_001"');
    expect(result.contents).toContain('data-object-type="electron-mark"');
    expect(result.contents).toContain('data-mark-kind="charge"');
    expect(result.contents).toContain('data-charge="-1"');
    expect(result.contents).toContain(">-</text>");
  });

  it("exports styled native text objects with text style metadata", () => {
    const textObject = {
      id: "text_export_001",
      type: "text",
      x: 144,
      y: 188,
      width: 220,
      height: 64,
      rotation: 0,
      style: {
        fontFamily: "Times New Roman, Times, serif",
        fontSizePx: 24,
        color: "#b3261e",
        letterSpacingPx: 0.8,
        lineHeight: 1.5,
        paragraphSpacingPx: 4,
        textAlign: "center",
        fontWeight: 700,
        fontStyle: "italic",
        textDecoration: "underline"
      },
      text: "Yield\n91%",
      spans: []
    } satisfies TextObject;
    const document = applyPatch(
      createEmptyDocument({ title: "Text Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: textObject },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);

    expect(result.warnings).toEqual([]);
    expect(result.contents).toContain('data-object-id="text_export_001"');
    expect(result.contents).toContain('data-object-type="text"');
    expect(result.contents).toContain('font-family="Times New Roman, Times, serif"');
    expect(result.contents).toContain('font-size="24"');
    expect(result.contents).toContain('font-weight="700"');
    expect(result.contents).toContain('font-style="italic"');
    expect(result.contents).toContain('text-decoration="underline"');
    expect(result.contents).toContain('letter-spacing="0.8"');
    expect(result.contents).toContain('text-anchor="middle"');
    expect(result.contents).toContain('fill="#b3261e"');
    expect(result.contents).toContain(">Yield</tspan>");
    expect(result.contents).toContain(">91%</tspan>");
  });

  it("exports native text script spans", () => {
    const textObject = {
      id: "text_script_export_001",
      type: "text",
      x: 144,
      y: 188,
      width: 120,
      height: 42,
      rotation: 0,
      style: {
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSizePx: 20,
        color: "#111111",
        letterSpacingPx: 0,
        lineHeight: 1.2,
        paragraphSpacingPx: 0,
        textAlign: "left",
        fontWeight: 400,
        fontStyle: "normal",
        textDecoration: "none"
      },
      text: "H2O",
      spans: [
        { text: "H", script: "normal", style: {} },
        { text: "2", script: "subscript", style: {} },
        { text: "O", script: "normal", style: { color: "#1f5fbf" } }
      ]
    } satisfies TextObject;
    const document = applyPatch(
      createEmptyDocument({ title: "Text Script Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: textObject },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);

    expect(result.warnings).toEqual([]);
    expect(result.contents).toContain('data-object-id="text_script_export_001"');
    expect(result.contents).toContain('baseline-shift="sub"');
    expect(result.contents).toContain('font-size="72%"');
    expect(result.contents).toContain('fill="#1f5fbf"');
    expect(result.contents).toContain(">H</tspan>");
    expect(result.contents).toContain(">2</tspan>");
    expect(result.contents).toContain(">O</tspan>");
  });

  it("exports condensed atom labels with numeric subscripts", () => {
    const methaneMolecule = {
      ...moleculeObject(),
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structure: "C",
      atoms: [{ id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0 }],
      bonds: [],
      chemistry: {
        formula: "CH4",
        atomCount: 1,
        bondCount: 0,
        totalCharge: 0,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      }
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ title: "Methane Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: methaneMolecule },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);

    expect(result.contents).toContain('data-atom-label="CH4"');
    expect(result.contents).toContain('data-atom-label-run="normal"');
    expect(result.contents).toContain(">CH</text>");
    expect(result.contents).toContain('data-atom-label-run="subscript"');
    expect(result.contents).toContain('font-size="10.8"');
    expect(result.contents).toContain(">4</text>");
    expect(result.contents).not.toContain(">CH4</text>");
  });

  it("exports explicit quaternary ammonium as a compact charge affix", () => {
    const ammoniumMolecule = {
      ...moleculeObject(),
      id: "mol_ammonium",
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structure: "C[N+](C)(C)C",
      atoms: [
        { id: "atom_n", element: "N", x: 200, y: 200, formalCharge: 1 },
        { id: "atom_left", element: "C", x: 140, y: 200, formalCharge: 0 },
        { id: "atom_up", element: "C", x: 205, y: 140, formalCharge: 0 },
        { id: "atom_down", element: "C", x: 170, y: 250, formalCharge: 0 },
        { id: "atom_right", element: "C", x: 260, y: 230, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_left", fromAtomId: "atom_left", toAtomId: "atom_n", order: "single" },
        { id: "bond_up", fromAtomId: "atom_n", toAtomId: "atom_up", order: "single" },
        { id: "bond_down", fromAtomId: "atom_n", toAtomId: "atom_down", order: "single" },
        { id: "bond_right", fromAtomId: "atom_n", toAtomId: "atom_right", order: "single" }
      ],
      chemistry: {
        formula: "C4H12N",
        atomCount: 5,
        bondCount: 4,
        totalCharge: 1,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      }
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ title: "Ammonium Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: ammoniumMolecule },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);
    const leftBondMarkup = result.contents.match(/<line data-bond-id="bond_left"[^>]*stroke-width="2"[^>]*>/)?.[0] ?? "";
    const rightBondMarkup = result.contents.match(/<line data-bond-id="bond_right"[^>]*stroke-width="2"[^>]*>/)?.[0] ?? "";

    expect(result.contents).toContain('data-atom-label="N+"');
    expect(result.contents).toContain('data-atom-label-run="normal"');
    expect(result.contents).toContain('text-anchor="middle">N</text>');
    expect(result.contents).toContain('data-atom-label-run="charge"');
    expect(result.contents).toContain('font-size="13.2"');
    expect(result.contents).toContain(">+</text>");
    expect(leftBondMarkup).not.toContain('x2="200"');
    expect(rightBondMarkup).not.toContain('x1="200"');
  });

  it("exports asymmetric double bonds with overlap clearance underlays", () => {
    const styledMolecule = {
      ...moleculeObject(),
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structure: "C=C",
      atoms: [
        { id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 142, y: 160, formalCharge: 0 }
      ],
      bonds: [
        {
          id: "bond_001",
          fromAtomId: "atom_001",
          toAtomId: "atom_002",
          order: "double",
          display: { doubleBondSide: "right" }
        }
      ]
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ title: "Double Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: styledMolecule },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);

    expect(result.contents.match(/data-bond-id="bond_001"/g) ?? []).toHaveLength(2);
    expect(result.contents).toContain('data-bond-segment="secondary"');
    expect(result.contents).toContain('data-double-bond-side="right"');
    expect(result.contents).toContain('stroke-width="2"');
  });

  it("exports terminal heteroatom double bonds with a centerline primary and short secondary", () => {
    const styledMolecule = {
      ...moleculeObject(),
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structure: "C=O",
      atoms: [
        { id: "atom_001", element: "C", x: 120, y: 160, formalCharge: 0 },
        { id: "atom_002", element: "O", x: 142, y: 160, formalCharge: 0 }
      ],
      bonds: [
        {
          id: "bond_001",
          fromAtomId: "atom_001",
          toAtomId: "atom_002",
          order: "double",
          display: { doubleBondSide: "left" }
        }
      ]
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ title: "Carbonyl Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: styledMolecule },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);
    const carbonylLineMarkups = result.contents.match(
      /<line data-bond-id="bond_001" data-bond-order="double" data-bond-segment="(?:primary|secondary)"[^>]*stroke-width="2"[^>]*>/g
    ) ?? [];
    const primaryLineMarkup = carbonylLineMarkups.find((line) => line.includes('data-bond-segment="primary"')) ?? "";
    const secondaryLineMarkup = carbonylLineMarkups.find((line) => line.includes('data-bond-segment="secondary"')) ?? "";

    expect(result.contents).toContain('data-structure="C=O"');
    expect(carbonylLineMarkups).toHaveLength(2);
    expect(primaryLineMarkup).not.toBe("");
    expect(secondaryLineMarkup).not.toBe("");
    expect(svgLineLength(primaryLineMarkup)).toBeGreaterThan(svgLineLength(secondaryLineMarkup));
    expect(svgLineNumberAttribute(primaryLineMarkup, "x1")).toBeLessThan(svgLineNumberAttribute(secondaryLineMarkup, "x1"));
    expect(svgLineNumberAttribute(primaryLineMarkup, "x2")).toBeGreaterThan(svgLineNumberAttribute(secondaryLineMarkup, "x2"));
    expect(Math.abs(svgLineNumberAttribute(primaryLineMarkup, "y1") - svgLineNumberAttribute(secondaryLineMarkup, "y1"))).toBeGreaterThan(0);
  });

  it("exports molecule drawing order as explicit layers for over-under crossings", () => {
    const backMolecule = {
      ...moleculeObject(),
      id: "mol_back",
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structure: "CC",
      atoms: [
        { id: "back_atom_001", element: "C", x: 120, y: 160, formalCharge: 0 },
        { id: "back_atom_002", element: "C", x: 164, y: 160, formalCharge: 0 }
      ],
      bonds: [{ id: "back_bond_001", fromAtomId: "back_atom_001", toAtomId: "back_atom_002", order: "single" }]
    } satisfies MoleculeObject;
    const frontMolecule = {
      ...moleculeObject(),
      id: "mol_front",
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structure: "CC",
      atoms: [
        { id: "front_atom_001", element: "C", x: 142, y: 138, formalCharge: 0 },
        { id: "front_atom_002", element: "C", x: 142, y: 182, formalCharge: 0 }
      ],
      bonds: [{ id: "front_bond_001", fromAtomId: "front_atom_001", toAtomId: "front_atom_002", order: "single" }]
    } satisfies MoleculeObject;
    const document = applyPatch(
      applyPatch(
        createEmptyDocument({ title: "Layered Export", now: timestamp }),
        { op: "addObject", pageId: "page_001", object: backMolecule },
        { now: timestamp }
      ),
      { op: "addObject", pageId: "page_001", object: frontMolecule },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);
    const backObjectIndex = result.contents.indexOf('data-object-id="mol_back"');
    const frontObjectIndex = result.contents.indexOf('data-object-id="mol_front"');
    const frontObjectMarkup = result.contents.slice(frontObjectIndex);

    expect(backObjectIndex).toBeGreaterThan(-1);
    expect(frontObjectIndex).toBeGreaterThan(-1);
    expect(backObjectIndex).toBeLessThan(frontObjectIndex);
    expect(result.contents).toContain('data-object-id="mol_back" data-layer-index="0"');
    expect(result.contents).toContain('data-object-id="mol_front" data-layer-index="1"');
    expect((result.contents.match(/data-bond-id="back_bond_001"/g) ?? []).length).toBe(2);
    expect((frontObjectMarkup.match(/data-bond-id="front_bond_001"/g) ?? []).length).toBe(1);
    expect(result.contents).not.toContain('native-crossing-hit-target');
    expect(result.contents).not.toContain('stroke-width="8"');
  });

  it("exports later bonds over earlier crossing bonds inside one native molecule", () => {
    const crossingMolecule = {
      ...moleculeObject(),
      id: "mol_crossing",
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structure: "CC.CC",
      atoms: [
        { id: "atom_back_001", element: "C", x: 140, y: 180, formalCharge: 0 },
        { id: "atom_back_002", element: "C", x: 220, y: 180, formalCharge: 0 },
        { id: "atom_front_001", element: "C", x: 180, y: 140, formalCharge: 0 },
        { id: "atom_front_002", element: "C", x: 180, y: 220, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_back", fromAtomId: "atom_back_001", toAtomId: "atom_back_002", order: "single" },
        { id: "bond_front", fromAtomId: "atom_front_001", toAtomId: "atom_front_002", order: "single" }
      ]
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ title: "Crossing Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: crossingMolecule },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);
    const backLayerIndex = result.contents.indexOf('data-bond-layer-id="bond_back"');
    const frontLayerIndex = result.contents.indexOf('data-bond-layer-id="bond_front"');
    const backLayerMarkup = result.contents.slice(backLayerIndex, frontLayerIndex);
    const frontLayerMarkup = result.contents.slice(frontLayerIndex);

    expect(backLayerIndex).toBeGreaterThan(-1);
    expect(frontLayerIndex).toBeGreaterThan(-1);
    expect(backLayerIndex).toBeLessThan(frontLayerIndex);
    expect((backLayerMarkup.match(/data-bond-id="bond_back"/g) ?? []).length).toBe(2);
    expect((frontLayerMarkup.match(/data-bond-id="bond_front"/g) ?? []).length).toBe(1);
    expect(result.contents).not.toContain('stroke-width="8"');
  });

  it("does not export over-under gaps at shared atom bond junctions", () => {
    const geminalMolecule = {
      ...moleculeObject(),
      id: "mol_geminal",
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structure: "CC(C)C",
      atoms: [
        { id: "atom_center", element: "C", x: 180, y: 180, formalCharge: 0 },
        { id: "atom_left", element: "C", x: 140, y: 180, formalCharge: 0 },
        { id: "atom_up", element: "C", x: 200, y: 140, formalCharge: 0 },
        { id: "atom_right", element: "C", x: 220, y: 165, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_left", fromAtomId: "atom_left", toAtomId: "atom_center", order: "single" },
        { id: "bond_up", fromAtomId: "atom_center", toAtomId: "atom_up", order: "single" },
        { id: "bond_right", fromAtomId: "atom_center", toAtomId: "atom_right", order: "single" }
      ]
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ title: "Geminal Export", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: geminalMolecule },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);
    const upLine = result.contents.match(/<line data-bond-id="bond_up"[^>]*stroke-width="2"[^>]*>/)?.[0] ?? "";

    expect(upLine).toContain('x1="180"');
    expect(upLine).toContain('y1="180"');
    expect(result.contents).not.toContain('stroke-width="8"');
  });

  it("exports mixed object types in the planner's page order", () => {
    const objects: DocumentObject[] = [
      {
        ...moleculeObject(),
        id: "mol_ordered",
        structure: "CC",
        chemistry: {
          atomCount: 2,
          bondCount: 1,
          totalCharge: 0,
          radicalCount: 0,
          isotopeLabels: [],
          stereochemistry: [],
          warnings: []
        }
      },
      {
        id: "text_ordered",
        type: "text",
        x: 220,
        y: 160,
        width: 80,
        height: 32,
        rotation: 0,
        style: {},
        text: "note",
        spans: []
      },
      {
        id: "charge_ordered",
        type: "electron-mark",
        x: 320,
        y: 160,
        width: 18,
        height: 18,
        rotation: 0,
        style: {},
        markKind: "charge",
        anchor: { kind: "point", point: { x: 329, y: 169 } },
        charge: 1
      },
      {
        id: "arrow_ordered",
        type: "reaction-arrow",
        x: 360,
        y: 160,
        width: 72,
        height: 22,
        rotation: 0,
        style: {},
        arrowKind: "forward",
        start: { kind: "point", point: { x: 360, y: 171 } },
        end: { kind: "point", point: { x: 432, y: 171 } },
        labels: []
      },
      {
        id: "graphic_ordered",
        type: "graphic",
        x: 460,
        y: 160,
        width: 42,
        height: 24,
        rotation: 0,
        style: {},
        graphicKind: "rect",
        data: {}
      }
    ];
    const document = objects.reduce(
      (current, object) => applyPatch(
        current,
        { op: "addObject", pageId: "page_001", object },
        { now: timestamp }
      ),
      createEmptyDocument({ title: "Mixed Order Export", now: timestamp })
    );

    const result = exportDocumentToSvg(document);
    const indexes = objects.map((object) => result.contents.indexOf(`data-object-id="${object.id}"`));

    expect(indexes.every((index) => index > -1)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
  });
});
