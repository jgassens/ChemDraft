// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { depictSmiles2D, ensureOclResources } from "@chemdraft/ocl-adapter";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, getSelectedMolecule, insertNativeMolfileMolecule, selectDocumentObjects } from "./documentWorkflow";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { openToolsetPopoverWindow, setToolsetPopoverContent } from "./window-manager";

vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  currentWindowLogicalPosition: vi.fn(async () => ({ x: 100, y: 200 })),
  openToolsetPopoverWindow: vi.fn(async () => {}),
  closeToolsetPopoverWindow: vi.fn(async () => {}),
  setToolsetPopoverContent: vi.fn(async () => {}),
  focusCurrentWindowAndWebview: vi.fn(async () => {})
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

let container: HTMLDivElement, root: Root;
const capture = vi.fn();
const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
let captureDescriptors: (PropertyDescriptor | undefined)[];
beforeAll(async () => { await ensureOclResources(); });
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  captureDescriptors = captureMethods.map(name => Object.getOwnPropertyDescriptor(Element.prototype, name));
  for (const name of captureMethods) {
    Object.defineProperty(Element.prototype, name, { configurable: true, value: name === "hasPointerCapture" ? () => false : capture });
  }
  window.history.replaceState(null, "", "/");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  captureDescriptors.forEach((descriptor, i) => {
    if (descriptor) Object.defineProperty(Element.prototype, captureMethods[i], descriptor);
    else Reflect.deleteProperty(Element.prototype, captureMethods[i]);
  });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) };
}
async function mount(platform: ShortcutPlatform) {
  const inserted = insertNativeMolfileMolecule(createPhase4Document("Badge pointer priority"), { x: 250, y: 250 },
    depictSmiles2D("CC=CC", { openUnspecifiedDoubleBonds: true }).molfile, "molfile-v2000");
  const molecule = getSelectedMolecule(inserted)!;
  const doc = selectDocumentObjects(inserted, inserted.pages[0].id, []);
  await act(async () => root.render(<MainWindow initialDocument={doc} initialActiveToolCommandId="tool.select"
    initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false} nativePalette={false}
    shortcutPlatform={platform} />));
  for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
    element.getBoundingClientRect = () => rect(0, 0, 792, 612);
  }
  const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
  Object.defineProperties(canvas, { clientWidth: { value: 792 }, clientHeight: { value: 612 } });
  canvas.focus();
  expect(window.__CHEMDRAFT_AGENT__).toBeUndefined();
  return molecule;
}
const currentDocument = () => getAssistantHistoryPort().read("initial")!;
const object = () => container.querySelector<HTMLElement>(".native-molecule-object")!;
const selection = () => ({
  objectIds: currentDocument().selection.objectIds,
  kind: object().getAttribute("data-selected-native-kind"),
  bondId: object().getAttribute("data-selected-native-bond-id"),
  blob: container.querySelector("[data-selection-blob]")?.outerHTML
});
const status = () => container.querySelector('[role="status"]')?.textContent;
function bondPoint(molecule: MoleculeObject) {
  const bond = molecule.bonds.find(bond => bond.stereo === "either")!;
  const from = molecule.atoms.find(atom => atom.id === bond.fromAtomId)!;
  const to = molecule.atoms.find(atom => atom.id === bond.toAtomId)!;
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, bond };
}
function badgePoint(molecule: MoleculeObject) {
  const badge = container.querySelector<SVGGElement>("[data-unspecified-bond-id]")!;
  const circle = badge.querySelector("circle")!;
  const point = { x: molecule.x + Number(circle.getAttribute("cx")), y: molecule.y + Number(circle.getAttribute("cy")) };
  // jsdom has no SVG layout. Supply the rendered icon's bounds; deliberately send
  // events to the browser's obstructing target, never directly to the badge.
  badge.getBoundingClientRect = () => rect(point.x - 6, point.y - 6, 12, 12);
  return point;
}
function resizeHandles(molecule: MoleculeObject) {
  const frame = container.querySelector<HTMLElement>('[data-molecule-transform-frame="fragment"]')!;
  expect(frame).not.toBeNull();
  const value = (property: string) => Number.parseFloat(frame.style.getPropertyValue(property).replace("calc(", ""));
  const left = molecule.x + value("left"), top = molecule.y + value("top");
  return [...frame.querySelectorAll<HTMLButtonElement>(".object-resize-handle")].map(handle => {
    const corner = handle.getAttribute("data-object-resize-corner")!;
    // Mirror the 18px handle boxes and -8px offsets from App.css; jsdom has no layout.
    const bounds = rect(left + (corner.endsWith("left") ? -8 : value("width") - 10),
      top + (corner.startsWith("top") ? -8 : value("height") - 10), 18, 18);
    handle.getBoundingClientRect = () => bounds;
    return { handle, bounds };
  });
}
function send(target: Element, type: string, point: { x: number; y: number }, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button,
    buttons: type.endsWith("down") ? (button === 0 ? 1 : 2) : 0, clientX: point.x, clientY: point.y, detail: 1 });
  if (type.startsWith("pointer")) Object.defineProperties(event, {
    pointerId: { value: 77 }, pointerType: { value: "mouse" }, isPrimary: { value: true }
  });
  target.dispatchEvent(event);
}
async function click(target: Element, point: { x: number; y: number }) {
  // Separate acts allow the same state updates/renders as distinct native events.
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    await act(async () => { send(target, type, point); });
  }
}
function expectOpenedOnce() {
  expect(openToolsetPopoverWindow).toHaveBeenCalledTimes(1);
  expect(openToolsetPopoverWindow).toHaveBeenCalledWith("core.bondStereo", "flyout", expect.any(Number), expect.any(Number));
  expect(setToolsetPopoverContent).toHaveBeenCalledTimes(1);
  expect(vi.mocked(setToolsetPopoverContent).mock.calls[0][1]).toMatchObject({ kind: "flyout", flyout: { variant: "bondStereo" } });
}

