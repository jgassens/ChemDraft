// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, nativeDrawingStyleFromObjectStyle, type ChemDraftDocument, type MoleculeObject, type Point } from "@chemdraft/chem-core";
import { createNativeTextObject, nativeAtomExternalValence, nativeAtomChargeSupportsValence, nativeAtomLabelReading, nativeLabelGroupVerdict, normalizeNativeMoleculeGeometry } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTemplateMolecule, insertNativeTextObject, selectDocumentObjects } from "./documentWorkflow";
import { nativeNicknameLabels } from "./commands";
import { loadKeybindingSettings, saveKeybindingSettings } from "./keybindingSettings";
import { DOM_COMMAND_EVENT } from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
function ring(template: "benzene" | "cyclohexane" = "cyclohexane") {
  const d = insertNativeTemplateMolecule(createPhase4Document("Ring labels"), { x: 300, y: 300 }, template);
  return selectDocumentObjects(d, d.pages[0].id, []);
}

describe.each(["macos", "windows"] as const)("ring label commits (%s)", platform => {
  let container: HTMLDivElement, root: Root, renderKey = 0;
  const captureNames = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let captureDescriptors: Array<PropertyDescriptor | undefined>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key), clear: () => storage.clear()
    });
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
    captureDescriptors = captureNames.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    for (const name of captureNames) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: name === "hasPointerCapture" ? () => false : () => {} });
    saveKeybindingSettings({ scheme: "chemdraft" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    captureNames.forEach((name, i) => {
      const descriptor = captureDescriptors[i];
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor); else Reflect.deleteProperty(HTMLElement.prototype, name);
    });
    Reflect.deleteProperty(navigator, "platform"); delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/"); saveKeybindingSettings({ scheme: "chemdraft" });
  });
  async function mount(d = ring(), tool = "tool.atom") {
    await act(async () => root.render(createElement(MainWindow, {
      key: ++renderKey, initialDocument: d, initialActiveToolCommandId: tool, initialCrosshairsVisible: false,
      initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const e of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) e.getBoundingClientRect = () => rect;
    await act(async () => { await Promise.resolve(); });
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const current = () => snapshot().document;
  const molecule = () => current().pages[0].objects.find((o): o is MoleculeObject => o.type === "molecule")!;
  const editor = () => container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
  const status = () => container.querySelector('[role="status"]')?.textContent;
  const page = () => container.querySelector<HTMLElement>(".page")!;
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function pointer(type: string, point: Point, target: Element = page()) {
    await act(async () => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerdown" ? 1 : 0, clientX: point.x, clientY: point.y });
      Object.defineProperties(e, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } }); target.dispatchEvent(e);
    });
  }
  async function input(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
      const prototype = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(target, value);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function key(key: string, init: KeyboardEventInit = {}) {
    const target = document.activeElement ?? document.body;
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    await act(async () => { target.dispatchEvent(e); });
    if (!e.defaultPrevented && target instanceof HTMLInputElement && key.length === 1) {
      const start = target.selectionStart ?? target.value.length, end = target.selectionEnd ?? start;
      await input(target, target.value.slice(0, start) + key + target.value.slice(end));
      target.setSelectionRange(start + 1, start + 1);
    }
  }
  async function history(redo = false) {
    await key("z", { [platform === "macos" ? "metaKey" : "ctrlKey"]: true, shiftKey: redo });
  }
  async function edit(index: number, label: string, finish = "Enter") {
    const atom = molecule().atoms[index]!;
    await pointer("pointerdown", atom, container.querySelector(`[data-object-id="${molecule().id}"]`)!);
    expect(editor()).not.toBeNull();
    for (const char of label) await key(char);
    if (finish === "click") {
      await pointer("pointerdown", { x: 50, y: 50 });
      // jsdom does not implement pointer focus defaults. Supply the resulting real blur.
      const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      await act(async () => { page().tabIndex = -1; page().focus(); }); focused.mockRestore();
    }
    else if (finish === "blur") {
      const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      await act(async () => editor()!.blur()); focused.mockRestore();
    } else if (finish === "tool") await command("tool.select");
    else await key(finish);
  }
  function check(atoms: number, bonds: number) {
    const m = molecule(), length = nativeDrawingStyleFromObjectStyle(m.style).bondLengthPx;
    expect(m.atoms).toHaveLength(atoms); expect(m.bonds).toHaveLength(bonds);
    expect(new Set(m.atoms.map(a => a.id)).size).toBe(atoms); expect(new Set(m.bonds.map(b => b.id)).size).toBe(bonds);
    for (const [i, a] of m.atoms.entries()) {
      const reading = nativeAtomLabelReading(a.element, { bonded: true });
      if (reading.kind === "element") expect(nativeAtomChargeSupportsValence(reading.element, nativeAtomExternalValence(m, a), a.formalCharge), a.id).toBe(true);
      if (reading.kind === "group") expect(nativeLabelGroupVerdict(reading.group, nativeAtomExternalValence(m, a), a.formalCharge).valid, a.element).toBe(true);
      if (reading.kind === "heavy-hydrogen") expect(nativeAtomExternalValence(m, a)).toBeLessThanOrEqual(1);
      expect(a.x).toBeGreaterThanOrEqual(0); expect(a.x).toBeLessThanOrEqual(current().pages[0].width);
      expect(a.y).toBeGreaterThanOrEqual(0); expect(a.y).toBeLessThanOrEqual(current().pages[0].height);
      for (const b of m.atoms.slice(i + 1)) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(length * 0.5 - 1e-6);
    }
  }

  it.each(["Enter", "Tab", "click", "blur", "tool"])("splits once on %s and restores the exact graph with one Undo/Redo", async finish => {
    await mount(); const before = molecule();
    await edit(0, "OMe", finish); expect(editor()).toBeNull(); check(7, 7);
    expect(molecule().atoms.slice(0, 6)).toEqual(before.atoms);
    expect(molecule().atoms[6]).toMatchObject({ element: "OMe", labelLiteral: true });
    expect(status()).toContain("Attached OMe as a substituent");
    if (finish === "Enter" || finish === "Tab") expect(snapshot().selectedNativeMoleculePart).toMatchObject({ kind: "atom", atomId: molecule().atoms[6]!.id });
    const after = molecule(); await history(); expect(molecule()).toEqual(before); await history(true); expect(molecule()).toEqual(after);
  });
  it("Escape adds nothing, restores carbon, and creates no history", async () => {
    await mount(); const before = molecule(); await edit(0, "OMe", "Escape");
    expect(molecule()).toEqual(before); check(6, 6); await history(); expect(molecule()).toEqual(before);
  });
  it("previews the same attachment without adding draft atoms to history", async () => {
    await mount(); const source = molecule().atoms[0]!;
    await pointer("pointerdown", source, container.querySelector(`[data-object-id="${molecule().id}"]`)!);
    for (const char of "OMe") await key(char);
    expect(molecule().atoms).toHaveLength(6);
    expect(container.querySelector('[data-atom-count]')?.getAttribute("data-atom-count")).toBe("7");
    expect(container.querySelector('[data-bond-count]')?.getAttribute("data-bond-count")).toBe("7");
    expect(editor()?.getAttribute("data-atom-id")).toBe(source.id);
    const bondPreview = container.querySelector('.native-molecule-overlay-visual')?.innerHTML;
    await key("Enter"); check(7, 7);
    // All preview bond paths remain verbatim; only the editor's suppressed label is restored.
    const after = container.querySelector('.native-molecule-overlay-visual')?.innerHTML;
    for (const line of (bondPreview ?? "").match(/<(?:line|path)\b[^>]*>/g) ?? []) expect(after).toContain(line);
  });
  it("a direct move between editors commits each label once and preserves both Undo baselines", async () => {
    await mount(); const original = molecule();
    await pointer("pointerdown", original.atoms[0]!, container.querySelector(`[data-object-id="${original.id}"]`)!);
    for (const char of "OMe") await key(char);
    await pointer("pointerdown", original.atoms[1]!, container.querySelector(`[data-object-id="${original.id}"]`)!);
    expect(editor()).not.toBeNull(); check(7, 7);
    const first = molecule(); for (const char of "OH") await key(char);
    await key("Enter"); check(8, 8); const second = molecule();
    await history(); expect(molecule()).toEqual(first);
    await history(); expect(molecule()).toEqual(original);
    await history(true); expect(molecule()).toEqual(first);
    await history(true); expect(molecule()).toEqual(second);
  });
  it("hover continuation restores pre-O carbon, reusing the first key's one Undo entry", async () => {
    await mount(ring("benzene"), "tool.bond"); const before = molecule();
    await pointer("pointermove", before.atoms[0]!);
    for (const char of "OMe") await key(char);
    expect(editor()?.value).toBe("OMe");
    // The uncommitted draft stays on the source in history; only the render preview is split.
    expect(molecule().atoms).toHaveLength(6); expect(molecule().bonds).toHaveLength(6);
    await key("Enter"); check(7, 7); expect(molecule().atoms.slice(0, 6)).toEqual(before.atoms);
    expect(status()).toContain("already has 2"); const after = molecule();
    await history(); expect(molecule()).toEqual(before); await history(true); expect(molecule()).toEqual(after);
  });
  it("ordinary NMe relabel has the same one Undo entry as the split", async () => {
    await mount(); const before = molecule(); await edit(0, "NMe"); check(6, 6);
    expect(molecule().atoms[0]!.element).toBe("NMe"); const after = molecule();
    await history(); expect(molecule()).toEqual(before); await history(true); expect(molecule()).toEqual(after);
  });
  it("guard fallback relabels rather than adding a fifth bond and explains why", async () => {
    let d = ring(); const m = d.pages[0].objects.find((o): o is MoleculeObject => o.type === "molecule")!;
    const a = m.atoms[0]!;
    const full = { ...m, atoms: [...m.atoms, { ...a, id: "extra1", x: a.x + 24 }, { ...a, id: "extra2", y: a.y - 24 }], bonds: [...m.bonds,
      { id: "extraB1", fromAtomId: a.id, toAtomId: "extra1", order: "single" as const },
      { id: "extraB2", fromAtomId: a.id, toAtomId: "extra2", order: "single" as const }] };
    d = applyPatches(d, [{ op: "updateObject", objectId: m.id, changes: full }]);
    await mount(d); await edit(0, "OMe");
    expect(molecule().atoms).toHaveLength(8); expect(molecule().bonds).toHaveLength(8);
    expect(status()).toContain("cannot take another bond");
  });
  it("explicit text conversion attaches, selects the new atom, and takes one Undo", async () => {
    const base = ring(), m = base.pages[0].objects.find((o): o is MoleculeObject => o.type === "molecule")!;
    const withText = insertNativeTextObject(base, m.atoms[0]!, "OMe");
    await mount(withText, "tool.select"); const before = current().pages[0].objects;
    await command("text.convertToAtomLabel"); check(7, 7); expect(current().pages[0].objects).toHaveLength(1);
    expect(snapshot().selectedNativeMoleculePart).toMatchObject({ kind: "atom", atomId: molecule().atoms[6]!.id });
    expect(status()).toContain("Attached OMe"); const after = current().pages[0].objects;
    await history(); expect(current().pages[0].objects).toEqual(before); await history(true); expect(current().pages[0].objects).toEqual(after);
  });
  it("fresh Text-tool text within reach converts automatically once", async () => {
    const d = ring(), m = d.pages[0].objects.find((o): o is MoleculeObject => o.type === "molecule")!;
    const point = { x: d.pages[0].width - 1, y: m.atoms[0]!.y };
    const anchor = createNativeTextObject(d, point);
    // Near the page edge the fresh text box clamps left of the click. Put a ring atom at
    // that anchor: the pointer places text in open space, then blur converts on the atom.
    const dx = anchor.x - m.atoms[0]!.x;
    const shifted = normalizeNativeMoleculeGeometry({ ...m, atoms: m.atoms.map(a => ({ ...a, x: a.x + dx })) });
    await mount(applyPatches(d, [{ op: "updateObject", objectId: m.id, changes: shifted }]), "tool.text");
    const before = molecule();
    await pointer("pointerdown", point);
    const textEditor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    expect(textEditor).not.toBeNull(); await input(textEditor, "OMe");
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await act(async () => textEditor.blur()); focused.mockRestore();
    check(7, 7); expect(current().pages[0].objects).toHaveLength(1);
    expect(status()).toContain("Attached OMe");
    const after = molecule(); await history();
    expect(molecule()).toEqual(before); expect(current().pages[0].objects.some(o => o.type === "text")).toBe(true);
    await history(true); expect(molecule()).toEqual(after);
  });

  it("stress: twelve ring labels, all nickname hotkeys, twenty chain edits and mixed Undo/Redo", async () => {
    const started = performance.now(); let labels = 0, hotkeys = 0, chainEdits = 0, undo = 0, redo = 0;
    for (const template of ["benzene", "cyclohexane"] as const) {
      await mount(ring(template));
      for (let i = 0; i < 6; i++) { await edit(i, "OMe"); labels++; check(7 + i, 7 + i); }
    }
    const keys = ["d", "e", "E", "F", "H", "m", "M", "N", "O", "P", "Q", "r", "x", "y", "Z", "!"];
    expect(keys).toHaveLength(nativeNicknameLabels.length);
    for (const [i, label] of nativeNicknameLabels.entries()) {
      saveKeybindingSettings({ scheme: "chemdraw" }); await mount(ring(), "tool.bond");
      expect(loadKeybindingSettings().scheme).toBe("chemdraw");
      const before = molecule(); await pointer("pointermove", before.atoms[0]!);
      expect(snapshot().hoveredNativeTarget, `${label}: hover`).toMatchObject({ kind: "atom", atomId: before.atoms[0]!.id });
      await key(keys[i]!);
      expect(molecule().atoms, `${label}: ${status()}`).toHaveLength(7);
      check(7, 7); hotkeys++; expect(molecule().atoms[6]!.element).toBe(label);
      expect(molecule().atoms[6]!.labelLiteral).not.toBe(true); expect(status()).toContain(`Attached ${label}`);
      const after = molecule(); await history(); undo++; expect(molecule()).toEqual(before);
      await history(true); redo++; expect(molecule()).toEqual(after); check(7, 7);
    }
    saveKeybindingSettings({ scheme: "chemdraft" });
    const d = createPhase4Document("Long chain"), L = 24;
    const m: MoleculeObject = { id: "chain", type: "molecule", x: 30, y: 300, width: 610, height: 12, rotation: 0, style: {}, structure: "", structureFormat: "smiles", superatoms: [], rGroups: [],
      atoms: Array.from({ length: 30 }, (_, i) => ({ id: `chainA${i}`, element: "C", formalCharge: 0, x: 30 + i * L * Math.sqrt(3) / 2, y: 300 + i % 2 * L / 2 })),
      bonds: Array.from({ length: 29 }, (_, i) => ({ id: `chainB${i}`, fromAtomId: `chainA${i}`, toAtomId: `chainA${i + 1}`, order: "single" })) };
    await mount(applyPatches(d, [{ op: "addObject", pageId: d.pages[0].id, object: m }]));
    const original = molecule();
    for (let i = 0; i < 20; i++) {
      await edit(14, "OMe"); chainEdits++; check(31, 30); const after = molecule();
      await history(); undo++; expect(molecule()).toEqual(original); check(30, 29);
      if (i % 2 === 0) { await history(true); redo++; expect(molecule()).toEqual(after); check(31, 30); await history(); undo++; check(30, 29); }
    }
    for (const label of ["NMe", "OH", "OMe", "N", "Me"]) {
      await edit(14, label); const split = ["OH", "OMe", "Me"].includes(label); check(split ? 31 : 30, split ? 30 : 29);
      const after = molecule(); await history(); undo++; expect(molecule()).toEqual(original); check(30, 29);
      await history(true); redo++; expect(molecule()).toEqual(after); await history(); undo++;
    }
    console.info(`[stress ring-label ${platform}] ringLabels=${labels} nicknameHotkeys=${hotkeys} chainEdits=${chainEdits} mixedEdits=5 undo=${undo} redo=${redo} overlaps=0 overValentSources=0 ms=${(performance.now() - started).toFixed(1)} PASS`);
  }, 120_000);
});
