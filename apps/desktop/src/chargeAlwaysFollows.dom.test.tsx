// @vitest-environment jsdom
// Owner ruling "charge always follows": every charge or radical mark associated with an atom moves
// with that atom on any move of the atom, and a move never changes chemistry. A charge is removed
// or changed only by dragging the mark itself (or deleting it). These tests pin the rule across the
// move paths; the final describe block is the control for mark drags, which keep today's policy.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, type ChemDraftDocument, type ElectronMarkObject,
  type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { transformPointForObject } from "@chemdraft/layout-engine";
import { createNativeTextObject, phase4Timestamp } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import * as workflow from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { ammoniumElectronMarkDropFixture, dropMark, dropMolecule, electronMarkDropFixture,
  fourBondNitrogenElectronMarkDropFixture } from "./testSupport/electronMarkDropFixture";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

type Point = { x: number; y: number };

/** One charged or radical atom in a Boc-glycine drawing, and the mark that carries it. */
interface Charged {
  document: ChemDraftDocument;
  moleculeId: string;
  atomId: string;
  markId: string;
}

function chargedFrom(document: ChemDraftDocument, atom: MoleculeAtom): Charged {
  return { document, moleculeId: dropMolecule(document).id, atomId: atom.id, markId: dropMark(document).id };
}

/** CH2⁻ on the terminal methyl carbon of Boc-glycine, placed by the charge tool (atom anchor). */
function carbanion(): Charged {
  const fixture = electronMarkDropFixture();
  const molecule = dropMolecule(fixture.document);
  const bare = workflow.normalizeCommittedDocument(applyPatch(fixture.document,
    { op: "removeObject", objectId: dropMark(fixture.document).id }, { now: phase4Timestamp }));
  const carbon = molecule.atoms[0];
  const document = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(bare,
    { kind: "charge", charge: -1 }, { kind: "atom", objectId: molecule.id, atomId: carbon.id, distanceToPointer: 0 }));
  return chargedFrom(document, carbon);
}

/** The tool-placed N⁺ mark re-stored as a legacy loose (point) or bond-anchored mark, same place. */
function legacyNitrogen(kind: "point" | "bond"): Charged {
  const { document, nitrogen } = electronMarkDropFixture();
  const molecule = dropMolecule(document), mark = dropMark(document);
  const bond = molecule.bonds.find(bond => bond.fromAtomId === nitrogen.id || bond.toAtomId === nitrogen.id)!;
  const anchor: ElectronMarkObject["anchor"] = kind === "point"
    ? { kind: "point", point: workflow.nativeChargeMarkCenter(mark) }
    : { kind: "bond", objectId: molecule.id, bondId: bond.id };
  const legacy = workflow.normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId: mark.id,
    changes: { anchor, atomAssociation: undefined } }, { now: phase4Timestamp }));
  return chargedFrom(legacy, nitrogen);
}

const variants: { name: string; build: () => Charged }[] = [
  { name: "C with an atom-anchored ⊖", build: carbanion },
  { name: "N+ with an atom-anchored ⊕", build: () => {
    const { document, nitrogen } = electronMarkDropFixture();
    return chargedFrom(document, nitrogen);
  } },
  { name: "N with an atom-anchored radical", build: () => {
    const { document, nitrogen } = electronMarkDropFixture({ kind: "radical-dot" });
    return chargedFrom(document, nitrogen);
  } },
  { name: "N+ with a legacy loose ⊕ in association range", build: () => legacyNitrogen("point") },
  { name: "N+ with a bond-anchored ⊕", build: () => legacyNitrogen("bond") }
];

const molecule = (document: ChemDraftDocument, id: string) =>
  document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule" && object.id === id)!;
const atomOf = (document: ChemDraftDocument, moleculeId: string, atomId: string) =>
  molecule(document, moleculeId).atoms.find(atom => atom.id === atomId)!;
const markOf = (document: ChemDraftDocument, markId: string) =>
  workflow.findDocumentObject(document, markId) as ElectronMarkObject;
