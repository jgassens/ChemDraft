import { currentPaletteTarget, type PaletteTarget } from "./window-manager/paletteTarget";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createNativeSavePayload, createNativeSingleBondMolecule, createPhase4Document, selectDocumentObjects } from "./documentWorkflow";
import { representativeMoleculeBondLengthPx } from "./moleculeInspectorModel";
import { moleculeStructureBondColorCommandId, moleculeStructureBondLengthCommandId } from "./commands";
import { DOM_COMMAND_EVENT, PALETTE_COMMAND_CANCEL_EVENT, PALETTE_COMMAND_COMMIT_EVENT, PALETTE_COMMAND_PREVIEW_EVENT, PALETTE_INSPECTOR_ACTION_EVENT } from "./window-manager";
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
  const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const canUndo = () => container.querySelector("main")?.getAttribute("data-can-undo");
  async function deliver(event: string, commandId: string, target = currentPaletteTarget()) {
    await act(async () => window.dispatchEvent(new CustomEvent(event, { detail: { target, commandId } })));
  }
  async function palette(event: string, color = "#0000ff") {
    await act(async () => window.dispatchEvent(new CustomEvent(event, { detail: { target: currentPaletteTarget(), commandId: moleculeStructureBondColorCommandId(color) } })));
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

  it("refuses palette previews and commits for another window or a closed tab", async () => {
    const target = currentPaletteTarget();
    const before = structuredClone(snapshot());
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    for (const foreign of [{ ...target, windowId: "doc-other" }, { ...target, tabId: "closed-tab" }]) {
      for (const event of [PALETTE_COMMAND_PREVIEW_EVENT, PALETTE_COMMAND_COMMIT_EVENT, PALETTE_COMMAND_CANCEL_EVENT]) {
        await act(async () => window.dispatchEvent(new CustomEvent(event, {
          detail: { target: foreign, commandId: moleculeStructureBondColorCommandId("#0000ff") }
        })));
      }
    }
    expect(snapshot()).toEqual(before);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("foreign window"));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("stale tab"));
    expect(container.textContent).toContain("Change not applied: the drawing it was for was closed");
    await palette(PALETTE_COMMAND_COMMIT_EVENT);
    expect(original().style.bondColor).toBe("#0000ff");
    await command("edit.undo");
    expect(snapshot()).toEqual(before);
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

  it.each(["tab switch", "new", "open", "close"])("retains a cancellable preview across %s, settling only for close confirmation", async navigation => {
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
      const bytes = new TextEncoder().encode(createNativeSavePayload(createPhase4Document("Another")).contents);
      Object.defineProperty(fileInput, "files", { configurable: true, value: [{
        name: "Another.chemdraft", size: bytes.length, arrayBuffer: async () => bytes.buffer
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
    if (navigation !== "close") await palette(PALETTE_COMMAND_COMMIT_EVENT);
    await palette(PALETTE_COMMAND_CANCEL_EVENT); // A dismissal after commit cannot undo it.
    expect(original().style.bondColor).toBe("#0000ff");
    await command("edit.undo");
    expect(snapshot().pages[0].objects).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    await command("edit.redo");
    expect(original().style.bondColor).toBe("#0000ff");
  });

  it.each(["commit", "cancel"] as const)("delivers an inactive-tab slider %s without changing the active document, selection, history or view", async ending => {
    const before = structuredClone(snapshot());
    const length = representativeMoleculeBondLengthPx(original());
    const target = currentPaletteTarget();
    await deliver(PALETTE_COMMAND_PREVIEW_EVENT, moleculeStructureBondLengthCommandId(33), target);
    await command("document.new");
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.click({ page: { x: 500, y: 400 } }); });
    await command("edit.selectAll");
    const activeBefore = structuredClone(window.__CHEMDRAFT_AGENT__!.snapshot());
    expect(activeBefore.document.selection.objectIds.length).toBeGreaterThan(0);
    expect(canUndo()).toBe("true");
    await deliver(PALETTE_COMMAND_PREVIEW_EVENT, moleculeStructureBondLengthCommandId(37), target);
    expect(window.__CHEMDRAFT_AGENT__!.snapshot()).toEqual(activeBefore);
    await deliver(ending === "commit" ? PALETTE_COMMAND_COMMIT_EVENT : PALETTE_COMMAND_CANCEL_EVENT,
      moleculeStructureBondLengthCommandId(39), target);
    expect(window.__CHEMDRAFT_AGENT__!.snapshot()).toEqual(activeBefore);
    await command("edit.undo"); // The active tab still has exactly its one drawing entry.
    expect(canUndo()).toBe("false");
    expect(molecules()).toHaveLength(0);
    await act(async () => tabs()[0]!.click());
    expect(representativeMoleculeBondLengthPx(original())).toBeCloseTo(ending === "commit" ? 39 : length);
    expect(snapshot().selection).toEqual(before.selection);
    expect(canUndo()).toBe(ending === "commit" ? "true" : "false");
    if (ending === "commit") {
      await command("edit.undo");
      expect(snapshot()).toEqual(before);
      expect(canUndo()).toBe("false");
      await command("edit.redo");
      expect(representativeMoleculeBondLengthPx(original())).toBeCloseTo(39);
    }
  });

  it("delivers an inactive-tab inspector command and a layout command to that tab's history", async () => {
    const target = currentPaletteTarget();
    const before = structuredClone(snapshot());
    await command("document.new");
    const activeBefore = structuredClone(window.__CHEMDRAFT_AGENT__!.snapshot());
    await deliver(DOM_COMMAND_EVENT, moleculeStructureBondColorCommandId("#ff0000"), target);
    await deliver(DOM_COMMAND_EVENT, "layout.rotate90", target);
    expect(window.__CHEMDRAFT_AGENT__!.snapshot()).toEqual(activeBefore);
    expect(canUndo()).toBe("false");
    await act(async () => tabs()[0]!.click());
    expect(original().style.bondColor).toBe("#ff0000");
    expect(original().atoms).not.toEqual(before.pages[0].objects[0].type === "molecule" ? before.pages[0].objects[0].atoms : []);
    await command("edit.undo");
    expect(original().style.bondColor).toBe("#ff0000");
    await command("edit.undo");
    expect(snapshot()).toEqual(before);
    expect(canUndo()).toBe("false");
  });

  it("keeps a late analysis interpretation action on its inactive drawing", async () => {
    const target = currentPaletteTarget();
    await command("document.new");
    const before = structuredClone(window.__CHEMDRAFT_AGENT__!.snapshot());
    const activeStatus = container.querySelector("[data-status-message]")?.textContent;
    await act(async () => window.dispatchEvent(new CustomEvent(PALETTE_INSPECTOR_ACTION_EVENT, {
      detail: { target, kind: "interpretation", interpretationId: "drawn" }
    })));
    expect(window.__CHEMDRAFT_AGENT__!.snapshot()).toEqual(before);
    expect(container.querySelector("[data-status-message]")?.textContent).toBe(activeStatus);
    await act(async () => tabs()[0]!.click());
    // No Worker in this DOM runtime: the refusal belongs to the captured drawing too.
    expect(container.querySelector("[data-status-message]")?.textContent).toBe("Analysis is unavailable in this runtime");
    expect(canUndo()).toBe("false");
  });

  it("accepts a first preview that arrives after switching away and commits after returning", async () => {
    const before = structuredClone(snapshot());
    const target = currentPaletteTarget();
    await command("document.new");
    const activeBefore = structuredClone(window.__CHEMDRAFT_AGENT__!.snapshot());
    await deliver(PALETTE_COMMAND_PREVIEW_EVENT, moleculeStructureBondLengthCommandId(37), target);
    expect(window.__CHEMDRAFT_AGENT__!.snapshot()).toEqual(activeBefore);
    await act(async () => tabs()[0]!.click());
    await deliver(PALETTE_COMMAND_PREVIEW_EVENT, moleculeStructureBondLengthCommandId(38), target);
    await act(async () => tabs()[1]!.click());
    await act(async () => tabs()[0]!.click());
    await deliver(PALETTE_COMMAND_COMMIT_EVENT, moleculeStructureBondLengthCommandId(39), target);
    expect(representativeMoleculeBondLengthPx(original())).toBeCloseTo(39);
    await command("edit.undo");
    expect(snapshot()).toEqual(before);
    expect(canUndo()).toBe("false");
  });

  it("refuses a release after the captured drawing was closed with a status line", async () => {
    await command("document.new");
    await act(async () => tabs()[0]!.click());
    const target = currentPaletteTarget();
    await deliver(PALETTE_COMMAND_PREVIEW_EVENT, moleculeStructureBondLengthCommandId(33), target);
    const restore = setNativePromptProvider(async prompt => prompt.choices.find(choice => choice.label === "Don't Save")!.id);
    try { await command("document.closeTab"); } finally { restore(); }
    expect(currentPaletteTarget().tabId).not.toBe(target.tabId);
    const before = structuredClone(snapshot());
    await deliver(PALETTE_COMMAND_COMMIT_EVENT, moleculeStructureBondLengthCommandId(39), target);
    expect(snapshot()).toEqual(before);
    expect(canUndo()).toBe("false");
    expect(container.textContent).toContain("Change not applied: the drawing it was for was closed");
  });

  it("refuses a release after a pristine tab's document was replaced with a status line", async () => {
    await command("document.new");
    const target: PaletteTarget = currentPaletteTarget();
    await deliver(PALETTE_COMMAND_PREVIEW_EVENT, moleculeStructureBondLengthCommandId(33), target);
    const fileInput = container.querySelector<HTMLInputElement>('[aria-label="Open native ChemDraft document"]')!;
    const bytes = new TextEncoder().encode(createNativeSavePayload(createPhase4Document("Replacement")).contents);
    Object.defineProperty(fileInput, "files", { configurable: true, value: [{
      name: "Replacement.chemdraft", size: bytes.length, arrayBuffer: async () => bytes.buffer
    }] });
    await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    expect(currentPaletteTarget().tabId).toBe(target.tabId);
    expect(currentPaletteTarget().documentRevision).not.toBe(target.documentRevision);
    const before = structuredClone(snapshot());
    for (const event of [PALETTE_COMMAND_PREVIEW_EVENT, PALETTE_COMMAND_COMMIT_EVENT, PALETTE_COMMAND_CANCEL_EVENT]) {
      await deliver(event, moleculeStructureBondLengthCommandId(39), target);
      expect(snapshot()).toEqual(before);
      expect(container.textContent).toContain("Change not applied: the drawing changed before it could be applied");
    }
    expect(canUndo()).toBe("false");
  });

  it("records consecutive distinct number commits as separate undo entries", async () => {
    const before = representativeMoleculeBondLengthPx(original());
    await palette(PALETTE_COMMAND_PREVIEW_EVENT);
    for (const value of [33, 34]) {
      await act(async () => window.dispatchEvent(new CustomEvent(PALETTE_COMMAND_COMMIT_EVENT, {
        detail: { target: currentPaletteTarget(), commandId: moleculeStructureBondLengthCommandId(value) }
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
