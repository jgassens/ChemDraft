import { describe, expect, it } from "vitest";
import { applyPatches, createEmptyDocument, type ArrowObject, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import {
  createPhase4Document,
  insertNativeArtGraphicObject,
  insertNativeTextObject,
  nativeArrowStyleToolIdList
} from "../documentWorkflow";
import {
  TOOLBAR_SELECTION_KINDS,
  classifyToolbarSelection,
  toolbarVariantForKind,
  type ToolbarSelectionKind,
  type ToolbarStyleVariant
} from "./toolbarSelectionKind";

function classify(document: ChemDraftDocument, overrides: {
  moleculeContext?: "none" | "molecule" | "ring" | "bond" | "atom";
  activeTextEditObjectId?: string;
} = {}) {
  return classifyToolbarSelection({
    document,
    moleculeContext: overrides.moleculeContext ?? "none",
    activeTextEditObjectId: overrides.activeTextEditObjectId
  });
}

function singleBondMolecule(id: string, x: number): MoleculeObject {
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
    style: {},
    atoms: [
      { id: `${id}_atom_1`, element: "C", x, y: 100, formalCharge: 0 },
      { id: `${id}_atom_2`, element: "C", x: x + 72, y: 100, formalCharge: 0 }
    ],
    bonds: [
      { id: `${id}_bond_1`, fromAtomId: `${id}_atom_1`, toAtomId: `${id}_atom_2`, order: "single" }
    ],
    superatoms: [],
    rGroups: []
  };
}

function documentWithMolecule(selected: boolean): { document: ChemDraftDocument; molecule: MoleculeObject } {
  const molecule = singleBondMolecule("mol_classifier", 100);
  const empty = createEmptyDocument({
    id: "doc_selection_kind",
    pageId: "page_selection_kind",
    title: "Selection Kind"
  });
  const withObject = { ...empty, pages: [{ ...empty.pages[0], objects: [molecule] }] };
  const document = selected
    ? applyPatches(withObject, [
        { op: "setSelection", pageId: withObject.pages[0].id, objectIds: [molecule.id] }
      ])
    : withObject;
  return { document, molecule };
}

