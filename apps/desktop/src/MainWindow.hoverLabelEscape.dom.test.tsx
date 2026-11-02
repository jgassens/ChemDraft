// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { insertNativeSingleBondMolecule, createPhase4Document, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("hover label Escape (%s shortcuts)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let canvas: HTMLElement;
  let carbon: { x: number; y: number; id: string };
  const molecule = () => container.querySelector<HTMLElement>(".native-molecule-object")!;
  const editor = () => container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
  const chemistry = () => ({
    structure: molecule().getAttribute("data-structure"),
    atoms: molecule().getAttribute("data-atom-count"),
    bonds: molecule().getAttribute("data-bond-count"),
    orders: molecule().getAttribute("data-bond-orders")
  });
  const label = () => container.querySelector("[data-atom-label]")?.getAttribute("data-atom-label");

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    saveKeybindingSettings({ scheme: "chemdraft" });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    const initial = insertNativeSingleBondMolecule(createPhase4Document("Hover label Escape"), { x: 300, y: 300 });
    const object = initial.pages[0].objects[0];
    if (object.type !== "molecule") throw new Error("Expected molecule");
    carbon = object.atoms[1]!;
    await act(async () => root.render(<MainWindow
      initialDocument={selectDocumentObjects(initial, initial.pages[0].id, [])}
      initialActiveToolCommandId="tool.bond" initialPaletteMode="hidden" initialRulersVisible={false}
      initialCrosshairsVisible={false} nativePalette={true} shortcutPlatform={platform}
    />));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    }
    canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    await act(async () => canvas.focus());
  });

  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  async function hover(point: { x: number; y: number }) {
    const event = new MouseEvent("pointermove", { bubbles: true, clientX: point.x, clientY: point.y, buttons: 0 });
    Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => container.querySelector(".page")!.dispatchEvent(event));
  }

  async function key(key: string, init: KeyboardEventInit = {}) {
    await act(async () => (document.activeElement ?? canvas).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
    ));
  }

  it("preserves the committed OH when an empty-canvas key is followed by Escape, with exactly one undo step", async () => {
    const before = chemistry();
    await hover(carbon);
    expect(molecule().dataset.deleteHoverAtomId).toBe(carbon.id);
    await key("o");
    expect(editor()).toBeNull();
    const committed = chemistry();
    expect(committed).toMatchObject({ atoms: before.atoms, bonds: before.bonds, orders: before.orders });
    expect(committed.structure).not.toBe(before.structure);
    expect(label()).toBe("OH");
    expect(container.querySelector('[data-can-undo]')?.getAttribute("data-can-undo")).toBe("true");

    await hover({ x: 650, y: 450 });
    expect(molecule().dataset.deleteHoverAtomId).toBeUndefined();
    await key("o");
    // Empty canvas has no atom-label target; this must not reopen the old atom as "Oo".
    expect(editor()).toBeNull();
    expect(chemistry()).toEqual(committed);
    await key("Escape");
    expect(editor()).toBeNull();
    expect(chemistry()).toEqual(committed);
    expect(label()).toBe("OH");
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/^Selection:/);

    await key("z", { metaKey: platform === "macos", ctrlKey: platform === "windows" });
    expect(chemistry()).toEqual(before);
    expect(container.querySelector('[data-can-undo]')?.getAttribute("data-can-undo")).toBe("false");
    await key("z", { shiftKey: true, metaKey: platform === "macos", ctrlKey: platform === "windows" });
    expect(chemistry()).toEqual(committed);
  });

  it("cancels a text continuation after pointer drift against the committed OH, without removing its undo entry", async () => {
    const before = chemistry();
    await hover(carbon);
    await key("o");
    const committed = chemistry();
    await hover({ x: 650, y: 450 });
    await key("M");
    expect(editor()?.value).toBe("OM");
    await key("Escape");
    expect(editor()).toBeNull();
    expect(chemistry()).toEqual(committed);
    expect(label()).toBe("OH");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Atom label unchanged");
    await key("z", { metaKey: platform === "macos", ctrlKey: platform === "windows" });
    expect(chemistry()).toEqual(before);
    expect(container.querySelector('[data-can-undo]')?.getAttribute("data-can-undo")).toBe("false");
  });

  it("records a text edit started after pointer drift separately from the committed hover edit", async () => {
    const before = chemistry();
    await hover(carbon);
    await key("o");
    const committed = chemistry();
    await hover({ x: 650, y: 450 });
    await key("M");
    expect(editor()?.value).toBe("OM");
    await key("Enter");
    expect(chemistry()).not.toEqual(committed);
    await key("z", { metaKey: platform === "macos", ctrlKey: platform === "windows" });
    expect(chemistry()).toEqual(committed);
    expect(label()).toBe("OH");
    await key("z", { metaKey: platform === "macos", ctrlKey: platform === "windows" });
    expect(chemistry()).toEqual(before);
    expect(container.querySelector('[data-can-undo]')?.getAttribute("data-can-undo")).toBe("false");
  });
});
