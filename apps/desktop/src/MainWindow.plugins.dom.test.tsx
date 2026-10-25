// @vitest-environment jsdom
import { act } from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantCapabilityPermissions, PluginPanelReportSchema, type PluginCommandContext, type PluginAssistantToolResult } from "@chemdraft/plugin-api";
import { applyPatch, createEmptyDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule, pastedStructureDepictionFromMolfile } from "@chemdraft/document-workflow-core";
import { ensureRdkit, generateSmiles2DMolfile, setRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/conformer";
import { applyChargeToolAtPoint } from "./documentWorkflow";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { buildMoveObjects, inspectMolecule } from "./assistant/writeBuilder";
import { testContext } from "./assistant/tools/testContext";
import type { AssistantToolContext } from "./assistant/AssistantToolContext";
import { pluginPanelWindowId, requestPluginPanelAction } from "./plugins/panelBridge";
import { MainWindow } from "./MainWindow";
import type { DesktopPluginRuntime } from "./plugins/createPluginRuntime";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
// Keep the ruler's DOM hit surface; jsdom does not implement its canvas painting context.
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
const captured = vi.hoisted(() => ({ runtime: undefined as DesktopPluginRuntime | undefined,
  assistantContext: undefined as import("./plugins/createPluginRuntime").DesktopPluginRuntimeOptions["assistantContext"] }));
const panelActions = vi.hoisted(() => ({ handler: undefined as Parameters<typeof import("./plugins/panelBridge").listenForPluginPanelActions>[0] | undefined }));
vi.mock("./plugins/panelBridge", async original => {
  const actual = await original<typeof import("./plugins/panelBridge")>();
  return { ...actual, listenForPluginPanelActions: (handler: typeof panelActions.handler) => {
    panelActions.handler = handler;
    return actual.listenForPluginPanelActions(handler!);
  } };
});
vi.mock("./plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("./plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: import("./plugins/createPluginRuntime").DesktopPluginRuntimeOptions) => {
    captured.runtime = actual.createPluginRuntime({ ...options,
      ...(captured.assistantContext ? { assistantContext: captured.assistantContext } : {}) });
    return captured.runtime;
  } };
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
const pluginId = "org.chemdraft.overlayTest";
const overlayId = `overlay.overlayTest.${"long".repeat(20)}`;
const commandId = "plugin.overlayTest.submit";
const selectId = "plugin.overlayTest.select";
const foreignId = "plugin.foreignOverlay.run";
const submit = vi.fn<(context: PluginCommandContext) => Promise<void>>();
const select = vi.fn<(context: PluginCommandContext) => Promise<void>>();
let root: Root;
let container: HTMLDivElement;