describe("classifyToolbarSelection", () => {
  it("classifies an empty selection as none", () => {
    const model = classify(createPhase4Document("Empty"));
    expect(model.kind).toBe("none");
    expect(model.objectTypes).toEqual([]);
    expect(model.arrowToolIds).toEqual([]);
    expect(model.selectedCount).toBe(0);
  });

  it("classifies a selected text object as text", () => {
    const document = insertNativeTextObject(createPhase4Document("Text"), { x: 100, y: 100 }, "Label");
    const model = classify(document);
    expect(model.kind).toBe("text");
    expect(model.objectTypes).toEqual(["text"]);
  });

  it("classifies a selected molecule as molecule", () => {
    const { document } = documentWithMolecule(true);
    const model = classify(document, { moleculeContext: "molecule" });
    expect(model.kind).toBe("molecule");
    expect(model.moleculeContext).toBe("molecule");
  });

  it("classifies a molecule sub-part with an empty object selection as molecule, not none", () => {
    // An atom/bond/ring selection lives outside document.selection.objectIds; the inspector context
    // is the only signal. Getting this wrong shows the empty-selection text bar mid-bond-edit.
    const { document } = documentWithMolecule(false);
    const model = classify(document, { moleculeContext: "bond" });
    expect(model.kind).toBe("molecule");
    expect(model.selectedCount).toBe(0);
  });

  it("classifies every arrow-family tool's graphic as arrow", () => {
    for (const toolId of nativeArrowStyleToolIdList) {
      const document = insertNativeArtGraphicObject(
        createPhase4Document(`Arrow ${toolId}`),
        { x: 220, y: 180 },
        `tool.art.${toolId}`
      );
      expect(document.selection.objectIds.length, `tool.art.${toolId} should insert+select`).toBe(1);
      const model = classify(document);
      expect(model.kind, `tool.art.${toolId} should classify as arrow`).toBe("arrow");
      expect(model.arrowToolIds).toEqual([toolId]);
    }
  });

  it("classifies a non-arrow graphic as shape", () => {
    const document = insertNativeArtGraphicObject(createPhase4Document("Rect"), { x: 220, y: 180 }, "tool.art.rect");
    const model = classify(document);
    expect(model.kind).toBe("shape");
    expect(model.objectTypes).toEqual(["graphic"]);
    expect(model.arrowToolIds).toEqual([]);
  });

  it("classifies an arrow mixed with a plain graphic as shape, not arrow", () => {
    const withArrow = insertNativeArtGraphicObject(
      createPhase4Document("Arrow and rect"),
      { x: 220, y: 180 },
      "tool.art.reactionArrow"
    );
    const arrowId = withArrow.selection.objectIds[0];
    const withRect = insertNativeArtGraphicObject(withArrow, { x: 340, y: 180 }, "tool.art.rect");
    const rectId = withRect.selection.objectIds[0];
    const document = applyPatches(withRect, [
      { op: "setSelection", pageId: withRect.pages[0].id, objectIds: [arrowId, rectId] }
    ]);
    const model = classify(document);
    expect(model.kind).toBe("shape");
    // The arrow's tool id still surfaces so a future variant could say "1 of 2 are arrows".
    expect(model.arrowToolIds).toEqual(["reactionArrow"]);
  });

  it("classifies a legacy reaction-arrow object as arrow", () => {
    const legacyArrow: ArrowObject = {
      id: "legacy_arrow",
      type: "reaction-arrow",
      x: 100,
      y: 100,
      width: 120,
      height: 0,
      rotation: 0,
      style: {},
      arrowKind: "forward",
      start: { kind: "point", point: { x: 100, y: 100 } },
      end: { kind: "point", point: { x: 220, y: 100 } },
      labels: []
    };
    const empty = createEmptyDocument({ id: "doc_legacy", pageId: "page_legacy", title: "Legacy" });
    const withObject = { ...empty, pages: [{ ...empty.pages[0], objects: [legacyArrow] }] };
    const document = applyPatches(withObject, [
      { op: "setSelection", pageId: withObject.pages[0].id, objectIds: [legacyArrow.id] }
    ]);
    expect(classify(document).kind).toBe("arrow");
  });

  it("classifies mixed object types as mixed", () => {
    const { document: moleculeDocument, molecule } = documentWithMolecule(false);
    const withText = insertNativeTextObject(moleculeDocument, { x: 300, y: 100 }, "Label");
    const textId = withText.selection.objectIds[0];
    const document = applyPatches(withText, [
      { op: "setSelection", pageId: withText.pages[0].id, objectIds: [molecule.id, textId] }
    ]);
    const model = classify(document, { moleculeContext: "molecule" });
    expect(model.kind).toBe("mixed");
    expect(model.objectTypes).toEqual(["molecule", "text"]);
  });

  it("classifies single types without a dedicated variant as the mixed fallback", () => {
    const plus = {
      id: "plus_1",
      type: "plus" as const,
      x: 100,
      y: 100,
      width: 16,
      height: 16,
      rotation: 0,
      style: {}
    };
    const empty = createEmptyDocument({ id: "doc_plus", pageId: "page_plus", title: "Plus" });
    const withObject = { ...empty, pages: [{ ...empty.pages[0], objects: [plus] }] };
    const document = applyPatches(withObject, [
      { op: "setSelection", pageId: withObject.pages[0].id, objectIds: [plus.id] }
    ]);
    const model = classify(document);
    expect(model.kind).toBe("mixed");
    expect(model.objectTypes).toEqual(["plus"]);
  });

  it("lets an active text caret beat everything else", () => {
    const { document } = documentWithMolecule(true);
    const model = classify(document, { moleculeContext: "molecule", activeTextEditObjectId: "text_being_edited" });
    expect(model.kind).toBe("text");
    expect(model.textEditing).toBe(true);
  });

  it("produces a JSON-serializable model (the Tauri emit path serializes; Sets would silently empty)", () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Serializable"),
      { x: 220, y: 180 },
      "tool.art.reactionArrow"
    );
    const model = classify(document);
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });
});

describe("toolbarVariantForKind", () => {
  it("maps every kind to a variant, with none and mixed falling back to text", () => {
    const expected: Record<ToolbarSelectionKind, ToolbarStyleVariant> = {
      none: "text",
      text: "text",
      molecule: "molecule",
      arrow: "arrow",
      shape: "shape",
      mixed: "text"
    };
    for (const kind of TOOLBAR_SELECTION_KINDS) {
      expect(toolbarVariantForKind(kind)).toBe(expected[kind]);
    }
  });
});
