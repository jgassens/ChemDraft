import { describe, expect, it } from "vitest";
import {
  DocumentPatchError,
  DocumentSchemaVersion,
  applyPatch,
  applyPatchWithHistory,
  applyPatches,
  createDocumentHistory,
  createEmptyDocument,
  deserializeDocument,
  redo,
  serializeDocument,
  undo,
  validateDocument,
  type AnnotationObject,
  type MoleculeObject
} from "./index";

const timestamp = "2026-05-29T00:00:00.000Z";

function moleculeObject(id = "mol_001"): MoleculeObject {
  return {
    id,
    type: "molecule",
    x: 120,
    y: 160,
    width: 180,
    height: 120,
    rotation: 0,
    style: {},
    structureFormat: "smiles",
    structure: "c1ccccc1",
    chemistry: {
      atomCount: 6,
      bondCount: 6,
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

function annotationObject(id = "ann_001"): AnnotationObject {
  return {
    id,
    type: "annotation",
    x: 24,
    y: 32,
    width: 180,
    height: 28,
    rotation: 0,
    style: {},
    targetObjectIds: ["mol_001"],
    message: "Review stereochemistry before export."
  };
}

describe("createEmptyDocument", () => {
  it("returns a minimal native document with a page and no objects", () => {
    const document = createEmptyDocument({
      id: "doc_test",
      pageId: "page_test",
      title: "Test Document",
      now: timestamp
    });

    expect(document).toEqual({
      schema: DocumentSchemaVersion,
      id: "doc_test",
      title: "Test Document",
      createdAt: timestamp,
      updatedAt: timestamp,
      pages: [
        {
          id: "page_test",
          width: 816,
          height: 1056,
          margin: {
            top: 72,
            right: 72,
            bottom: 72,
            left: 72
          },
          objects: []
        }
      ],
      selection: {
        objectIds: []
      },
      styles: {},
      plugins: {},
      compatibility: {
        warnings: []
      }
    });
  });
});

describe("native document validation and serialization", () => {
  it("round-trips a valid native document through JSON", () => {
    const document = createEmptyDocument({ id: "doc_roundtrip", now: timestamp });
    const withMolecule = applyPatch(
      document,
      {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      },
      { now: timestamp }
    );

    expect(deserializeDocument(serializeDocument(withMolecule))).toEqual(withMolecule);
  });

  it("reports validation issues for unsupported object shapes", () => {
    const document = createEmptyDocument({ now: timestamp });
    const result = validateDocument({
      ...document,
      pages: [
        {
          ...document.pages[0],
          objects: [{ id: "bad_001", type: "unsupported" }]
        }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((issue) => issue.path)).toContain("pages.0.objects.0.type");
  });
});

describe("document patches", () => {
  it("adds, moves, updates, batches, and removes objects without mutating the original", () => {
    const document = createEmptyDocument({ now: timestamp });
    const added = applyPatch(
      document,
      {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      },
      { now: timestamp }
    );

    expect(document.pages[0].objects).toEqual([]);
    expect(added.pages[0].objects).toHaveLength(1);

    const moved = applyPatch(added, { op: "moveObject", objectId: "mol_001", x: 200, y: 240 }, { now: timestamp });
    expect(moved.pages[0].objects[0]).toMatchObject({ x: 200, y: 240 });

    const selected = applyPatch(
      moved,
      { op: "setSelection", pageId: "page_001", objectIds: ["mol_001"] },
      { now: timestamp }
    );
    expect(selected.selection).toEqual({ pageId: "page_001", objectIds: ["mol_001"] });

    const updated = applyPatch(
      selected,
      { op: "updateObject", objectId: "mol_001", changes: { structure: "CCO" } },
      { now: timestamp }
    );
    expect(updated.pages[0].objects[0]).toMatchObject({ structure: "CCO" });

    const removed = applyPatches(
      updated,
      [
        { op: "addAnnotation", pageId: "page_001", annotation: annotationObject() },
        { op: "removeObject", objectId: "mol_001" }
      ],
      { now: timestamp }
    );
    expect(removed.pages[0].objects).toEqual([annotationObject()]);
  });

  it("rejects duplicate object IDs and identity-changing updates", () => {
    const document = applyPatch(
      createEmptyDocument({ now: timestamp }),
      {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      },
      { now: timestamp }
    );

    expect(() =>
      applyPatch(document, {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      })
    ).toThrow(DocumentPatchError);

    expect(() =>
      applyPatch(document, {
        op: "updateObject",
        objectId: "mol_001",
        changes: { id: "mol_002" }
      })
    ).toThrow(DocumentPatchError);

    expect(() =>
      applyPatch(document, {
        op: "setSelection",
        pageId: "page_001",
        objectIds: ["mol_missing"]
      })
    ).toThrow(DocumentPatchError);
  });

  it("only removes annotations through removeAnnotation", () => {
    const document = applyPatch(
      createEmptyDocument({ now: timestamp }),
      {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      },
      { now: timestamp }
    );

    expect(() => applyPatch(document, { op: "removeAnnotation", annotationId: "mol_001" })).toThrow(
      DocumentPatchError
    );
  });
});

describe("document history", () => {
  it("supports undo and redo around controlled patches", () => {
    const document = createEmptyDocument({ now: timestamp });
    const history = createDocumentHistory(document);
    const withPatch = applyPatchWithHistory(
      history,
      {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      },
      { now: timestamp }
    );

    expect(withPatch.present.pages[0].objects).toHaveLength(1);

    const undone = undo(withPatch);
    expect(undone.present.pages[0].objects).toHaveLength(0);

    const redone = redo(undone);
    expect(redone.present.pages[0].objects).toHaveLength(1);
  });
});