describe("assistant writes through mounted desktop normalization", () => {
  let chemistry: AssistantToolContext["chemistry"];
  beforeEach(() => {
    // jsdom rewrites import.meta.url to HTTP, so load the real vendored WASM by filesystem path.
    const glue = resolve("packages/rdkit-adapter/vendor/RDKit_minimal.js");
    const factory = new Function("require", "__dirname", `${readFileSync(glue, "utf8")}\n;return initRDKitModule;`)(
      createRequire(glue), resolve("packages/rdkit-adapter/vendor"));
    setRdkitModuleLoader(() => factory({ wasmBinary: new Uint8Array(readFileSync(resolve("packages/rdkit-adapter/vendor/RDKit_minimal.wasm"))) }));
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    chemistry = { ...testContext().context.chemistry,
      inspectStructure: async (_format, value) => {
        const rdkit = await ensureRdkit();
        const molecule = rdkit.get_mol(value);
        if (!molecule) return { valid: false, reason: "Invalid structure" };
        try {
          const graph = JSON.parse((molecule as typeof molecule & { get_json(): string }).get_json());
          return { valid: true, canonicalSmiles: molecule.get_smiles!(), formula: "test-only", warnings: [],
            heavyAtoms: graph.molecules.reduce((n: number, mol: { atoms: { z?: number }[] }) =>
              n + mol.atoms.filter(atom => (atom.z ?? graph.defaults?.atom?.z ?? 6) !== 1).length, 0) };
        } finally { molecule.delete(); }
      },
      structureFromSmiles: async ({ smiles }) => ({ available: true, built: true,
        object: createSmilesMolecule(getAssistantHistoryPort().read("initial")!, { x: 200, y: 200 },
          pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(smiles)), smiles) })
    };
    captured.assistantContext = () => ({ chemistry, now: () => new Date(), render: testContext().context.render });
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    captured.runtime = undefined; captured.assistantContext = undefined;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  async function mount(drawing: ChemDraftDocument) {
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialPaletteMode="hidden"
      initialRulersVisible={false} nativePalette={false} />));
    const port = getAssistantHistoryPort();
    return { port, push: vi.spyOn(port, "push"), amend: vi.spyOn(port, "amend"), select: vi.spyOn(port, "select") };
  }
  async function call(name: string, input: unknown) {
    let result!: PluginAssistantToolResult;
    await act(async () => {
      const id = "org.chemdraft.normalizationTest";
      const command = "plugin.normalizationTest.run";
      captured.runtime!.registerPlugin({ id, name: "Normalization test", version: "0.1.0", apiVersion: "^0.1.14",
        entry: "test.js", permissions: [...AssistantCapabilityPermissions], contributes: { commands: [{ id: command, title: "Test" }] }
      }, { commandHandlers: { [command]: async context => {
        const request = await context.assistant!.beginRequest({ prompt: name });
        try { result = await context.assistant!.callTool({ name, input }); }
        finally { await context.assistant!.endRequest(request); }
      } } });
      await captured.runtime!.host.invokeCommand(command);
    });
    return result;
  }

  it.each([
    { selectedMark: false, kind: "charge" }, { selectedMark: true, kind: "charge" },
    { selectedMark: false, kind: "lone-pair" }, { selectedMark: true, kind: "radical-dot" }
  ] as const)("refuses a relative move that would attach a $kind mark (selected: $selectedMark), without changing document or history", async ({ selectedMark, kind }) => {
    const fixture = testContext();
    const input = { objectIds: [fixture.molecule.id], to: { relativeTo: fixture.text.id, side: "right" as const } };
    const drawing = fixture.context.getDocument()!;
    const planned = applyPatch(drawing, buildMoveObjects(fixture.context, input).patch);
    const moved = planned.pages[0]!.objects.find(object => object.id === fixture.molecule.id)! as MoleculeObject;
    const atom = moved.atoms[0]!;
    const withMark = applyChargeToolAtPoint(drawing, kind === "charge" ? 1 : { kind }, { x: atom.x - 30, y: atom.y });
    const mark = withMark.pages[0]!.objects.find(object => object.type === "electron-mark")!;
    const { port, push, amend, select } = await mount(applyPatch(withMark, { op: "setSelection",
      objectIds: [fixture.molecule.id, ...(selectedMark ? [mark.id] : [])] }));
    const before = port.read("initial")!;
    expect(before.pages[0]!.objects.find(object => object.id === mark.id)).toMatchObject({ anchor: { kind: "point" } });
    expect((await inspectMolecule({ ...fixture.context, chemistry }, before.pages[0]!.objects[0] as MoleculeObject)).canonicalSmiles).toBe("CC");
    const result = await call("move_objects", input);
    // Before the guard, this mounted path reported success with [] warnings and committed
    // [CH2+]C instead of CC, while changing the unselected mark's anchor from point to atom.
    expect(result.isError, JSON.stringify(result)).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(selectedMark
      ? kind === "charge" ? "change its atom count or charges" : "canonical isomeric SMILES"
      : `attach the unselected ${kind} mark ${mark.id}`) });
    const after = port.read("initial")!;
    expect(after).toBe(before);
    expect(push).not.toHaveBeenCalled(); expect(amend).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
  });

  it("refuses a keep-position replacement that would absorb a floating charge mark atomically", async () => {
    const fixture = testContext();
    const drawing = fixture.context.getDocument()!;
    const replacement = createSmilesMolecule(drawing, { x: 250, y: 250 },
      pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile("CCCCCCCC")), "CCCCCCCC");
    const terminal = replacement.atoms.reduce((left, atom) => atom.x < left.x ? atom : left);
    const withMark = applyChargeToolAtPoint(drawing, 1, terminal);
    const mark = withMark.pages[0]!.objects.find(object => object.type === "electron-mark")!;
    const { port, push, amend, select } = await mount(applyPatch(withMark, { op: "setSelection", objectIds: [fixture.molecule.id] }));
    const before = port.read("initial")!;
    expect(before.pages[0]!.objects.find(object => object.id === mark.id)).toMatchObject({ anchor: { kind: "point" } });
    const result = await call("edit_structure", { objectId: fixture.molecule.id, smiles: "CCCCCCCC", keepPosition: true });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`unselected charge mark ${mark.id}`) });
    expect(port.read("initial")).toBe(before);
    expect(push).not.toHaveBeenCalled(); expect(amend).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
  });

  it("automatically inserts away from a floating charge mark and records the unchanged mark", async () => {
    const drawing = applyChargeToolAtPoint(createEmptyDocument(), 1, { x: 300, y: 300 });
    captured.assistantContext = () => ({ chemistry, now: () => new Date(), render: testContext().context.render,
      getViewportRect: () => ({ x: 100, y: 100, width: 400, height: 400 }) });
    const { port, push } = await mount(applyPatch(drawing, { op: "setSelection", objectIds: [] }));
    const before = port.read("initial")!;
    const mark = before.pages[0]!.objects[0]!;
    const result = await call("insert_structures", { items: [{ kind: "molecule", smiles: "CC" }] });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const after = port.read("initial")!;
    expect(after.pages[0]!.objects.find(object => object.id === mark.id)).toEqual(mark);
    const molecule = after.pages[0]!.objects.find(object => object.type === "molecule")! as MoleculeObject;
    expect((await inspectMolecule({ ...testContext().context, chemistry }, molecule)).canonicalSmiles).toBe("CC");
    expect(push).toHaveBeenCalledOnce();
    expect(after.selection.objectIds).toEqual([molecule.id]);
  });

  it.each(["move_objects", "insert_structures", "edit_structure"])("keeps ordinary %s writes working", async name => {
    const fixture = testContext();
    const { port, push } = await mount(applyPatch(fixture.context.getDocument()!, { op: "setSelection", objectIds: [fixture.molecule.id] }));
    const input = name === "move_objects" ? { objectIds: [fixture.molecule.id], to: { relativeTo: fixture.text.id, side: "right" } }
      : name === "insert_structures" ? { items: [{ kind: "molecule", smiles: "CO" }] }
        : { objectId: fixture.molecule.id, smiles: "CO", keepPosition: true };
    const result = await call(name, input);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const after = port.read("initial")!;
    const molecule = after.pages[0]!.objects.find(object => after.selection.objectIds.includes(object.id))! as MoleculeObject;
    expect((await inspectMolecule({ ...fixture.context, chemistry }, molecule)).canonicalSmiles).toBe(name === "move_objects" ? "CC" : "CO");
    expect(push).toHaveBeenCalledOnce();
  });
});

