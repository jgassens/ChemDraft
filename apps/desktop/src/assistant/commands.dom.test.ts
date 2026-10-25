// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRegistry } from "@chemdraft/plugin-host";
import type { DesktopPluginRuntimeOptions } from "../plugins/createPluginRuntime";
import type { ConformerStageHandlers } from "../conformerClient";
import type { Generate3DConformerResult } from "@chemdraft/chemistry-adapter";
import { DocumentObjectSchema, toEngineDocument } from "@chemdraft/chem-core";
import { normalizeCommittedDocument } from "../documentWorkflow";
import { MainWindow } from "../MainWindow";
import { invokeAssistantRegistryCommand } from "../commands/coreCommandRegistrar";
import { ASSISTANT_COMMANDS } from "./commandCatalog";
import { callAssistantTool } from "./assistantTools";
import { testContext } from "./tools/testContext";

vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
const captured = vi.hoisted(() => ({ options: undefined as DesktopPluginRuntimeOptions | undefined }));
const conformer = vi.hoisted(() => ({ handlers: undefined as ConformerStageHandlers | undefined, cancel: vi.fn() }));
vi.mock("../conformerClient", () => ({ getConformerWorkerClient: () => ({
  warmup: vi.fn(), prefetch: vi.fn(), generate: (_molfile: string, _count: number, _options: unknown, _engine: unknown, handlers: ConformerStageHandlers) => {
    conformer.handlers = handlers;
    return conformer.cancel;
  }
}) }));
vi.mock("../plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("../plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: DesktopPluginRuntimeOptions) => {
    captured.options = options;
    return actual.createPluginRuntime(options);
  } };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
let root: Root;
let container: HTMLDivElement;
let registry: CommandRegistry;
function embedded(): Generate3DConformerResult {
  return { mapping: { coords3dByOriginalAtom: new Float64Array([0, 0, 0, 1, 0.5, 0.25]), originalToEngineAtom: [0, 1],
    engineToOriginalAtom: [0, 1], generatedHydrogenEngineAtoms: [] }, originalAtomCount: 2, generatedAtomCount: 2,
    hydrogens: { added: false, explicitInputHydrogensPreserved: false }, embed: { status: "ok" },
    engine: { name: "openchemlib", version: "test", parameters: {} }, unsupportedFeatures: [], warnings: [] };
}

describe("assistant commands in the mounted menu registry", () => {
  beforeEach(async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    conformer.handlers = undefined;
    conformer.cancel.mockClear();
    const fixture = testContext();
    await act(async () => { root.render(createElement(MainWindow, {
      initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: false,
      initialDocument: fixture.context.getDocument()
    })); });
    registry = captured.options!.commandRegistry!;
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    captured.options = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("registers every allowlisted command as a core command", () => {
    for (const { id } of ASSISTANT_COMMANDS) expect(registry.get(id), id).toMatchObject({ id, source: "core" });
  });
  it.each(ASSISTANT_COMMANDS.filter(command => command.actsOn !== "view"))("$id runs on its isolated target without changing the menu's document", async ({ id }) => {
    const { context, molecule, text } = testContext();
    context.getSelectionAtSend = () => id.startsWith("structure.") ? [molecule.id] : [molecule.id, text.id];
    context.commands = { has: command => registry.has(command), invoke: (command, target) => invokeAssistantRegistryCommand(registry, command, target) };
    const live = captured.options!.getActiveDocument();
    const invoke = vi.spyOn(registry, "invoke");
    await act(async () => {
      const result = await callAssistantTool(context, "run_command", { id });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(captured.options!.getActiveDocument()).toEqual(live);
  });
  it.each(["structure.spin3d", "structure.openInteractive3d"])("%s refuses an inactive target instead of opening another tab's view", async id => {
    const { context } = testContext();
    context.commands = { has: command => registry.has(command), invoke: (command, target) => invokeAssistantRegistryCommand(registry, command, target) };
    const live = captured.options!.getActiveDocument();
    await act(async () => {
      expect(await callAssistantTool(context, "run_command", { id })).toMatchObject({ isError: true,
        content: [{ text: expect.stringContaining("Activate the assistant's document tab") }] });
    });
    expect(context.write).not.toHaveBeenCalled();
    expect(captured.options!.getActiveDocument()).toEqual(live);
  });
  it("includes implicit charge reconciliation in scope checks before committing", async () => {
    const { context, molecule, text, replace } = testContext();
    const initial = structuredClone(context.getDocument()!);
    const atom = molecule.atoms[0]!;
    const mark = DocumentObjectSchema.parse({ id: "charge", type: "electron-mark", markKind: "charge", charge: 1,
      x: atom.x + 12, y: atom.y, width: 12, height: 12,
      anchor: { kind: "atom", objectId: molecule.id, atomId: atom.id } });
    initial.pages[0]!.objects.push(mark);
    replace(normalizeCommittedDocument(toEngineDocument(initial)));
    context.getSelectionAtSend = () => [mark.id, text.id];
    context.commands = { has: id => registry.has(id), invoke: (id, target) => invokeAssistantRegistryCommand(registry, id, target) };
    const before = structuredClone(context.getDocument());
    await act(async () => {
      expect(await callAssistantTool(context, "run_command", { id: "layout.alignRight" })).toMatchObject({ isError: true,
        content: [{ text: expect.stringContaining(molecule.id) }] });
    });
    expect(context.getDocument()).toEqual(before);
    expect(context.write).not.toHaveBeenCalled();
  });
  it.each(["opened", "failed", "cancelled"])("waits for the actual spin callback (%s) without changing the document", async outcome => {
    const { context, molecule } = testContext();
    context.tabId = "initial";
    let active = true;
    context.getDocument = () => active ? captured.options!.getActiveDocument() : undefined;
    context.getSelectionAtSend = () => [molecule.id];
    context.commands = { has: id => registry.has(id), invoke: (id, target) => invokeAssistantRegistryCommand(registry, id, target) };
    const before = structuredClone(context.getDocument());
    let completed = false;
    await act(async () => {
      const pending = callAssistantTool(context, "run_command", { id: "structure.spin3d" }).then(result => { completed = true; return result; });
      await vi.waitFor(() => expect(conformer.handlers).toBeDefined());
      expect(completed).toBe(false);
      if (outcome === "cancelled") active = false;
      if (outcome === "failed") conformer.handlers!.onError("Fixture engine failure");
      else conformer.handlers!.onEmbedded(embedded());
      const result = await pending;
      if (outcome === "opened") expect(result).toMatchObject({ structuredContent: { summary: "opened the 3D view", objectIds: [] } });
      else expect(result.isError).toBe(true);
    });
    expect(!!container.querySelector("[data-spin3d-overlay]")).toBe(outcome === "opened");
    expect(captured.options!.getActiveDocument()).toEqual(before);
    expect(context.write).not.toHaveBeenCalled();
  });
});
