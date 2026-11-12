// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, type ChemDraftDocument } from "@chemdraft/chem-core";
import { atomDisplayLabel, moleculeLayoutLabelBoxes } from "@chemdraft/layout-engine";
import { nativeAtomBondOrderUsage, nativeImplicitHydrogenCount, phase4Timestamp } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import * as workflow from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { saveDirectElectronMarkEditing } from "./electronMarkEditingSettings";
import { dropMark, dropMolecule, electronMarkDropFixture, rotatedElectronMarkDropFixture } from "./testSupport/electronMarkDropFixture";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("electron-mark drops on %s", platform => {
describe.each([false, true])("electron-mark drop interaction with direct editing %s", enabled => {
  let container: HTMLDivElement, root: Root;
  let frames: Map<number, FrameRequestCallback>, frameId: number;
  const captureMethods = { set: Element.prototype.setPointerCapture,
    release: Element.prototype.releasePointerCapture, has: Element.prototype.hasPointerCapture };
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveDirectElectronMarkEditing(enabled);
    frames = new Map(); frameId = 0;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    Element.prototype.setPointerCapture = captureMethods.set;
    Element.prototype.releasePointerCapture = captureMethods.release;
    Element.prototype.hasPointerCapture = captureMethods.has;
  });
  async function mount(document: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, { initialDocument: document,
      initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: false,
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) });
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  const highlighted = () => container.querySelector("[data-delete-hover-atom-id]")?.getAttribute("data-delete-hover-atom-id");
  const page = () => container.querySelector(".page")!;
  function pointer(target: EventTarget, type: string, point: { x: number; y: number }) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    target.dispatchEvent(event);
  }
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  async function start() {
    const mark = dropMark(snapshot());
    // Pick painted ink on both preference paths; a rectangular grab area is optional.
    const target = container.querySelector(`[data-page-svg-object-visual="${mark.id}"] circle`)!;
    expect(target).not.toBeNull();
    await act(async () => pointer(target, "pointerdown", workflow.nativeChargeMarkCenter(mark)));
    return { target, mark };
  }
  async function move(target: EventTarget, point: { x: number; y: number }) {
    await act(async () => {
      pointer(target, "pointermove", point);
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(performance.now()));
    });
  }
  function labels() {
    const molecule = dropMolecule(snapshot());
    return molecule.atoms.map(atom => atomDisplayLabel(atom, molecule.bonds, undefined, molecule.atoms));
  }

  it.each([
    ["tool.plus", "Add Charge"], ["tool.minus", "Add Charge"],
    ["tool.radical", "Add Radical"], ["tool.lonePair", "Add Lone Pair"],
    ["tool.radicalCation", "Add Charge"], ["tool.radicalAnion", "Add Charge"]
  ])("labels %s placement on both an atom and empty canvas", async (tool, label) => {
    const initial = workflow.insertNativeSingleBondMolecule(workflow.createPhase4Document("Mark labels"), { x: 300, y: 300 });
    await mount(initial);
    const atom = dropMolecule(snapshot()).atoms[0];
    for (const point of [atom, { x: 600, y: 500 }]) {
      await command(tool);
      await act(async () => pointer(page(), "pointermove", point));
      const before = snapshot();
      await act(async () => pointer(page(), "pointerdown", point));
      await act(async () => pointer(page(), "pointerup", point));
      const after = snapshot();
      expect(after).not.toEqual(before);
      await command("edit.undo");
      expect(status()).toBe(`Undid ${label}`);
      expect(snapshot()).toEqual(before);
      await command("edit.redo");
      expect(status()).toBe(`Redid ${label}`);
      expect(snapshot()).toEqual(after);
      await command("edit.undo");
    }
  });

  it.each([1, -1] as const)("labels reducing and removing a %s charge", async sign => {
    await mount(electronMarkDropFixture({ kind: "charge", charge: sign }).document);
    const atom = dropMolecule(snapshot()).atoms[7];
    for (const [tool, label] of [
      [sign > 0 ? "tool.plus" : "tool.minus", "Add Charge"],
      [sign > 0 ? "tool.minus" : "tool.plus", "Remove Charge"],
      [sign > 0 ? "tool.minus" : "tool.plus", "Remove Charge"]
    ]) {
      await command(tool);
      await act(async () => pointer(page(), "pointermove", atom));
      const before = snapshot();
      await act(async () => pointer(page(), "pointerdown", atom));
      await act(async () => pointer(page(), "pointerup", atom));
      const after = snapshot();
      expect(after).not.toEqual(before);
      await command("edit.undo"); expect(status()).toBe(`Undid ${label}`); expect(snapshot()).toEqual(before);
      await command("edit.redo"); expect(status()).toBe(`Redid ${label}`); expect(snapshot()).toEqual(after);
    }
  });

  it("keeps repeated charge-tool clicks stacked through +9, warning beyond carbon's valence", async () => {
    const ethane = workflow.insertNativeSingleBondMolecule(workflow.createPhase4Document("Carbon charge stacking"), { x: 300, y: 300 });
    const molecule = dropMolecule(ethane);
    const methane = workflow.applyNativeMoleculeDeleteTarget(ethane, {
      objectId: molecule.id, kind: "bond", bondId: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002",
      terminalAtomId: "atom_002", distanceToPointer: 0
    });
    await mount(methane);
    const atom = dropMolecule(snapshot()).atoms[0];
    await command("tool.plus");
    await act(async () => pointer(page(), "pointermove", atom));
    expect(highlighted()).toBe(atom.id);
    const atomTarget = () => container.querySelector(`[data-hit-target="atom"][data-atom-id="${atom.id}"]`)!;
    const clickAtom = async () => {
      expect(atomTarget()).not.toBeNull();
      await act(async () => pointer(atomTarget(), "pointerdown", atom));
      await act(async () => pointer(atomTarget(), "pointerup", atom));
    };
    let markId: string | undefined;
    // Drawing edits preserve the requested charge and warn; only the ±9 format cap refuses.
    for (let charge = 1; charge <= 9; charge++) {
      await clickAtom();
      const after = snapshot(), mark = dropMark(after);
      markId ??= mark.id;
      expect(after.pages[0].objects.filter(object => object.type === "electron-mark"), `press ${charge}`).toHaveLength(1);
      expect(mark).toMatchObject({ id: markId, charge,
        anchor: { kind: "atom", objectId: molecule.id, atomId: atom.id } });
      expect(dropMolecule(after).atoms[0]).toMatchObject({ formalCharge: charge, markCharge: charge });
      expect(status()).toBe(`Placed positive charge${charge > 1 ? ` ${charge}+` : ""} on hovered atom`);
      if (charge > 4) {
        // Valence warnings identify the charged atom within the molecule.
        expect(dropMolecule(after).chemistry?.warnings).toContainEqual(expect.objectContaining({
          code: "chemistry.invalid_valence", objectId: atom.id
        }));
      }
    }
    const charged = snapshot();
    await clickAtom();
    expect(snapshot()).toBe(charged);
    expect(status()).toBe("Charge is already at the ±9 limit");
    await command("edit.undo");
    expect(status()).toBe("Undid Add Charge");
    expect(dropMolecule(snapshot()).atoms[0]).toMatchObject({ formalCharge: 8, markCharge: 8 });
    await command("edit.redo");
    expect(status()).toBe("Redid Add Charge");
    expect(snapshot()).toEqual(charged);
  });

  it.each(["object", "page"])("moves charge through the full Boc-glycine sequence with one exact undo/redo step per %s drop", async route => {
    const { document, nitrogen, carbonylOxygen, hydroxylOxygen } = electronMarkDropFixture();
    await mount(document);
    const reporter = vi.spyOn(workflow, "electronMarkChemistryChanges");
    const states = [snapshot()];
    for (const [point, message, expectedLabels] of [
      [carbonylOxygen, "Charge moved from N to O (O now OH, N now NH)", ["NH", "OH", "OH"]],
      [hydroxylOxygen, "Charge moved from O (C=O) to O (OH) (OH now OH2, C=O now O)", ["NH", "O", "OH2"]],
      [nitrogen, "Charge moved from O to N (N now NH2, O now OH)", ["NH2", "O", "OH"]]
    ] as const) {
      const drag = await start(), before = snapshot(), calls = reporter.mock.calls.length;
      await move(drag.target, point);
      expect(snapshot()).toBe(before);
      expect(reporter).toHaveBeenCalledTimes(calls);
      expect(highlighted()).toBe(point.id);
      expect(container.querySelector(".native-atom-hover")).not.toBeNull();
      await act(async () => pointer(route === "page" ? page() : drag.target, "pointerup", point));
      expect(highlighted()).toBeUndefined();
      expect(status()).toBe(message);
      expect(reporter).toHaveBeenCalledTimes(calls + 1);
      expect([labels()[7], labels()[10], labels()[11]]).toEqual(expectedLabels);
      // Real DOM pointer events commit geometry as well as chemistry, for both release routes.
      const mark = dropMark(snapshot()), molecule = dropMolecule(snapshot());
      const targetLabel = moleculeLayoutLabelBoxes(molecule).find(label => molecule.atoms[label.atom].id === point.id)!;
      expect(mark.x < targetLabel.x + targetLabel.width && mark.x + mark.width > targetLabel.x &&
        mark.y < targetLabel.y + targetLabel.height && mark.y + mark.height > targetLabel.y).toBe(false);
      const after = snapshot(); states.push(after);
      await command("edit.undo");
      expect(status()).toBe("Undid Move Charge");
      expect(snapshot()).toEqual(before);
      await command("edit.redo");
      expect(snapshot()).toEqual(after);
      expect(reporter).toHaveBeenCalledTimes(calls + 1);
    }
    for (const state of states.slice(0, -1).reverse()) {
      await command("edit.undo");
      expect(snapshot()).toEqual(state);
    }
    for (const state of states.slice(1)) {
      await command("edit.redo");
      expect(snapshot()).toEqual(state);
    }
  });

  it("keeps the atom and chemistry when dropping into empty space", async () => {
    const { document } = electronMarkDropFixture(); await mount(document);
    const before = snapshot(), drag = await start(), end = { x: 600, y: 500 };
    await move(drag.target, end);
    expect(highlighted()).toBeUndefined();
    await act(async () => pointer(drag.target, "pointerup", end));
    expect(dropMark(snapshot()).anchor).toEqual(dropMark(before).anchor);
    expect(dropMolecule(snapshot())).toEqual(dropMolecule(before));
    expect(status()).toBe("Charge repositioned on N; no atom within capture radius");
    await command("edit.undo"); expect(snapshot()).toEqual(before);
  });

  it.each([20, 8])("commits a floating charge released %s px from O with accurate status", async separation => {
    const fixture = electronMarkDropFixture();
    const document = workflow.normalizeCommittedDocument(workflow.moveDocumentObject(fixture.document,
      dropMark(fixture.document).id, { x: 591, y: 491 }));
    await mount(document);
    const before = snapshot(), drag = await start();
    const point = { x: fixture.carbonylOxygen.x, y: fixture.carbonylOxygen.y - separation };
    await move(drag.target, point);
    expect(highlighted()).toBe(separation === 8 ? fixture.carbonylOxygen.id : undefined);
    await act(async () => pointer(drag.target, "pointerup", point));
    if (separation === 20) {
      expect(dropMark(snapshot()).anchor.kind).toBe("point");
      expect(dropMolecule(snapshot())).toEqual(dropMolecule(before));
      expect(status()).toBe("Moved electron mark");
    } else {
      expect(dropMark(snapshot()).anchor.atomId).toBe(fixture.carbonylOxygen.id);
      expect(dropMolecule(snapshot()).atoms[10]).toMatchObject({ formalCharge: 1, markCharge: 1 });
      expect(labels()[10]).toBe("OH");
      expect(status()).toBe("Charge attached to O (O now OH)");
    }
    const after = snapshot();
    await command("edit.undo"); expect(snapshot()).toEqual(before);
    await command("edit.redo"); expect(snapshot()).toEqual(after);
  });

  it.each(["Select All", "selection click"])("keeps a deliberately floating drop neutral after %s", async action => {
    const fixture = electronMarkDropFixture();
    await mount(workflow.normalizeCommittedDocument(workflow.moveDocumentObject(fixture.document,
      dropMark(fixture.document).id, { x: 591, y: 491 })));
    const drag = await start();
    const point = { x: fixture.carbonylOxygen.x, y: fixture.carbonylOxygen.y - 20 };
    await move(drag.target, point);
    expect(highlighted()).toBeUndefined();
    await act(async () => pointer(drag.target, "pointerup", point));
    expect(status()).toBe("Moved electron mark");
    const after = snapshot(), mark = dropMark(after), molecule = dropMolecule(after);
    expect(mark.anchor.kind).toBe("point");
    expect(molecule.atoms[10].formalCharge).toBe(0);
    if (action === "Select All") {
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "a", bubbles: true, metaKey: platform === "macos", ctrlKey: platform === "windows"
      })));
      expect(status()).toBe("Selected 2 canvas objects");
    } else {
      await act(async () => pointer(page(), "pointerdown", { x: 650, y: 500 }));
      await act(async () => pointer(page(), "pointerup", { x: 650, y: 500 }));
    }
    expect(snapshot().selection).not.toEqual(after.selection);
    expect(dropMolecule(snapshot()).atoms[10].formalCharge).toBe(0);
    expect(dropMolecule(snapshot())).toEqual(molecule);
    expect(dropMark(snapshot())).toEqual(mark);
  });

  it.each([0, 180])("previews and commits the rendered O target in a molecule rotated %s degrees", async rotation => {
    await mount(rotatedElectronMarkDropFixture(rotation));
    const molecule = dropMolecule(snapshot()), oxygen = molecule.atoms[0], nitrogen = molecule.atoms[3];
    const point = { x: rotation === 180 ? 200 : 100, y: 110 };
    const drag = await start(), before = snapshot();
    await move(drag.target, point);
    expect(snapshot()).toBe(before);
    expect(highlighted()).toBe(oxygen.id);
    await act(async () => pointer(drag.target, "pointerup", point));
    expect(dropMark(snapshot()).anchor.atomId).toBe(oxygen.id);
    expect(dropMolecule(snapshot()).atoms.find(atom => atom.id === oxygen.id)?.formalCharge).toBe(1);
    expect(dropMolecule(snapshot()).atoms.find(atom => atom.id === nitrogen.id)?.formalCharge).toBe(0);
    expect(status()).toBe("Charge attached to O (O now H2O)");
  });

  it.each([1, -1] as const)("keeps the radical on its atom after dropping and neutralising a radical ion with charge %s", async charge => {
    const fixture = electronMarkDropFixture({ kind: "charge", charge, radical: true });
    await mount(fixture.document);
    const drag = await start(), end = { x: 600, y: 500 };
    await move(drag.target, end);
    await act(async () => pointer(drag.target, "pointerup", end));
    expect(status()).toContain("no atom within capture radius");
    const distant = snapshot(), original = dropMark(distant);
    await act(async () => pointer(page(), "pointermove", fixture.sourceAtom));
    await command(charge > 0 ? "tool.minus" : "tool.plus");
    await act(async () => pointer(page(), "pointerdown", fixture.sourceAtom));
    const neutral = snapshot(), molecule = dropMolecule(neutral);
    const atom = molecule.atoms.find(atom => atom.id === fixture.sourceAtom.id)!;
    expect(dropMark(neutral)).toMatchObject({ id: original.id, markKind: "radical-dot",
      anchor: original.anchor, atomAssociation: "explicit", x: original.x, y: original.y });
    expect(atom).toMatchObject({ formalCharge: 0, markRadicals: 1 });
    expect(nativeImplicitHydrogenCount(workflow.nativeElementFromAtomLabel(atom.element)!,
      nativeAtomBondOrderUsage(atom.id, molecule.bonds, molecule.atoms), atom.formalCharge, atom.markRadicals)).toBe(charge > 0 ? 0 : 2);
    expect(status()).toBe("Placed radical electron on hovered atom");
    await command("edit.undo"); expect(snapshot()).toEqual(distant);
    expect(status()).toBe("Undid Remove Charge");
    await command("edit.redo"); expect(snapshot()).toEqual(neutral);
    expect(status()).toBe("Redid Remove Charge");
  });

  it("highlights a refused target, reports why, and leaves no undo entry", async () => {
    const { document, saturatedCarbon } = electronMarkDropFixture(); await mount(document);
    const before = snapshot(), drag = await start();
    await move(drag.target, saturatedCarbon);
    expect(highlighted()).toBe(saturatedCarbon.id);
    await act(async () => pointer(drag.target, "pointerup", saturatedCarbon));
    expect(snapshot()).toEqual(before);
    expect(status()).toBe("Cannot move Charge from N to C: C cannot carry formal charge +1 with bond/radical valence 4");
    expect(highlighted()).toBeUndefined();
    await command("edit.undo"); expect(snapshot()).toEqual(before);
  });

  it.each(["Escape", "object cancel", "page cancel"])("clears the attachment highlight and preserves chemistry on %s", async cancel => {
    const { document, carbonylOxygen } = electronMarkDropFixture(); await mount(document);
    const before = snapshot(), drag = await start();
    await move(drag.target, carbonylOxygen);
    expect(highlighted()).toBe(carbonylOxygen.id);
    await act(async () => {
      if (cancel === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else pointer(cancel === "page cancel" ? page() : drag.target, "pointercancel", carbonylOxygen);
    });
    expect(highlighted()).toBeUndefined();
    expect(snapshot()).toEqual(before);
    await act(async () => pointer(drag.target, "pointerup", carbonylOxygen));
    expect(snapshot()).toEqual(before);
  });

  it.each(["radical-dot", "lone-pair", "unknown"] as const)("attaches a dragged %s through painted ink with either preference", async kind => {
    const fixture = electronMarkDropFixture({ kind: kind === "unknown" ? "lone-pair" : kind });
    const document = kind === "unknown" ? applyPatch(fixture.document, { op: "updateObject",
      objectId: dropMark(fixture.document).id, changes: { markKind: "unknown" } }, { now: phase4Timestamp }) : fixture.document;
    await mount(document);
    const before = snapshot();
    // Unknown marks render as a fallback glyph rather than a dot; their wrapper still owns the drag.
    const mark = dropMark(before);
    const target = container.querySelector(`[data-page-svg-object-visual="${mark.id}"]`)!;
    await act(async () => pointer(target, "pointerdown", workflow.nativeChargeMarkCenter(mark)));
    await move(target, fixture.hydroxylOxygen);
    expect(highlighted()).toBe(fixture.hydroxylOxygen.id);
    await act(async () => pointer(target, "pointerup", fixture.hydroxylOxygen));
    expect(dropMark(snapshot()).anchor.atomId).toBe(fixture.hydroxylOxygen.id);
    expect(dropMolecule(snapshot()).atoms[7].markRadicals ?? 0).toBe(0);
    expect(dropMolecule(snapshot()).atoms[11].markRadicals ?? 0).toBe(kind === "radical-dot" ? 1 : 0);
    await command("edit.undo"); expect(snapshot()).toEqual(before);
  });
});
});
