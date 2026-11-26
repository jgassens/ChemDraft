// @vitest-environment jsdom
// 1.2.3 (Windows report, both platforms): "Rotate molecule…" vanished from the right-click menu, and
// was disabled after Select All, once the molecule carried a charge, radical or lone-pair mark. Since
// #483 a molecule's own marks join its selection, and the rotate command still asked for exactly one
// selected object. It now reads the selection with `singleMoleculeTransformSelection`: one molecule plus
// only marks the rotation cascade carries (its own owner rule, `atomOwnedMarksForTransform`) is that
// molecule, and the rotation carries the marks. A mark the cascade would leave behind (a stale stored
// anchor, a floating mark, an anchor to a missing atom) keeps the command refused.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatch, applyPatches, type ChemDraftDocument, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { moleculeSelectionBounds, transformPointForObject } from "@chemdraft/layout-engine";
import { phase4Timestamp, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { createLayerActions } from "./commands";
import * as workflow from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import type { NativeElectronMarkSpec } from "./documentWorkflow";
import { distantAttachedElectronMarkFixture, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";
import { PRESERVE_CHEMISTRY, policyChemistryRefusals } from "./commitChemistryGuard";
import { relayoutMolfile2D } from "@chemdraft/ocl-adapter";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@scena/react-ruler", () => ({ default: () => null }));

const markCases: Array<[string, NativeElectronMarkSpec]> = [
  ["charge", { kind: "charge", charge: 1 }],
  ["radical", { kind: "radical-dot" }],
  ["lone-pair", { kind: "lone-pair" }]
];

/** Boc-glycine with one mark on N, selected together with that mark (as #483 leaves it after placement). */
function markedDrawing(spec: NativeElectronMarkSpec, selected: "molecule-and-mark" | "none" = "molecule-and-mark") {
  const { document } = electronMarkDropFixture(spec);
  const molecule = document.pages[0].objects.find(object => object.type === "molecule") as MoleculeObject;
  const mark = document.pages[0].objects.find(object => object.type === "electron-mark") as ElectronMarkObject;
  expect(mark.anchor).toMatchObject({ kind: "atom", objectId: molecule.id });
  const ids = selected === "none" ? [] : [molecule.id, mark.id];
  return { document: workflow.selectDocumentObjects(document, document.pages[0].id, ids), moleculeId: molecule.id, markId: mark.id };
}

const rotateAction = (document: ChemDraftDocument) =>
  createLayerActions(document).find(action => action.id === "layout.rotateMolecule")!;
const REFUSED = { enabled: false, disabledReason: "Select one whole molecule with editable atoms" };
const ADMITTED = { enabled: true, disabledReason: undefined };

/**
 * Glycine A (its N's mark) and benzene B, with the mark edited the way an opened file can keep it:
 * still anchored to A's N, but not explicitly, and sitting where `place` puts it. The open path keeps
 * stored marks as they are (`preserveElectronMarks`), so the stale anchor survives; the committed
 * assignment resolver, which the rotation cascade follows, decides the mark's real owner.
 */
function staleAnchorDrawing(spec: NativeElectronMarkSpec, place: (benzene: MoleculeObject) => { x: number; y: number },
  association: ElectronMarkObject["atomAssociation"] = undefined) {
  const { document: marked, moleculeId, markId } = markedDrawing(spec, "none");
  const pageId = marked.pages[0].id;
  const benzene = workflow.createNativeTemplateMolecule(marked, { x: 500, y: 450 }, "benzene");
  const withBenzene = applyPatches(marked, [{ op: "addObject", pageId, object: benzene }], { now: phase4Timestamp });
  const mark = withBenzene.pages[0].objects.find(object => object.id === markId) as ElectronMarkObject;
  const center = place(withBenzene.pages[0].objects.find(object => object.id === benzene.id) as MoleculeObject);
  const opened = workflow.normalizeCommittedDocument(applyPatch(withBenzene, { op: "updateObject", objectId: markId,
    changes: { atomAssociation: association, x: center.x - mark.width / 2, y: center.y - mark.height / 2 } },
    { now: phase4Timestamp }), { preserveElectronMarks: true });
  const stored = opened.pages[0].objects.find(object => object.id === markId) as ElectronMarkObject;
  expect(stored.anchor).toMatchObject({ kind: "atom", objectId: moleculeId });
  expect(stored.atomAssociation).toBe(association);
  const select = (ids: string[]) => workflow.selectDocumentObjects(opened, pageId, ids);
  const owner = workflow.committedElectronMarkAssignments(opened.pages[0]).anchorByMarkId.get(markId);
  return { document: opened, select, moleculeId, markId, benzeneId: benzene.id, owner };
}

/** A point 12 below the first benzene atom: inside that atom's association radius, far from A. */
const nearBenzeneAtom = (benzene: MoleculeObject) => {
  const atom = transformPointForObject(benzene, benzene.atoms[0]);
  return { x: atom.x, y: atom.y + 12 };
};
const farFromEveryAtom = () => ({ x: 720, y: 60 });

describe.each(["macos", "windows"] as const)("Rotate molecule with the molecule's own marks (%s)", platform => {
  const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
  let container: HTMLDivElement;
  let root: Root;
  const pointerMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  const pointerDescriptors = pointerMethods.map(method => Object.getOwnPropertyDescriptor(Element.prototype, method));
  beforeEach(() => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
    for (const method of pointerMethods) {
      Object.defineProperty(Element.prototype, method, { configurable: true,
        value: method === "hasPointerCapture" ? () => false : () => {} });
    }
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform); else Reflect.deleteProperty(navigator, "platform");
    delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    pointerMethods.forEach((method, index) => {
      const descriptor = pointerDescriptors[index];
      if (descriptor) Object.defineProperty(Element.prototype, method, descriptor);
      else Reflect.deleteProperty(Element.prototype, method);
    });
  });
  async function mount(doc: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden",
      initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false, shortcutPlatform: platform
    })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({})
    });
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const objectById = <T>(id: string) => snapshot().pages[0].objects.find(object => object.id === id) as T;
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  const angleInput = () => container.querySelector<HTMLInputElement>('[aria-label="Z rotation degrees"]');
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  async function rightClickMolecule(moleculeId: string) {
    const molecule = objectById<MoleculeObject>(moleculeId);
    const atom = molecule.atoms[0];
    const scale = (window.__CHEMDRAFT_AGENT__!.snapshot().viewport as { scale: number }).scale;
    await act(async () => container.querySelector(`.native-molecule-object[data-object-id="${moleculeId}"]`)!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,
        button: 2, clientX: atom.x * scale, clientY: atom.y * scale })));
  }
  async function angle(degrees: string) {
    const input = angleInput()!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, degrees);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function keep() {
    await act(async () => container.querySelector("[data-rotation-input-popover]")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  }

  it.each(markCases)("right-click on a molecule carrying its own %s mark offers Rotate molecule", async (_name, spec) => {
    const { document, moleculeId, markId } = markedDrawing(spec);
    await mount(document);
    await rightClickMolecule(moleculeId);
    // The right-click keeps the molecule and its mark selected (the reported state).
    expect(new Set(snapshot().selection.objectIds)).toEqual(new Set([moleculeId, markId]));
    const item = container.querySelector('[data-command-id="layout.rotateMolecule"]');
    expect(item).not.toBeNull();
    await act(async () => item!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(angleInput()).not.toBeNull();
  });

  it.each(markCases)("Select All on a molecule carrying its own %s mark enables Rotate molecule", async (_name, spec) => {
    const { document, moleculeId, markId } = markedDrawing(spec, "none");
    await mount(document);
    await command("edit.selectAll");
    expect(new Set(snapshot().selection.objectIds)).toEqual(new Set([moleculeId, markId]));
    expect(rotateAction(snapshot())).toMatchObject({ enabled: true, disabledReason: undefined });
    await command("layout.rotateMolecule");
    expect(angleInput()).not.toBeNull();
    expect(status()).toBe("Z rotation entry");
  });

  it.each(markCases)("rotates the %s mark rigidly with its atom, keeps the chemistry, and undoes in one step", async (_name, spec) => {
    const { document, moleculeId, markId } = markedDrawing(spec);
    await mount(document);
    const before = snapshot();
    const moleculeBefore = objectById<MoleculeObject>(moleculeId), markBefore = objectById<ElectronMarkObject>(markId);
    await command("layout.rotateMolecule");
    await angle("90");
    await keep();
    const after = snapshot();
    const moleculeAfter = objectById<MoleculeObject>(moleculeId), markAfter = objectById<ElectronMarkObject>(markId);

    // The molecule turned by 90° as one rigid piece.
    const atomPoint = (molecule: MoleculeObject, atomId: string) =>
      transformPointForObject(molecule, molecule.atoms.find(atom => atom.id === atomId)!);
    const [a0, a1] = [moleculeBefore.atoms[0].id, moleculeBefore.atoms[1].id];
    const direction = (molecule: MoleculeObject) => {
      const p = atomPoint(molecule, a0), q = atomPoint(molecule, a1);
      return Math.atan2(q.y - p.y, q.x - p.x);
    };
    const turn = direction(moleculeAfter) - direction(moleculeBefore);
    expect(((turn * 180 / Math.PI - 90) % 360 + 540) % 360 - 180).toBeCloseTo(0, 6);

    // The mark stays linked to the same atom, and its offset from that atom turned by the same angle.
    expect(markAfter.anchor).toEqual(markBefore.anchor);
    const atomId = markBefore.anchor.atomId!;
    const offset = (molecule: MoleculeObject, mark: ElectronMarkObject) => {
      const center = workflow.nativeChargeMarkCenter(mark), atom = atomPoint(molecule, atomId);
      return { x: center.x - atom.x, y: center.y - atom.y };
    };
    const o0 = offset(moleculeBefore, markBefore), o1 = offset(moleculeAfter, markAfter);
    expect(Math.hypot(o0.x, o0.y)).toBeGreaterThan(1);
    expect(o1.x).toBeCloseTo(o0.x * Math.cos(turn) - o0.y * Math.sin(turn), 4);
    expect(o1.y).toBeCloseTo(o0.x * Math.sin(turn) + o0.y * Math.cos(turn), 4);
    // The mark's own angle (a lone pair's orientation) turns with it; its size is unchanged.
    expect(((markAfter.rotation - markBefore.rotation - 90) % 360 + 540) % 360 - 180).toBeCloseTo(0, 4);
    expect([markAfter.width, markAfter.height]).toEqual([markBefore.width, markBefore.height]);

    // Chemistry is unchanged: canonical SMILES, total charge, every atom's charge and radicals.
    const canonical = (molecule: MoleculeObject) => Molecule.fromMolfile(stereoPerceptionMolfile(molecule)).toIsomericSmiles();
    expect(canonical(moleculeAfter)).toBe(canonical(moleculeBefore));
    expect(moleculeAfter.chemistry).toEqual(moleculeBefore.chemistry);
    expect(moleculeAfter.atoms.map(({ x, y, ...atom }) => atom)).toEqual(moleculeBefore.atoms.map(({ x, y, ...atom }) => atom));
    expect(moleculeAfter.bonds).toEqual(moleculeBefore.bonds);
    expect({ markKind: markAfter.markKind, charge: markAfter.charge, radical: markAfter.radical })
      .toEqual({ markKind: markBefore.markKind, charge: markBefore.charge, radical: markBefore.radical });
    expect(after.pages[0].objects.map(object => object.id)).toEqual(before.pages[0].objects.map(object => object.id));
    expect(new Set(after.selection.objectIds)).toEqual(new Set([moleculeId, markId]));

    // One undo restores the molecule and its mark exactly; one redo brings the rotation back.
    await command("edit.undo");
    expect(snapshot().pages[0].objects).toEqual(before.pages[0].objects);
    expect(status()).toBe("Undid Rotate molecule");
    await command("edit.redo");
    expect(snapshot().pages[0].objects).toEqual(after.pages[0].objects);
  });

  it("cancels the rotation entry and leaves the molecule and its mark as they were", async () => {
    const { document, moleculeId } = markedDrawing({ kind: "charge", charge: 1 });
    await mount(document);
    const before = snapshot().pages[0].objects;
    await command("layout.rotateMolecule");
    await angle("47");
    expect(objectById<MoleculeObject>(moleculeId).atoms).not.toEqual((before.find(o => o.id === moleculeId) as MoleculeObject).atoms);
    await act(async () => container.querySelector('[aria-label="Cancel rotation entry"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(snapshot().pages[0].objects).toEqual(before);
  });

  /** The marked glycine plus a benzene, a text and an arrow, none of them related to the glycine's mark. */
  function crowdedDrawing() {
    const { document: marked, moleculeId, markId } = markedDrawing({ kind: "charge", charge: 1 });
    const pageId = marked.pages[0].id;
    const second = workflow.createNativeTemplateMolecule(marked, { x: 500, y: 450 }, "benzene");
    const text = workflow.createNativeTextObject(marked, { x: 420, y: 120 }, "label");
    const arrow = workflow.createNativeReactionArrow(marked, { x: 400, y: 300 }, { x: 480, y: 300 }, "forward");
    const document = applyPatches(marked, [second, text, arrow].map(object => ({ op: "addObject", pageId, object } as const)),
      { now: phase4Timestamp });
    const select = (ids: string[]) => workflow.selectDocumentObjects(document, pageId, ids);
    return { select, moleculeId, markId, secondId: second.id, textId: text.id, arrowId: arrow.id };
  }

  it("still refuses two molecules, and a molecule with an unrelated text, arrow or another molecule's mark", async () => {
    const { select, moleculeId, markId, secondId, textId, arrowId } = crowdedDrawing();
    const refusals = [
      [moleculeId, secondId],
      [moleculeId, markId, secondId],
      [moleculeId, textId],
      [moleculeId, markId, textId],
      [moleculeId, arrowId],
      [moleculeId, markId, arrowId],
      // Another molecule's mark: the benzene cannot carry the glycine N's charge.
      [secondId, markId],
      [markId]
    ];
    for (const ids of refusals) {
      expect(rotateAction(select(ids)), ids.join(",")).toMatchObject({ enabled: false, disabledReason: "Select one whole molecule with editable atoms" });
    }

    // In the window: the menu item is absent and the command refuses, with the reason it gave before.
    for (const ids of [[moleculeId, markId, secondId], [moleculeId, markId, textId]]) {
      await act(async () => root.unmount());
      delete window.__CHEMDRAFT_AGENT__;
      root = createRoot(container);
      await mount(select(ids));
      await rightClickMolecule(moleculeId);
      expect(new Set(snapshot().selection.objectIds)).toEqual(new Set(ids));
      expect(container.querySelector('[data-command-id="layout.rotateMolecule"]')).toBeNull();
      await command("layout.rotateMolecule");
      expect(angleInput()).toBeNull();
      expect(status()).toBe("Command failed: Select one whole molecule with editable atoms");
    }
  });

  it("enables rotation for the same drawing when only the molecule and its own mark are selected", () => {
    const { select, moleculeId, markId } = crowdedDrawing();
    expect(rotateAction(select([moleculeId, markId]))).toMatchObject({ enabled: true, disabledReason: undefined });
    expect(rotateAction(select([markId, moleculeId]))).toMatchObject({ enabled: true, disabledReason: undefined });
  });
  it.each(markCases.slice(0, 2))("a stale non-explicit %s anchor follows the mark's real owner, as the rotation does", async (_name, spec) => {
    const { select, moleculeId, markId, benzeneId, owner } = staleAnchorDrawing(spec, nearBenzeneAtom);
    // The committed resolver gives the mark to the benzene atom it sits on, not to A's N.
    expect(owner?.objectId).toBe(benzeneId);
    // A plus the mark: the rotation of A would leave the mark behind, so it is refused.
    expect(rotateAction(select([moleculeId, markId]))).toMatchObject(REFUSED);
    // B plus the mark: the rotation of B carries it, so it is admitted.
    expect(rotateAction(select([benzeneId, markId]))).toMatchObject(ADMITTED);
    expect(rotateAction(select([markId, benzeneId]))).toMatchObject(ADMITTED);

    // In the window, A plus the mark: the command refuses with no angle box.
    await mount(select([moleculeId, markId]));
    await command("layout.rotateMolecule");
    expect(angleInput()).toBeNull();
    expect(status()).toBe("Command failed: Select one whole molecule with editable atoms");

    // B plus the mark: B turns 90° and the mark turns rigidly about its owner atom.
    await act(async () => root.unmount());
    delete window.__CHEMDRAFT_AGENT__;
    root = createRoot(container);
    await mount(select([benzeneId, markId]));
    const benzeneBefore = objectById<MoleculeObject>(benzeneId), markBefore = objectById<ElectronMarkObject>(markId);
    const glycineBefore = objectById<MoleculeObject>(moleculeId);
    await command("layout.rotateMolecule");
    await angle("90");
    await keep();
    const benzeneAfter = objectById<MoleculeObject>(benzeneId), markAfter = objectById<ElectronMarkObject>(markId);
    const atomPoint = (molecule: MoleculeObject) => transformPointForObject(molecule, molecule.atoms.find(atom => atom.id === owner!.atomId)!);
    const offset = (molecule: MoleculeObject, mark: ElectronMarkObject) => {
      const center = workflow.nativeChargeMarkCenter(mark), atom = atomPoint(molecule);
      return { x: center.x - atom.x, y: center.y - atom.y };
    };
    const o0 = offset(benzeneBefore, markBefore), o1 = offset(benzeneAfter, markAfter);
    expect(Math.hypot(o0.x, o0.y)).toBeGreaterThan(1);
    expect(o1.x).toBeCloseTo(-o0.y, 4);
    expect(o1.y).toBeCloseTo(o0.x, 4);
    // Carried, it is linked to the atom it belonged to; A is untouched.
    expect(markAfter.anchor).toEqual({ kind: "atom", objectId: benzeneId, atomId: owner!.atomId });
    expect({ markKind: markAfter.markKind, charge: markAfter.charge, radical: markAfter.radical })
      .toEqual({ markKind: markBefore.markKind, charge: markBefore.charge, radical: markBefore.radical });
    expect(objectById<MoleculeObject>(moleculeId).atoms).toEqual(glycineBefore.atoms);
  });

  it.each(markCases.slice(0, 2))("refuses a molecule with a floating %s mark still anchored to it", (_name, spec) => {
    const { select, moleculeId, markId, benzeneId, owner } = staleAnchorDrawing(spec, farFromEveryAtom);
    expect(owner).toBeUndefined();
    expect(rotateAction(select([moleculeId, markId]))).toMatchObject(REFUSED);
    expect(rotateAction(select([benzeneId, markId]))).toMatchObject(REFUSED);
  });

  it.each(markCases)("refuses an explicit %s anchor that names a missing atom", (_name, spec) => {
    const { document, moleculeId, markId } = markedDrawing(spec, "none");
    const pageId = document.pages[0].id;
    const missing = applyPatch(document, { op: "updateObject", objectId: markId, changes: {
      anchor: { kind: "atom", objectId: moleculeId, atomId: "no_such_atom" }, atomAssociation: "explicit" } },
    { now: phase4Timestamp });
    expect(rotateAction(workflow.selectDocumentObjects(missing, pageId, [moleculeId, markId]))).toMatchObject(REFUSED);
    // The molecule alone still rotates.
    expect(rotateAction(workflow.selectDocumentObjects(missing, pageId, [moleculeId]))).toMatchObject(ADMITTED);
  });

  it("opens the angle box on the molecule's own frame, not the group frame that includes the mark", async () => {
    // An explicitly linked mark far from its atom makes the molecule frame and the group frame differ.
    const { document: distant } = distantAttachedElectronMarkFixture();
    const molecule = distant.pages[0].objects.find(object => object.type === "molecule") as MoleculeObject;
    const mark = distant.pages[0].objects.find(object => object.type === "electron-mark") as ElectronMarkObject;
    const document = workflow.selectDocumentObjects(distant, distant.pages[0].id, [molecule.id, mark.id]);
    expect(rotateAction(document)).toMatchObject(ADMITTED);
    await mount(document);
    await command("layout.rotateMolecule");
    expect(angleInput()).not.toBeNull();
    const layers = container.querySelectorAll<HTMLElement>(".object-transform-input-layer");
    expect(layers).toHaveLength(1);
    const px = (value: string) => Number(/^calc\((-?[\d.e+-]+)px \* var\(--page-scale\)\)$/.exec(value)?.[1]);
    const shown = { x: px(layers[0].style.left), y: px(layers[0].style.top),
      width: px(layers[0].style.width), height: px(layers[0].style.height) };

    // The molecule's transform frame (as `moleculeTransformFrameForSelection` builds it for a whole
    // molecule): its selection bounds relative to the molecule, at least 28 on each side, centred.
    const bounds = moleculeSelectionBounds(molecule);
    const width = Math.max(bounds.width, 28), height = Math.max(bounds.height, 28);
    const expected = { x: bounds.x - molecule.x + bounds.width / 2 - width / 2,
      y: bounds.y - molecule.y + bounds.height / 2 - height / 2, width, height };
    expect(shown.x).toBeCloseTo(expected.x, 6);
    expect(shown.y).toBeCloseTo(expected.y, 6);
    expect(shown.width).toBeCloseTo(expected.width, 6);
    expect(shown.height).toBeCloseTo(expected.height, 6);
    // The mark lies outside that frame, so a frame grown to the group's bounds would fail above.
    const center = workflow.nativeChargeMarkCenter(mark);
    expect(center.x > molecule.x + expected.x + expected.width || center.y > molecule.y + expected.y + expected.height).toBe(true);

    // The same frame the molecule alone opens its angle box on.
    await act(async () => root.unmount());
    delete window.__CHEMDRAFT_AGENT__;
    root = createRoot(container);
    await mount(workflow.selectDocumentObjects(distant, distant.pages[0].id, [molecule.id]));
    await command("layout.rotateMolecule");
    const alone = container.querySelector<HTMLElement>(".object-transform-input-layer")!;
    expect([alone.style.left, alone.style.top, alone.style.width, alone.style.height])
      .toEqual([layers[0].style.left, layers[0].style.top, layers[0].style.width, layers[0].style.height]);
  });
});

// 3D clean-up (and the engine pass of 2D Clean Up) carries the cleaned molecule's marks with its
// atoms (`carriedElectronMarkPatches`). A mark whose stale non-explicit anchor still names A but which
// the committed resolver gives to benzene B belongs to B, as it does for Rotate Molecule: cleaning up
// A must leave it on B. Captured by its stored anchor, it was re-anchored explicitly to A's N, and
// the commit funnel's chemistry guard refused the clean-up as a charge moved from B to A. Opened
// files keep stored marks (`preserveElectronMarks`), which is how this state reaches the window.
describe("clean-up of A with a stale-anchored mark that B owns", () => {
  it.each(markCases.slice(0, 2))("leaves the %s mark on B and passes the commit chemistry guard", (_name, spec) => {
    const stale = staleAnchorDrawing(spec, nearBenzeneAtom);
    expect(stale.owner?.objectId).toBe(stale.benzeneId);
    // Bend A so the clean-up has something to fix; the stored marks are kept as an opened file keeps them.
    const glycine = stale.document.pages[0].objects.find(object => object.id === stale.moleculeId) as MoleculeObject;
    const before = workflow.normalizeCommittedDocument(applyPatch(stale.document, { op: "updateObject", objectId: glycine.id,
      changes: { atoms: glycine.atoms.map((atom, index) => ({ ...atom, x: atom.x + (index % 3) * 7, y: atom.y - (index % 2) * 9 })) } },
    { now: phase4Timestamp }), { preserveElectronMarks: true });
    const markBefore = before.pages[0].objects.find(object => object.id === stale.markId) as ElectronMarkObject;
    expect(markBefore.anchor).toMatchObject({ kind: "atom", objectId: stale.moleculeId });
    expect(markBefore.atomAssociation).toBeUndefined();

    const next = workflow.applyNativeMoleculeEngineRelayout(before, stale.moleculeId, relayoutMolfile2D, { warnings: [] });
    // The commit funnel (`prepareDocumentCommit`): marks follow moved atoms, then commit normalization.
    const after = workflow.normalizeCommittedDocument(workflow.carryElectronMarksWithMovedAtoms(before, next, PRESERVE_CHEMISTRY));
    const cleanedA = after.pages[0].objects.find(object => object.id === stale.moleculeId) as MoleculeObject;
    expect(cleanedA.atoms.map(atom => [atom.x, atom.y])).not.toEqual(
      (before.pages[0].objects.find(object => object.id === stale.moleculeId) as MoleculeObject).atoms.map(atom => [atom.x, atom.y]));
    // The commit funnel's check, as `commitChemistryRefusal` runs it for 3D clean-up.
    expect(policyChemistryRefusals(PRESERVE_CHEMISTRY, { before, next, after,
      normalize: workflow.committedNormalForm, markAtoms: workflow.committedElectronMarkAtoms })).toEqual([]);
    // The mark is B's: the clean-up of A neither moves it nor re-anchors it.
    const markNext = next.pages[0].objects.find(object => object.id === stale.markId) as ElectronMarkObject;
    expect(markNext).toEqual(markBefore);
    expect(workflow.committedElectronMarkAssignments(after.pages[0]).anchorByMarkId.get(stale.markId)).toEqual(stale.owner);
  });
});

// Review claim (1.2.3): a mark lying outside its stored anchor's association radius is moved onto the
// stored atom by the carry, a silent charge move. Clean-up carries only owned marks (above), so the
// floating mark is not touched; the Spin 3D rule (`spin3dCarriedElectronMarks`, flatten and its
// overlay) still prefers the stored anchor, so this checks what the carry does with it and whether
// the commit funnel's chemistry guard refuses the edit when it does.
describe("a floating mark still anchored to A, outside every association radius", () => {
  it.each(markCases.slice(0, 2))("%s: clean-up leaves it; a Spin 3D carry of it is caught by the chemistry guard", (_name, spec) => {
    const stale = staleAnchorDrawing(spec, farFromEveryAtom);
    expect(stale.owner).toBeUndefined();
    const before = stale.document;
    const page = before.pages[0];
    const glycine = page.objects.find(object => object.id === stale.moleculeId) as MoleculeObject;
    const markBefore = page.objects.find(object => object.id === stale.markId) as ElectronMarkObject;
    const guard = (next: ChemDraftDocument) => policyChemistryRefusals(PRESERVE_CHEMISTRY, { before, next,
      after: workflow.normalizeCommittedDocument(workflow.carryElectronMarksWithMovedAtoms(before, next, PRESERVE_CHEMISTRY)),
      normalize: workflow.committedNormalForm, markAtoms: workflow.committedElectronMarkAtoms });

    // Clean-up (the committed owner rule): the floating mark is not carried, and the edit commits.
    const cleaned = workflow.applyNativeMoleculeEngineRelayout(before, stale.moleculeId, relayoutMolfile2D, { warnings: [] });
    expect(cleaned.pages[0].objects.find(object => object.id === stale.markId)).toEqual(markBefore);
    expect(guard(cleaned)).toEqual([]);

    // The Spin 3D rule carries it by its stored anchor: redraw A shifted and see where it goes.
    const redrawn = { ...glycine, atoms: glycine.atoms.map(atom => ({ ...atom, x: atom.x + 15, y: atom.y + 10 })) };
    const patches = workflow.carriedElectronMarkPatches(page, glycine, redrawn);
    expect(patches.map(patch => patch.op === "updateObject" && patch.objectId)).toEqual([stale.markId]);
    const next = applyPatches(before, [{ op: "updateObject", objectId: glycine.id, changes: { atoms: redrawn.atoms } }, ...patches],
      { now: phase4Timestamp });
    const carried = next.pages[0].objects.find(object => object.id === stale.markId) as ElectronMarkObject;
    // It is made explicit on A's atom, so it would put its charge or radical there: the guard refuses.
    expect(carried.atomAssociation).toBe("explicit");
    expect(guard(next).length).toBeGreaterThan(0);
  });
});

// Review claim (1.2.3, reported for 1.2.4): when a redraw leaves a mark's atom where it was but puts
// a bond over the mark, the carry turns the mark to a clear side, and then the commit funnel's
// `followElectronMarksWithMovedAtoms` restores every mark of a STATIONARY atom to its stored spot,
// over the bond. Pinned as observed; 7f2322bb0 had the same restore (and its flatten kept the offset
// with no clear-side turn at all), so this is not a regression of 1.2.3.
describe("a stationary atom's carried mark under the commit funnel", () => {
  it("is put back over the bond that the redraw laid across it (known, 1.2.4)", () => {
    const { document } = markedDrawing({ kind: "charge", charge: 1 }, "none");
    const page = document.pages[0];
    const molecule = page.objects.find(object => object.type === "molecule") as MoleculeObject;
    const mark = page.objects.find(object => object.type === "electron-mark") as ElectronMarkObject;
    const atomId = (mark.anchor as { atomId: string }).atomId;
    const atom = molecule.atoms.find(candidate => candidate.id === atomId)!;
    const bond = molecule.bonds.find(candidate => candidate.fromAtomId === atomId || candidate.toAtomId === atomId)!;
    const neighborId = bond.fromAtomId === atomId ? bond.toAtomId : bond.fromAtomId;
    // Lay the neighbor along the atom -> mark direction, so the bond runs through the mark.
    const center = workflow.nativeChargeMarkCenter(mark), atomPoint = transformPointForObject(molecule, atom);
    const dx = center.x - atomPoint.x, dy = center.y - atomPoint.y, length = Math.hypot(dx, dy);
    const neighbor = molecule.atoms.find(candidate => candidate.id === neighborId)!;
    const scale = 40 / length;
    const redrawn = { ...molecule, atoms: molecule.atoms.map(candidate => candidate.id === neighborId
      ? { ...candidate, x: atom.x + dx * scale, y: atom.y + dy * scale } : candidate) };
    expect(redrawn.atoms.find(candidate => candidate.id === neighborId)).not.toEqual(neighbor);
    const patches = workflow.carriedElectronMarkPatches(page, molecule, redrawn);
    const next = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: { atoms: redrawn.atoms } }, ...patches],
      { now: phase4Timestamp });
    const placed = next.pages[0].objects.find(object => object.id === mark.id) as ElectronMarkObject;
    // The carry turned the mark off the bond...
    expect([placed.x, placed.y]).not.toEqual([mark.x, mark.y]);
    // ...and the funnel restores the stationary atom's mark to its old spot, now on the bond.
    const followed = workflow.carryElectronMarksWithMovedAtoms(document, next, PRESERVE_CHEMISTRY);
    const committed = followed.pages[0].objects.find(object => object.id === mark.id) as ElectronMarkObject;
    expect([committed.x, committed.y]).toEqual([mark.x, mark.y]);
  });
});