const chemistryOf = ({ formalCharge, markCharge, markRadicals }: MoleculeAtom) =>
  ({ formalCharge, markCharge: markCharge ?? 0, markRadicals: markRadicals ?? 0 });

/** The atom a mark is associated with: its atom anchor, or the committed legacy assignment. */
function association(document: ChemDraftDocument, markId: string) {
  const mark = markOf(document, markId);
  if (mark.anchor.kind === "atom") return { objectId: mark.anchor.objectId, atomId: mark.anchor.atomId };
  const page = document.pages.find(page => page.objects.some(object => object.id === markId))!;
  const owner = workflow.committedElectronMarkAssignments(page).anchorByMarkId.get(markId);
  return owner ? { objectId: owner.objectId, atomId: owner.atomId } : undefined;
}

function atomPagePoint(document: ChemDraftDocument, moleculeId: string, atomId: string): Point {
  const owner = molecule(document, moleculeId);
  return transformPointForObject(owner, owner.atoms.find(atom => atom.id === atomId)!);
}

/** Mark center relative to the drawn atom it belongs to. */
function markOffset(document: ChemDraftDocument, charged: Charged, moleculeId = charged.moleculeId, markId = charged.markId): Point {
  const center = workflow.nativeChargeMarkCenter(markOf(document, markId));
  const atom = atomPagePoint(document, moleculeId, charged.atomId);
  return { x: center.x - atom.x, y: center.y - atom.y };
}

function neighborOf(document: ChemDraftDocument, charged: Charged): string {
  const bond = molecule(document, charged.moleculeId).bonds.find(bond =>
    bond.fromAtomId === charged.atomId || bond.toAtomId === charged.atomId)!;
  return bond.fromAtomId === charged.atomId ? bond.toAtomId : bond.fromAtomId;
}

/** The fixture is what it claims: the mark is associated with the atom and carries chemistry. */
function expectChargedFixture(charged: Charged, document = charged.document) {
  expect(association(document, charged.markId), "fixture mark must be associated with its atom")
    .toEqual({ objectId: charged.moleculeId, atomId: charged.atomId });
  const atom = chemistryOf(atomOf(document, charged.moleculeId, charged.atomId));
  expect(atom.formalCharge !== 0 || atom.markRadicals !== 0, "fixture atom must carry a charge or radical").toBe(true);
}

/**
 * The rule: chemistry identical on every atom, the mark still associated with the same atom, and
 * the mark's offset from the atom kept (mapped through `map` for rotations and flips).
 */
function expectChargeFollowed(before: ChemDraftDocument, after: ChemDraftDocument, charged: Charged,
  map: (offset: Point) => Point = offset => offset) {
  const { moleculeId, atomId, markId } = charged;
  expect(chemistryOf(atomOf(after, moleculeId, atomId)), "a move never changes the atom's chemistry")
    .toEqual(chemistryOf(atomOf(before, moleculeId, atomId)));
  expect(molecule(after, moleculeId).atoms.map(chemistryOf), "no charge moves to another atom")
    .toEqual(molecule(before, moleculeId).atoms.map(chemistryOf));
  expect(molecule(after, moleculeId).chemistry?.formula).toBe(molecule(before, moleculeId).chemistry?.formula);
  expect(molecule(after, moleculeId).chemistry?.totalCharge).toBe(molecule(before, moleculeId).chemistry?.totalCharge);
  expect(association(after, markId), "the mark stays associated with its atom").toEqual({ objectId: moleculeId, atomId });
  const expected = map(markOffset(before, charged));
  const actual = markOffset(after, charged);
  expect(actual.x, "the mark moves with its atom (x)").toBeCloseTo(expected.x, 3);
  expect(actual.y, "the mark moves with its atom (y)").toBeCloseTo(expected.y, 3);
  const mark = markOf(after, markId), original = markOf(before, markId);
  expect({ markKind: mark.markKind, charge: mark.charge, radical: mark.radical })
    .toEqual({ markKind: original.markKind, charge: original.charge, radical: original.radical });
}

