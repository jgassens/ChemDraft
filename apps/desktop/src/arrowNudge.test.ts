import { describe, expect, it } from "vitest";
import { arrowNudgeOffset, arrowNudgeContinuesBurst, createDesktopShortcutRegistry, createMainWindowShortcutCommands } from "./keyboardShortcuts";
import { selectionNudgeActions, selectionNudgeCommandId } from "./commands";
import {
  createPhase4Document, insertNativeSingleBondMolecule, insertNativeTextObject,
  insertNativeArtGraphicObject, moveCanvasSelection, moveDocumentObjects, moveDocumentObject,
  moveNativeMoleculeParts, selectDocumentObjects, insertNativeReactionArrow, createMechanismArrowBetween,
  applyChargeToolAtNativeAtom, normalizeCommittedDocument, documentObjectMoveDeltaResolver
} from "./documentWorkflow";

describe("arrow nudge", () => {
  it.each([
    ["ArrowLeft", -1, 0], ["ArrowRight", 1, 0], ["ArrowUp", 0, -1], ["ArrowDown", 0, 1]
  ] as const)("%s uses document units, with positive y down", (key, x, y) => {
    expect(arrowNudgeOffset(key)).toEqual({ x, y });
    expect(arrowNudgeOffset(key, true)).toEqual({ x: x * 10, y: y * 10 });
  });
  it("ignores other keys", () => expect(arrowNudgeOffset("Enter")).toBeUndefined());
  it("ends the burst after one second idle", () => {
    expect(arrowNudgeContinuesBurst(undefined, 100)).toBe(false);
    expect(arrowNudgeContinuesBurst(100, 100)).toBe(true);
    expect(arrowNudgeContinuesBurst(100, 1099)).toBe(true);
    expect(arrowNudgeContinuesBurst(100, 1100)).toBe(false);
    expect(arrowNudgeContinuesBurst(100, 99)).toBe(false);
  });
  describe.each(["macos", "windows"] as const)("%s command shortcuts", platform => {
    const registry = createDesktopShortcutRegistry(createMainWindowShortcutCommands({
      quickActions: [], layerActions: [], toolCommandSpecs: []
    }, "chemdraft"), platform);
    it("registers every direction and size through the shared shortcut registry", () => {
      expect(registry.conflicts()).toEqual([]);
      expect(selectionNudgeActions).toHaveLength(8);
      for (const direction of ["left", "right", "up", "down"] as const) {
        const key = `Arrow${direction[0].toUpperCase()}${direction.slice(1)}`;
        for (const shiftKey of [false, true]) {
          expect(registry.resolve({ key, shiftKey })).toBe(selectionNudgeCommandId(direction, shiftKey));
          for (const modifier of ["ctrlKey", "altKey", "metaKey"]) {
            expect(registry.resolve({ key, shiftKey, [modifier]: true })).toBeUndefined();
          }
        }
      }
    });
  });

  function drawing() {
    let document = insertNativeSingleBondMolecule(createPhase4Document(), { x: 200, y: 200 });
    document = insertNativeTextObject(document, { x: 300, y: 200 }, "Conditions");
    document = insertNativeArtGraphicObject(document, { x: 400, y: 300 }, "tool.art.rect");
    document = insertNativeReactionArrow(document, { x: 400, y: 400 }, { x: 500, y: 400 }, "forward");
    return selectDocumentObjects(document, document.pages[0].id, document.pages[0].objects.map(object => object.id));
  }
  it("shares whole-object and mixed-selection drag movement exactly", () => {
    const document = drawing();
    const delta = { x: 1, y: 10 };
    expect(moveCanvasSelection(document, [], delta)).toEqual(
      moveDocumentObjects(document, document.selection.objectIds, delta.x, delta.y));
    for (const object of document.pages[0].objects) {
      const single = selectDocumentObjects(document, document.pages[0].id, [object.id]);
      expect(moveCanvasSelection(single, [], delta)).toEqual(
        moveDocumentObject(single, object.id, { x: object.x + delta.x, y: object.y + delta.y }));
    }
  });
  it("moves fragments through the part-drag primitive without also moving their object highlight", () => {
    const document = drawing();
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    const single = selectDocumentObjects(document, document.pages[0].id, [molecule.id]);
    const fragment = { objectId: molecule.id, atomIds: [molecule.atoms[0].id], bondIds: [] };
    expect(moveCanvasSelection(single, [fragment], { x: -1, y: 0 })).toEqual(
      moveNativeMoleculeParts(single, { ...fragment, kind: "parts" }, { x: -1, y: 0 }));
  });
  describe.each([0, 1])("two-page document, page index %s", pageIndex => {
    function twoPages() {
      const document = structuredClone(drawing());
      const page = document.pages[0];
      page.width = 900; page.height = 700;
      page.layout = { ...page.layout!, widthPx: 900, heightPx: 700 };
      const other = { ...page, id: "other-page", width: 250, height: 250,
        layout: { ...page.layout, widthPx: 250, heightPx: 250 }, objects: [] };
      document.pages = pageIndex === 0 ? [page, other] : [other, page];
      return document;
    }
    it.each(["text", "molecule", "two objects", "fragment and text"])("nudges %s on its owning page", kind => {
      const initial = twoPages();
      const page = initial.pages[pageIndex];
      const molecule = page.objects.find(object => object.type === "molecule")!;
      const text = page.objects.find(object => object.type === "text")!;
      const ids = kind === "text" ? [text.id] : kind === "molecule" ? [molecule.id] : [molecule.id, text.id];
      const document = selectDocumentObjects(initial, page.id, ids);
      const fragments = kind === "fragment and text"
        ? [{ objectId: molecule.id, atomIds: [molecule.atoms[0].id], bondIds: [] }] : [];
      const moved = moveCanvasSelection(document, fragments, { x: 1, y: 0 });
      const nextPage = moved.pages[pageIndex];
      expect(nextPage.objects.find(object => object.id === text.id)?.x).toBe(text.x + (ids.includes(text.id) ? 1 : 0));
      const nextMolecule = nextPage.objects.find(object => object.type === "molecule")!;
      expect(nextMolecule.atoms).toEqual(molecule.atoms.map((atom, index) => ({ ...atom,
        x: atom.x + (ids.includes(molecule.id) && (kind !== "fragment and text" || index === 0) ? 1 : 0) })));
      expect(nextMolecule.bonds).toEqual(molecule.bonds);
      expect(moved.pages[1 - pageIndex]).toEqual(document.pages[1 - pageIndex]);
      expect(moved.selection).toEqual(document.selection);
    });
    it.each([false, true])("clamps to the owning page's right edge (multiple objects: %s)", multiple => {
      let document = twoPages();
      const page = document.pages[pageIndex];
      const text = page.objects.find(object => object.type === "text")!;
      document = moveDocumentObject(document, text.id, { x: page.width - text.width - 1, y: text.y });
      document = selectDocumentObjects(document, page.id, multiple
        ? [text.id, page.objects.find(object => object.type === "molecule")!.id] : [text.id]);
      const edge = moveCanvasSelection(document, [], { x: 10, y: 0 });
      expect(edge.pages[pageIndex].objects.find(object => object.id === text.id)?.x).toBe(page.width - text.width);
      expect(moveCanvasSelection(edge, [], { x: 1, y: 0 })).toBe(edge);
      expect(edge.pages[1 - pageIndex]).toEqual(document.pages[1 - pageIndex]);
    });
    it("shares group-drag bounds and movement on the owning page", () => {
      const initial = twoPages();
      const page = initial.pages[pageIndex];
      const ids = page.objects.filter(object => object.type === "molecule" || object.type === "text").map(object => object.id);
      const document = selectDocumentObjects(initial, page.id, ids);
      expect(documentObjectMoveDeltaResolver(document, ids[0], ids)(1, 0)).toEqual({ x: 1, y: 0 });
      const moved = moveDocumentObjects(document, ids, 1, 0);
      expect(moved.pages[pageIndex].objects.find(object => object.type === "text")!.x).toBe(301);
      expect(moveCanvasSelection(document, [], { x: 1, y: 0 })).toEqual(moved);
    });
    it("uses the owning page's bounds for atom-part nudges", () => {
      const document = twoPages();
      const page = document.pages[pageIndex];
      const molecule = page.objects.find(object => object.type === "molecule")!;
      const atom = molecule.atoms[0];
      const fragments = [{ objectId: molecule.id, atomIds: [atom.id], bondIds: [] }];
      const selected = selectDocumentObjects(document, page.id, []);
      const edge = moveCanvasSelection(selected, fragments, { x: page.width, y: page.height });
      expect(edge.pages[pageIndex].objects.find(object => object.type === "molecule")!.atoms).toEqual(
        molecule.atoms.map(candidate => candidate.id === atom.id ? { ...candidate, x: page.width, y: page.height } : candidate));
      expect(moveCanvasSelection(edge, fragments, { x: 1, y: 1 })).toBe(edge);
    });
  });
  it("returns the original document for no selection", () => {
    const document = createPhase4Document();
    expect(moveCanvasSelection(document, [], { x: 1, y: 0 })).toBe(document);
  });
  it("moves anchored charge marks and mechanism-arrow controls exactly as group dragging does", () => {
    const initial = insertNativeSingleBondMolecule(createPhase4Document(), { x: 200, y: 200 });
    const molecule = initial.pages[0].objects.find(object => object.type === "molecule")!;
    let document = normalizeCommittedDocument(applyChargeToolAtNativeAtom(initial, 1, {
      objectId: molecule.id, kind: "atom", atomId: molecule.atoms[0].id, distanceToPointer: 0
    }));
    document = createMechanismArrowBetween(document, "full-headed",
      { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[0].id },
      { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[1].id });
    const arrow = document.pages[0].objects.find(object => object.type === "mechanism-arrow")!;
    document = selectDocumentObjects(document, document.pages[0].id, [molecule.id, arrow.id]);
    expect(normalizeCommittedDocument(moveCanvasSelection(document, [], { x: 10, y: 1 }))).toEqual(
      normalizeCommittedDocument(moveDocumentObjects(document, [molecule.id, arrow.id], 10, 1)));
  });
});
