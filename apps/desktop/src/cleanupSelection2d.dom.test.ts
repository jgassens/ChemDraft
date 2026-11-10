// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type ChemDraftDocument, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { transformPointForObject } from "@chemdraft/layout-engine";
import { MainWindow } from "./MainWindow";
import { cleanUpNativeMolecules2d } from "./documentWorkflow";
import * as workflow from "./documentWorkflow";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("@scena/react-ruler", () => ({ default: () => createElement("canvas") }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612,
  toJSON: () => ({}) } as DOMRect;

describe("Clean Up Selection command", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const current = () => getAssistantHistoryPort().read("initial")!;
  const objects = () => current().pages[0]!.objects as MoleculeObject[];
  const status = () => container.querySelector("[role=status]")?.textContent;
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  async function render(initialDocument: ChemDraftDocument) {
    await act(async () => root.render(createElement(StrictMode, null, createElement(MainWindow, {
      initialDocument, initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden",
      initialCrosshairsVisible: false, initialRulersVisible: false, nativePalette: false
    }))));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => rect;
  }
  function fixture(count = 1, smiles = "c1ccccc1CCCC") {
    const document = createEmptyDocument();
    for (let n = 0; n < count; n++) {
      const molecule = createSmilesMolecule(document, { x: 250 + n * 260, y: 250 }, depictSmiles2D(smiles), smiles);
      molecule.atoms = molecule.atoms.map((atom, i) => i < 8 ? atom
        : { ...atom, x: atom.x + (i - 7) * 15, y: atom.y + (i - 7) * 12 });
      document.pages[0]!.objects.push(molecule);
    }
    return document;
  }
  async function selectLastBond(molecule: MoleculeObject, pointerId: number) {
    const bond = molecule.bonds.find(bond => [bond.fromAtomId, bond.toAtomId].every(id =>
      [molecule.atoms[8]!.id, molecule.atoms[9]!.id].includes(id)))!;
    const a = molecule.atoms.find(atom => atom.id === bond.fromAtomId)!;
    const b = molecule.atoms.find(atom => atom.id === bond.toAtomId)!;
    const wrapper = () => container.querySelector<HTMLElement>(`[data-object-id="${molecule.id}"]`)!;
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
          buttons: type === "pointerdown" ? 1 : 0, shiftKey: true, clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
        Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: pointerId }, pointerType: { value: "mouse" } });
        wrapper().dispatchEvent(event);
      }
    });
    expect(wrapper().dataset.selectedNativeBondId).toBe(bond.id);
    return { bond, wrapper };
  }

  it.each([1, 2])("cleans partial selections across %i molecule(s) in one labelled undo entry and keeps the selection", async count => {
    await render(fixture(count));
    const selections = [];
    for (const [i, molecule] of objects().entries()) selections.push(await selectLastBond(molecule, 101 + i));
    const before = structuredClone(objects());
    const selection = structuredClone(current().selection);
    await command("structure.cleanup2d");
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(status()).toMatch(/^Cleaned up selected structure/);
    }, { timeout: 10_000 });
    const after = structuredClone(objects());
    for (const [i, molecule] of after.entries()) {
      expect(molecule.atoms.slice(0, 8)).toEqual(before[i]!.atoms.slice(0, 8));
      expect(molecule.atoms.slice(8)).not.toEqual(before[i]!.atoms.slice(8));
      expect(molecule.bonds).toEqual(before[i]!.bonds);
      expect(selections[i]!.wrapper().dataset.selectedNativeBondId).toBe(selections[i]!.bond.id);
    }
    expect(current().selection).toEqual(selection);
    await command("edit.undo");
    expect(status()).toBe("Undid Clean Up Selection");
    expect(objects()).toEqual(before);
    await command("edit.undo");
    expect(objects()).toEqual(before); // No second cleanup or selection history entry.
    await command("edit.redo");
    expect(objects()).toEqual(after);
  }, 20_000);

  it("without selection keeps the previous no-op behaviour", async () => {
    await render(fixture());
    const before = structuredClone(current());
    await command("structure.cleanup2d");
    expect(status()).toBe("No selected structure to clean up");
    expect(current()).toEqual(before);
  });

  it.each(["charge", "lone-pair", "radical-dot"] as const)("carries an attached %s with the selected terminal oxygen through normalization", async kind => {
    const document = fixture(1, "c1ccccc1CCCO");
    const molecule = document.pages[0]!.objects[0] as MoleculeObject;
    const charged = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(document,
      kind === "charge" ? { kind, charge: -1 } : { kind },
      { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[9]!.id }));
    await render({ ...charged, selection: { pageId: charged.pages[0]!.id, objectIds: [] } });
    await selectLastBond(objects()[0]!, 301);
    const before = structuredClone(current());
    const beforeMolecule = before.pages[0]!.objects.find(object => object.type === "molecule") as MoleculeObject;
    const beforeMark = before.pages[0]!.objects.find(object => object.type === "electron-mark") as ElectronMarkObject;
    expect(beforeMark.anchor).toEqual({ kind: "atom", objectId: molecule.id, atomId: molecule.atoms[9]!.id });
    if (kind === "charge") expect(beforeMolecule.atoms[9]!.formalCharge).toBe(-1);
    await command("structure.cleanup2d");
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(status()).toMatch(/^Cleaned up selected structure/);
    }, { timeout: 10_000 });
    const afterMolecule = objects()[0]!;
    const afterMark = current().pages[0]!.objects.find(object => object.id === beforeMark.id) as ElectronMarkObject;
    const dx = afterMolecule.atoms[9]!.x - beforeMolecule.atoms[9]!.x;
    const dy = afterMolecule.atoms[9]!.y - beforeMolecule.atoms[9]!.y;
    expect(Math.hypot(dx, dy)).toBeGreaterThan(25);
    expect(afterMark.x).toBeCloseTo(beforeMark.x + dx, 10);
    expect(afterMark.y).toBeCloseTo(beforeMark.y + dy, 10);
    expect(afterMark.anchor).toEqual(beforeMark.anchor);
    expect(afterMolecule.atoms[9]!.formalCharge).toBe(beforeMolecule.atoms[9]!.formalCharge);
    expect(afterMolecule.atoms[9]!.markRadicals).toBe(beforeMolecule.atoms[9]!.markRadicals);
    const after = structuredClone(current());
    await command("edit.undo");
    expect(current()).toEqual(before);
    await command("edit.redo");
    expect(current()).toEqual(after);
  }, 20_000);

  it.each([45, -73, 180].flatMap(rotation =>
    (["charge", "lone-pair", "radical-dot"] as const).map(kind => ({ rotation, kind }))
  ))("shows a refusal for $kind marks at $rotation degrees without document or history changes", async ({ rotation, kind }) => {
    const document = fixture(1, "c1ccccc1CCCO");
    const molecule = document.pages[0]!.objects[0] as MoleculeObject;
    const marked = structuredClone(workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(document,
      kind === "charge" ? { kind, charge: -1 } : { kind },
      { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[9]!.id })));
    const rotated = marked.pages[0]!.objects.find(object => object.id === molecule.id) as MoleculeObject;
    rotated.rotation = rotation;
    await render({ ...marked, selection: { pageId: marked.pages[0]!.id, objectIds: [] } });
    await selectLastBond(objects()[0]!, 501);
    const before = structuredClone(current());
    const normalize = vi.spyOn(workflow, "normalizeCommittedDocument");
    await command("structure.cleanup2d");
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(status()).toBe("Clean Up Selection: can't move atoms with electron marks in a rotated or transformed structure yet. Clean up the whole structure, or remove the transform first.");
    }, { timeout: 10_000 });
    expect(normalize).not.toHaveBeenCalled();
    expect(current()).toEqual(before);
    await command("edit.undo");
    expect(current()).toEqual(before);
    await command("edit.redo");
    expect(current()).toEqual(before);
  }, 20_000);

  it.each([45, -73, 180])("cleans an unmarked rotated structure at %i degrees with exact fixed rendered positions", async rotation => {
    const document = fixture();
    (document.pages[0]!.objects[0] as MoleculeObject).rotation = rotation;
    await render(document);
    await selectLastBond(objects()[0]!, 601);
    const before = structuredClone(objects()[0]!);
    await command("structure.cleanup2d");
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(status()).toMatch(/^Cleaned up selected structure/);
    }, { timeout: 10_000 });
    const after = objects()[0]!;
    for (let i = 0; i < 8; i++) {
      expect(transformPointForObject(after, after.atoms[i]!)).toEqual(transformPointForObject(before, before.atoms[i]!));
    }
    expect(after.atoms.slice(8)).not.toEqual(before.atoms.slice(8));
    await command("edit.undo");
    expect(objects()[0]).toEqual(before);
  }, 20_000);

  it.each([0, 1])("refuses final normalization chemistry changes in molecule %i, including outside the selection, without committing history", async moleculeIndex => {
    await render(fixture(2));
    await selectLastBond(objects()[0]!, 401);
    const before = structuredClone(current());
    const changedObjectId = objects()[moleculeIndex]!.id;
    const normalize = workflow.normalizeCommittedDocument;
    const finalNormalization = vi.spyOn(workflow, "normalizeCommittedDocument").mockImplementation(document => {
      const normalized = normalize(document);
      return { ...normalized, pages: normalized.pages.map(page => ({ ...page, objects: page.objects.map(object =>
        object.type !== "molecule" || object.id !== changedObjectId ? object : { ...object, atoms: object.atoms.map((atom, i) =>
          i !== 0 ? atom : { ...atom, formalCharge: atom.formalCharge + 1 }) }) })) };
    });
    await command("structure.cleanup2d");
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(status()).toMatch(/refused:.*final.*normaliz.*chang.*chemistry/i);
      expect(status()).toContain(changedObjectId);
    }, { timeout: 10_000 });
    expect(finalNormalization).toHaveBeenCalled();
    finalNormalization.mockRestore();
    expect(current()).toEqual(before);
    await command("edit.undo");
    expect(current()).toEqual(before);
  }, 20_000);

  it("whole-molecule selection uses precisely the existing polygon/tree cleanup", async () => {
    const document = fixture();
    document.selection = { pageId: document.pages[0]!.id, objectIds: [document.pages[0]!.objects[0]!.id] };
    await render(document);
    const before = current();
    const expected = cleanUpNativeMolecules2d(before, before.selection.objectIds);
    await command("structure.cleanup2d");
    expect(objects()).toEqual(expected.pages[0]!.objects);
    expect(current().selection).toEqual(before.selection);
  });
});
