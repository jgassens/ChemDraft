import { redo, undo, type MechanismArrowObject, type MoleculeObject } from "@chemdraft/chem-core";
import { mechanismArrowGeometry } from "@chemdraft/layout-engine";
import { describe, expect, it } from "vitest";
import {
  createMechanismArrowBetween,
  createPhase4Document,
  documentObjectInteractionBounds,
  documentObjectVisualBounds,
  insertNativeSingleBondMolecule,
  moveDocumentObject,
  selectionBounds
} from "./documentWorkflow";

describe("resolved mechanism arrow bounds", () => {
  it("follows a moved anchor and undo/redo without changing chemistry or the arrow", () => {
    let document = insertNativeSingleBondMolecule(createPhase4Document(), { x: 150, y: 150 });
    const source = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    document = insertNativeSingleBondMolecule(document, { x: 350, y: 150 });
    const target = document.pages[0].objects.find((object): object is MoleculeObject =>
      object.type === "molecule" && object.id !== source.id)!;
    document = createMechanismArrowBetween(document, "full-headed",
      { kind: "atom", objectId: source.id, atomId: source.atoms[0].id },
      { kind: "atom", objectId: target.id, atomId: target.atoms[0].id });
    const arrow = document.pages[0].objects.find((object): object is MechanismArrowObject => object.type === "mechanism-arrow")!;
    const before = documentObjectInteractionBounds(arrow, document.pages[0].objects);
    const moved = moveDocumentObject(document, source.id, { x: source.x, y: source.y + 200 });
    const after = documentObjectInteractionBounds(arrow, moved.pages[0].objects);
    const geometry = mechanismArrowGeometry(moved.pages[0], arrow)!;
    const points = [geometry.source, geometry.target, ...geometry.controls];
    const x = Math.min(...points.map((point) => point.x)) - 12;
    const y = Math.min(...points.map((point) => point.y)) - 12;
    expect(after).toEqual({ x, y,
      width: Math.max(...points.map((point) => point.x)) + 12 - x,
      height: Math.max(...points.map((point) => point.y)) + 12 - y });
    expect(after).not.toEqual(before);
    expect(documentObjectVisualBounds(arrow, moved.pages[0].objects)).toEqual(after);
    expect(selectionBounds(moved.pages[0].objects, [arrow.id])).toMatchObject(after);
    expect(moved.pages[0].objects.find((object) => object.id === arrow.id)).toEqual(arrow);
    const movedSource = moved.pages[0].objects.find((object): object is MoleculeObject => object.id === source.id && object.type === "molecule")!;
    expect(movedSource.bonds).toEqual(source.bonds);
    expect(movedSource.chemistry).toEqual(source.chemistry);
    expect(movedSource.atoms).toEqual(source.atoms.map((atom) => ({ ...atom, y: atom.y + 200 })));
    expect(moved.pages[0].objects.find((object) => object.id === target.id)).toEqual(target);

    const history = { past: [document], present: moved, future: [] };
    const restored = undo(history);
    expect(documentObjectInteractionBounds(arrow, restored.present.pages[0].objects)).toEqual(before);
    expect(restored.present).toEqual(document);
    const redone = redo(restored);
    expect(documentObjectInteractionBounds(arrow, redone.present.pages[0].objects)).toEqual(after);
    expect(redone.present).toEqual(moved);
  });

  it("keeps the stored frame when an anchor cannot resolve", () => {
    let document = insertNativeSingleBondMolecule(createPhase4Document(), { x: 150, y: 150 });
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    document = createMechanismArrowBetween(document, "half-headed",
      { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[0].id },
      { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[1].id });
    const arrow = document.pages[0].objects.find((object): object is MechanismArrowObject => object.type === "mechanism-arrow")!;
    expect(documentObjectInteractionBounds(arrow, [arrow])).toEqual({
      x: arrow.x, y: arrow.y, width: arrow.width, height: arrow.height
    });
  });
});