describe.each<ShortcutPlatform>(["macos", "windows"])("badge pointer priority (%s)", platform => {
  it("opens over an overlapping selection handle without starting resize or changing selection", async () => {
    const molecule = await mount(platform);
    await click(object(), bondPoint(molecule));
    const center = badgePoint(molecule);
    const overlap = resizeHandles(molecule).map(({ handle, bounds }) => ({ handle, point: {
      x: Math.max(bounds.left + 0.5, Math.min(bounds.right - 0.5, center.x)),
      y: Math.max(bounds.top + 0.5, Math.min(bounds.bottom - 0.5, center.y))
    } })).find(({ point }) => Math.hypot(point.x - center.x, point.y - center.y) < 6);
    expect(overlap, "fixture must have a real overlap between the badge circle and a handle").toBeDefined();
    const before = currentDocument(), selected = selection(), previousStatus = status();
    capture.mockClear();
    await click(overlap!.handle, overlap!.point);
    expectOpenedOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(status()).toBe(previousStatus);
    expect(selection()).toEqual(selected);
    expect(currentDocument()).toBe(before);
    expect(container.querySelector("[data-selection-marquee]")).toBeNull();
    // A leaked resize/move gesture would apply this movement after the click.
    await act(async () => { send(container.querySelector(".page")!, "pointermove", { x: 330, y: 320 }); });
    expect(currentDocument()).toBe(before);
  });

  it.each(["molecule", "page"])("opens with nothing selected through the %s target without changing selection", async target => {
    const molecule = await mount(platform);
    const before = currentDocument(), selected = selection(), previousStatus = status();
    await click(target === "molecule" ? object() : container.querySelector(".page")!, badgePoint(molecule));
    expectOpenedOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(status()).toBe(previousStatus);
    expect(selection()).toEqual(selected);
    expect(currentDocument()).toBe(before);
  });

  it("still selects a bond away from the badge", async () => {
    const molecule = await mount(platform);
    badgePoint(molecule);
    const point = bondPoint(molecule);
    await click(object(), point);
    expect(object().getAttribute("data-selected-native-kind")).toBe("bond");
    expect(object().getAttribute("data-selected-native-bond-id")).toBe(point.bond.id);
    expect(openToolsetPopoverWindow).not.toHaveBeenCalled();
  });

  it("still starts resize on a handle away from the badge", async () => {
    const molecule = await mount(platform);
    await click(object(), bondPoint(molecule));
    const center = badgePoint(molecule);
    const { handle, bounds } = resizeHandles(molecule)[0];
    const point = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    expect(Math.hypot(point.x - center.x, point.y - center.y)).toBeGreaterThan(12);
    await act(async () => { send(handle, "pointerdown", point); });
    expect(status()).toContain("Resize selected molecule fragment");
    expect(capture).toHaveBeenCalled();
    expect(openToolsetPopoverWindow).not.toHaveBeenCalled();
    await act(async () => { send(container.querySelector(".page")!, "pointercancel", point); });
  });
});
