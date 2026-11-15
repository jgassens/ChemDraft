// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { ToolPalette, TOOLBAR_FLYOUT_HOLD_MS } from "./ToolPalette";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { createNativeSingleBondMolecule, createPhase4Document } from "./documentWorkflow";
import { getToolsetCommandGroups, getToolsetItemGroups } from "./toolsets";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT, toolsetPopoverTimestamp, type ToolsetPopoverContentPayload,
  type ToolsetPopoverDismissPayload } from "./window-manager";
import { installPopoverEscapeRouting } from "./window-manager/popoverEscape";

const bus = vi.hoisted(() => ({
  content: new Set<(payload: ToolsetPopoverContentPayload) => void>(),
  dismiss: new Set<(payload?: ToolsetPopoverDismissPayload) => void>(),
  closed: new Set<(payload: { toolsetId: string; openedAt: number; generation?: number }) => void>(),
  visible: true,
  queryVisibility: vi.fn(async (): Promise<boolean> => bus.visible),
  hide: vi.fn(async () => {}), invoke: vi.fn(), cancel: vi.fn(async () => {})
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("./plugins/pluginPanelInputFocus", async original => ({
  ...await original<typeof import("./plugins/pluginPanelInputFocus")>(), installPaletteInputFocus: () => () => {}
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: bus.hide }) }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(),
  listenForToolsetPopoverContent: async (fn: (payload: ToolsetPopoverContentPayload) => void) => {
    bus.content.add(fn); return () => bus.content.delete(fn);
  },
  listenForToolsetPopoverDismiss: async (fn: (payload?: ToolsetPopoverDismissPayload) => void) => {
    bus.dismiss.add(fn); return () => bus.dismiss.delete(fn);
  },
  listenForToolsetPopoverClosed: async (fn: (payload: { toolsetId: string; openedAt: number; generation?: number }) => void) => {
    bus.closed.add(fn); return () => bus.closed.delete(fn);
  },
  dismissToolsetPopovers: vi.fn(async (requestedAt?: number, reason?: "escape", openings?: ToolsetPopoverDismissPayload["openings"]) => {
    bus.dismiss.forEach(fn => fn(requestedAt === undefined ? undefined : { requestedAt, reason, openings }));
  }),
  notifyToolsetPopoverClosed: async (toolsetId: string, openedAt: number, generation?: number) => {
    bus.closed.forEach(fn => fn({ toolsetId, openedAt, generation }));
  },
  requestToolsetPopoverContent: async () => {}, requestToolsetTextStyle: async () => {},
  setCurrentWindowLogicalSize: async () => {}, setCurrentWindowLogicalPosition: async () => {},
  showCurrentToolsetPopoverWindow: async () => {}, sendPaletteCommandCancel: bus.cancel,
  isToolsetPopoverVisible: bus.queryVisibility
}));

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  bus.hide.mockClear(); bus.invoke.mockClear(); bus.cancel.mockClear();
  bus.visible = true;
  bus.queryVisibility.mockReset().mockImplementation(async () => bus.visible);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});

it("ignores closed content replay and an older close cannot dismiss a newer opening", async () => {
  const stop = installPopoverEscapeRouting();
  try {
    const payload: ToolsetPopoverContentPayload = { toolsetId: "core.art", kind: "flyout", openedAt: 100,
      flyout: { flyoutId: "shapes", title: "Shapes", commands: [] } };
    bus.content.forEach(fn => fn(payload));
    bus.closed.forEach(fn => fn({ toolsetId: "core.art", openedAt: 100 }));
    bus.content.forEach(fn => fn(payload));
    const first = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(false);
    bus.content.forEach(fn => fn({ ...payload, openedAt: 200 }));
    bus.closed.forEach(fn => fn({ toolsetId: "core.art", openedAt: 100 }));
    const second = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);
    const third = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(third);
    expect(third.defaultPrevented).toBe(false);
  } finally { stop(); }
});

