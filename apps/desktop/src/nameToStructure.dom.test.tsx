import { initialDocumentTabId } from "./testSupport/documentTabIdentity";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, DocumentObjectSchema, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule, type PastedStructureDepiction } from "@chemdraft/document-workflow-core";
import type { PluginNameToStructureResult } from "@chemdraft/plugin-api";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { objectRect, overlaps } from "./assistant/placement";
import { MainWindow } from "./MainWindow";
import type { DesktopPluginRuntime } from "./plugins/createPluginRuntime";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { setNativePromptProvider } from "./nativePrompt";

const harness = vi.hoisted(() => ({
  runtime: undefined as DesktopPluginRuntime | undefined,
  built: undefined as MoleculeObject | undefined,
  resolution: undefined as PluginNameToStructureResult | undefined,
  opsin: vi.fn()
}));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: async (command: string, args?: { name: string }) => {
    if (command === "opsin_status") return { available: true, version: "test" };
    if (command === "opsin_name_to_structure") return harness.opsin(args?.name);
    throw new Error(`Native command unavailable in test: ${command}`);
  }
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("./plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("./plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: Parameters<typeof actual.createPluginRuntime>[0]) => {
    harness.runtime = actual.createPluginRuntime({ ...options,
      // Mock only the depiction engine; name resolution, patch validation, placement,
      // selection and history all run through the mounted desktop host.
      buildStructureFromSmiles: async request => {
        const drawing = options.getActiveDocument()!;
        const page = drawing.pages[0]!;
        harness.built = createSmilesMolecule(drawing, { x: page.width / 2, y: page.height / 2 },
          ethanol, request.smiles);
        return { available: true, built: true, object: harness.built };
      }
    });
    return harness.runtime;
  } };
});

