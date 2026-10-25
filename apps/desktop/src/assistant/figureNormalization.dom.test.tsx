// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantCapabilityPermissions, type PluginAssistantToolResult } from "@chemdraft/plugin-api";
import { applyPatch, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { applyChargeToolAtPoint } from "../documentWorkflow";
import { MainWindow } from "../MainWindow";
import type { DesktopPluginRuntime, DesktopPluginRuntimeOptions } from "../plugins/createPluginRuntime";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { getAssistantHistoryPort } from "./historyPort";
import { buildMoveObjects } from "./writeBuilder";
import { testContext } from "./tools/testContext";

vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
const captured = vi.hoisted(() => ({ runtime: undefined as DesktopPluginRuntime | undefined,
  assistantContext: undefined as DesktopPluginRuntimeOptions["assistantContext"] }));
vi.mock("../plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("../plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: DesktopPluginRuntimeOptions) => {
    captured.runtime = actual.createPluginRuntime({ ...options,
      ...(captured.assistantContext ? { assistantContext: captured.assistantContext } : {}) });
    return captured.runtime;
  } };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
let root: Root;
let container: HTMLDivElement;

// C5 anchored placement goes through the same normalized-write guard as every other assistant
// write: the desktop commit, not just the patch, must leave unselected objects unchanged.
describe("anchored figure moves through mounted desktop normalization", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    const { context } = testContext();
    captured.assistantContext = () => ({ chemistry: context.chemistry, now: () => new Date(), render: context.render });
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
      const id = "org.chemdraft.figureNormalizationTest";
      const command = "plugin.figureNormalizationTest.run";
      captured.runtime!.registerPlugin({ id, name: "Figure normalization test", version: "0.1.0", apiVersion: "^0.1.14",
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
  function anchoredMove() {
    const fixture = testContext();
    const input = { objectIds: [fixture.molecule.id], to: { relativeTo: fixture.text.id, anchor: "center" as const, offset: { dx: 0, dy: 3 } } };
    const drawing = fixture.context.getDocument()!;
    const planned = applyPatch(drawing, buildMoveObjects(fixture.context, input).patch);
    const moved = planned.pages[0]!.objects.find(object => object.id === fixture.molecule.id)! as MoleculeObject;
    return { fixture, input, drawing, atom: moved.atoms[0]! };
  }

  it("refuses an anchored move onto an unselected floating + charge mark, without changing document or history", async () => {
    const { fixture, input, drawing, atom } = anchoredMove();
    const withMark = applyChargeToolAtPoint(drawing, 1, { x: atom.x - 30, y: atom.y });
    const mark = withMark.pages[0]!.objects.find(object => object.type === "electron-mark")!;
    const { port, push, amend, select } = await mount(applyPatch(withMark, { op: "setSelection", objectIds: [fixture.molecule.id] }));
    const before = port.read("initial")!;
    expect(before.pages[0]!.objects.find(object => object.id === mark.id)).toMatchObject({ anchor: { kind: "point" } });
    const result = await call("move_objects", input);
    expect(result.isError, JSON.stringify(result)).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`attach the unselected charge mark ${mark.id}`) });
    expect(port.read("initial")).toBe(before);
    expect(push).not.toHaveBeenCalled(); expect(amend).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
  });

  it("commits the same anchored move when no mark is in the way", async () => {
    const { fixture, input, drawing, atom } = anchoredMove();
    const { port, push } = await mount(applyPatch(drawing, { op: "setSelection", objectIds: [fixture.molecule.id] }));
    const result = await call("move_objects", input);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const moved = port.read("initial")!.pages[0]!.objects.find(object => object.id === fixture.molecule.id)! as MoleculeObject;
    expect(moved.atoms[0]!.x).toBeCloseTo(atom.x);
    expect(moved.atoms[0]!.y).toBeCloseTo(atom.y);
    expect(push).toHaveBeenCalledOnce();
  });
});
