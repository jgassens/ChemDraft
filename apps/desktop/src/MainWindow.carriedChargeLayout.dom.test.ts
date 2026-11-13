// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, type ChemDraftDocument, type DocumentObject, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { combinedLayoutBounds, planObjectArrangement } from "@chemdraft/layout-engine";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import * as workflow from "./documentWorkflow";
import { dropElectronMark } from "./electronMarkDrop";
import { saveDirectElectronMarkEditing } from "./electronMarkEditingSettings";
import { saveCompoundLayoutSettings } from "./compoundLayoutSettings";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

function twoGlycinesAndArrow(distant = true): ChemDraftDocument {
  let document = workflow.createPhase4Document("Distant glycine charges");
  for (const [index, [x, y]] of [[100, 100], [310, 240]].entries()) {
    const graph = testMoleculeFromSmiles("NCC(=O)O");
    const points = [[0, 0], [22, 12], [44, 0], [44, -22], [66, 12]];
    const atoms = graph.atoms.map((atom, i) => ({ ...atom, x: x + points[i][0], y: y + points[i][1] }));
    const molecule: MoleculeObject = { id: `glycine_${index}`, type: "molecule", x, y: y - 22, width: 66, height: 34,
      rotation: 0, style: {}, atoms, bonds: graph.bonds, structureFormat: "smiles",
      structure: nativeSingleBondGraphSmiles(atoms, graph.bonds), chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds),
      superatoms: [], rGroups: [] };
    document = applyPatch(document, { op: "addObject", pageId: document.pages[0].id, object: molecule });
    document = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(document, { kind: "charge", charge: 1 },
      { kind: "atom", objectId: molecule.id, atomId: atoms[0].id, distanceToPointer: 0 }));
    if (!distant) continue;
    const mark = document.pages[0].objects.find(object => object.type === "electron-mark" && object.anchor.objectId === molecule.id)!;
    const center = { x: 450 + index * 100, y: 390 + index * 90 };
    const dropped = dropElectronMark(document, mark.id, { x: center.x - mark.width / 2, y: center.y - mark.height / 2 }, center);
    expect(dropped.refused).toBeUndefined();
    document = dropped.document;
  }
  const arrow = workflow.createNativeArtLineGraphicObject(document, { x: 660, y: 540 }, { x: 750, y: 540 }, "tool.art.reactionArrow")!;
  return applyPatch(document, { op: "addObject", pageId: document.pages[0].id, object: arrow });
}

const operations = [
  ...["Left", "Center", "Right", "Top", "Middle", "Bottom"].map(mode => ({ commandId: `layout.align${mode}`, mode: "centers" })),
  ...["Horizontal", "Vertical"].flatMap(axis => ["centers", "spacing"].map(mode => ({ commandId: `layout.distribute${axis}`, mode })))
];

