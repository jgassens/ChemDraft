// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatches, type MoleculeObject, type Point } from "@chemdraft/chem-core";
import { normalizeNativeMoleculeGeometry } from "@chemdraft/document-workflow-core";
import { copyAsScopedDocument, createPhase4Document, exportPhase4Svg, insertNativeTemplateMolecule, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";
import { DOM_COMMAND_EVENT } from "./window-manager";

// Wrap the actual memoized component only in this test module: count render executions,
// rather than commits of a Profiler ancestor (which can commit without an object rendering).
const observation = vi.hoisted(() => ({ renders: new Map<string, number>(), objects: new Map<string, MoleculeObject>() }));
vi.mock("react", async importOriginal => {
  const react = await importOriginal<typeof import("react")>();
  type Props = { object: MoleculeObject };
  return { ...react, memo: ((component: (props: Props) => ReactNode, compare?: (before: Props, after: Props) => boolean) => {
    if (component.name !== "DocumentObjectViewContent") return react.memo(component, compare);
    return react.memo(function ObservedDocumentObjectView(props: { object: MoleculeObject }) {
      const id = props.object.id;
      observation.renders.set(id, (observation.renders.get(id) ?? 0) + 1);
      observation.objects.set(id, props.object);
      return component(props);
    }, compare);
  }) as unknown as typeof react.memo };
});
const conformer = vi.hoisted(() => ({ generate: vi.fn(() => () => {}), prefetch: vi.fn(), warmup: vi.fn() }));
vi.mock("./conformerClient", () => ({ getConformerWorkerClient: () => conformer }));
const clipboard = vi.hoisted(() => ({ write: vi.fn(async (_items: readonly { type: string; text: string }[]) => true) }));
vi.mock("./clipboard", async importOriginal => ({
  ...await importOriginal<typeof import("./clipboard")>(), writeClipboardTextItems: clipboard.write
}));
import { MainWindow } from "./MainWindow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
function ring(template: "cyclohexane" | "benzene" = "cyclohexane") {
  const d = insertNativeTemplateMolecule(createPhase4Document("Preview isolation"), { x: 300, y: 300 }, template);
  return selectDocumentObjects(d, d.pages[0].id, []);
}
function largePage() {
  const d = createPhase4Document("500 atoms");
  const objects = Array.from({ length: 5 }, (_, m): MoleculeObject => normalizeNativeMoleculeGeometry({
    id: `large${m}`, type: "molecule", x: 0, y: 0, width: 1, height: 1, rotation: 0,
    style: { bondLengthPx: 6 }, structure: "", structureFormat: "smiles", superatoms: [], rGroups: [],
    atoms: Array.from({ length: 100 }, (_, i) => ({ id: `large${m}a${i}`, element: "C", formalCharge: 0,
      x: 50 + i * 6 * Math.sqrt(3) / 2, y: 80 + m * 100 + i % 2 * 3 })),
    bonds: Array.from({ length: 99 }, (_, i) => ({ id: `large${m}b${i}`, fromAtomId: `large${m}a${i}`,
      toAtomId: `large${m}a${i + 1}`, order: "single" }))
  }));
  return applyPatches(d, objects.map(object => ({ op: "addObject", pageId: d.pages[0].id, object })));
}

describe.each(["macos", "windows"] as const)("label preview proofs (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  const captureNames = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let descriptors: Array<PropertyDescriptor | undefined>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
    descriptors = captureNames.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    for (const name of captureNames) Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true, value: name === "hasPointerCapture" ? () => false : () => {}
    });
    observation.renders.clear(); observation.objects.clear(); conformer.generate.mockClear(); clipboard.write.mockClear();
    saveKeybindingSettings({ scheme: "chemdraft" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    captureNames.forEach((name, i) => {
      if (descriptors[i]) Object.defineProperty(HTMLElement.prototype, name, descriptors[i]!);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    });
    Reflect.deleteProperty(navigator, "platform"); delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/"); saveKeybindingSettings({ scheme: "chemdraft" });
  });
  async function mount(d = ring(), tool = "tool.atom") {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: d, initialActiveToolCommandId: tool, initialCrosshairsVisible: false,
      initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    await act(async () => { await Promise.resolve(); });
  }
  const bridge = () => window.__CHEMDRAFT_AGENT__!;
  const current = () => bridge().snapshot().document;
  const molecule = () => current().pages[0].objects[0] as MoleculeObject;
  const editor = () => container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]')!;
  const page = () => container.querySelector<HTMLElement>(".page")!;
  async function pointer(type: string, point: Point, target: Element = page()) {
    await act(async () => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons: type === "pointerdown" ? 1 : 0, clientX: point.x, clientY: point.y });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      target.dispatchEvent(event);
    });
  }
  async function key(key: string, init: KeyboardEventInit = {}) {
    const target = document.activeElement ?? document.body;
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    await act(async () => target.dispatchEvent(event));
    if (!event.defaultPrevented && target instanceof HTMLInputElement && key.length === 1) {
      const start = target.selectionStart ?? target.value.length, end = target.selectionEnd ?? start;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target,
          target.value.slice(0, start) + key + target.value.slice(end));
        target.dispatchEvent(new Event("input", { bubbles: true }));
      });
      target.setSelectionRange(start + 1, start + 1);
    }
  }
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  async function openPreview() {
    await mount();
    const source = molecule().atoms[0]!;
    await pointer("pointerdown", source, container.querySelector(`[data-object-id="${molecule().id}"]`)!);
    for (const char of "OMe") await key(char);
    expect(editor().value).toBe("OMe");
    const preview = observation.objects.get(molecule().id)!.atoms[6]!;
    expect(preview.element).toBe("OMe"); expect(molecule().atoms).toHaveLength(6);
    return preview;
  }

  it("keeps double-bond preview geometry in SVG without changing object-view bond metadata or selection", async () => {
    await mount(ring("benzene"), "tool.bond");
    const before = observation.objects.get(molecule().id)!;
    const bond = before.bonds.find(b => b.order === "double")!;
    const from = before.atoms.find(a => a.id === bond.fromAtomId)!, to = before.atoms.find(a => a.id === bond.toAtomId)!;
    const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
    await pointer("pointermove", { x: (from.x + to.x) / 2 - dy / length * 3, y: (from.y + to.y) / 2 + dx / length * 3 });
    const view = container.querySelector(`[data-object-id="${before.id}"]`)!;
    const side = view.getAttribute("data-double-bond-preview-side");
    expect(side).toBeTruthy();
    expect(observation.objects.get(before.id)).toBe(before);
    expect(molecule().bonds).toEqual(before.bonds);
    expect(bridge().snapshot().selectedNativeMoleculePart).toBeUndefined();
    expect(view.querySelectorAll(`.native-bond-line[data-bond-id="${bond.id}"][data-double-bond-side="${side}"]`)).toHaveLength(2);
    expect(container.querySelectorAll(`.page-svg-surface .native-bond-line[data-bond-id="${bond.id}"]`)).toHaveLength(0);
    expect(bridge().hitTest({ page: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 } }).target).toMatchObject({ kind: "bond", bondId: bond.id });
  });
  it("copy as SVG and the agent's document read exclude the uncommitted attachment", async () => {
    const preview = await openPreview();
    const real = current();
    expect(real.pages[0].objects.flatMap(o => o.type === "molecule" ? o.atoms : []).some(a => a.id === preview.id)).toBe(false);
    expect(bridge().snapshot().objects[0]!.atomCount).toBe(6);
    await command("clipboard.copyAs.svg");
    expect(clipboard.write).toHaveBeenCalledOnce();
    const svg = clipboard.write.mock.calls[0]![0].find(item => item.type === "image/svg+xml")!.text;
    expect(svg).toContain("<svg");
    expect(svg).toBe(exportPhase4Svg(copyAsScopedDocument(real), { includeWarnings: false }).contents);
    expect(svg).not.toContain(preview.id);
    expect(container.querySelector('[data-atom-count="7"]')).not.toBeNull();
    expect(current().pages[0].objects[0]).toEqual(real.pages[0].objects[0]);
    expect(editor().value).toBe("OMe");
  });
  it("Spin 3D sends the real six-atom graph to the conformer engine during the preview", async () => {
    const preview = await openPreview();
    await command("structure.spin3d");
    expect(conformer.generate).toHaveBeenCalledOnce();
    const [molfile, atomCount] = conformer.generate.mock.calls[0]! as unknown as [string, number];
    expect(atomCount).toBe(6); expect(Molecule.fromMolfile(molfile).getAllAtoms()).toBe(6);
    expect(molecule().atoms.some(a => a.id === preview.id)).toBe(false);
  });
  it("hover and pointer hit-testing at the preview position never select a phantom atom", async () => {
    const preview = await openPreview();
    const catcher = container.querySelector(`[data-hit-target="atom"][data-atom-id="${preview.id}"]`)!;
    expect(catcher).not.toBeNull();
    await pointer("pointermove", preview, catcher);
    expect(bridge().hitTest({ page: preview }).target).toBeUndefined();
    expect(bridge().snapshot().hoveredNativeTarget).toBeUndefined();
    expect(JSON.stringify(bridge().snapshot().selectedNativeMoleculePart) ?? "").not.toContain(preview.id);
    expect(molecule().atoms).toHaveLength(6);
    // The editor occupies this position; a real pointer press on it keeps the edit open.
    await pointer("pointerdown", preview, editor());
    expect(editor().value).toBe("OMe"); expect(molecule().atoms).toHaveLength(6);
    expect(JSON.stringify(bridge().snapshot().selection)).not.toContain(preview.id);
    expect(JSON.stringify(bridge().snapshot().selectedNativeMoleculePart) ?? "").not.toContain(preview.id);
  });
  it("logs render cost for 500 atoms and keeps all other molecules memoized during ten keystrokes", async () => {
    await mount(largePage(), "tool.select");
    const atoms = current().pages[0].objects.reduce((sum, o) => sum + (o.type === "molecule" ? o.atoms.length : 0), 0);
    expect(atoms).toBeGreaterThanOrEqual(500);
    const before = current().pages[0].objects;
    observation.renders.clear();
    let started = performance.now();
    for (let i = 0; i < 50; i++) await pointer("pointermove", { x: 20 + i * 10, y: 15 });
    for (let i = 0; i < 20; i++) await key("z", { [platform === "macos" ? "metaKey" : "ctrlKey"]: true });
    const total = () => [...observation.renders.values()].reduce((sum, n) => sum + n, 0);
    console.info(`[stress render-cost ${platform}] atoms=${atoms} moves=50 keys=20 objectRenders=${total()} ms=${(performance.now() - started).toFixed(1)}`);
    expect(current().pages[0].objects).toEqual(before);
    await command("tool.atom");
    await pointer("pointerdown", molecule().atoms[45]!, container.querySelector(`[data-object-id="${molecule().id}"]`)!);
    expect(editor()).not.toBeNull();
    const editedId = molecule().id;
    observation.renders.clear(); started = performance.now();
    for (let i = 0; i < 50; i++) await pointer("pointermove", { x: 20 + i * 10, y: 15 });
    // An unbound function key leaves both the inline editor and document untouched.
    for (let i = 0; i < 20; i++) await key("F8");
    for (const char of "OMeabcdefg") {
      await key(char);
      for (const object of before.filter(o => o.id !== editedId)) expect(observation.renders.get(object.id) ?? 0).toBe(0);
    }
    console.info(`[stress render-cost ${platform}] atoms=${atoms} moves=50 keys=20 editChars=10 objectRenders=${total()} otherMoleculeRenders=0 ms=${(performance.now() - started).toFixed(1)}`);
    expect(editor().value).toBe("OMeabcdefg");
  }, 120_000);
});