it("leaves Escape to an editor awaiting focus and to a modal dialog", async () => {
  let editorOpen = true;
  const stop = installPopoverEscapeRouting(() => editorOpen);
  const dialog = document.createElement("div");
  try {
    bus.content.forEach(fn => fn({ toolsetId: "core.art", kind: "artColor", openedAt: toolsetPopoverTimestamp() }));
    const escape = () => {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      document.body.dispatchEvent(event); return event;
    };
    expect(escape().defaultPrevented).toBe(false);
    editorOpen = false;
    dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); document.body.append(dialog);
    expect(escape().defaultPrevented).toBe(false);
    dialog.remove();
    expect(escape().defaultPrevented).toBe(true);
  } finally { dialog.remove(); stop(); }
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  expect(bus.content.size + bus.dismiss.size + bus.closed.size).toBe(0);
});

describe.each(["macos", "windows"] as const)("flyout Escape on %s", platform => {
  let atomPoint: { x: number; y: number };
  async function mount(native: boolean, renderPopover = true) {
    let drawing = createPhase4Document("Escape routing");
    const molecule = createNativeSingleBondMolecule(drawing, { x: 100, y: 100 });
    atomPoint = molecule.atoms[0]!;
    drawing = applyPatches(drawing, [{ op: "addObject", pageId: drawing.pages[0].id, object: molecule }]);
    drawing = { ...drawing, selection: { ...drawing.selection, objectIds: [molecule.id] } };
    await act(async () => root.render(<>
      <MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.bond"
        initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} shortcutPlatform={platform} />
      <ToolPalette groups={getToolsetCommandGroups("core.art")} itemGroups={getToolsetItemGroups("core.art")}
        activeTool="tool.bond" onInvoke={bus.invoke} onRequestFlyout={native ? request => {
          const payload: ToolsetPopoverContentPayload = { toolsetId: "core.art", kind: "flyout",
            openedAt: toolsetPopoverTimestamp(), flyout: request.flyout };
          bus.content.forEach(fn => fn(payload));
        } : undefined} />
      {native && renderPopover && <PalettePopoverWindow toolsetId="core.art" kind="flyout" prewarm />}
    </>));
    return container.querySelector<HTMLElement>(".canvas-region")!;
  }
  async function mouseOpen() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const trigger = container.querySelector<HTMLButtonElement>('[data-command-flyout-button="shapes"]')!;
    expect(trigger).not.toBeNull();
    await act(async () => trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    await act(async () => vi.advanceTimersByTimeAsync(TOOLBAR_FLYOUT_HOLD_MS));
    await act(async () => trigger.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 })));
    vi.useRealTimers();
    return trigger;
  }
  async function escape(target: EventTarget) {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => target.dispatchEvent(event));
    return event;
  }

  it.each([false, true])("mouse-opened flyout consumes only the first Escape (native=%s)", async native => {
    const canvas = await mount(native);
    canvas.focus();
    expect(container.querySelector("[data-active-tool]")?.getAttribute("data-active-tool")).toBe("tool.bond");
    const selected = () => [...container.querySelectorAll(".native-molecule-selected")].map(el => el.getAttribute("data-object-id"));
    const moleculeId = container.querySelector("[data-object-id]")!.getAttribute("data-object-id");
    // Drawing tools hide selection chrome. The second Escape reveals the seeded selection again.
    const before = selected();
    const trigger = await mouseOpen();
    expect(document.activeElement).toBe(canvas);
    if (!native) {
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(document.getElementById(trigger.getAttribute("aria-controls")!)?.getAttribute("role")).toBe("menu");
    } else expect(trigger.hasAttribute("aria-controls")).toBe(false);
    expect((await escape(canvas)).defaultPrevented).toBe(true);
    if (native) {
      expect(bus.queryVisibility).toHaveBeenCalled();
      expect(bus.hide).toHaveBeenCalled();
      expect(bus.cancel).toHaveBeenCalledWith("palette.preview.cancel");
    }
    else expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-active-tool]")?.getAttribute("data-active-tool")).toBe("tool.bond");
    expect(selected()).toEqual(before);
    expect(bus.invoke).not.toHaveBeenCalled();
    await escape(canvas);
    expect(container.querySelector("[data-active-tool]")?.getAttribute("data-active-tool")).toBe("tool.select");
    expect(selected()).toEqual([moleculeId]);
  });

  it("an OS-hidden flyout leaves the next Escape to the canvas", async () => {
    // The hidden popover's webview has a separate DOM and cannot receive canvas key events.
    const canvas = await mount(true, false);
    canvas.focus();
    await mouseOpen();
    // Native hidesOnDeactivate does not send the renderer's closed notification.
    const osHide = () => { bus.visible = false; };
    window.addEventListener("blur", osHide, { once: true });
    window.dispatchEvent(new Event("blur"));
    await escape(canvas);
    expect(container.querySelector("[data-active-tool]")?.getAttribute("data-active-tool")).toBe("tool.select");
    expect(bus.hide).not.toHaveBeenCalled();
    expect(bus.cancel).not.toHaveBeenCalled();
  });

  it.each([false, true])("a text editor opened during a late visibility check receives the first Escape (visible=%s)", async visible => {
    const canvas = await mount(true, false);
    canvas.focus();
    await mouseOpen();
    let resolveVisibility!: (visible: boolean) => void;
    bus.queryVisibility.mockImplementationOnce(() => new Promise(resolve => { resolveVisibility = resolve; }));
    await escape(canvas);
    expect(bus.queryVisibility).toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "tool.text" } })));
    const page = container.querySelector(".page")!;
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: 300 });
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      await act(async () => page.dispatchEvent(event));
    }
    expect(container.querySelector(".text-object-editor")).not.toBeNull();
    await act(async () => resolveVisibility(visible));
    expect(container.querySelector(".text-object-editor")).toBeNull();
    expect(bus.hide).not.toHaveBeenCalled();
    expect(bus.invoke).not.toHaveBeenCalled();
  });

  it.each([false, true])("an open text editor retains its Escape (native=%s)", async native => {
    await mount(native);
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "tool.text" } })));
    const page = container.querySelector(".page")!;
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: 300 });
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      await act(async () => page.dispatchEvent(event));
    }
    const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    expect(editor).not.toBeNull();
    await mouseOpen();
    expect(container.querySelector(".text-object-editor")).toBe(editor);
    await escape(editor);
    expect(container.querySelector(".text-object-editor")).toBeNull();
    expect(bus.invoke).not.toHaveBeenCalled();
    expect(container.querySelector("[data-active-tool]")?.getAttribute("data-active-tool")).toBe("tool.bond");
  });

  it.each([false, true])("an atom-label editor cancels its draft with a flyout open (native=%s)", async native => {
    const canvas = await mount(native);
    const page = container.querySelector<HTMLElement>(".page")!;
    const rect = { x: 0, y: 0, left: 0, top: 0, width: 792, height: 612, right: 792, bottom: 612, toJSON: () => ({}) };
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue(rect);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect);
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "tool.atom" } })));
    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0,
      buttons: 1, clientX: atomPoint.x, clientY: atomPoint.y });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => container.querySelector("[data-object-id]")!.dispatchEvent(event));
    const editor = container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]')!;
    expect(editor).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(editor, "OMe");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await mouseOpen();
    expect(container.querySelector('[data-atom-label-editor="true"]')).toBe(editor);
    await escape(editor);
    expect(container.querySelector('[data-atom-label-editor="true"]')).toBeNull();
    expect(container.querySelector(".page-stage")?.textContent).not.toContain("OMe");
    expect(container.querySelector("[data-active-tool]")?.getAttribute("data-active-tool")).toBe("tool.atom");
  });
});