function input(value: string): void {
  const textarea = container.querySelector(".plugin-canvas-overlay textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}
async function send(): Promise<void> {
  await act(async () => container.querySelector(".plugin-canvas-overlay textarea")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}

/** jsdom has no browser text insertion default. Deliver each real DOM key event to the
 * focused element, then emulate only its uncancelled text insertion (never refocus it).
 * These traverse MainWindow's document/window shortcut listeners, not the agent bridge. */
async function typeAtFocus(text: string): Promise<void> {
  for (const key of text) await act(async () => {
    const target = document.activeElement!;
    const options = { key, code: key === " " ? "Space" : `Key${key.toUpperCase()}`, bubbles: true, cancelable: true };
    const allowed = target.dispatchEvent(new KeyboardEvent("keydown", options))
      && target.dispatchEvent(new KeyboardEvent("keypress", { ...options, charCode: key.charCodeAt(0) }));
    if (allowed && target instanceof HTMLTextAreaElement
      && target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: key }))) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(target, target.value + key);
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: key }));
    }
    target.dispatchEvent(new KeyboardEvent("keyup", options));
  });
}

/** Dispatch through the actual DOM path without supplying the focus handoff under test.
 * In particular, do not call canvas.focus(): page tools can cancel browser focus defaults. */
async function canvasPointer(target: Element, type: "pointerdown" | "pointerup",
  options: MouseEventInit & { pointerType?: string; isPrimary?: boolean } = {}): Promise<void> {
  await act(async () => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 500, clientY: 500, ...options });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: options.pointerType ?? "mouse" },
      isPrimary: { value: options.isPrimary ?? true } });
    target.dispatchEvent(event);
  });
}

async function undoAtFocus(platform: "macos" | "windows"): Promise<void> {
  await act(async () => {
    const options = { key: "z", code: "KeyZ", bubbles: true, cancelable: true,
      metaKey: platform === "macos", ctrlKey: platform === "windows" };
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", options));
    document.activeElement!.dispatchEvent(new KeyboardEvent("keyup", options));
  });
}

