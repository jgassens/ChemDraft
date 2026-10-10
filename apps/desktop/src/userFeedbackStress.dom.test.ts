// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Molecule } from "openchemlib";
import {
  applyPatches, deserializeDocument, moleculeToMolfileV2000, serializeDocument,
  type ChemDraftDocument, type MoleculeObject, type Point, type ViewMatrix
} from "@chemdraft/chem-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "@chemdraft/cdx-compat";
import { nativeBondLengthPx, nativeBondOrderResolution } from "@chemdraft/document-workflow-core";
import { MainWindow, nativeTemplateStatusForApplication, rotationDeltaDegrees, visualSelectionBounds } from "./MainWindow";
import {
  applyNativeTemplatePlacementPlan, createPhase4Document, createSelectionClipboardPayload,
  flattenSpunMolecule, insertNativeArtGraphicObject, insertNativeSingleBondMolecule,
  insertNativeTemplateMolecule, insertNativeTextObject, parseSelectionClipboardPayload,
  pasteSelectionClipboardPayload, planNativeTemplatePlacement, rotateDocumentObjectsAroundPoint,
  rotateDocumentObject, nativeMoleculeCenter, nativeMoleculeTransformState,
  selectDocumentObjects, serializeSelectionClipboardPayload
} from "./documentWorkflow";
import { convertTextToAtomLabelCommandId, moleculeDoubleBondPositionCommandId } from "./commands";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { saveKeybindingSettings } from "./keybindingSettings";
import { snapRotationDegrees } from "./rotationSnap";
import { DOM_COMMAND_EVENT } from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const IDENTITY: ViewMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

function molecules(doc: ChemDraftDocument) {
  return doc.pages[0].objects.filter((o): o is MoleculeObject => o.type === "molecule");
}
function canonical(mol: MoleculeObject) {
  return Molecule.fromMolfile(moleculeToMolfileV2000(mol, {
    fromDocFrame: true, kekuleBondOrders: nativeBondOrderResolution(mol.atoms, mol.bonds).kekuleOrders
  }).contents).toIsomericSmiles();
}
function mixedBondDocument() {
  const mol: MoleculeObject = {
    id: "mixed-polyene", type: "molecule", x: 100, y: 160, width: 360, height: 40,
    rotation: 0, style: {}, structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
    atoms: Array.from({ length: 16 }, (_, i) => ({
      id: `a${i}`, element: "C", x: 100 + i * 24, y: 160 + (i % 2) * 12, formalCharge: 0
    })),
    bonds: Array.from({ length: 15 }, (_, i) => ({
      id: `b${i}`, fromAtomId: `a${i}`, toAtomId: `a${i + 1}`, order: i % 2 ? "single" : "double",
      ...(!(i % 2) && i !== 6 ? { display: { doubleBondSide: (["center", "left", "center", "right"] as const)[(i / 2) % 4] } } : {})
    }))
  };
  const doc = createPhase4Document("Feedback stress");
  return applyPatches(doc, [{ op: "addObject", pageId: doc.pages[0].id, object: mol },
    { op: "setSelection", pageId: doc.pages[0].id, objectIds: [mol.id] }]);
}

function saturatedMolecule(original: MoleculeObject): MoleculeObject {
  const atom = original.atoms[0];
  return { ...original, structure: "CC(C)(C)C", atoms: [atom, ...Array.from({ length: 4 }, (_, i) => ({
    id: `sat${i}`, element: "C", x: atom.x + Math.cos(i * Math.PI / 2) * 24,
    y: atom.y + Math.sin(i * Math.PI / 2) * 24, formalCharge: 0
  }))], bonds: Array.from({ length: 4 }, (_, i) => ({
    id: `satb${i}`, fromAtomId: atom.id, toAtomId: `sat${i}`, order: "single"
  })) };
}

