// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, moleculeToMolfileV2000, nativeDrawingStyleFromObjectStyle, type ChemDraftDocument, type MoleculeObject, type Point } from "@chemdraft/chem-core";
import { createNativeTextObject, nativeAtomExternalValence, nativeAtomChargeSupportsValence, nativeAtomLabelReading, nativeBondOrderResolution, nativeLabelGroupVerdict, nativeSingleBondGraphMetadata, normalizeNativeMoleculeGeometry, tryNativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, insertNativeTemplateMolecule, insertNativeTextObject, selectDocumentObjects } from "./documentWorkflow";
import { nativeNicknameLabels } from "./commands";
import { loadKeybindingSettings, saveKeybindingSettings } from "./keybindingSettings";
import { DOM_COMMAND_EVENT } from "./window-manager";
import type { DesktopPluginRuntime } from "./plugins/createPluginRuntime";
import { ANALYSIS_WINDOW_ACTION_EVENT } from "./plugins/panelBridge";

const externalWrite = vi.hoisted(() => ({ object: undefined as MoleculeObject | undefined, pageId: "", proposalId: "" }));
// Use the same runtime registration path as the plugin DOM fixtures, with real permission-gated writes.
vi.mock("./plugins/registerBundledPlugins", async importOriginal => {
  const actual = await importOriginal<typeof import("./plugins/registerBundledPlugins")>();
  const { PluginManifestSchema } = await import("@chemdraft/plugin-api");
  return {
    ...actual,
    registerBundledPlugins(runtime: DesktopPluginRuntime, disabledIds?: ReadonlySet<string>) {
      const descriptors = [...actual.registerBundledPlugins(runtime, disabledIds), {
        manifest: PluginManifestSchema.parse({
          id: "org.chemdraft.test.labelHistory", name: "Label History Test", version: "1.0.0",
          apiVersion: "^0.1.6", entry: "test:label-history", permissions: ["document.write", "document.read", "document.proposePatch"],
          contributes: { commands: [
            { id: "plugin.labelHistory.insert", title: "Insert other molecule", requiredPermissions: ["document.write"], enabled: true },
            { id: "plugin.labelHistory.move", title: "Move another atom", requiredPermissions: ["document.read", "document.proposePatch"], enabled: true }
          ] }
        }),
        options: { commandHandlers: {
          "plugin.labelHistory.insert": async (context: import("@chemdraft/plugin-api").PluginCommandContext) => context.documents.applyPatch!({
            reason: "Insert other molecule",
            patch: { op: "addObject", pageId: externalWrite.pageId, object: externalWrite.object! }
          }),
          "plugin.labelHistory.move": async (context: import("@chemdraft/plugin-api").PluginCommandContext) => {
            const document = (await context.documents.getActiveDocument())!;
            const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
            const { moveNativeMoleculeParts } = await import("./documentWorkflow");
            const moved = moveNativeMoleculeParts(document, { objectId: molecule.id, kind: "atom", atomId: molecule.atoms[2]!.id }, { x: 120, y: 60 });
            const next = moved.pages[0].objects.find((object): object is MoleculeObject => object.id === molecule.id && object.type === "molecule")!;
            const receipt = await context.documents.proposePatch({ reason: "Move another atom",
              patch: { op: "updateObject", objectId: molecule.id, changes: {
                atoms: next.atoms, x: next.x, y: next.y, width: next.width, height: next.height
              } } });
            externalWrite.proposalId = receipt.id;
          }
        } }
      }];
      actual.applyEnabledPlugins(runtime, disabledIds ?? new Set(), descriptors);
      return descriptors;
    }
  };
});

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
  async function insertOtherMolecule() {
    const seed = insertNativeTemplateMolecule(createPhase4Document(), { x: 550, y: 400 }, "cyclohexane");
    const other = seed.pages[0].objects[0] as MoleculeObject;
    externalWrite.object = {
      ...other, id: "external_molecule",
      atoms: other.atoms.map(a => ({ ...a, id: `external_${a.id}` })),
      bonds: other.bonds.map(b => ({ ...b, id: `external_${b.id}`, fromAtomId: `external_${b.fromAtomId}`, toAtomId: `external_${b.toAtomId}` }))
    };
    externalWrite.pageId = current().pages[0].id;
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("plugin.labelHistory.insert"); });
    const inserted = current().pages[0].objects.find(o => o.id === "external_molecule");
    expect(inserted).toEqual(externalWrite.object);
    return inserted;
  }
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function moveOtherAtom() {
    const before = molecule().atoms[2]!;
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("plugin.labelHistory.move"); });
    await act(async () => { window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_ACTION_EVENT, {
      detail: { kind: "acceptPluginProposal", proposalId: externalWrite.proposalId }
    })); });
    const moved = molecule().atoms[2]!;
    expect(moved).toMatchObject({ id: before.id, x: before.x + 120, y: before.y + 60 });
    expect(editor()).not.toBeNull();
    return moved;
  }
  function expectFreshDerivedFields(object: MoleculeObject) {
    const smiles = tryNativeSingleBondGraphSmiles(object.atoms, object.bonds);
    expect(object.structureFormat).toBe("smiles");
    expect(object.structure).toBe("smiles" in smiles ? smiles.smiles : "");
    expect(object.chemistry).toEqual(nativeSingleBondGraphMetadata(object.atoms, object.bonds));
    const geometry = normalizeNativeMoleculeGeometry(object);
    for (const key of ["x", "y", "width", "height"] as const) expect(object[key]).toBe(geometry[key]);
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
  it.each(["CH3", "NH2"])("a no-op hover %s first key owns exactly one named entry and preserves the earlier entry", async label => {
    const d = ring(), original = d.pages[0].objects[0] as MoleculeObject;
    const source = { ...original.atoms[0]!, element: label[0]!, ...(label === "CH3" ? { labelVisible: true } : {}) };
    await mount(applyPatches(d, [{ op: "updateObject", objectId: original.id, changes: { atoms: original.atoms.map(a => a.id === source.id ? source : a) } }]), "tool.bond");
    const before = molecule();
    const other = await insertOtherMolecule();
    const priorStatus = status();
    await history();
    const priorUndoStatus = status();
    expect(priorUndoStatus).toBe("Undid Label History Test: Insert other molecule");
    expect(current().pages[0].objects).toHaveLength(1);
    await history(true);
    expect(current().pages[0].objects[1]).toEqual(other);
    expect(priorStatus).toContain("inserted structure");
    await pointer("pointermove", source);
    await key(label[0]!);
    expect(molecule()).toEqual(before); // The instant key really is a no-op.
    for (const char of label.slice(1)) await key(char);
    await key("Enter");
    expect(molecule().atoms[6]).toMatchObject({ element: label });
    await history();
    expect(molecule()).toEqual(before);
    expect(current().pages[0].objects[1]).toEqual(other);
    expect(status()).toBe(`Undid Add ${label} substituent`);
    await history();
    expect(current().pages[0].objects).toHaveLength(1);
    expect(molecule()).toEqual(before);
    expect(status()).toBe(priorUndoStatus);
  });
  it.each(["Escape", "Enter"])("%s preserves an external plugin insertion and never records the live draft", async finish => {
    await mount(); const before = molecule();
    await pointer("pointerdown", before.atoms[0]!, container.querySelector(`[data-object-id="${before.id}"]`)!);
    for (const char of "OMe") await key(char);
    const other = await insertOtherMolecule();
    expect(editor()?.value).toBe("OMe");
    await key(finish);
    expect(current().pages[0].objects[1]).toEqual(other);
    if (finish === "Enter") {
      expect(molecule().atoms[6]).toMatchObject({ element: "OMe" });
      await history();
      expect(current().pages[0].objects[1]).toEqual(other);
      expect(status()).toBe("Undid Add OMe substituent");
    }
    expect(molecule()).toEqual(before);
    await history();
    expect(current().pages[0].objects).toHaveLength(1);
    expect(molecule()).toEqual(before);
    await history(true);
    expect(molecule()).toEqual(before); // Redo of the plugin entry contains no half-typed OMe.
    expect(current().pages[0].objects[1]).toEqual(other);
  });
  it.each(["Enter", "click"])("an empty draft closed by %s restores the exact atom and adds no entry", async finish => {
    await mount(); const before = molecule();
    await pointer("pointerdown", before.atoms[0]!, container.querySelector(`[data-object-id="${before.id}"]`)!);
    for (const char of "OMe") await key(char);
    await input(editor()!, "");
    if (finish === "click") {
      await pointer("pointerdown", { x: 50, y: 50 });
      const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      await act(async () => { page().tabIndex = -1; page().focus(); }); focused.mockRestore();
    }
    else await key(finish);
    expect(editor()).toBeNull(); expect(molecule()).toEqual(before);
    await command("edit.undo"); expect(status()).toBe("Nothing to undo");
  });
  it.each(["N", "F"])("retyping existing %s restores its flags without a status or an undo entry", async label => {
    const d = ring(), m = d.pages[0].objects[0] as MoleculeObject;
    await mount(applyPatches(d, [{ op: "updateObject", objectId: m.id, changes: { atoms: m.atoms.map((a, i) => i === 0 ? { ...a, element: label, warningSuppressed: true } : a) } }]));
    const before = molecule(); await edit(0, label);
    expect(molecule()).toEqual(before); expect(status()).toBe("");
    await command("edit.undo"); expect(status()).toBe("Nothing to undo");
  });
  it.each(["Escape", "empty", "Enter"])("%s restores imported hydrogen hints, atom flags and molecule data while preserving another commit", async finish => {
    const d = ring("benzene"), m = d.pages[0].objects[0] as MoleculeObject;
    const imported: MoleculeObject = {
      ...m, structureFormat: "molfile-v2000",
      structure: moleculeToMolfileV2000(m, { kekuleBondOrders: nativeBondOrderResolution(m.atoms, m.bonds).kekuleOrders }).contents,
      atoms: m.atoms.map((a, i) => i === 0 ? { ...a, hydrogenCount: 1, labelVisible: true, warningSuppressed: true } : a),
      bonds: m.bonds.map(b => ({ ...b, order: "aromatic" }))
    };
    // Admit an imported fixture directly: a chemistry update patch would intentionally clear H hints.
    await mount({ ...d, pages: d.pages.map(p => ({ ...p, objects: p.objects.map(o => o.id === m.id ? imported : o) })) });
    const before = molecule();
    expect(before.atoms[0]!.hydrogenCount).toBe(1);
    await pointer("pointerdown", before.atoms[0]!, container.querySelector(`[data-object-id="${before.id}"]`)!);
    for (const char of "OMe") await key(char);
    expect(molecule().atoms[0]!.hydrogenCount).toBeUndefined();
    expect(molecule().structureFormat).toBe("smiles");
    const other = await insertOtherMolecule();
    if (finish === "empty") await input(editor()!, "");
    await key(finish === "Escape" ? "Escape" : "Enter");
    if (finish === "Enter") {
      expect(molecule().atoms[6]).toMatchObject({ element: "OMe" });
      await history();
    }
    expect(molecule()).toEqual(before);
    expect(current().pages[0].objects[1]).toEqual(other);
    await history(); expect(molecule()).toEqual(before);
    expect(current().pages[0].objects).toHaveLength(1);
    await history(true); expect(molecule()).toEqual(before);
    expect(current().pages[0].objects[1]).toEqual(other);
  });
  it.each(["Escape", "empty", "same-label"])("%s without another edit restores hints and flags on every atom exactly", async finish => {
    const d = ring(), original = d.pages[0].objects[0] as MoleculeObject;
    const imported: MoleculeObject = { ...original, structureFormat: "molfile-v2000",
      structure: moleculeToMolfileV2000(original, { kekuleBondOrders: nativeBondOrderResolution(original.atoms, original.bonds).kekuleOrders }).contents,
      atoms: original.atoms.map(atom => ({ ...atom, hydrogenCount: 2, labelVisible: true,
        warningSuppressed: true, labelOffset: { x: 1, y: 2 } })) };
    await mount({ ...d, pages: d.pages.map(p => ({ ...p, objects: [imported] })) });
    const before = molecule();
    await pointer("pointerdown", before.atoms[0]!, container.querySelector(`[data-object-id="${before.id}"]`)!);
    for (const char of "OMe") await key(char);
    expect(molecule().atoms.every(atom => atom.hydrogenCount === undefined)).toBe(true);
    if (finish !== "Escape") await input(editor()!, finish === "empty" ? "" : "C");
    await key(finish === "Escape" ? "Escape" : "Enter");
    expect(editor()).toBeNull();
    expect(molecule()).toEqual(before);
    await command("edit.undo"); expect(status()).toBe("Nothing to undo");
  });
  it.each(["Escape", "Enter"])("%s keeps a mid-edit move on the same molecule with fresh derived data and clean history", async finish => {
    await mount(); const before = molecule();
    await pointer("pointerdown", before.atoms[0]!, container.querySelector(`[data-object-id="${before.id}"]`)!);
    for (const char of "OMe") await key(char);
    const moved = await moveOtherAtom();
    // A further key must not claim the move as part of the preview's rollback.
    await input(editor()!, "OM"); await key("e");
    await key(finish);
    expect(editor()).toBeNull();
    const result = molecule();
    expect(result.atoms[2]).toEqual(moved);
    expect(result.width).toBeGreaterThan(before.width);
    expectFreshDerivedFields(result);
    if (finish === "Enter") {
      expect(result.atoms).toHaveLength(7); expect(result.bonds).toHaveLength(7);
      expect(result.atoms[6]).toMatchObject({ element: "OMe", labelLiteral: true });
      await history();
      expect(molecule().atoms[2]).toEqual(moved);
      expect(molecule().atoms).toHaveLength(6);
      expectFreshDerivedFields(molecule());
    } else {
      expect(result.atoms).toHaveLength(6); expect(result.bonds).toEqual(before.bonds);
      expect(result.atoms[0]).toEqual(before.atoms[0]);
    }
    await history(); expect(molecule()).toEqual(before);
    await history(true);
    expect(molecule().atoms[2]).toEqual(moved);
    expect(molecule().atoms[0]).toEqual(before.atoms[0]);
    expectFreshDerivedFields(molecule());
    if (finish === "Enter") {
      await history(true); expect(molecule()).toEqual(result);
    }
  });
  it("Undo during a live draft and its Redo never revive the half-typed label", async () => {
    await mount(); const before = molecule();
    await pointer("pointerdown", before.atoms[0]!, container.querySelector(`[data-object-id="${before.id}"]`)!);
    for (const char of "OMe") await key(char);
    const other = await insertOtherMolecule();
    await command("edit.undo:forceDocumentHistory");
    expect(editor()).toBeNull(); expect(molecule()).toEqual(before);
    expect(current().pages[0].objects).toHaveLength(1);
    await history(true); expect(molecule()).toEqual(before);
    expect(current().pages[0].objects[1]).toEqual(other);
  });
  it("a changed hover key stays before an intervening plugin commit and the final label entry", async () => {
    await mount(ring(), "tool.bond"); const before = molecule();
    await pointer("pointermove", before.atoms[0]!); await key("O");
    const firstKey = molecule(); await key("M"); await key("e");
    const other = await insertOtherMolecule(); await key("Enter");
    expect(molecule().atoms[6]).toMatchObject({ element: "OMe" });
    await history(); expect(molecule()).toEqual(firstKey);
    expect(current().pages[0].objects[1]).toEqual(other);
    expect(status()).toBe("Undid Add OMe substituent");
    await history(); expect(molecule()).toEqual(firstKey);
    expect(current().pages[0].objects).toHaveLength(1);
    expect(status()).toBe("Undid Label History Test: Insert other molecule");
    await history(); expect(molecule()).toEqual(before);
    await history(true); expect(molecule()).toEqual(firstKey);
    await history(true); expect(molecule()).toEqual(firstKey);
    expect(current().pages[0].objects[1]).toEqual(other);
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
  it("names hover continuations for their final substituent or relabel result", async () => {
    await mount(ring(), "tool.bond");
    const ringBefore = molecule();
    await pointer("pointermove", ringBefore.atoms[0]!);
    for (const char of "OMe") await key(char);
    await key("Enter");
    const ringAfter = molecule();
    await history();
    expect(molecule()).toEqual(ringBefore);
    expect(status()).toBe("Undid Add OMe substituent");
    await history(true);
    expect(molecule()).toEqual(ringAfter);
    expect(status()).toBe("Redid Add OMe substituent");

    const chain = insertNativeSingleBondMolecule(createPhase4Document("Terminal relabel"), { x: 300, y: 300 });
    await mount(selectDocumentObjects(chain, chain.pages[0].id, []), "tool.bond");
    const chainBefore = molecule();
    await pointer("pointermove", chainBefore.atoms[0]!);
    for (const char of "OMe") await key(char);
    await key("Enter");
    const chainAfter = molecule();
    await history();
    expect(molecule()).toEqual(chainBefore);
    expect(status()).toBe("Undid Edit Atom Label");
    await history(true);
    expect(molecule()).toEqual(chainAfter);
    expect(status()).toBe("Redid Edit Atom Label");
  });
  it("names inline ring-label attachments for Undo and Redo", async () => {
    await mount();
    const before = molecule();
    await edit(0, "OMe");
    const after = molecule();
    await history();
    expect(molecule()).toEqual(before);
    expect(status()).toBe("Undid Add OMe substituent");
    await history(true);
    expect(molecule()).toEqual(after);
    expect(status()).toBe("Redid Add OMe substituent");
  });
  it("names nickname-label hotkey attachments for Undo and Redo", async () => {
    saveKeybindingSettings({ scheme: "chemdraw" });
    await mount(ring(), "tool.bond");
    const before = molecule();
    await pointer("pointermove", before.atoms[0]!);
    await key("m");
    const after = molecule();
    await history();
    expect(molecule()).toEqual(before);
    expect(status()).toBe("Undid Add Me substituent");
    await history(true);
    expect(molecule()).toEqual(after);
    expect(status()).toBe("Redid Add Me substituent");
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
    await history(); expect(current().pages[0].objects).toEqual(before); expect(status()).toBe("Undid Add OMe substituent");
    await history(true); expect(current().pages[0].objects).toEqual(after); expect(status()).toBe("Redid Add OMe substituent");
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