describe("MainWindow canvas overlays", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", new MemoryStorage()); vi.stubGlobal("ResizeObserver", TestResizeObserver); vi.stubGlobal("CSS", { escape: (value: string) => value });
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
    submit.mockReset().mockResolvedValue(undefined); select.mockReset().mockResolvedValue(undefined);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<MainWindow initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    // jsdom has no layout. Model a bordered, offset viewport with native scrollbar gutters.
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x: 100, y: 100, left: 100, top: 100,
      width: 820, height: 620, right: 920, bottom: 720, toJSON: () => ({}) });
    for (const [key, value] of Object.entries({ clientLeft: 2, clientTop: 2, clientWidth: 800, clientHeight: 600 })) {
      vi.spyOn(canvas, key as "clientLeft" | "clientTop" | "clientWidth" | "clientHeight", "get").mockReturnValue(value);
    }
    await act(async () => {
      captured.runtime!.registerPlugin({ id: pluginId, name: "Overlay test", version: "0.1.0", apiVersion: "^0.1.10",
        entry: "test.js", permissions: ["ui.canvas"], contributes: {
          commands: [{ id: commandId, title: "Send" }, { id: selectId, title: "Provider" }],
          canvasOverlays: [{ id: overlayId, title: "Assistant overlay", icon: "data:image/png;base64,AA==", commandId,
            prompt: { kind: "prompt", id: "message", commandId: selectId, label: "Message", select: {
              id: "provider", label: "Provider", value: "codex", commandId: selectId, options: [{ value: "codex", label: "Codex" }]
            } } }]
        }
      }, { commandHandlers: { [commandId]: submit, [selectId]: select } });
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!.click());
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); captured.runtime = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it("renders a registered overlay and delivers Enter to its own command with overlay input", async () => {
    expect(container.querySelector(".plugin-canvas-overlay")).not.toBeNull(); expect(container.querySelector(".page .plugin-canvas-overlay")).toBeNull();
    expect(container.querySelector(".plugin-canvas-overlay-panel")).toBeNull();
    await act(async () => input("Draw aspirin")); await send(); expect(submit).toHaveBeenCalledOnce(); expect(select).not.toHaveBeenCalled();
    expect(submit.mock.calls[0]![0].input).toEqual({ source: "overlay", overlayId, sectionId: "message",
      control: "prompt", text: "Draw aspirin", selected: "codex" });
    expect(container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!.value).toBe("");
  });

  describe.each(["macos", "windows"] as const)("canvas focus handoff on %s", platform => {
    beforeEach(async () => {
      await act(async () => root.render(<MainWindow initialPaletteMode="hidden" initialRulersVisible={false}
        nativePalette={false} shortcutPlatform={platform} />));
    });

    it("keeps the prompt focused for a press inside the overlay", async () => {
      const textarea = container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!;
      expect(document.activeElement).toBe(textarea);
      await canvasPointer(textarea, "pointerdown");
      await canvasPointer(textarea, "pointerup");
      expect(document.activeElement).toBe(textarea);
    });

    it.each([
      { name: "right button", button: 2 }, { name: "middle button", button: 1 },
      { name: "pen barrel button", button: 2, pointerType: "pen" },
      { name: "secondary pen", button: 0, pointerType: "pen", isPrimary: false },
      { name: "secondary touch", button: 0, pointerType: "touch", isPrimary: false }
    ])("keeps the prompt focused for a $name press", async options => {
      const textarea = document.activeElement;
      await canvasPointer(container.querySelector(".page")!, "pointerdown", options);
      await canvasPointer(container.querySelector(".canvas-region")!, "pointerup", options);
      expect(document.activeElement).toBe(textarea);
    });

    it.each([
      { name: "vertical scrollbar", clientX: 902, clientY: 500 },
      { name: "horizontal scrollbar", clientX: 500, clientY: 702 },
      { name: "scrollbar corner", clientX: 910, clientY: 710 },
      { name: "left border", clientX: 101, clientY: 500 },
      { name: "top border", clientX: 500, clientY: 101 }
    ])("keeps the prompt focused for a press on the $name", async options => {
      const textarea = document.activeElement;
      const canvas = container.querySelector(".canvas-region")!;
      await canvasPointer(canvas, "pointerdown", options);
      await canvasPointer(canvas, "pointerup", options);
      expect(document.activeElement).toBe(textarea);
    });

    it.each([
      { selector: ".ruler-top canvas", clientX: 500, clientY: 110 },
      { selector: ".ruler-left canvas", clientX: 110, clientY: 500 },
      { selector: ".ruler-corner", clientX: 110, clientY: 110 },
      // Rulers are pointer-transparent in the browser: the underlying canvas can be the target.
      { selector: ".canvas-region", clientX: 500, clientY: 110 },
      { selector: ".canvas-region", clientX: 110, clientY: 500 }
    ])("keeps the prompt focused under ruler $selector at ($clientX, $clientY)", async ({ selector, ...options }) => {
      await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "view.toggleRulers" } })));
      const textarea = document.activeElement;
      const target = container.querySelector(selector)!;
      expect(target).not.toBeNull();
      await canvasPointer(target, "pointerdown", options);
      await canvasPointer(target, "pointerup", options);
      expect(document.activeElement).toBe(textarea);
    });

    it("keeps an active canvas text editor focused after a canvas press", async () => {
      await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "tool.text" } })));
      await canvasPointer(container.querySelector(".page")!, "pointerdown");
      await canvasPointer(container.querySelector(".page")!, "pointerup");
      const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
      expect(editor).not.toBeNull();
      expect(document.activeElement).toBe(editor);
      const canvas = container.querySelector(".canvas-region")!;
      await canvasPointer(canvas, "pointerdown");
      await canvasPointer(canvas, "pointerup");
      expect(document.activeElement).toBe(editor);
    });

    it.each([
      { method: "shortcut", draft: "" }, { method: "menu", draft: "" },
      { method: "shortcut", draft: "Next draft" }, { method: "menu", draft: "Next draft" }
    ])("routes $method Undo to the document after a page press (draft: '$draft')", async ({ method, draft }) => {
      const port = getAssistantHistoryPort();
      const before = port.read("initial")!;
      submit.mockImplementationOnce(async () => {
        port.push("initial", before, applyPatch(before, { op: "addObject", pageId: before.pages[0]!.id,
          object: { id: "assistant_caption", type: "text", x: 50, y: 50, width: 100, height: 20,
            rotation: 0, style: {}, text: "Assistant result", spans: [] } }), "Assistant result");
      });
      await typeAtFocus("Draw");
      await send();
      const after = port.read("initial")!;
      expect(after.pages[0]!.objects.some(object => object.id === "assistant_caption")).toBe(true);
      const textarea = container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!;
      expect(document.activeElement).toBe(textarea);
      expect(textarea.value).toBe("");
      // An empty composer still owns text undo until the user deliberately leaves it.
      await undoAtFocus(platform);
      expect(port.read("initial")).toBe(after);
      await typeAtFocus(draft);
      const widget = container.querySelector<HTMLElement>(".plugin-canvas-overlay")!;
      const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
      await canvasPointer(container.querySelector(".page")!, "pointerdown");
      expect(document.activeElement).toBe(canvas);
      await canvasPointer(canvas, "pointerup");
      expect(widget.hidden).toBe(false);
      expect(widget.dataset.expanded).toBe("true");
      expect(document.activeElement).toBe(canvas);
      if (method === "shortcut") await undoAtFocus(platform);
      else await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.undo" } })));
      expect(port.read("initial")!.pages).toEqual(before.pages);
      expect(textarea.value).toBe(draft);
      expect(document.activeElement).toBe(canvas);
    });

    it("does not restore an activated action's focus after a canvas press", async () => {
      const api = captured.runtime!.host.createCommandContext(pluginId).overlays!;
      await act(async () => api.setContent({ overlayId, sections: [
        { kind: "actions", id: "actions", buttons: [{ id: "action", label: "New conversation", commandId: selectId }] }
      ] }));
      let finish!: () => void;
      select.mockImplementationOnce(async context => {
        await new Promise<void>(resolve => { finish = resolve; });
        await context.overlays!.setContent({ overlayId, sections: [] });
      });
      const button = container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-primary-actions button")!;
      await act(async () => { button.focus(); button.click(); });
      const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
      try {
        await canvasPointer(canvas, "pointerdown");
        expect(document.activeElement).toBe(canvas);
      } finally { await act(async () => finish()); }
      await canvasPointer(canvas, "pointerup");
      expect(button.isConnected).toBe(false);
      expect(document.activeElement).toBe(canvas);
    });
  });

  it("stacks the canvas overlay above the build stamp but below floating panels", () => {
    const css = readFileSync("apps/desktop/src/App.css", "utf8");
    expect(css).toMatch(/--cd-z-canvas-overlay:\s*1100/);
    expect(css).toMatch(/\.plugin-canvas-overlay-layer\s*\{[\s\S]*?z-index:\s*var\(--cd-z-canvas-overlay\)/);
    expect(css).toMatch(/\.status-row\s*\{[\s\S]*?z-index:\s*1000/);
    expect(css).toMatch(/--cd-z-floating-panel:\s*1200/);
  });

  async function openPanel(plugin: string, panelId: string, commandId: string, handler: typeof submit): Promise<void> {
    await act(async () => {
      captured.runtime!.registerPlugin({ id: plugin, name: plugin, version: "0.1.0", apiVersion: "^0.1.10",
        entry: "test.js", permissions: ["ui.panel"], contributes: {
          commands: [{ id: commandId, title: "Send" }], panels: [{ id: panelId, title: "Assistant" }]
        }
      }, { commandHandlers: { [commandId]: handler } });
      captured.runtime!.panels.showReport(plugin, panelId, PluginPanelReportSchema.parse({ title: "Assistant", sections: [
        { kind: "prompt", id: "message", commandId }
      ] }));
    });
  }

  it("refuses panel A forwarding an action naming plugin B's panel", async () => {
    await openPanel("org.panelA", "panel.a.chat", "plugin.a.submit", select);
    await act(async () => captured.runtime!.panels.detachPanel("org.panelA", "panel.a.chat"));
    await openPanel("org.panelB", "panel.b.chat", "plugin.b.submit", submit);
    await act(async () => captured.runtime!.panels.detachPanel("org.panelB", "panel.b.chat"));
    await act(async () => {
      // The native bridge has authenticated A's label; B's claimed panel id is untrusted.
      (panelActions.handler as (...args: unknown[]) => void)("forged", {
        panelId: "panel.b.chat", sectionId: "message", control: "prompt", text: "Run B"
      }, `plugin-panel-${pluginPanelWindowId("org.panelA", "panel.a.chat")}`);
    });
    expect(submit).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("uses the authenticated owner when two detached plugins share a panel id", async () => {
    const panelId = "panel.shared.chat";
    await openPanel("org.panelA", panelId, "plugin.a.submit", select);
    await act(async () => captured.runtime!.panels.detachPanel("org.panelA", panelId));
    await openPanel("org.panelB", panelId, "plugin.b.submit", submit);
    await act(async () => captured.runtime!.panels.detachPanel("org.panelB", panelId));
    await act(async () => panelActions.handler!("from-a", {
      panelId, sectionId: "message", control: "prompt", text: "Run A"
    }, `plugin-panel-${pluginPanelWindowId("org.panelA", panelId)}`));
    expect(select).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    await act(async () => {
      // Web CustomEvents cannot claim to come from a detached window.
      expect(await requestPluginPanelAction({ panelId, sectionId: "message", control: "prompt", text: "Forged" }))
        .toMatchObject({ ok: false });
    });
    expect(select).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("binds CustomEvents to the inline panel MainWindow rendered", async () => {
    await openPanel("org.panelA", "panel.a.chat", "plugin.a.submit", select);
    await act(async () => captured.runtime!.panels.detachPanel("org.panelA", "panel.a.chat"));
    await openPanel("org.panelB", "panel.b.chat", "plugin.b.submit", submit);
    await act(async () => {
      expect(await requestPluginPanelAction({ panelId: "panel.a.chat", sectionId: "message", control: "prompt", text: "Forged" }))
        .toMatchObject({ ok: false });
    });
    expect(select).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await act(async () => {
      expect(await requestPluginPanelAction({ panelId: "panel.b.chat", sectionId: "message", control: "prompt", text: "Run B" }))
        .toEqual({ ok: true });
    });
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each([false, true])("refuses a synchronously disabled report before React updates (detached=%s)", async detached => {
    const panelId = "panel.live.chat";
    const commandId = "plugin.live.submit";
    await openPanel("org.live", panelId, commandId, submit);
    if (detached) await act(async () => captured.runtime!.panels.detachPanel("org.live", panelId));
    let result: Awaited<ReturnType<typeof requestPluginPanelAction>> | undefined;
    await act(async () => {
      captured.runtime!.panels.showReport("org.live", panelId, PluginPanelReportSchema.parse({ title: "Busy", sections: [
        { kind: "prompt", id: "message", commandId, disabled: true }
      ] }));
      const request = { panelId, sectionId: "message", control: "prompt" as const, text: "Too late" };
      if (detached) {
        (panelActions.handler as (...args: unknown[]) => void)("late", request,
          `plugin-panel-${pluginPanelWindowId("org.live", panelId)}`);
      } else result = await requestPluginPanelAction(request);
    });
    expect(submit).not.toHaveBeenCalled();
    if (!detached) expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("disabled") });
  });

  it("resolves the live declaration and refuses a foreign command without clearing the draft", async () => {
    const foreign = vi.fn();
    await act(async () => captured.runtime!.registerPlugin({ id: "org.chemdraft.foreignOverlay", name: "Foreign",
      version: "0.1.0", apiVersion: "^0.1.10", entry: "test.js", permissions: [],
      contributes: { commands: [{ id: foreignId, title: "Foreign" }] }
    }, { commandHandlers: { [foreignId]: foreign } }));
    const declarations = captured.runtime!.listCanvasOverlays();
    // Only the host's live declaration changes; the widget still holds its rendered copy.
    vi.spyOn(captured.runtime!, "listCanvasOverlays").mockReturnValue(declarations.map(entry => ({
      ...entry, overlay: { ...entry.overlay, commandId: foreignId }
    })));
    await act(async () => input("Keep this")); await send(); expect(foreign).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    expect(container.querySelector(".plugin-canvas-overlay [role=alert]")?.textContent).toContain("not owned");
    expect(container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!.value).toBe("Keep this");
  });

  it("shows runtime status, hides through canvas pointer events, and restores drawing focus on Esc", async () => {
    submit.mockImplementation(async context => {
      await context.overlays!.setStatus({ overlayId, text: "Working…" });
      await context.overlays!.setTranscript({ overlayId, entries: [
        { role: "user", text: context.input?.text ?? "" }, { role: "assistant", text: "Drawing your request." }
      ] });
    });
    await act(async () => input("Draw")); await send();
    expect(container.querySelector(".plugin-canvas-overlay [role=status]")?.textContent).toBe("Working…");
    expect(container.querySelector('.plugin-canvas-overlay [data-role="assistant"]')?.textContent).toContain("Drawing your request.");
    const contributions = vi.fn();
    const unsubscribe = captured.runtime!.onDidChange(contributions);
    await act(async () => captured.runtime!.host.createCommandContext(pluginId).overlays!.setTranscript({ overlayId,
      entries: [{ role: "error", text: "Try a shorter request." }] }));
    expect(container.querySelector('.plugin-canvas-overlay [data-role="error"]')?.textContent).toContain("Try a shorter request.");
    expect(contributions).not.toHaveBeenCalled(); unsubscribe();
    const widget = container.querySelector<HTMLElement>(".plugin-canvas-overlay")!;
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    await act(async () => canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))); expect(widget.hidden).toBe(true);
    await act(async () => canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }))); expect(widget.hidden).toBe(false);
    await act(async () => widget.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(widget.dataset.expanded).toBe("false"); expect(document.activeElement).toBe(canvas);
  });

  it("acknowledges a long request immediately so the next draft remains editable", async () => {
    let finish!: () => void; submit.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    try {
      await act(async () => input("Long request")); await send();
      const textarea = container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!;
      expect(submit).toHaveBeenCalledOnce(); expect(textarea.value).toBe(""); expect(textarea.disabled).toBe(false);
      await act(async () => input("Next request")); expect(textarea.value).toBe("Next request");
    } finally { await act(async () => finish?.()); }
  });

  it.each(["Finish setup", "New conversation", "Stop"])("keeps real typing out of canvas shortcuts after %s and releases focus on Esc", async label => {
    const api = captured.runtime!.host.createCommandContext(pluginId).overlays!;
    await act(async () => api.setContent({ overlayId, sections: [
      { kind: "actions", id: "actions", buttons: [{ id: "action", label, commandId: selectId }] }
    ] }));
    let finish!: () => void;
    select.mockImplementationOnce(async context => {
      await new Promise<void>(resolve => { finish = resolve; });
      await context.overlays!.setContent({ overlayId, sections: [{ kind: "text", body: "Ready" }] });
      container.querySelector<HTMLElement>(".canvas-region")!.focus();
    });
    const button = container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-primary-actions button")!;
    await act(async () => { button.focus(); button.click(); });
    expect(select).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button);
    await act(async () => finish());
    expect(button.isConnected).toBe(false);
    const textarea = container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!;
    expect(document.activeElement).toBe(textarea);
    const activeTool = container.querySelector("[data-active-tool]")?.getAttribute("data-active-tool");
    expect(activeTool).toBeTruthy();
    const invoke = vi.spyOn(captured.runtime!.host.commands, "invoke");
    const keys = vi.fn();
    document.addEventListener("keydown", keys, true);
    try { await typeAtFocus("draw aspirin"); }
    finally { document.removeEventListener("keydown", keys, true); }
    expect(keys).toHaveBeenCalledTimes("draw aspirin".length);
    expect(textarea.value).toBe("draw aspirin");
    expect(container.querySelector("[data-active-tool]")?.getAttribute("data-active-tool")).toBe(activeTool);
    expect(invoke.mock.calls.filter(([id]) => id.startsWith("tool."))).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(container.querySelector(".canvas-region"));
    // Positive control: the same DOM path now reaches the live drawing-tool shortcuts.
    await typeAtFocus("t");
    expect(container.querySelector("[data-active-tool]")?.getAttribute("data-active-tool")).toBe("tool.text");
    expect(invoke.mock.calls.some(([id]) => id === "tool.text")).toBe(true);
  });

  it.each(["", "New draft", " "])("restores a declined request only into an empty composer (current: %s)", async nextDraft => {
    const api = captured.runtime!.host.createCommandContext(pluginId).overlays!;
    let decline!: () => void;
    submit.mockImplementationOnce(async context => {
      await new Promise<void>(resolve => { decline = resolve; });
      await context.overlays!.setContent({ overlayId, sections: [], prompt: { restoreDraft: context.input!.text! } });
    });
    await act(async () => input("draw aspirin")); await send();
    const textarea = container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!;
    expect(textarea.value).toBe("");
    await act(async () => input(nextDraft));
    await act(async () => decline());
    expect(textarea.value).toBe(nextDraft || "draw aspirin");
    expect(submit).toHaveBeenCalledOnce();
    // A restore is consumed even if skipped. Clearing later or unrelated updates never replay it.
    await act(async () => input(""));
    await act(async () => api.setStatus({ overlayId, text: "Ready" }));
    expect(textarea.value).toBe("");
    await act(async () => api.setContent({ overlayId, sections: [], prompt: { restoreDraft: "draw aspirin" } }));
    expect(textarea.value).toBe("draw aspirin");
    expect(submit).toHaveBeenCalledOnce();
    await send();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(textarea.value).toBe(""); // A later Send cannot replay the consumed restore.
  });

  it("restores an immediately refused request without sending it again", async () => {
    submit.mockImplementationOnce(async context => {
      await context.overlays!.setContent({ overlayId, sections: [], prompt: { restoreDraft: context.input!.text! } });
    });
    await act(async () => input("draw aspirin")); await send();
    expect(container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!.value).toBe("draw aspirin");
    expect(submit).toHaveBeenCalledOnce();
  });

  it("allows Stop during a running Send and returns focus when Stop completes", async () => {
    const api = captured.runtime!.host.createCommandContext(pluginId).overlays!;
    let finish!: () => void;
    submit.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => input("Long request")); await send();
    await act(async () => api.setContent({ overlayId, sections: [
      { kind: "actions", id: "actions", buttons: [{ id: "stop", label: "Stop", commandId: selectId }] }
    ] }));
    select.mockImplementationOnce(async context => {
      finish();
      await context.overlays!.setContent({ overlayId, sections: [] });
      container.querySelector<HTMLElement>(".canvas-region")!.focus();
    });
    const stop = container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-primary-actions button")!;
    await act(async () => { stop.focus(); stop.click(); });
    expect(select).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(container.querySelector(".plugin-canvas-overlay textarea"));
  });

  it("clears busy refusals on draft edits and document changes without discarding the next draft", async () => {
    let finish!: () => void;
    submit.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    try {
      await act(async () => input("Long request")); await send();
      await act(async () => input("Next request")); await send();
      expect(container.querySelector(".plugin-canvas-overlay [role=alert]")).not.toBeNull();
      await act(async () => input("Changed draft"));
      expect(container.querySelector(".plugin-canvas-overlay [role=alert]")).toBeNull();
      await send();
      expect(container.querySelector(".plugin-canvas-overlay [role=alert]")).not.toBeNull();
      await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "document.new" } })); });
      expect(container.querySelector(".plugin-canvas-overlay [role=alert]")).toBeNull();
      expect(container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!.value).toBe("Changed draft");
    } finally { await act(async () => finish?.()); }
  });

  it.each(["Enter", "Send"])("refuses a second %s while the first request runs and keeps its draft without queueing", async method => {
    let finish!: () => void;
    submit.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    try {
      await act(async () => input("Long request")); await send();
      const textarea = container.querySelector<HTMLTextAreaElement>(".plugin-canvas-overlay textarea")!;
      expect(textarea.value).toBe(""); expect(textarea.disabled).toBe(false);
      await act(async () => input("Next request"));
      if (method === "Enter") await send();
      else await act(async () => container.querySelector<HTMLButtonElement>(".plugin-canvas-overlay .plugin-report-action-primary")!.click());
      expect(submit).toHaveBeenCalledOnce();
      expect(container.querySelector(".plugin-canvas-overlay [role=alert]")?.textContent)
        .toBe("Wait for the current request to finish, or press Stop.");
      expect(textarea.value).toBe("Next request"); expect(textarea.disabled).toBe(false);
      await act(async () => finish());
      expect(submit).toHaveBeenCalledOnce();
      expect(container.querySelector(".plugin-canvas-overlay [role=alert]")).toBeNull();
      expect(textarea.value).toBe("Next request"); expect(textarea.disabled).toBe(false);
      await send();
      expect(submit).toHaveBeenCalledTimes(2);
      expect(submit.mock.calls[1]![0].input?.text).toBe("Next request");
      expect(textarea.value).toBe(""); expect(textarea.disabled).toBe(false);
    } finally { await act(async () => finish?.()); }
  });

  it("keeps the overlay hidden until both wheel and native pinch gestures finish", async () => {
    vi.useFakeTimers();
    try {
      const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
      const widget = container.querySelector<HTMLElement>(".plugin-canvas-overlay")!;
      await act(async () => canvas.dispatchEvent(new Event("gesturestart", { bubbles: true, cancelable: true })));
      await act(async () => canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 10 })));
      expect(widget.hidden).toBe(true);
      await act(async () => vi.advanceTimersByTime(150));
      expect(widget.hidden).toBe(true);
      await act(async () => canvas.dispatchEvent(new Event("gestureend", { bubbles: true, cancelable: true })));
      expect(widget.hidden).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