describe.each(["macos", "windows"] as const)("toolbar charge layout (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveDirectElectronMarkEditing(true);
    saveCompoundLayoutSettings({ enabled: true });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  async function command(commandId: string) {
    // Native toolbar/palette delivery enters the same registered command handler as inline toolbar clicks.
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }

  async function changeSpacing() {
    await command("layout.adjustArrangementSpacing");
    const slider = container.querySelector<HTMLInputElement>('.arrangement-spacing-dialog input[type="range"]')!;
    expect(slider).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "90");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('.arrangement-spacing-dialog button[type="submit"]')?.disabled).toBe(false));
    await act(async () => container.querySelector<HTMLButtonElement>('.arrangement-spacing-dialog button[type="submit"]')!.click());
  }

  it.each(["arrange", "spacing"])("warns and keeps independent explicit-mark movement through %s", async operation => {
    let initialDocument = twoGlycinesAndArrow();
    const objects = initialDocument.pages[0].objects;
    const mark = objects.find(object => object.type === "electron-mark")!;
    const arrow = objects[objects.length - 1];
    initialDocument = workflow.selectDocumentObjects(initialDocument, initialDocument.pages[0].id, [mark.id, arrow.id]);
    await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false, shortcutPlatform: platform })));
    const before = snapshot();
    if (operation === "arrange") await command("layout.arrange.row");
    else await changeSpacing();
    const after = snapshot();
    expect(container.querySelector("[data-status-message]")?.textContent).toContain("the mark is moving independently");
    expect(after.pages[0].objects.filter(object => object.type === "molecule")
      .map(molecule => molecule.atoms[0].formalCharge)).toEqual([0, 1]);
    const movedMark = after.pages[0].objects.find(object => object.id === mark.id)!;
    expect(movedMark).toMatchObject({ anchor: { kind: "point" } });
    expect(movedMark.x).not.toBe(mark.x);
    // Both operations retain their translation-only policy; the unselected molecules stay put.
    expect(after.pages[0].objects.filter(object => object.type === "molecule").map(({ x, y }) => ({ x, y })))
      .toEqual(before.pages[0].objects.filter(object => object.type === "molecule").map(({ x, y }) => ({ x, y })));
    if (operation === "arrange") {
      const page = before.pages[0];
      const plan = planObjectArrangement([mark, arrow].map(object => ({ id: object.id,
        bounds: workflow.documentObjectVisualBounds(object, objects) })), "row",
      { pageBounds: { x: 0, y: 0, width: page.width, height: page.height } });
      expect(plan.ok).toBe(true);
      if (!plan.ok) throw new Error("Expected a valid row");
      for (const { id, dx, dy } of plan.placements) {
        const original = before.pages[0].objects.find(object => object.id === id)!;
        const moved = after.pages[0].objects.find(object => object.id === id)!;
        expect(moved.x).toBeCloseTo(original.x + dx);
        expect(moved.y).toBeCloseTo(original.y + dy);
      }
    } else {
      const movedArrow = after.pages[0].objects.find(object => object.id === arrow.id)!;
      const center = (object: DocumentObject) => {
        const bounds = workflow.documentObjectVisualBounds(object, objects);
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      };
      expect(center(movedMark).x - center(movedArrow).x).toBeCloseTo((center(mark).x - center(arrow).x) * 0.9);
      expect(center(movedMark).y - center(movedArrow).y).toBeCloseTo((center(mark).y - center(arrow).y) * 0.9);
    }
    await command("edit.undo");
    expect(snapshot().pages).toEqual(before.pages);
    await command("edit.redo");
    expect(snapshot().pages).toEqual(after.pages);
  });

  it.each([...operations, { commandId: "layout.arrange.row", mode: "centers" },
    { commandId: "layout.adjustArrangementSpacing", mode: "centers" }])(
    "keeps default +1 marks through Select All / $commandId ($mode)", async ({ commandId, mode }) => {
      const initialDocument = twoGlycinesAndArrow(false);
      await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: "tool.select",
        initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false, shortcutPlatform: platform })));
      await command("edit.selectAll");
      const before = snapshot();
      const marks = before.pages[0].objects.filter(object => object.type === "electron-mark");
      expect(marks).toHaveLength(2);
      marks.forEach(mark => expect(mark.atomAssociation).toBeUndefined());
      await command(`layout.distribute.mode.${mode}`);
      if (commandId === "layout.adjustArrangementSpacing") await changeSpacing();
      else await command(commandId);
      const after = snapshot();
      expect(after).not.toEqual(before);
      for (const originalMark of marks) {
        const original = before.pages[0].objects.find(object => object.id === originalMark.anchor.objectId) as MoleculeObject;
        const molecule = after.pages[0].objects.find(object => object.id === original.id) as MoleculeObject;
        const mark = after.pages[0].objects.find(object => object.id === originalMark.id)!;
        expect(molecule.atoms[0].formalCharge).toBe(1);
        expect(mark).toMatchObject({ anchor: originalMark.anchor });
        expect(mark.x - molecule.x).toBeCloseTo(originalMark.x - original.x);
        expect(mark.y - molecule.y).toBeCloseTo(originalMark.y - original.y);
        molecule.atoms.forEach((atom, index) => {
          const { x, y, ...chemistry } = atom;
          const { x: originalX, y: originalY, ...originalChemistry } = original.atoms[index];
          expect(chemistry).toEqual(originalChemistry);
          expect(x).toBeCloseTo(originalX + molecule.x - original.x);
          expect(y).toBeCloseTo(originalY + molecule.y - original.y);
        });
        expect(molecule.bonds).toEqual(original.bonds);
        expect(molecule.structure).toBe(original.structure);
        expect(molecule.chemistry).toEqual(original.chemistry);
      }
      expect(container.querySelector("[data-status-message]")?.textContent).not.toContain("Cannot preserve");
      expect(await workflow.copyAsSmiles(after)).toBe("[NH3+]CC(O)=O.[NH3+]CC(O)=O");
      await command("edit.undo");
      expect(snapshot().pages).toEqual(before.pages);
      await command("edit.redo");
      expect(snapshot().pages).toEqual(after.pages);
    });

  it.each(["layout.alignRight", "layout.distributeHorizontal"])(
    "keeps a sticky ordinary +1 on its original atom with only molecules selected / %s", async commandId => {
      let initialDocument = twoGlycinesAndArrow(false);
      const marks = initialDocument.pages[0].objects.filter(object => object.type === "electron-mark");
      for (const mark of marks) {
        const molecule = initialDocument.pages[0].objects.find(object => object.id === mark.anchor.objectId) as MoleculeObject;
        const neighbor = molecule.atoms[1];
        // The stored ordinary anchor is sticky even though the glyph is closer to the next atom.
        initialDocument = applyPatch(initialDocument, { op: "updateObject", objectId: mark.id,
          changes: { x: neighbor.x - mark.width / 2, y: neighbor.y - mark.height / 2 } });
      }
      initialDocument = workflow.selectDocumentObjects(initialDocument, initialDocument.pages[0].id,
        initialDocument.pages[0].objects.filter(object => object.type !== "electron-mark").map(object => object.id));
      await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: "tool.select",
        initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false, shortcutPlatform: platform })));
      const before = snapshot();
      expect(before.selection.objectIds.some(id => marks.some(mark => mark.id === id))).toBe(false);
      expect(before.pages[0].objects.filter(object => object.type === "molecule").map(molecule => molecule.atoms[0].formalCharge))
        .toEqual([1, 1]);
      await command(commandId);
      const after = snapshot();
      expect(after.pages).not.toEqual(before.pages);
      for (const initialMark of marks) {
        const originalMark = before.pages[0].objects.find((object): object is ElectronMarkObject => object.type === "electron-mark" && object.id === initialMark.id)!;
        const original = before.pages[0].objects.find(object => object.id === originalMark.anchor.objectId) as MoleculeObject;
        const molecule = after.pages[0].objects.find(object => object.id === original.id) as MoleculeObject;
        const mark = after.pages[0].objects.find((object): object is ElectronMarkObject => object.type === "electron-mark" && object.id === originalMark.id)!;
        expect(molecule.atoms.map(atom => atom.formalCharge)).toEqual(original.atoms.map(atom => atom.formalCharge));
        expect(molecule.atoms[0].formalCharge).toBe(1);
        expect(mark).toMatchObject({ anchor: originalMark.anchor });
        expect(mark.atomAssociation).toBeUndefined();
        expect(mark.x - molecule.x).toBeCloseTo(originalMark.x - original.x);
        expect(mark.y - molecule.y).toBeCloseTo(originalMark.y - original.y);
      }
      expect(container.querySelector("[data-status-message]")?.textContent).not.toContain("Cannot preserve");
      await command("edit.undo");
      expect(snapshot().pages).toEqual(before.pages);
      await command("edit.redo");
      expect(snapshot().pages).toEqual(after.pages);
    });

  it("warns when an ordinary charge loses its association during independent alignment", async () => {
    let initialDocument = twoGlycinesAndArrow(false);
    const objects = initialDocument.pages[0].objects;
    const mark = objects.find(object => object.type === "electron-mark")!;
    initialDocument = workflow.selectDocumentObjects(initialDocument, initialDocument.pages[0].id, [mark.id, objects[objects.length - 1].id]);
    await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false, shortcutPlatform: platform })));
    await command("layout.alignRight");
    expect(snapshot().pages[0].objects.filter(object => object.type === "molecule")
      .map(molecule => molecule.atoms[0].formalCharge)).toEqual([0, 1]);
    expect(container.querySelector("[data-status-message]")?.textContent).toContain("association");
    expect(container.querySelector("[data-status-message]")?.textContent).toContain(mark.id);
  });

  it("warns when aligning a selected mark independently of its unselected molecule", async () => {
    let initialDocument = twoGlycinesAndArrow();
    const objects = initialDocument.pages[0].objects;
    const mark = objects.find(object => object.type === "electron-mark")!;
    initialDocument = workflow.selectDocumentObjects(initialDocument, initialDocument.pages[0].id, [mark.id, objects[objects.length - 1].id]);
    await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false, shortcutPlatform: platform })));
    await command("layout.alignRight");
    expect(container.querySelector("[data-status-message]")?.textContent).toContain("the mark is moving independently");
    expect(snapshot().pages[0].objects.filter(object => object.type === "molecule")
      .map(molecule => molecule.atoms[0].formalCharge)).toEqual([0, 1]);
  });

  it.each(operations)("keeps two explicit distant +1 marks through Select All / $commandId ($mode), undo and redo", async ({ commandId, mode }) => {
    const initialDocument = twoGlycinesAndArrow();
    await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false, shortcutPlatform: platform })));
    await command("edit.selectAll");
    const before = snapshot();
    expect(before.selection.objectIds).toHaveLength(5);
    await command(`layout.distribute.mode.${mode}`);
    await command(commandId);
    const after = snapshot();
    const checkPairs = (document: ChemDraftDocument) => {
      const molecules = document.pages[0].objects.filter(object => object.type === "molecule");
      expect(molecules.map(molecule => molecule.atoms.find(atom => atom.element === "N")?.formalCharge)).toEqual([1, 1]);
      for (const molecule of molecules) {
        const original = before.pages[0].objects.find(object => object.id === molecule.id)!;
        const mark = document.pages[0].objects.find(object => object.type === "electron-mark" && object.anchor.objectId === molecule.id)!;
        const originalMark = before.pages[0].objects.find(object => object.id === mark.id)!;
        expect(mark).toMatchObject({ atomAssociation: "explicit", anchor: { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[0].id } });
        expect(mark.x - molecule.x).toBeCloseTo(originalMark.x - original.x);
        expect(mark.y - molecule.y).toBeCloseTo(originalMark.y - original.y);
        expect(molecule.atoms).toEqual((original as MoleculeObject).atoms.map(atom => ({ ...atom,
          x: atom.x + molecule.x - original.x, y: atom.y + molecule.y - original.y })));
        expect(molecule.bonds).toEqual((original as MoleculeObject).bonds);
        expect(molecule.structure).toBe((original as MoleculeObject).structure);
        expect(molecule.chemistry).toEqual((original as MoleculeObject).chemistry);
      }
    };
    checkPairs(before);
    checkPairs(after);
    expect(after).not.toEqual(before);
    const unitBounds = (document: ChemDraftDocument) => {
      const objects = document.pages[0].objects;
      return objects.filter(object => object.type !== "electron-mark").map(object => {
        const members = [object, ...objects.filter(mark => mark.type === "electron-mark" && mark.anchor.objectId === object.id)];
        return commandId.startsWith("layout.align") ? workflow.selectionBounds(objects, members.map(member => member.id))!
          : combinedLayoutBounds(members.map(member => workflow.documentObjectVisualBounds(member, objects)))!;
      });
    };
    const boxes = unitBounds(after), originalBoxes = unitBounds(before);
    if (commandId.startsWith("layout.align")) {
      const feature = (box: typeof boxes[number]) => {
        switch (commandId) {
          case "layout.alignLeft": return box.x;
          case "layout.alignCenter": return box.x + box.width / 2;
          case "layout.alignRight": return box.x + box.width;
          case "layout.alignTop": return box.y;
          case "layout.alignMiddle": return box.y + box.height / 2;
          default: return box.y + box.height;
        }
      };
      const target = feature(combinedLayoutBounds(originalBoxes)!);
      boxes.forEach(box => expect(feature(box)).toBeCloseTo(target));
    } else {
      const horizontal = commandId.endsWith("Horizontal");
      const start = (box: typeof boxes[number]) => horizontal ? box.x : box.y;
      const size = (box: typeof boxes[number]) => horizontal ? box.width : box.height;
      const position = (box: typeof boxes[number]) => start(box) + (mode === "centers" ? size(box) / 2 : 0);
      const ordered = [...boxes].sort((a, b) => position(a) - position(b));
      const originals = [...originalBoxes].sort((a, b) => position(a) - position(b));
      expect(ordered[0]).toEqual(originals[0]);
      expect(ordered[2]).toEqual(originals[2]);
      const gap = (i: number) => position(ordered[i + 1]) - position(ordered[i]) - (mode === "spacing" ? size(ordered[i]) : 0);
      expect(gap(0)).toBeCloseTo(gap(1));
    }
    // The available serializer writes the equivalent glycine branch order CC(O)=O.
    expect(await workflow.copyAsSmiles(after)).toBe("[NH3+]CC(O)=O.[NH3+]CC(O)=O");
    await command("edit.undo");
    expect(snapshot().pages).toEqual(before.pages);
    await command("edit.redo");
    expect(snapshot().pages).toEqual(after.pages);
    checkPairs(snapshot());
  });
});
