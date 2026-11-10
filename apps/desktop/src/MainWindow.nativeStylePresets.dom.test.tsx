// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Acs1996StylePreset, RscJournalStylePreset, SketchStylePreset, createEmptyDocument } from "@chemdraft/chem-core";
import { createSmilesMolecule, createNativeTextObject } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { nativeStylePresetCommandId } from "./commands";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("MainWindow native style presets (%s)", platform => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  const read = () => getAssistantHistoryPort().read("initial")!;

  it.each([Acs1996StylePreset, RscJournalStylePreset, SketchStylePreset])("applies $name in one labelled entry and restores exact undo/redo snapshots", async preset => {
    const initial = createEmptyDocument();
    initial.pages[0]!.objects.push(createSmilesMolecule(initial, { x: 180, y: 180 }, {
      atoms: [{ element: "C", x: 0, y: 0, charge: 0 }, { element: "N", x: 1, y: 0, charge: 1 }],
      bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
    }, "C[NH3+]", undefined, { bondLengthPx: 30 }));
    initial.pages[0]!.objects.push(createNativeTextObject(initial, { x: 150, y: 240 }, "Caption"));
    await act(async () => root.render(<MainWindow initialDocument={initial} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} shortcutPlatform={platform} />));
    const before = structuredClone(read());
    await command(nativeStylePresetCommandId(preset.id));
    const after = structuredClone(read());
    expect(after.styles.drawing).toEqual(preset.drawing);
    expect(after.selection.objectIds).toEqual(after.pages[0]!.objects.map(object => object.id));
    expect(after.pages[0]!.objects.every(object => object.style.stylePresetId === preset.id)).toBe(true);
    await command("edit.undo");
    expect(read()).toEqual(before);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`Undid ${preset.name}`);
    await command("edit.undo");
    expect(read()).toEqual(before);
    await command("edit.redo");
    expect(read()).toEqual(after);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`Redid ${preset.name}`);
    await command(nativeStylePresetCommandId(preset.id));
    expect(read()).toEqual(after);
    await command("edit.undo");
    expect(read()).toEqual(before); // Applying the same preset added no entry.
  });

  it("uses selection scope when anything is selected and leaves other objects/defaults unchanged", async () => {
    const initial = createEmptyDocument();
    initial.pages[0]!.objects.push(createNativeTextObject(initial, { x: 100, y: 100 }, "Selected"));
    initial.pages[0]!.objects.push({ ...createNativeTextObject(initial, { x: 200, y: 200 }, "Untouched"), id: "untouched" });
    initial.selection = { pageId: initial.pages[0]!.id, objectIds: [initial.pages[0]!.objects[0]!.id] };
    await act(async () => root.render(<MainWindow initialDocument={initial} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} shortcutPlatform={platform} />));
    const before = structuredClone(read());
    await command(nativeStylePresetCommandId(Acs1996StylePreset.id));
    expect(read().styles).toEqual(before.styles);
    expect(read().pages[0]!.objects[1]).toEqual(before.pages[0]!.objects[1]);
    expect(read().pages[0]!.objects[0]!.style.stylePresetId).toBe(Acs1996StylePreset.id);
    await command("edit.undo");
    expect(read()).toEqual(before);
  });
});
