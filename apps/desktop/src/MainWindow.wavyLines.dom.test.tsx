import { currentPaletteTarget } from "./window-manager/paletteTarget";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatches, moleculeToMolfileV2000, type GraphicObject, type MoleculeObject } from "@chemdraft/chem-core";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { MainWindow } from "./MainWindow";
import { createNativeSingleBondMolecule, createPhase4Document, insertNativeArtGraphicObject, selectDocumentObjects } from "./documentWorkflow";
import { objectWaveCommandId, objectWaveCommands, objectWaveForCommand } from "./commands";
import { PALETTE_COMMAND_CANCEL_EVENT, PALETTE_COMMAND_COMMIT_EVENT, PALETTE_COMMAND_PREVIEW_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pointer(type: string, options: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, ...options });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

describe.each(["macos", "windows"] as const)("registered wave edits (%s)", platform => {
  let root: Root;
  let container: HTMLDivElement;
  let registry: CommandRegistry;
  let invokeSpy: MockInstance<CommandRegistry["invoke"]>;
  let waveIds: string[];
  let moleculeId: string;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const objects = () => snapshot().pages[0].objects;
  const waves = () => objects().filter((object): object is GraphicObject => waveIds.includes(object.id) && object.type === "graphic");
  const molecule = () => objects().find(object => object.id === moleculeId) as MoleculeObject;
  const canonical = (object: MoleculeObject) => Molecule.fromMolfile(moleculeToMolfileV2000(object, { kekuleBondOrders: new Map() }).contents).toSmiles();
  const moleculeSvg = () => container.querySelector(`[data-object-id="${moleculeId}"].native-molecule-object`)?.innerHTML;
  async function palette(event: string, commandId = objectWaveCommandId("height", 18)) {
    await act(async () => { window.dispatchEvent(new CustomEvent(event, { detail: { target: currentPaletteTarget(), commandId } })); });
  }
  async function command(id: string) {
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); });
  }
  beforeEach(async () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.history.replaceState(null, "", "/?agentBridge=1");
    let drawing = createPhase4Document("Wave registry integration");
    drawing = insertNativeArtGraphicObject(drawing, { x: 220, y: 180 }, "tool.art.lineWavy");
    drawing = insertNativeArtGraphicObject(drawing, { x: 320, y: 240 }, "tool.art.lineWavy");
    waveIds = drawing.pages[0].objects.map(object => object.id);
    drawing = applyPatches(drawing, [
      { op: "updateObject", objectId: waveIds[0], changes: { x: 220, y: 180, width: 2, height: 1,
        data: { artPathKind: "wavy", lineStart: { x: 220, y: 180 }, lineEnd: { x: 222, y: 180 } } } },
      { op: "updateObject", objectId: waveIds[1], changes: { x: 320, y: 240, width: 12, height: 16,
        data: { artPathKind: "wavy", lineStart: { x: 320, y: 240 }, lineEnd: { x: 332, y: 256 } } } }
    ]);
    drawing = insertNativeArtGraphicObject(drawing, { x: 520, y: 180 }, "tool.art.lineWavy");
    const unselectedWaveId = drawing.selection.objectIds[0];
    drawing = insertNativeArtGraphicObject(drawing, { x: 420, y: 180 }, "tool.art.rect");
    drawing = insertNativeArtGraphicObject(drawing, { x: 420, y: 260 }, "tool.art.line");
    const mol = createNativeSingleBondMolecule(drawing, { x: 100, y: 100 });
    moleculeId = mol.id;
    // V2000 stereo=4 is a source wavy/either single bond. Main has no native wavy
    // single-bond display enum: preserve its source and existing native display exactly.
    const lines = moleculeToMolfileV2000(mol, { kekuleBondOrders: new Map() }).contents.split("\n");
    const bondLine = lines.findIndex(line => line.includes("V2000")) + 1 + mol.atoms.length;
    lines[bondLine] = `${lines[bondLine].slice(0, 9)}  4${lines[bondLine].slice(12)}`;
    mol.structure = lines.join("\n"); mol.structureFormat = "molfile-v2000";
    drawing = applyPatches(drawing, [{ op: "addObject", pageId: drawing.pages[0].id, object: mol }]);
    drawing = selectDocumentObjects(drawing, drawing.pages[0].id, drawing.pages[0].objects.filter(object => object.id !== unselectedWaveId).map(object => object.id));
    const registerSpy = vi.spyOn(CommandRegistry.prototype, "register");
    invokeSpy = vi.spyOn(CommandRegistry.prototype, "invoke");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false}
      nativePalette={false} shortcutPlatform={platform} />));
    registry = registerSpy.mock.contexts.find((candidate): candidate is CommandRegistry =>
      candidate instanceof CommandRegistry && candidate.has(objectWaveCommands[0].id))!;
    expect(registry).toBeDefined();
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it("executes every registered slider value and leaves the mixed selection's molecule and other graphics unchanged", async () => {
    const before = structuredClone(objects().filter(object => !waveIds.includes(object.id)));
    const selection = structuredClone(snapshot().selection);
    const smiles = canonical(molecule());
    const sourceSmiles = Molecule.fromMolfile(molecule().structure).toSmiles();
    expect(smiles).toBe("CC");
    expect(sourceSmiles).toBe("CC");
    expect(molecule().structure.split("\n").some(line => /^  1  2  1  4/.test(line))).toBe(true);
    const svg = moleculeSvg();
    expect(svg).toBeTruthy();
    await act(async () => {
      for (const { id } of objectWaveCommands) {
        expect(registry.has(id), id).toBe(true);
        await registry.invoke(id);
        const parsed = objectWaveForCommand(id)!;
        const key = { smoothness: "waveSmoothness", height: "waveHeight", width: "waveWidth" }[parsed.setting] as "waveSmoothness" | "waveHeight" | "waveWidth";
        for (const object of waves()) expect(object.data[key], id).toBe(parsed.value);
      }
    });
    expect(objects().filter(object => !waveIds.includes(object.id))).toEqual(before);
    expect(snapshot().selection).toEqual(selection);
    expect(canonical(molecule())).toBe(smiles);
    expect(Molecule.fromMolfile(molecule().structure).toSmiles()).toBe(sourceSmiles);
    expect(moleculeSvg()).toBe(svg);
  });

  it("routes an app command through the registry and restores exact states on Undo/Redo", async () => {
    const before = structuredClone(objects());
    const id = objectWaveCommandId("width", 24);
    await command(id);
    expect(invokeSpy).toHaveBeenCalledWith(id);
    expect(waves().every(object => object.data.waveWidth === 24)).toBe(true);
    const after = structuredClone(objects());
    await command("edit.undo");
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    await command("edit.redo");
    expect(objects()).toEqual(after);
  });

  it.each(["smoothness", "height", "width"] as const)("labels a %s keyboard step in undo history", async setting => {
    await command("view.toolset.toggle.core.art");
    const slider = container.querySelector<HTMLInputElement>(`[aria-label="Wave ${setting}"]`)!;
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    const dataKey = ({ smoothness: "waveSmoothness", height: "waveHeight", width: "waveWidth" } as const)[setting];
    const value = waves()[0].data[dataKey];
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`Wave ${setting} set to ${value}${setting === "smoothness" ? "%" : " px"}`);
    await command("edit.undo");
    expect(container.textContent).toContain(`Undid Updated wave ${setting}`);
  });

  it("cancels a detached palette preview when Escape reaches the document window", async () => {
    const before = structuredClone(objects());
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("width", 59));
    expect(waves().every(object => object.data.waveWidth === 59)).toBe(true);
    const canceled = vi.fn();
    window.addEventListener(PALETTE_COMMAND_CANCEL_EVENT, canceled);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    window.removeEventListener(PALETTE_COMMAND_CANCEL_EVENT, canceled);
    expect(canceled).toHaveBeenCalledOnce();
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it("disarms the palette pointer when cancellation arrives from the document window", async () => {
    await command("view.toolset.toggle.core.art");
    const slider = container.querySelector<HTMLInputElement>('[aria-label="Wave width"]')!;
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
      right: 100, bottom: 20, width: 100, height: 20, toJSON: () => ({}) });
    const before = structuredClone(objects());
    await act(async () => { slider.dispatchEvent(pointer("pointerdown", { clientX: 45, buttons: 1 })); });
    await palette(PALETTE_COMMAND_CANCEL_EVENT, "palette.preview.cancel");
    invokeSpy.mockClear();
    await act(async () => { slider.dispatchEvent(pointer("pointerup", { clientX: 45 })); });
    expect(invokeSpy.mock.calls.filter(([id]) => id.startsWith("object.wave."))).toEqual([]);
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it.each(["document", "palette"])("lets an expanded menu own Escape before cancelling a wave drag in the %s", async source => {
    const before = structuredClone(objects());
    await command("view.toolset.toggle.core.art");
    const slider = container.querySelector<HTMLInputElement>('[aria-label="Wave width"]')!;
    if (source === "palette") {
      vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
        right: 100, bottom: 20, width: 100, height: 20, toJSON: () => ({}) });
      await act(async () => { slider.dispatchEvent(pointer("pointerdown", { clientX: 45, buttons: 1 })); });
    } else {
      await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("width", 59));
    }
    const preview = structuredClone(objects());
    expect(preview).not.toEqual(before);
    const menu = container.querySelector<HTMLButtonElement>('[data-menu-section="file"]')!;
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    const canceled = vi.fn();
    window.addEventListener(PALETTE_COMMAND_CANCEL_EVENT, canceled);
    try {
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
      expect(menu.getAttribute("aria-expanded")).toBe("false");
      expect(objects()).toEqual(preview);
      expect(canceled).not.toHaveBeenCalled();
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
      expect(objects()).toEqual(before);
      invokeSpy.mockClear();
      await act(async () => { slider.dispatchEvent(pointer("pointerup", { clientX: 45 })); });
      expect(invokeSpy.mock.calls.filter(([id]) => id.startsWith("object.wave."))).toEqual([]);
      expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    } finally {
      window.removeEventListener(PALETTE_COMMAND_CANCEL_EVENT, canceled);
    }
  });

  it.each(["document", "palette"])("lets a modal own Escape before cancelling a wave drag in the %s", async source => {
    const before = structuredClone(objects());
    if (source === "palette") {
      await command("view.toolset.toggle.core.art");
      const slider = container.querySelector<HTMLInputElement>('[aria-label="Wave width"]')!;
      vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
        right: 100, bottom: 20, width: 100, height: 20, toJSON: () => ({}) });
      await act(async () => { slider.dispatchEvent(pointer("pointerdown", { clientX: 45, buttons: 1 })); });
    } else {
      await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("width", 59));
    }
    const preview = structuredClone(objects());
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    container.append(modal);
    const close = vi.fn((event: KeyboardEvent) => { event.preventDefault(); modal.hidden = true; });
    modal.addEventListener("keydown", close);
    await act(async () => { modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(close).toHaveBeenCalledOnce();
    expect(modal.hidden).toBe(true);
    expect(objects()).toEqual(preview);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it("excludes per-value wave tiles from the mounted Customize gallery", async () => {
    await command("view.customizeMainToolbar");
    const gallery = container.querySelector('[aria-label="Toolbar item gallery"]');
    expect(gallery).not.toBeNull();
    const waveTitles = new Set(objectWaveCommands.map(command => command.title));
    const waveTiles = [...gallery!.querySelectorAll("button")].filter(button =>
      waveTitles.has(button.getAttribute("aria-label") ?? ""));
    expect(waveTiles).toHaveLength(0);
  });

  it.each(["release", "Escape", "pointercancel", "blur"])("handles a real slider drag ending in %s", async ending => {
    await command("view.toolset.toggle.core.art");
    const slider = container.querySelector<HTMLInputElement>('[aria-label="Wave height"]')!;
    expect(slider).not.toBeNull();
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ x: 10, y: 4, left: 10, top: 4,
      right: 110, bottom: 22, width: 100, height: 18, toJSON: () => ({}) });
    const before = structuredClone(objects());
    invokeSpy.mockClear();
    await act(async () => {
      slider.focus();
      slider.dispatchEvent(pointer("pointerdown", { clientX: 35, buttons: 1 }));
      slider.dispatchEvent(pointer("pointermove", { clientX: 60, buttons: 1 }));
    });
    expect(waves().every(object => object.data.waveHeight === 24)).toBe(true);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    await act(async () => {
      if (ending === "Escape") slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (ending === "pointercancel") slider.dispatchEvent(pointer("pointercancel"));
      if (ending === "blur") slider.blur();
      slider.dispatchEvent(pointer("pointerup", { clientX: 60 }));
    });
    const invocations = invokeSpy.mock.calls.filter(([id]) => id.startsWith("object.wave."));
    if (ending === "release") {
      expect(invocations).toEqual([[objectWaveCommandId("height", 24)]]);
      const after = structuredClone(objects());
      await command("edit.undo");
      expect(objects()).toEqual(before);
      expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
      await command("edit.redo");
      expect(objects()).toEqual(after);
    } else {
      expect(invocations).toEqual([]);
      expect(objects()).toEqual(before);
      expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    }
  });

  it("commits successive palette previews once through the registry, then undoes/redoes exactly", async () => {
    const before = structuredClone(objects());
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("height", 12));
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("height", 18));
    expect(waves().every(object => object.data.waveHeight === 18)).toBe(true);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    invokeSpy.mockClear();
    await palette(PALETTE_COMMAND_COMMIT_EVENT);
    expect(invokeSpy.mock.calls.filter(([id]) => id === objectWaveCommandId("height", 18))).toHaveLength(1);
    const after = structuredClone(objects());
    await command("edit.undo");
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    await command("edit.redo");
    expect(objects()).toEqual(after);
  });

  it("cancels palette previews without metadata, chemistry, display or history changes", async () => {
    const before = structuredClone(objects());
    await palette(PALETTE_COMMAND_PREVIEW_EVENT);
    expect(waves().every(object => object.data.waveHeight === 18)).toBe(true);
    await palette(PALETTE_COMMAND_CANCEL_EVENT);
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });
});