const ethanol: PastedStructureDepiction = {
  atoms: [{ element: "C", x: 0, y: 0, charge: 0 }, { element: "C", x: 1, y: 0.5, charge: 0 },
    { element: "O", x: 2, y: 0, charge: 0 }],
  bonds: [{ from: 0, to: 1, order: "single", wedge: null }, { from: 1, to: 2, order: "single", wedge: null }]
};
const benzene: PastedStructureDepiction = {
  atoms: Array.from({ length: 6 }, (_, i) => ({ element: "C", x: Math.cos(i * Math.PI / 3),
    y: Math.sin(i * Math.PI / 3), charge: 0 })),
  bonds: Array.from({ length: 6 }, (_, i) => ({ from: i, to: (i + 1) % 6,
    order: i % 2 ? "single" as const : "double" as const, wedge: null }))
};
const commandId = "plugin.opsinNameToStructure.convert";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe("Name to Structure insertion placement", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    harness.opsin.mockReset();
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () =>
      new TextEncoder().encode("CCO\tethyl alcohol\t64-17-5\tLFQSCWFLJHTTHZ-UHFFFAOYSA-N").buffer })));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    harness.runtime = undefined; harness.built = undefined; harness.resolution = undefined;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  async function mount(drawing: ChemDraftDocument, name: string) {
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialPaletteMode="hidden"
      initialRulersVisible={false} nativePalette={false} />));
    await act(async () => { harness.runtime!.registerPlugin({ id: "org.chemdraft.opsin.nameToStructure", name: "Name to Structure",
      version: "0.1.0", apiVersion: "^0.1.22", entry: "test.js",
      permissions: ["document.read", "document.write", "chemistry.compute", "native.execute"],
      contributes: { commands: [{ id: commandId, title: "Insert Named Structure" }] }
    }, { commandHandlers: { [commandId]: async context => {
      const result = await context.chemistry!.nameToStructure!({ name });
      harness.resolution = result;
      if (!result.available || !result.parsed) throw new Error("Test name was not resolved");
      const structure = await context.chemistry!.structureFromSmiles!({ smiles: result.smiles });
      if (!structure.available || !structure.built) throw new Error("Test structure was not built");
      return context.documents.applyPatch!({ reason: "Insert Named Structure", patch: {
        op: "addObject", pageId: drawing.pages[0]!.id, object: structure.object
      } });
    } } }); });
    return getAssistantHistoryPort();
  }
  async function command(id: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: id } })); });
  }

  it("applies a reviewed edit without moving overlapping existing objects", async () => {
    const drawing = createEmptyDocument();
    const page = drawing.pages[0]!;
    const centre = { x: page.width / 2, y: page.height / 2 };
    const existing = createSmilesMolecule(drawing, centre, benzene, "c1ccccc1");
    const edited = { ...createSmilesMolecule(drawing, centre, ethanol, "CCO"), id: "edited-molecule" };
    page.objects = [existing, edited];
    const port = await mount(drawing, "unused");
    const before = port.read(initialDocumentTabId())!;
    await act(async () => {
      harness.runtime!.registerPlugin({ id: "org.chemdraft.test.proposal", name: "Mock Proposal", version: "0.1.0",
        apiVersion: "^0.1.25", entry: "test.js", permissions: ["document.proposePatch"],
        contributes: { commands: [{ id: "plugin.mockProposal.edit", title: "Edit" }] }
      }, { commandHandlers: { "plugin.mockProposal.edit": context => context.documents.proposePatch({
        reason: "Edit style", patch: { op: "updateObject", objectId: edited.id, changes: { rotation: 15 } }
      }) } });
      await harness.runtime!.invokeCommand("plugin.mockProposal.edit");
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".patch-review-badge")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".patch-review-actions button")!.click());
    expect(port.read(initialDocumentTabId())!.pages[0]!.objects).toEqual([
      before.pages[0]!.objects[0], { ...before.pages[0]!.objects[1], rotation: 15 }
    ]);
    expect(port.read(initialDocumentTabId())!.selection.objectIds).toEqual([edited.id]);
    await command("edit.undo");
    expect(port.read(initialDocumentTabId())!.pages).toEqual(before.pages);
    expect(container.querySelector("[role=status]")?.textContent).toBe("Undid Mock Proposal: Apply Proposal");
  });

  it.each(["opsin", "dictionary"] as const)("places a %s result beside central benzene, selected in one undo entry", async source => {
    harness.opsin.mockResolvedValue(source === "opsin" ? { smiles: "CCO" } : { smiles: null });
    const drawing = createEmptyDocument();
    const page = drawing.pages[0]!;
    const existing = createSmilesMolecule(drawing, { x: page.width / 2, y: page.height / 2 }, benzene, "c1ccccc1");
    page.objects = [existing];
    const port = await mount(drawing, source === "opsin" ? "ethanol" : "ethyl alcohol");
    const before = port.read(initialDocumentTabId())!;
    await act(async () => { await harness.runtime!.invokeCommand(commandId); });
    expect(harness.resolution).toMatchObject({ parsed: true, source });
    const after = port.read(initialDocumentTabId())!;
    expect(after.pages[0]!.objects).toHaveLength(2);
    const inserted = after.pages[0]!.objects[1]! as MoleculeObject;
    expect(overlaps(inserted, existing)).toBe(false);
    expect(overlaps(objectRect(inserted), objectRect(existing))).toBe(false);
    expect(after.pages[0]!.objects[0]).toEqual(before.pages[0]!.objects[0]);
    expect(after.selection.objectIds).toEqual([inserted.id]);
    // Every field, atom id, bond, chemistry value and style survives; only translation changes.
    const built = harness.built!;
    const dx = inserted.x - built.x, dy = inserted.y - built.y;
    expect(inserted).toEqual({ ...built, x: built.x + dx, y: built.y + dy,
      atoms: built.atoms.map(atom => ({ ...atom, x: atom.x + dx, y: atom.y + dy })) });
    expect(container.querySelector("[role=status]")?.textContent).toContain(source === "opsin" ? "OPSIN" : "Wikidata dictionary");
    await command("edit.undo");
    expect(port.read(initialDocumentTabId())!.pages).toEqual(before.pages);
    expect(container.querySelector("[role=status]")?.textContent).toBe("Undid Name to Structure: Insert Named Structure");
    await command("edit.undo");
    expect(container.querySelector("[role=status]")?.textContent).toBe("Nothing to undo");
    await command("edit.redo");
    expect(port.read(initialDocumentTabId())!.pages).toEqual(after.pages);
    expect(port.read(initialDocumentTabId())!.selection.objectIds).toEqual([inserted.id]);
    expect(harness.opsin).toHaveBeenCalledTimes(1);
  });

  it.each(["opsin", "dictionary"] as const)("keeps a %s result centred on an empty page", async source => {
    harness.opsin.mockResolvedValue(source === "opsin" ? { smiles: "CCO" } : { smiles: null });
    const drawing = createEmptyDocument();
    const port = await mount(drawing, source === "opsin" ? "ethanol" : "ethyl alcohol");
    await act(async () => { await harness.runtime!.invokeCommand(commandId); });
    const page = port.read(initialDocumentTabId())!.pages[0]!;
    const inserted = page.objects[0]!;
    expect(page.objects).toEqual([harness.built]);
    expect(inserted.x + inserted.width / 2).toBeCloseTo(page.width / 2);
    expect(inserted.y + inserted.height / 2).toBeCloseTo(page.height / 2);
  });

  it.each(["filled molecule frame", "page border"])("keeps the original position without asking to enlarge a page occupied by %s", async kind => {
    harness.opsin.mockResolvedValue({ smiles: "CCO" });
    const drawing = createEmptyDocument();
    const page = drawing.pages[0]!;
    page.objects = [kind === "filled molecule frame"
      ? { ...createSmilesMolecule(drawing, { x: page.width / 2, y: page.height / 2 }, benzene, "c1ccccc1"),
        x: 0, y: 0, width: page.width, height: page.height }
      : DocumentObjectSchema.parse({ id: "border", type: "graphic", graphicKind: "rect",
        x: 0, y: 0, width: page.width, height: page.height })];
    const prompt = vi.fn(async () => "keep");
    const restorePrompt = setNativePromptProvider(prompt);
    try {
      const port = await mount(drawing, "ethanol");
      const before = port.read(initialDocumentTabId())!;
      await act(async () => { await harness.runtime!.invokeCommand(commandId); });
      const after = port.read(initialDocumentTabId())!;
      expect(after.pages[0]!.objects).toEqual([...before.pages[0]!.objects, harness.built]);
      expect(after.pages[0]!.width).toBe(page.width);
      expect(after.pages[0]!.height).toBe(page.height);
      expect(prompt).not.toHaveBeenCalled();
    } finally { restorePrompt(); }
  });
});
