// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createNativeSavePayload, createNativeSingleBondMolecule, createPhase4Document, selectDocumentObjects } from "./documentWorkflow";
import { representativeMoleculeBondLengthPx } from "./moleculeInspectorModel";
import { moleculeStructureBondColorCommandId, moleculeStructureBondLengthCommandId } from "./commands";
import { PALETTE_COMMAND_CANCEL_EVENT, PALETTE_COMMAND_COMMIT_EVENT, PALETTE_COMMAND_PREVIEW_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["macos", "windows"] as const)("palette preview interruption (%s)", platform => {
  let root: Root;
  let container: HTMLDivElement;
  let moleculeId: string;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const molecules = () => snapshot().pages[0].objects.filter((object): object is MoleculeObject => object.type === "molecule");
  const original = () => molecules().find(object => object.id === moleculeId)!;
  async function palette(event: string, color = "#0000ff") {
    await act(async () => window.dispatchEvent(new CustomEvent(event, { detail: { commandId: moleculeStructureBondColorCommandId(color) } })));
  }
  async function command(id: string) {
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); });
  }
  beforeEach(async () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    let drawing = createPhase4Document("Palette colour transaction");
    const molecule = createNativeSingleBondMolecule(drawing, { x: 100, y: 100 });
    molecule.style.bondColor = "#000000";
    moleculeId = molecule.id;
    drawing = applyPatches(drawing, [{ op: "addObject", pageId: drawing.pages[0].id, object: molecule }]);
    drawing = selectDocumentObjects(drawing, drawing.pages[0].id, [moleculeId]);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.bond"
      initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false}
      nativePalette={false} shortcutPlatform={platform} />));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    }
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    vi.spyOn(canvas, "clientWidth", "get").mockReturnValue(792);
    vi.spyOn(canvas, "clientHeight", "get").mockReturnValue(612);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it.each(["commit", "cancel"])("preserves a drawn bond when an uncommitted blue preview is followed by a green preview and %s", async ending => {
    const chemistry = structuredClone({ atoms: original().atoms, bonds: original().bonds, structure: original().structure });
    await palette(PALETTE_COMMAND_PREVIEW_EVENT);
    expect(original().style.bondColor).toBe("#0000ff");
    // Deliberately omit both change/commit and blur, reproducing the macOS Colors panel.
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.click({ page: { x: 500, y: 400 } }); });
    expect(molecules()).toHaveLength(2);
    const afterDrawing = structuredClone(snapshot().pages[0].objects);
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, "#00ff00");
    expect(molecules()).toHaveLength(2);
    await palette(ending === "commit" ? PALETTE_COMMAND_COMMIT_EVENT : PALETTE_COMMAND_CANCEL_EVENT, "#00ff00");
    expect(molecules()).toHaveLength(2);
    expect(original().style.bondColor).toBe("#0000ff");
    expect({ atoms: original().atoms, bonds: original().bonds, structure: original().structure }).toEqual(chemistry);
    if (ending === "commit") {
      expect(molecules().find(object => object.id !== moleculeId)!.style.bondColor).toBe("#00ff00");
      await command("edit.undo"); // Green is independent of the bond and blue.
    }
    expect(snapshot().pages[0].objects).toEqual(afterDrawing);
    await command("edit.undo");
    expect(molecules()).toHaveLength(1);
    expect(original().style.bondColor).toBe("#0000ff");
    await command("edit.undo");
    expect(original().style.bondColor).toBe("#000000");
  });

  it("settles before a document command so a late chooser cancel cannot remove its edit", async () => {
    await palette(PALETTE_COMMAND_PREVIEW_EVENT);
    await command("layout.duplicate");
    expect(molecules()).toHaveLength(2);
    const afterCommand = structuredClone(snapshot().pages[0].objects);
    await palette(PALETTE_COMMAND_CANCEL_EVENT);
    expect(snapshot().pages[0].objects).toEqual(afterCommand);
    await command("edit.undo");
    expect(molecules()).toHaveLength(1);
    expect(original().style.bondColor).toBe("#0000ff");
    await command("edit.undo");
    expect(original().style.bondColor).toBe("#000000");
  });

  it("settles a preview before undo/redo and ignores later cancellation", async () => {
    await palette(PALETTE_COMMAND_PREVIEW_EVENT);
    await command("edit.undo");
    expect(original().style.bondColor).toBe("#000000");
    await palette(PALETTE_COMMAND_CANCEL_EVENT);
    await command("edit.redo");
    expect(original().style.bondColor).toBe("#0000ff");
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, "#00ff00");
    await command("edit.redo"); // Settling a new edit clears the redo branch.
    await palette(PALETTE_COMMAND_CANCEL_EVENT);
    expect(original().style.bondColor).toBe("#00ff00");
    await command("edit.undo");
    expect(original().style.bondColor).toBe("#0000ff");
  });

  it.each(["tab switch", "new", "open", "close"])("settles an uncommitted colour before %s cleanup chooses its rollback snapshot", async navigation => {
    const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    // Close Document Tab is disabled while only one document is open, so the close case needs a second tab, like the tab switch.
    if (navigation === "tab switch" || navigation === "close") {
      await command("document.new");
      await act(async () => tabs()[0]!.click());
    }
    const before = structuredClone(snapshot().pages[0].objects);
    await palette(PALETTE_COMMAND_PREVIEW_EVENT); // No native change or blur.
    if (navigation === "tab switch") {
      await act(async () => tabs()[1]!.click());
    } else if (navigation === "new") {
      await command("document.new");
    } else if (navigation === "open") {
      const fileInput = container.querySelector<HTMLInputElement>('[aria-label="Open native ChemDraft document"]')!;
      Object.defineProperty(fileInput, "files", { configurable: true, value: [{
        name: "Another.chemdraft", text: async () => createNativeSavePayload(createPhase4Document("Another")).contents
      }] });
      await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    } else {
      let pendingPrompt: { prompt: NativePromptOptions; resolve: (id: string) => void } | undefined;
      const restorePromptProvider = setNativePromptProvider(prompt => new Promise(resolve => {
        pendingPrompt = { prompt, resolve };
      }));
      try {
        await command("document.closeTab");
        expect(pendingPrompt?.prompt.title).toBe("Save changes before closing?");
        const { prompt, resolve } = pendingPrompt!;
        const cancel = prompt.choices.find(choice => choice.label === "Cancel");
        expect(cancel).toBeDefined();
        await act(async () => resolve(cancel!.id));
      } finally {
        restorePromptProvider();
      }
    }
    if (navigation !== "close") {
      expect(tabs()).toHaveLength(2);
      await act(async () => tabs()[0]!.click());
    }
    expect(original().style.bondColor).toBe("#0000ff");
    await palette(PALETTE_COMMAND_CANCEL_EVENT); // Late chooser dismissal cannot undo settlement.
    expect(original().style.bondColor).toBe("#0000ff");
    await command("edit.undo");
    expect(snapshot().pages[0].objects).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    await command("edit.redo");
    expect(original().style.bondColor).toBe("#0000ff");
  });

  it("records consecutive distinct number commits as separate undo entries", async () => {
    const before = representativeMoleculeBondLengthPx(original());
    await palette(PALETTE_COMMAND_PREVIEW_EVENT);
    for (const value of [33, 34]) {
      await act(async () => window.dispatchEvent(new CustomEvent(PALETTE_COMMAND_COMMIT_EVENT, {
        detail: { commandId: moleculeStructureBondLengthCommandId(value) }
      })));
    }
    expect(representativeMoleculeBondLengthPx(original())).toBeCloseTo(34);
    await command("edit.undo");
    expect(representativeMoleculeBondLengthPx(original())).toBeCloseTo(33);
    await command("edit.undo");
    expect(representativeMoleculeBondLengthPx(original())).toBeCloseTo(before);
    expect(original().style.bondColor).toBe("#0000ff");
    await command("edit.undo");
    expect(original().style.bondColor).toBe("#000000");
  });

  it("keeps successive live values from the same colour field in one preview entry", async () => {
    await palette(PALETTE_COMMAND_PREVIEW_EVENT);
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, "#00ff00");
    await palette(PALETTE_COMMAND_COMMIT_EVENT, "#00ff00");
    expect(original().style.bondColor).toBe("#00ff00");
    await command("edit.undo");
    expect(original().style.bondColor).toBe("#000000");
  });
});