describe("user feedback app stress", () => {
  let container: HTMLDivElement;
  let root: Root;
  let renderKey = 0;
  const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let captureDescriptors: Array<PropertyDescriptor | undefined>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    captureDescriptors = captureMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    for (const name of captureMethods) Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true, value: name === "hasPointerCapture" ? () => false : () => {}
    });
    saveKeybindingSettings({ scheme: "chemdraft" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    captureMethods.forEach((name, i) => {
      const descriptor = captureDescriptors[i];
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    });
    window.history.replaceState(null, "", "/");
    Reflect.deleteProperty(navigator, "platform"); delete window.__CHEMDRAFT_AGENT__;
  });
  function platform(value: ShortcutPlatform) {
    Object.defineProperty(navigator, "platform", { configurable: true, value: value === "macos" ? "MacIntel" : "Win32" });
  }
  async function mount(doc: ChemDraftDocument, tool = "tool.select") {
    await act(async () => root.render(createElement(MainWindow, {
      key: ++renderKey, initialDocument: doc, initialActiveToolCommandId: tool,
      initialCrosshairsVisible: false, initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const e of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) e.getBoundingClientRect = () => rect;
    await act(async () => { await Promise.resolve(); });
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const current = () => snapshot().document;
  const page = () => container.querySelector<HTMLElement>(".page")!;
  const status = () => container.querySelector('[role="status"]')?.textContent;
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function pointer(type: string, point: Point, target: Element = page(), shiftKey = false, id = 7, buttons = type === "pointerdown" ? 1 : 0) {
    await act(async () => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons,
        clientX: point.x, clientY: point.y, shiftKey });
      Object.defineProperties(e, { pointerId: { value: id }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      target.dispatchEvent(e);
    });
  }
  async function key(key: string, init: KeyboardEventInit = {}) {
    const target = document.activeElement ?? document.body;
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    await act(async () => { target.dispatchEvent(e); });
    // jsdom has no native text-editing default; reproduce it only after an unconsumed real key.
    if (!e.defaultPrevented && target instanceof HTMLInputElement && (key.length === 1 || key === "Backspace" || key === "Delete")) {
      const start = target.selectionStart ?? target.value.length, end = target.selectionEnd ?? start;
      const from = key === "Backspace" && start === end ? Math.max(0, start - 1) : start;
      const to = key === "Delete" && start === end ? end + 1 : end;
      const insertion = key.length === 1 ? key : "";
      await input(target, target.value.slice(0, from) + insertion + target.value.slice(to));
      target.setSelectionRange(from + insertion.length, from + insertion.length);
    }
  }
  async function input(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
      const prototype = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(target, value);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const editor = () => container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
  function report(name: string, started: number, counts: string) {
    const elapsed = performance.now() - started;
    console.info(`[stress ${name}] ${counts} ms=${elapsed.toFixed(1)} PASS`);
  }

  it("A1-4: preserves mixed double-bond sides and canonical chemistry through CDXML, clipboard, native reopen and placed flatten", () => {
    const started = performance.now(), doc = mixedBondDocument(), mol = molecules(doc)[0];
    const sides = (m: MoleculeObject) => m.bonds.map(b => b.display?.doubleBondSide);
    const exported = exportDocumentToCdxml(doc);
    const native = openChemDraftPayload(exported.contents).document!;
    // Strip the native envelope too, so the CDXML test cannot pass by restoring hidden JSON.
    const visible = openChemDraftPayload(exported.contents.replace(/<objecttag Name="org\.chemdraft\/[^>]*\/>/g, "")).document!;
    const payload = parseSelectionClipboardPayload(serializeSelectionClipboardPayload(createSelectionClipboardPayload(doc)!))!;
    const pasted = pasteSelectionClipboardPayload(createPhase4Document("Paste"), payload, { x: 300, y: 300 });
    const reopened = deserializeDocument(serializeDocument(doc));
    for (const result of [native, visible, pasted, reopened]) {
      expect(sides(molecules(result)[0])).toEqual(sides(mol));
      expect(canonical(molecules(result)[0])).toBe(canonical(mol));
    }
    const coords = mol.atoms.flatMap((a, i) => [i * 1.2, i % 2 ? 0.6 : 0, i % 3 * 0.1]);
    const flattened = flattenSpunMolecule(doc, mol.id, coords, IDENTITY, { placement: { centerX: 300, centerY: 300, scale: 24 } });
    expect(flattened.status).toBe("committed");
    const next = molecules(flattened.document)[0];
    for (const bond of mol.bonds.filter(b => b.display?.doubleBondSide === "center")) {
      expect(next.bonds.find(b => b.id === bond.id)?.display?.doubleBondSide).toBe("center");
    }
    expect(canonical(next)).toBe(canonical(mol));
    report("A1-4", started, "atoms=16 doubleBonds=8 center=4 paths=5");
  });

  it.each(["macos", "windows"] as const)("A5: 20 whole-molecule Center/undo/redo cycles end exactly (%s)", async p => {
    platform(p); const doc = mixedBondDocument(); await mount(doc);
    const before = molecules(current())[0], started = performance.now();
    await command(moleculeDoubleBondPositionCommandId("center"));
    const centered = molecules(current())[0];
    expect(centered.bonds.filter(b => b.order === "double").every(b => b.display?.doubleBondSide === "center")).toBe(true);
    for (let i = 0; i < 20; i++) {
      await key("z", p === "macos" ? { metaKey: true } : { ctrlKey: true });
      expect(molecules(current())[0]).toEqual(before);
      await key(p === "macos" ? "z" : "y", p === "macos" ? { metaKey: true, shiftKey: true } : { ctrlKey: true });
      expect(molecules(current())[0]).toEqual(centered);
      await command(moleculeDoubleBondPositionCommandId("center")); // idempotent Center must add no history.
    }
    expect(canonical(centered)).toBe(canonical(before));
    report(`A5 ${p}`, started, "cycles=20 commands=61 exactStates=40");
  }, 120000);

  it.each(["macos", "windows"] as const)("B: 50 seeded rotate drags match their previews and undo exactly, grouped and ungrouped (%s)", async p => {
    platform(p);
    let doc = mixedBondDocument();
    doc = insertNativeTemplateMolecule(doc, { x: 240, y: 320 }, "benzene");
    doc = insertNativeArtGraphicObject(doc, { x: 440, y: 340 }, "tool.art.rect");
    doc = selectDocumentObjects(doc, doc.pages[0].id, doc.pages[0].objects.map(o => o.id));
    await mount(doc); const started = performance.now();
    let seed = 0xabc123;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 50; i++) {
      if (i === 25) await command("layout.group");
      const before = current(), ids = before.selection.objectIds;
      const bounds = visualSelectionBounds(before.pages[0].objects, ids)!;
      await key("Shift");
      const handle = container.querySelector<HTMLElement>('[data-group-rotate-handle="true"], [data-selection-rotate-handle="true"]')!;
      expect(handle).not.toBeNull();
      const center = { x: bounds.centerX, y: bounds.centerY }, start = { x: center.x, y: bounds.y - 30 };
      await pointer("pointerdown", start, handle, random() > 0.5);
      let degrees = 0, shift = false, latest = start;
      for (let step = 0; step < 3; step++) {
        shift = random() > 0.5;
        do {
          degrees = random() * 320 - 160;
          const radius = center.y - start.y, radians = degrees * Math.PI / 180;
          latest = { x: center.x + radius * Math.sin(radians), y: center.y - radius * Math.cos(radians) };
          // A snapped zero is intentionally not a history entry. Require a real final rotation.
        } while (step === 2 && Math.abs(snapRotationDegrees(rotationDeltaDegrees(center, start, latest), { shiftKey: shift })) < 1);
        await pointer("pointermove", latest, page(), shift, 7, 1);
      }
      const preview = current();
      // Group/multi-selection frames are axis-aligned and have no persistent orientation.
      const expected = rotateDocumentObjectsAroundPoint(before, ids, center, snapRotationDegrees(rotationDeltaDegrees(center, start, latest), { shiftKey: shift, referenceDegrees: 0 }));
      expect(preview.pages[0].objects).toEqual(expected.pages[0].objects);
      // A release at another point/with another modifier must retain the last shown preview.
      await pointer("pointerup", { x: start.x + 3, y: start.y + 4 }, page(), !shift);
      expect(current().pages[0].objects).toEqual(preview.pages[0].objects);
      for (const [j, mol] of molecules(current()).entries()) {
        expect(canonical(mol)).toBe(canonical(molecules(before)[j]));
        expect(mol.bonds).toEqual(molecules(before)[j].bonds);
      }
      await command("edit.undo");
      expect(current().pages[0].objects).toEqual(before.pages[0].objects);
    }
    await command("layout.ungroup");
    report(`B ${p}`, started, "drags=50 grouped=25 ungrouped=25 moves=150 undo=50");
  }, 120000);

  it.each(["macos", "windows"] as const)("B: individual molecules and art snap absolute orientations (%s)", async p => {
    platform(p);
    for (const kind of ["molecule", "art"] as const) {
      let doc = createPhase4Document("Absolute rotation stress");
      doc = kind === "molecule"
        ? insertNativeTemplateMolecule(doc, { x: 240, y: 320 }, "benzene")
        : insertNativeArtGraphicObject(doc, { x: 440, y: 340 }, "tool.art.rect");
      const id = doc.pages[0].objects[0].id;
      doc = rotateDocumentObject(doc, id, kind === "molecule" ? 7 : 100);
      await mount(doc);
      await key("Shift");
      for (const [i, delta] of [6, 15, 22, 37, -7, 4].entries()) {
        for (const shift of [false, true]) {
          const before = current();
          const object = before.pages[0].objects[0];
          const reference = object.type === "molecule" ? nativeMoleculeTransformState(object).rotationDegrees : object.rotation;
          const center = object.type === "molecule" ? nativeMoleculeCenter(object)
            : { x: object.x + object.width / 2, y: object.y + object.height / 2 };
          // Distinct grab locations avoid interpreting consecutive drags as a double click.
          const start = { x: center.x + 100 + i * 60 + (shift ? 30 : 0), y: center.y };
          const end = { x: start.x, y: start.y + delta };
          const absolute = reference + delta;
          const nearest = Math.round(absolute / 15) * 15;
          const snapped = shift || Math.abs(nearest - absolute) <= 3 ? nearest : absolute;
          const expected = rotateDocumentObject(before, id, snapped - reference);
          const handle = container.querySelector<HTMLElement>(".object-rotate-handle")!;
          expect(handle).not.toBeNull();
          await pointer("pointerdown", start, handle, shift);
          // Cross the drag threshold before inspecting small final movements.
          await pointer("pointermove", { x: start.x, y: start.y + 20 }, page(), shift, 7, 1);
          await pointer("pointermove", end, page(), shift, 7, 1);
          await act(async () => { await vi.advanceTimersByTimeAsync(20); });
          if (object.type === "molecule") {
            expect(current().pages[0].objects).toEqual(expected.pages[0].objects);
            expect(canonical(molecules(current())[0])).toBe(canonical(object));
          } else {
            const shell = container.querySelector<HTMLElement>(`[data-object-id="${id}"] .graphic-visual-shell`)!;
            expect(shell.style.transform).toContain(`rotate(${snapped}deg)`);
          }
          await pointer("pointerup", { x: end.x, y: end.y + 10 }, page(), !shift);
          expect(current().pages[0].objects).toEqual(expected.pages[0].objects);
          await command("edit.undo");
          expect(current().pages[0].objects).toEqual(before.pages[0].objects);
        }
      }
    }
  }, 120000);

  it("C: refused targets place separate rings with reasons; 20 rapid real clicks preserve the saturated original", async () => {
    const base = insertNativeSingleBondMolecule(createPhase4Document("Refused rings"), { x: 300, y: 300 });
    const original = molecules(base)[0], atom = original.atoms[0];
    const saturated = saturatedMolecule(original);
    const atomTarget = { objectId: original.id, kind: "atom" as const, atomId: atom.id, distanceToPointer: 0 };
    const variants = [
      { mol: saturated, target: atomTarget, reason: "atom-no-free-valence", text: "that atom has no free valence" },
      { mol: { ...original, atoms: original.atoms.map((a, i) => i ? a : { ...a, markRadicals: 1 }), bonds: [{ ...original.bonds[0], order: "double" as const }] }, target: atomTarget, reason: "atom-no-free-valence", text: "that atom has no free valence" },
      { mol: { ...original, atoms: original.atoms.map(a => ({ ...a, x: atom.x, y: atom.y })) }, target: { objectId: original.id, kind: "bond" as const, bondId: original.bonds[0].id, fromAtomId: original.bonds[0].fromAtomId, toAtomId: original.bonds[0].toAtomId, distanceToPointer: 0 }, reason: "bond-cannot-accept", text: "that bond cannot accept a ring" },
      { mol: { ...original, atoms: [], bonds: [] }, target: atomTarget, reason: "structure-not-editable", text: "that structure cannot be edited" },
      { mol: original, target: { ...atomTarget, atomId: "missing-atom" }, reason: "target-unavailable", text: "that target is unavailable" }
    ];
    const started = performance.now();
    for (const variant of variants) {
      const doc = applyPatches(base, [{ op: "updateObject", objectId: original.id, changes: variant.mol }]);
      const plan = planNativeTemplatePlacement(doc, { point: atom, target: variant.target }, "benzene")!;
      expect(plan).toMatchObject({ kind: "standalone", fallbackReason: variant.reason });
      const placed = applyNativeTemplatePlacementPlan(doc, plan);
      expect(molecules(placed)[0]).toEqual(variant.mol);
      expect(molecules(placed)).toHaveLength(2);
      expect(plan.molecule.atoms.every(a => variant.mol.atoms.every(b =>
        Math.hypot(a.x - b.x, a.y - b.y) >= nativeBondLengthPx
      ))).toBe(true);
      expect(nativeTemplateStatusForApplication("benzene", variant.target, true, plan.fallbackReason)).toBe(`Placed benzene separately: ${variant.text}`);
    }
    const doc = applyPatches(base, [{ op: "updateObject", objectId: original.id, changes: saturated }]);
    await mount(doc, "tool.benzene");
    for (let i = 0; i < 20; i++) {
      const wrapper = container.querySelector(`[data-object-id="${original.id}"]`)!;
      await pointer("pointerdown", atom, wrapper); await pointer("pointerup", atom, wrapper);
      expect(molecules(current())).toHaveLength(i + 2);
      expect(molecules(current())[0]).toEqual(saturated);
      expect(status()).toBe("Placed benzene separately: that atom has no free valence");
    }
    for (const ring of molecules(current()).slice(1)) {
      expect(ring.atoms.every(a => saturated.atoms.every(b => Math.hypot(a.x - b.x, a.y - b.y) >= nativeBondLengthPx))).toBe(true);
    }
    report("C", started, "refusedKinds=5 workflowRings=5 clicks=20 separateRings=20");
  }, 120000);

  // Bug: plain bond fusion skips the endpoint-valence guard and creates a five-bond carbon.
  it.fails("C bug: ring click on a full-valence bond endpoint should place separately", async () => {
    const base = insertNativeSingleBondMolecule(createPhase4Document("Bond refusal bug"), { x: 300, y: 300 });
    const saturated = saturatedMolecule(molecules(base)[0]);
    const doc = applyPatches(base, [{ op: "updateObject", objectId: saturated.id, changes: saturated }]);
    await mount(doc, "tool.cyclohexane");
    const [a, b] = saturated.atoms, started = performance.now();
    const wrapper = container.querySelector(`[data-object-id="${saturated.id}"]`)!;
    const point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    await pointer("pointerdown", point, wrapper); await pointer("pointerup", point, wrapper);
    const next = molecules(current())[0];
    const degree = next.bonds.filter(bond => bond.fromAtomId === a.id || bond.toAtomId === a.id).length;
    console.info(`[stress C bond bug] clicks=1 originalDegree=4 committedDegree=${degree} objects=${molecules(current()).length} status=${status()} ms=${(performance.now() - started).toFixed(1)} FAIL`);
    expect(molecules(current())).toHaveLength(2);
    expect(next).toEqual(saturated);
    expect(status()).toBe("Placed cyclohexane separately: that bond cannot accept a ring");
  });

  it.each(["macos", "windows"] as const)("D: 30 rapid label characters and continuation Backspace/Delete never delete objects (%s)", async p => {
    platform(p); const doc = insertNativeTemplateMolecule(createPhase4Document("Typing"), { x: 300, y: 300 }, "cyclohexane");
    await mount(selectDocumentObjects(doc, doc.pages[0].id, []), "tool.bond");
    const before = molecules(current())[0], started = performance.now();
    await pointer("pointermove", before.atoms[0]);
    const label = "O" + "Me".repeat(14) + "C";
    for (const char of label) await key(char);
    expect(editor()?.value).toBe(label);
    await key("Backspace"); expect(editor()?.value).toBe(label.slice(0, -1));
    editor()!.setSelectionRange(1, 2); await key("Delete");
    const finalLabel = label.slice(0, 1) + label.slice(2, -1);
    expect(editor()?.value).toBe(finalLabel); await key("Enter");
    expect(molecules(current())[0].atoms[0].element).toBe(finalLabel);
    expect(molecules(current())[0].bonds).toEqual(before.bonds);
    expect(current().pages[0].objects).toHaveLength(1); expect(snapshot().activeToolCommandId).toBe("tool.bond");
    report(`D continuation ${p}`, started, "characters=30 deletionKeys=2 deletedObjects=0");
  }, 120000);

  it.each(["macos", "windows"] as const)("D: records O → bond drift → M → e (%s)", async p => {
    platform(p); const doc = insertNativeTemplateMolecule(createPhase4Document("Drift"), { x: 300, y: 300 }, "cyclohexane");
    await mount(selectDocumentObjects(doc, doc.pages[0].id, []), "tool.bond");
    const mol = molecules(current())[0], a = mol.atoms[0], b = mol.atoms[1], started = performance.now();
    await pointer("pointermove", a); await key("O");
    await pointer("pointermove", { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond" });
    await key("M"); await key("e");
    const label = molecules(current())[0].atoms[0].element;
    const deleted = doc.pages[0].objects.length - current().pages[0].objects.length;
    console.info(`[stress D drift ${p}] keys=3 label=${label} tool=${snapshot().activeToolCommandId} deletedObjects=${deleted} ms=${(performance.now() - started).toFixed(1)} known-main-bond-hotkey-bug`);
    expect(label).toBe("O"); expect(editor()).toBeNull(); expect(deleted).toBe(0);
  });

  // Known pre-existing main bug: 'e' over a hovered bond switches to the Eraser after label drift.
  it.fails("D bug: bond drift should continue OMe rather than arming Eraser", async () => {
    const doc = insertNativeTemplateMolecule(createPhase4Document("Drift bug"), { x: 300, y: 300 }, "cyclohexane");
    await mount(selectDocumentObjects(doc, doc.pages[0].id, []), "tool.bond");
    const [a, b] = molecules(current())[0].atoms;
    await pointer("pointermove", a); await key("O");
    await pointer("pointermove", { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    await key("M"); await key("e");
    expect(snapshot().activeToolCommandId).toBe("tool.bond");
    expect(editor()?.value).toBe("OMe");
  });

  it.each(["macos", "windows"] as const)("F: 50 rapid Text placements/commits have atomic conversion or label undo and leave no stray text (%s)", async p => {
    platform(p); const doc = insertNativeSingleBondMolecule(createPhase4Document("Text stress"), { x: 300, y: 300 });
    await mount(doc, "tool.text"); const started = performance.now();
    for (let i = 0; i < 50; i++) {
      await command("tool.text");
      const onAtom = i % 2 === 1;
      const before = molecules(current())[0];
      const point = onAtom ? before.atoms[1] : { x: 70 + (i % 10) * 40, y: 70 + Math.floor(i / 10) * 30 };
      await pointer("pointerdown", point);
      if (onAtom) {
        expect(editor()).not.toBeNull(); await input(editor()!, i % 4 === 1 ? "OMe" : "OEt"); await key("Enter");
        const committed = current().pages[0].objects;
        await command("edit.undo"); expect(molecules(current())[0]).toEqual(before);
        await command("edit.redo"); expect(current().pages[0].objects).toEqual(committed);
      } else {
        const text = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
        expect(text).not.toBeNull(); await input(text, "N");
        const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
        await act(async () => text.blur()); focused.mockRestore();
        expect(current().pages[0].objects.some(o => o.type === "text")).toBe(false);
        const committed = current().pages[0].objects;
        await command("edit.undo");
        expect(current().pages[0].objects.filter(o => o.type === "text")).toHaveLength(1);
        await command("edit.redo"); expect(current().pages[0].objects).toEqual(committed);
      }
    }
    expect(molecules(current())).toHaveLength(26); expect(current().pages[0].objects).toHaveLength(26);
    report(`F placements ${p}`, started, "placements=50 openSpace=25 onAtom=25 undo=50 redo=50 strayText=0");
  }, 120000);

  it("F: explicitly converts 20 selected text boxes with exactly one undo entry per conversion", async () => {
    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      const doc = insertNativeSingleBondMolecule(createPhase4Document("Explicit text"), { x: 300, y: 300 });
      const atom = molecules(doc)[0].atoms[1];
      const initial = insertNativeTextObject(doc, { x: atom.x, y: atom.y + 15 }, `OMe${i}`);
      await mount(initial); const before = current().pages[0].objects;
      await command(convertTextToAtomLabelCommandId);
      expect(current().pages[0].objects).toHaveLength(1);
      expect(molecules(current())[0].atoms[1].element).toBe(`OMe${i}`);
      await command("edit.undo"); expect(status()).toContain("Undid Convert Text to Atom Label");
      expect(current().pages[0].objects).toEqual(before);
      await command("edit.undo"); expect(current().pages[0].objects).toEqual(before);
      await command("edit.redo"); expect(current().pages[0].objects).toHaveLength(1);
    }
    report("F explicit", started, "selectedBoxes=20 conversions=20 undoEntries=20 strayObjects=0");
  }, 120000);
});
