// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPatches } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { ColorPickerPopoverBody, ToolPalette } from "./ToolPalette";
import { createNativeArtGraphicObject, createNativeSingleBondMolecule, createPhase4Document, selectDocumentObjects } from "./documentWorkflow";
import { createMoleculeInspectorModel } from "./moleculeInspectorModel";
import { moleculeStructureBondColorCommandId, objectCustomColorCommandId } from "./commands";
import { getToolsetItemGroups } from "./toolsets";
import { PALETTE_COMMAND_COMMIT_EVENT, PALETTE_COMMAND_PREVIEW_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(["macos", "windows"] as const)("detached palette colour delivery (%s)", platform => {
  it.each(["molecule", "art"] as const)("keeps %s chooser values across delayed model echoes and records one undo", async target => {
    await exercise(target, "chooser");
  });
  it.each(["molecule", "art"] as const)("commits the %s grid's applyAndCommitColor across separate IPC turns once", async target => {
    await exercise(target, "grid");
  });

  async function exercise(target: "molecule" | "art", control: "chooser" | "grid") {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.history.replaceState(null, "", "/?agentBridge=1");
    let drawing = createPhase4Document("Detached colour");
    const object = target === "molecule"
      ? createNativeSingleBondMolecule(drawing, { x: 100, y: 100 })
      : createNativeArtGraphicObject(drawing, { x: 100, y: 100 }, "tool.art.rect")!;
    if (object.type === "molecule") object.style.bondColor = "#000000";
    else object.style.fillColor = "#000000";
    drawing = applyPatches(drawing, [{ op: "addObject", pageId: drawing.pages[0].id, object }]);
    drawing = selectDocumentObjects(drawing, drawing.pages[0].id, [object.id]);
    const main = document.createElement("div"), palette = document.createElement("div");
    document.body.append(main, palette);
    const root = createRoot(main), paletteRoot = createRoot(palette);
    const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
    const selected = () => snapshot().pages[0].objects.find(entry => entry.id === object.id)!;
    const color = () => {
      const current = selected();
      return current.type === "molecule" ? current.style.bondColor : current.style.fillColor;
    };
    // This is the cross-webview transport, not a callback into MainWindow's render.
    // Leave the palette's model prop at black until the pick commits: native IPC
    // echoes can arrive after input/change, unlike a synchronous setState harness.
    const messages: { event: string; commandId: string }[] = [];
    const preview = (commandId: string) => messages.push({ event: PALETTE_COMMAND_PREVIEW_EVENT, commandId });
    const commit = (commandId: string) => messages.push({ event: PALETTE_COMMAND_COMMIT_EVENT, commandId });
    const commandId = target === "molecule" && control === "chooser" ? moleculeStructureBondColorCommandId : objectCustomColorCommandId;
    async function deliver() {
      while (messages.length) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        const { event, commandId } = messages.shift()!;
        await act(async () => { window.dispatchEvent(new CustomEvent(event, { detail: { commandId } })); });
      }
    }
    async function command(id: string) {
      await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); });
    }
    try {
      await act(async () => root.render(<MainWindow initialDocument={drawing} initialPaletteMode="hidden"
        initialRulersVisible={false} initialCrosshairsVisible={false} nativePalette={false} shortcutPlatform={platform} />));
      if (target === "molecule" && control === "grid") await command("object.style.target.stroke");
      const before = structuredClone(selected());
      await act(async () => paletteRoot.render(target === "molecule" && control === "chooser"
        ? <ToolPalette itemGroups={[getToolsetItemGroups("core.drawnStructureSettings").flat().filter(item => item.primary.type === "control")]}
            activeTool="tool.select" onInvoke={() => {}} widgetState={{
              currentMoleculeInspector: createMoleculeInspectorModel(drawing, { selectedObjectIds: [object.id] }),
              onInvoke: () => {}, onMoleculeInspectorPreview: preview, onMoleculeInspectorCommit: commit
            }} />
        : <ColorPickerPopoverBody value="#000000" onPreviewColor={value => preview(commandId(value))}
            onCommitColor={value => commit(commandId(value))} />));
      const picked = control === "grid" ? "#ed0a3f" : "#0000ff";
      if (control === "grid") {
        await act(async () => palette.querySelector<HTMLButtonElement>('[role="tab"]:last-child')!.click());
        await act(async () => palette.querySelector<HTMLButtonElement>('[aria-label="Crayola red"]')!.click());
        expect(messages.map(message => message.event)).toEqual([PALETTE_COMMAND_PREVIEW_EVENT, PALETTE_COMMAND_COMMIT_EVENT]);
        await deliver(); // applyAndCommitColor still gets a React render between the two events.
      } else {
        const input = palette.querySelector<HTMLInputElement>(`input[aria-label="${target === "molecule" ? "Bond color" : "System color wheel"}"]`)!;
        await act(async () => {
          input.focus();
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, picked);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await deliver();
        expect(color()).toBe(picked);
        // No second synthetic value assignment: WebKit's change reads the live
        // input, which 622c4ee9 restored to the stale black controlled prop.
        expect(input.value).toBe(picked);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
        await deliver();
        await act(async () => input.blur());
        expect(messages).toHaveLength(0);
      }
      expect(color()).toBe(picked);
      expect(main.querySelector("main")?.getAttribute("data-can-undo")).toBe("true");
      if (before.type === "molecule") {
        const after = selected();
        expect(after.type === "molecule" && { atoms: after.atoms, bonds: after.bonds, structure: after.structure })
          .toEqual({ atoms: before.atoms, bonds: before.bonds, structure: before.structure });
      }
      // Duplicate commit is harmless, including a delayed native change after blur.
      commit(commandId(picked)); await deliver();
      await command("edit.undo");
      expect(selected()).toEqual(before);
      expect(main.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
      await command("edit.redo");
      expect(color()).toBe(picked);
    } finally {
      await act(async () => { paletteRoot.unmount(); root.unmount(); });
      main.remove(); palette.remove(); delete window.__CHEMDRAFT_AGENT__;
      window.history.replaceState(null, "", "/");
    }
  }
});
