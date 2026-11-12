import { describe, expect, it } from "vitest";
import { arrowNudgeOffset, arrowNudgeContinuesBurst, createDesktopShortcutRegistry, createMainWindowShortcutCommands } from "./keyboardShortcuts";
import { selectionNudgeActions, selectionNudgeCommandId } from "./commands";
import {
  createPhase4Document, insertNativeSingleBondMolecule, insertNativeTextObject,
  insertNativeArtGraphicObject, moveCanvasSelection, moveDocumentObjects, moveDocumentObject,
  moveNativeMoleculeParts, selectDocumentObjects, insertNativeReactionArrow, createMechanismArrowBetween,
  applyChargeToolAtNativeAtom, normalizeCommittedDocument
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