function expectAtomMoved(before: ChemDraftDocument, after: ChemDraftDocument, charged: Charged, atLeast: number) {
  const from = atomPagePoint(before, charged.moleculeId, charged.atomId);
  const to = atomPagePoint(after, charged.moleculeId, charged.atomId);
  expect(Math.hypot(to.x - from.x, to.y - from.y), "the gesture must actually move the atom").toBeGreaterThan(atLeast);
}

describe.each(["macos", "windows"] as const)("charge always follows its atom (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  let frames: Map<number, FrameRequestCallback>, frameId: number;
  const captureMethods = { set: Element.prototype.setPointerCapture,
    release: Element.prototype.releasePointerCapture, has: Element.prototype.hasPointerCapture };
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    frames = new Map(); frameId = 0;
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
  const status = () => container.querySelector("[data-status-message]")?.textContent ?? "";
  const page = () => container.querySelector(".page")!;
  const canUndo = () => container.querySelector("main")?.getAttribute("data-can-undo");
  function pointer(target: EventTarget, type: string, point: Point, shiftKey = false) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y, shiftKey });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    target.dispatchEvent(event);
  }
  async function move(target: EventTarget, point: Point) {
    await act(async () => {
      pointer(target, "pointermove", point);
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(performance.now()));
    });
  }
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  const moleculeTarget = (objectId: string) => {
    const target = container.querySelector(`.native-molecule-object[data-object-id="${objectId}"]`)!;
    expect(target).not.toBeNull();
    return target;
  };
  /** Press an atom of an unselected or part-selected molecule and drag it: a molecule part drag. */
  async function dragPart(objectId: string, from: Point, to: Point) {
    await act(async () => pointer(moleculeTarget(objectId), "pointerdown", from));
    const before = snapshot();
    await move(page(), to);
    await act(async () => pointer(page(), "pointerup", to));
    return before;
  }
  async function shiftClickAtom(objectId: string, point: Point) {
    await act(async () => pointer(moleculeTarget(objectId), "pointerdown", point, true));
    await act(async () => pointer(moleculeTarget(objectId), "pointerup", point, true));
  }
  /** One Undo restores `before` under the given label, a second has nothing left, Redo restores `after`. */
  async function expectSingleUndo(before: ChemDraftDocument, after: ChemDraftDocument, label: string | RegExp) {
    await command("edit.undo");
    if (typeof label === "string") expect(status()).toBe(`Undid ${label}`);
    else expect(status()).toMatch(label);
    expect(status(), "an atom move never names a charge change").not.toMatch(/Charge|Radical/);
    expect(snapshot().pages).toEqual(before.pages);
    await command("edit.undo"); expect(snapshot().pages).toEqual(before.pages);
    await command("edit.redo"); expect(snapshot().pages).toEqual(after.pages);
  }
  function expectNoChargeReport() {
    expect(status(), "an atom move neither refuses nor reports a charge change")
      .not.toMatch(/Cannot move|removed from|moved from|attached to|transfer/i);
  }
  function withCaptions(document: ChemDraftDocument, points: Point[]) {
    let next = document;
    const ids: string[] = [];
    for (const [index, point] of points.entries()) {
      const caption = createNativeTextObject(next, point, `Caption ${index + 1}`);
      next = applyPatch(next, { op: "addObject", pageId: next.pages[0].id, object: caption }, { now: phase4Timestamp });
      ids.push(caption.id);
    }
    return { document: next, captionIds: ids };
  }

  describe("molecule part drags", () => {
    it.each(variants)("drags only the $name: the mark follows and Undo says Move", async ({ build }) => {
      const charged = build();
      expectChargedFixture(charged);
      // Nothing selected, so pressing the atom starts a part drag of that atom alone.
      await mount(workflow.selectDocumentObjects(charged.document, charged.document.pages[0].id, []));
      const from = atomPagePoint(charged.document, charged.moleculeId, charged.atomId);
      const before = await dragPart(charged.moleculeId, from, { x: from.x + 100, y: from.y + 100 });
      const after = snapshot();
      expectAtomMoved(before, after, charged, 50);
      expectChargeFollowed(before, after, charged);
      expectNoChargeReport();
      expect(canUndo()).toBe("true");
      await expectSingleUndo(before, after, "Move");
    });

    it.each(variants)("drags the $name together with a bonded neighbor: the mark follows", async ({ build }) => {
      const charged = build();
      expectChargedFixture(charged);
      await mount(workflow.selectDocumentObjects(charged.document, charged.document.pages[0].id, []));
      const neighborId = neighborOf(charged.document, charged);
      const from = atomPagePoint(charged.document, charged.moleculeId, charged.atomId);
      await shiftClickAtom(charged.moleculeId, from);
      await shiftClickAtom(charged.moleculeId, atomPagePoint(charged.document, charged.moleculeId, neighborId));
      const before = await dragPart(charged.moleculeId, from, { x: from.x + 90, y: from.y + 110 });
      const after = snapshot();
      expectAtomMoved(before, after, charged, 50);
      const delta = (atomId: string) => {
        const start = atomPagePoint(before, charged.moleculeId, atomId), end = atomPagePoint(after, charged.moleculeId, atomId);
        return { x: end.x - start.x, y: end.y - start.y };
      };
      expect(delta(neighborId), "both selected atoms move together").toEqual(delta(charged.atomId));
      expectChargeFollowed(before, after, charged);
      expectNoChargeReport();
      await expectSingleUndo(before, after, "Move");
    });

    it("drags four-bond N+ away from its mark's old place without a refusal: the charge is kept", async () => {
      const { document, nitrogen } = fourBondNitrogenElectronMarkDropFixture();
      const charged = chargedFrom(document, nitrogen);
      expectChargedFixture(charged);
      await mount(document);
      const before = await dragPart(charged.moleculeId, nitrogen, { x: nitrogen.x + 100, y: nitrogen.y + 100 });
      const after = snapshot();
      expect(after.pages, "the drag is not refused").not.toEqual(before.pages);
      expect(atomOf(after, charged.moleculeId, nitrogen.id)).toMatchObject({ formalCharge: 1, markCharge: 1 });
      expectAtomMoved(before, after, charged, 50);
      expectChargeFollowed(before, after, charged);
      expectNoChargeReport();
      expect(canUndo()).toBe("true");
      await expectSingleUndo(before, after, "Move");
    });

    it("drags the nitrogen of NH4+ away from its stationary charge: the charge is kept and the mark follows", async () => {
      // 1.2.2 removed the charge here ("Charge removed from N", Undo "Move and Remove Charge").
      const { document, nitrogen } = ammoniumElectronMarkDropFixture();
      const charged = chargedFrom(document, nitrogen);
      expectChargedFixture(charged);
      await mount(document);
      const before = await dragPart(charged.moleculeId, nitrogen, { x: nitrogen.x + 100, y: nitrogen.y + 100 });
      const after = snapshot();
      expectAtomMoved(before, after, charged, 50);
      expectChargeFollowed(before, after, charged);
      expectNoChargeReport();
      await expectSingleUndo(before, after, "Move");
    });
  });

  describe("arrow-key nudge", () => {
    it.each(variants)("nudges the $name in one burst: the charge is kept and Undo says Move", async ({ build }) => {
      const charged = build();
      expectChargedFixture(charged);
      await mount(workflow.selectDocumentObjects(charged.document, charged.document.pages[0].id, []));
      await shiftClickAtom(charged.moleculeId, atomPagePoint(charged.document, charged.moleculeId, charged.atomId));
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const before = snapshot();
      // Five Shift+Right presses carry the atom 50 px, well outside any association radius.
      for (let press = 0; press < 5; press++) {
        await act(async () => page().dispatchEvent(new KeyboardEvent("keydown", {
          key: "ArrowRight", shiftKey: true, repeat: press > 0, bubbles: true, cancelable: true
        })));
      }
      const after = snapshot();
      expectAtomMoved(before, after, charged, 40);
      expectChargeFollowed(before, after, charged);
      expectNoChargeReport();
      await expectSingleUndo(before, after, "Move");
    });
  });

  describe("whole-molecule and multi-object drags", () => {
    it.each(variants.flatMap(variant => ["the molecule alone", "the molecule and a caption"].map(selection => ({ ...variant, selection }))))(
      "drags $selection with the $name: the mark follows", async ({ build, selection }) => {
        const charged = build();
        expectChargedFixture(charged);
        const { document, captionIds } = withCaptions(charged.document,
          selection === "the molecule alone" ? [] : [{ x: 420, y: 140 }]);
        await mount(workflow.selectDocumentObjects(document, document.pages[0].id, [charged.moleculeId, ...captionIds]));
        // Grab the ester oxygen, away from either charged atom and its mark.
        const grip = transformPointForObject(dropMolecule(document), dropMolecule(document).atoms[4]);
        const before = await dragPart(charged.moleculeId, grip, { x: grip.x + 120, y: grip.y + 90 });
        const after = snapshot();
        expectAtomMoved(before, after, charged, 50);
        expectChargeFollowed(before, after, charged);
        expectNoChargeReport();
        // Whole-object drags keep their existing label; only a charge suffix is ruled out.
        await expectSingleUndo(before, after, /^Undid /);
      });
  });

  describe("selection transforms", () => {
    const rotation = (before: ChemDraftDocument, after: ChemDraftDocument, charged: Charged) => {
      // Read the turn from a bond vector, so the check does not depend on the rotation's sign convention.
      const neighborId = neighborOf(before, charged);
      const vector = (document: ChemDraftDocument) => {
        const atom = atomPagePoint(document, charged.moleculeId, charged.atomId);
        const neighbor = atomPagePoint(document, charged.moleculeId, neighborId);
        return Math.atan2(neighbor.y - atom.y, neighbor.x - atom.x);
      };
      const turn = vector(after) - vector(before);
      expect(Math.abs(Math.cos(turn)), "layout.rotate90 turns by a quarter").toBeLessThan(1e-6);
      return ({ x, y }: Point) => ({ x: x * Math.cos(turn) - y * Math.sin(turn), y: x * Math.sin(turn) + y * Math.cos(turn) });
    };

    it.each(variants.flatMap(variant => (["layout.rotate90", "layout.flipHorizontal"] as const).map(commandId => ({ ...variant, commandId }))))(
      "$commandId of the $name with a caption turns the mark's offset with its atom", async ({ build, commandId }) => {
        const charged = build();
        expectChargedFixture(charged);
        const { document, captionIds } = withCaptions(charged.document, [{ x: 420, y: 160 }]);
        await mount(workflow.selectDocumentObjects(document, document.pages[0].id, [charged.moleculeId, ...captionIds]));
        const before = snapshot();
        await command(commandId);
        const after = snapshot();
        expectAtomMoved(before, after, charged, 1);
        const map = commandId === "layout.rotate90" ? rotation(before, after, charged) : ({ x, y }: Point) => ({ x: -x, y });
        expectChargeFollowed(before, after, charged, map);
        expectNoChargeReport();
        await expectSingleUndo(before, after, /^Undid /);
      });

    const layoutCommands = [
      { commandId: "layout.alignLeft", label: "Align Left", captions: [{ x: 40, y: 420 }] },
      { commandId: "layout.distributeHorizontal", label: "Distribute Horizontally", captions: [{ x: 40, y: 420 }, { x: 700, y: 420 }] }
    ];
    it.each(variants.flatMap(variant => layoutCommands.map(layout => ({ ...variant, ...layout }))))(
      "$commandId of the $name with captions keeps the charge and the mark follows", async ({ build, commandId, label, captions }) => {
        const charged = build();
        expectChargedFixture(charged);
        const { document, captionIds } = withCaptions(charged.document, captions);
        await mount(workflow.selectDocumentObjects(document, document.pages[0].id, [charged.moleculeId, ...captionIds]));
        const before = snapshot();
        await command(commandId);
        const after = snapshot();
        expectAtomMoved(before, after, charged, 1);
        expectChargeFollowed(before, after, charged);
        expectNoChargeReport();
        await expectSingleUndo(before, after, label);
      });
  });

  describe("duplicate", () => {
    it.each(variants)("duplicates a molecule with the $name: the copy carries the charge and its mark", async ({ build }) => {
      const charged = build();
      expectChargedFixture(charged);
      await mount(workflow.selectDocumentObjects(charged.document, charged.document.pages[0].id, [charged.moleculeId]));
      const before = snapshot();
      await command("layout.duplicate");
      const after = snapshot();
      expectChargeFollowed(before, after, charged);
      const copy = after.pages[0].objects.find((object): object is MoleculeObject =>
        object.type === "molecule" && object.id !== charged.moleculeId)!;
      expect(copy, "duplicate adds a molecule").toBeDefined();
      expect(chemistryOf(copy.atoms.find(atom => atom.id === charged.atomId)!))
        .toEqual(chemistryOf(atomOf(before, charged.moleculeId, charged.atomId)));
      const copiedMarks = after.pages[0].objects.filter(object => object.type === "electron-mark" &&
        association(after, object.id)?.objectId === copy.id && association(after, object.id)?.atomId === charged.atomId);
      expect(copiedMarks, "the copy's atom has its own copy of the mark").toHaveLength(1);
      const copyOffset = markOffset(after, charged, copy.id, copiedMarks[0].id);
      const offset = markOffset(before, charged);
      expect(copyOffset.x).toBeCloseTo(offset.x, 3);
      expect(copyOffset.y).toBeCloseTo(offset.y, 3);
    });
  });

  describe("control: dragging the mark itself keeps today's association and valence check", () => {
    async function dragMark(document: ChemDraftDocument, end: Point) {
      await mount(document);
      const mark = dropMark(snapshot());
      const target = container.querySelector(`[data-page-svg-object-visual="${mark.id}"] circle`)!;
      expect(target).not.toBeNull();
      await act(async () => pointer(target, "pointerdown", workflow.nativeChargeMarkCenter(mark)));
      const before = snapshot();
      await move(target, end);
      await act(async () => pointer(target, "pointerup", end));
      return before;
    }

    it("detaches a charge dragged off NH4+ and labels Undo Move Charge", async () => {
      const { document, nitrogen } = ammoniumElectronMarkDropFixture();
      const before = await dragMark(document, { x: 600, y: 500 });
      const after = snapshot();
      expect(dropMark(after).anchor).toEqual({ kind: "point", point: { x: 600, y: 500 } });
      expect(atomOf(after, dropMolecule(after).id, nitrogen.id).formalCharge).toBe(0);
      expect(status()).toBe("Charge removed from N (N now NH3)");
      await command("edit.undo");
      expect(status()).toBe("Undid Move Charge");
      expect(snapshot()).toEqual(before);
    });

    it("refuses to drag the charge off four-bond N+", async () => {
      const { document } = fourBondNitrogenElectronMarkDropFixture();
      const before = await dragMark(document, { x: 600, y: 500 });
      expect(status()).toMatch(/^Cannot move Charge from N/);
      expect(snapshot()).toEqual(before);
      expect(canUndo()).toBe("false");
    });

    it("transfers a charge dropped on another atom and names the transfer", async () => {
      const { document, carbonylOxygen } = electronMarkDropFixture();
      const before = await dragMark(document, carbonylOxygen);
      expect(association(snapshot(), dropMark(snapshot()).id)).toEqual({ objectId: dropMolecule(before).id, atomId: carbonylOxygen.id });
      expect(status()).toBe("Charge moved from N to O (O now OH, N now NH)");
      await command("edit.undo");
      expect(status()).toBe("Undid Move Charge");
      expect(snapshot()).toEqual(before);
    });
  });
});
