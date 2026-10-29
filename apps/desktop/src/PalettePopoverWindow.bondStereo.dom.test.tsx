// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { sendBondStereoPopoverAction, sendPaletteCommand, type ToolsetPopoverDismissPayload, type ToolsetPopoverContentPayload } from "./window-manager";
import { useBondStereoPopover } from "./useBondStereoPopover";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { closeToolsetPopoverWindow, openToolsetPopoverWindow, setToolsetPopoverContent } from "./window-manager";

const native = vi.hoisted(() => ({
  content: undefined as undefined | ((payload: ToolsetPopoverContentPayload) => void),
  action: undefined as undefined | ((payload: { sessionId: string; action: string }) => void),
  dismiss: undefined as undefined | ((payload?: ToolsetPopoverDismissPayload) => void),
  hide: vi.fn(async () => {}), focus: vi.fn(async () => {}), show: vi.fn(async () => {}),
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => {}),
  fallbackShow: vi.fn(async () => {}),
  events: {} as Record<string, () => void>
}));
vi.mock("./window-manager/tauriEvents", () => ({
  listenCurrentWindowEvent: vi.fn(async (name: string, handler: () => void) => { native.events[name] = handler; return () => { delete native.events[name]; }; }),
  listenTauriEvent: vi.fn(async () => () => {})
}));
vi.mock("./documentWorkflow", async importOriginal => ({
  ...await importOriginal<typeof import("./documentWorkflow")>(),
  nativeBondStereoAvailability: vi.fn(() => ({})), nativeBondStereoFlipDisabledReason: vi.fn(() => undefined)
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: native.hide, setFocus: native.focus, show: native.fallbackShow }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setFocus: vi.fn(async () => {}) }) }));
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  listenForToolsetPopoverContent: vi.fn(async handler => { native.content = handler; return () => {}; }),
  listenForToolsetPopoverDismiss: vi.fn(async handler => { native.dismiss = handler; return () => {}; }),
  listenForBondStereoPopoverActions: vi.fn(async handler => { native.action = handler; return () => {}; }),
  listenForToolsetTextStyle: vi.fn(async () => () => {}),
  requestToolsetPopoverContent: vi.fn(async () => {}), requestToolsetTextStyle: vi.fn(async () => {}),
  setCurrentWindowLogicalSize: vi.fn(async () => {}), setCurrentWindowLogicalPosition: vi.fn(async () => {}),
  showCurrentToolsetPopoverWindow: native.show,
  sendBondStereoPopoverAction: vi.fn(async () => {}), sendPaletteCommand: vi.fn(async () => {}),
  currentWindowLogicalPosition: vi.fn(async () => ({ x: 100, y: 200 })),
  openToolsetPopoverWindow: vi.fn(async () => {}), closeToolsetPopoverWindow: vi.fn(async () => {}),
  setToolsetPopoverContent: vi.fn(async () => {}), listenForToolsetPopoverContentRequests: vi.fn(async () => () => {}),
  sendPaletteCommandCancel: vi.fn(async () => {})
}));

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});

describe("document-owned bond stereo popover", () => {
  const doc = { pages: [{ objects: [{ id: "m", type: "molecule", bonds: [{ id: "b", stereo: "either" }] }] }] } as unknown as ChemDraftDocument;
  function Owner({ keyboard = false }: { keyboard?: boolean }) {
    const openPopover = useBondStereoPopover({ document: doc, targets: [{ objectId: "m", bondId: "b" }], reader: undefined,
      select: () => {}, invoke: () => {}, focusCanvas: () => {} });
    return <><div className="page-stage" /><button onClick={() => openPopover({ objectId: "m", bondId: "b", rect: { left: 30, bottom: 50 }, keyboard })}>Open</button></>;
  }
  it.each([false, true])("sends the native creation and content focus mode for keyboard=%s", async keyboard => {
    await act(async () => root.render(<Owner keyboard={keyboard} />));
    await act(async () => container.querySelector("button")!.click());
    expect(openToolsetPopoverWindow).toHaveBeenCalledWith("core.bondStereo", "flyout", 130, 254, keyboard ? "focus" : "preserve");
    expect(setToolsetPopoverContent).toHaveBeenCalledWith("core.bondStereo", expect.objectContaining({
      kind: "flyout", flyout: expect.objectContaining({ variant: "bondStereo", keyboardOpen: keyboard })
    }), { x: 130, y: 254 });
  });
  it("logs a failed preserve reveal, hides, and releases the document session without activating", async () => {
    const manager = await vi.importActual<typeof import("./window-manager")>("./window-manager");
    const host = window as typeof window & { __TAURI__?: unknown };
    const error = new Error("native preserve reveal failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => root.render(<Owner />));
    const ownerAction = native.action;
    await act(async () => container.querySelector("button")!.click());
    const [, content, anchor] = vi.mocked(setToolsetPopoverContent).mock.calls[0];
    expect(content.kind).toBe("flyout");
    if (content.kind !== "flyout") throw new Error("Expected E/Z flyout");
    const sessionId = content.flyout.id!;
    host.__TAURI__ = {};
    try {
      // Use the real reveal transport so the no-activating-fallback guarantee and
      // the popover-to-document close notification are exercised together.
      native.show.mockImplementationOnce(() => manager.showCurrentToolsetPopoverWindow("preserve"));
      native.invoke.mockRejectedValueOnce(error);
      vi.mocked(sendBondStereoPopoverAction).mockImplementationOnce(async payload => { ownerAction?.(payload); });
      await act(async () => root.render(<><Owner /><PalettePopoverWindow toolsetId="core.bondStereo" kind="flyout" prewarm /></>));
      await act(async () => native.content?.({ toolsetId: "core.bondStereo", ...content, anchor }));
      expect(native.invoke).toHaveBeenCalledWith("show_toolset_popover_window", { focusMode: "preserve" });
      expect(warn).toHaveBeenCalledWith("Toolset popover reveal failed", error);
      expect(native.hide).toHaveBeenCalledTimes(1);
      expect(sendBondStereoPopoverAction).toHaveBeenCalledWith({ sessionId, action: "close" });
      expect(closeToolsetPopoverWindow).toHaveBeenCalledTimes(1);
      expect(native.fallbackShow).not.toHaveBeenCalled();
      expect(native.focus).not.toHaveBeenCalled();
      // A later action from the failed session has no remaining authority.
      await act(async () => ownerAction?.({ sessionId, action: "close" }));
      expect(closeToolsetPopoverWindow).toHaveBeenCalledTimes(1);
    } finally { delete host.__TAURI__; }
  });
  it.each(["pointer-away", "escape", "scroll", "viewport", "move", "resize", "scale"])("closes a never-focused mouse open on %s", async trigger => {
    await act(async () => root.render(<Owner />));
    await act(async () => container.querySelector("button")!.click());
    expect(openToolsetPopoverWindow).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (trigger === "pointer-away") container.querySelector(".page-stage")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      else if (trigger === "escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      else if (trigger === "scroll") container.querySelector(".page-stage")!.dispatchEvent(new Event("scroll"));
      else if (trigger === "viewport") (container.querySelector(".page-stage") as HTMLElement).style.setProperty("--viewport-scale", "2");
      else native.events[trigger === "scale" ? "tauri://scale-change" : `tauri://${trigger}`]?.();
    });
    expect(closeToolsetPopoverWindow).toHaveBeenCalledWith("core.bondStereo");
    expect(sendBondStereoPopoverAction).toHaveBeenCalledWith(expect.objectContaining({ action: "close" }));
  });
});
describe("native popover focus transport", () => {
  it("sends both focus modes through the real window manager and preserves the color-picker default", async () => {
    const manager = await vi.importActual<typeof import("./window-manager")>("./window-manager");
    const host = window as typeof window & { __TAURI__?: unknown };
    host.__TAURI__ = {};
    try {
      for (const focusMode of ["preserve", "focus"] as const) {
        await manager.openToolsetPopoverWindow("core.bondStereo", "flyout", 130, 254, focusMode);
        expect(native.invoke).toHaveBeenLastCalledWith("open_toolset_popover", {
          toolsetId: "core.bondStereo", kind: "flyout", x: 130, y: 254, focusMode
        });
        await manager.showCurrentToolsetPopoverWindow(focusMode);
        expect(native.invoke).toHaveBeenLastCalledWith("show_toolset_popover_window", { focusMode });
      }
      await manager.openToolsetPopoverWindow("core.art", "artColor", 0, 0);
      expect(native.invoke).toHaveBeenLastCalledWith("open_toolset_popover", {
        toolsetId: "core.art", kind: "artColor", x: 0, y: 0, focusMode: "focus"
      });
      await manager.showCurrentToolsetPopoverWindow();
      expect(native.invoke).toHaveBeenLastCalledWith("show_toolset_popover_window", { focusMode: "focus" });
    } finally { delete host.__TAURI__; }
  });
  it("never falls back to an activating show after a preserve-focus reveal fails", async () => {
    const manager = await vi.importActual<typeof import("./window-manager")>("./window-manager");
    const host = window as typeof window & { __TAURI__?: unknown };
    host.__TAURI__ = {};
    try {
      native.invoke.mockRejectedValueOnce(new Error("native reveal failed"));
      await expect(manager.showCurrentToolsetPopoverWindow("preserve")).rejects.toThrow("native reveal failed");
      expect(native.fallbackShow).not.toHaveBeenCalled();
    } finally { delete host.__TAURI__; }
  });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function open(keyboardOpen = false) {
  await act(async () => root.render(<PalettePopoverWindow toolsetId="core.bondStereo" kind="flyout" prewarm />));
  expect(native.show).not.toHaveBeenCalled();
  await act(async () => native.content?.({ toolsetId: "core.bondStereo", anchor: { x: 130, y: 254 }, kind: "flyout",
    flyout: { id: "session-1", flyoutId: "core.bondStereo", title: "E/Z not specified", variant: "bondStereo", keyboardOpen,
      commands: [
        { id: "molecule.bondStereo:geometry", title: "Use drawn geometry (Z)", enabled: true, active: false },
        { id: "molecule.bondStereo:flipped", title: "Use the other geometry (E)", enabled: true, active: false }
      ] } }));
  expect(native.show).toHaveBeenCalledTimes(1);
  expect(native.show).toHaveBeenCalledWith(keyboardOpen ? "focus" : "preserve");
  expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("E/Z not specified");
  expect(container.querySelector("p")?.textContent).toBe("This double bond's geometry wasn't given, so ChemDraft shows it as either E or Z.");
  return [...container.querySelectorAll("button")];
}

describe("open-bond native popover body", () => {
  it("keeps the shared color picker reveal focusable and its text input editable", async () => {
    await act(async () => root.render(<PalettePopoverWindow toolsetId="core.art" kind="artColor" prewarm />));
    await act(async () => native.content?.({ toolsetId: "core.art", kind: "artColor" }));
    expect(native.show).toHaveBeenCalledWith("focus");
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input).not.toBeNull();
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(false);
  });
  it.each(["bondStereo", "artColor", "menu"] as const)("ignores a stale dismiss for fresh %s content and honors a later press", async variant => {
    const now = vi.spyOn(performance, "now").mockReturnValue(200);
    if (variant === "bondStereo") await open();
    else {
      await act(async () => root.render(<PalettePopoverWindow toolsetId="core.art" kind={variant === "artColor" ? "artColor" : "flyout"} prewarm />));
      await act(async () => native.content?.(variant === "artColor" ? { toolsetId: "core.art", kind: "artColor" } : {
        toolsetId: "core.art", kind: "flyout", flyout: { flyoutId: "shapes", title: "Shapes", commands: [
          { id: "tool.rectangle", title: "Rectangle", enabled: true, active: false }
        ] }
      }));
    }
    expect(native.show).toHaveBeenCalledTimes(1);
    now.mockReturnValue(400); // Delivery time must not replace the original press time.
    await act(async () => native.dismiss?.({ requestedAt: performance.timeOrigin + 100 }));
    expect(native.hide).not.toHaveBeenCalled();
    expect(sendBondStereoPopoverAction).not.toHaveBeenCalled();
    await act(async () => native.dismiss?.({ requestedAt: performance.timeOrigin + 300 }));
    expect(native.hide).toHaveBeenCalledTimes(1);
    if (variant === "bondStereo") expect(sendBondStereoPopoverAction).toHaveBeenCalledWith({ sessionId: "session-1", action: "close" });
  });
  it("keeps unstamped colour-picker click-away dismissal unconditional", async () => {
    await act(async () => root.render(<PalettePopoverWindow toolsetId="core.art" kind="artColor" prewarm />));
    await act(async () => native.content?.({ toolsetId: "core.art", kind: "artColor" }));
    await act(async () => native.dismiss?.());
    expect(native.hide).toHaveBeenCalledTimes(1);
  });
  it.each(["geometry", "flipped", "keep"] as const)("sends %s exactly once and hides", async action => {
    const buttons = await open();
    expect(native.focus).not.toHaveBeenCalled(); // Mouse opens never steal document focus.
    const button = buttons[action === "geometry" ? 0 : action === "flipped" ? 1 : 2];
    await act(async () => { button.click(); button.click(); });
    expect(sendBondStereoPopoverAction).toHaveBeenCalledTimes(1);
    expect(sendBondStereoPopoverAction).toHaveBeenCalledWith({ sessionId: "session-1", action });
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    expect(native.hide).toHaveBeenCalledTimes(1);
  });
  it("ignores startup replay after dismissal and a delayed snapshot for a cancelled open", async () => {
    await open();
    await act(async () => native.action?.({ sessionId: "session-1", action: "close" }));
    await act(async () => native.content?.({ toolsetId: "core.bondStereo", kind: "flyout", flyout: {
      id: "session-1", flyoutId: "core.bondStereo", title: "E/Z not specified", variant: "bondStereo", commands: []
    } }));
    expect(native.show).toHaveBeenCalledTimes(1);
    await act(async () => native.action?.({ sessionId: "cancelled-before-content", action: "close" }));
    await act(async () => native.content?.({ toolsetId: "core.bondStereo", kind: "flyout", flyout: {
      id: "cancelled-before-content", flyoutId: "core.bondStereo", title: "E/Z not specified", variant: "bondStereo", commands: []
    } }));
    expect(native.show).toHaveBeenCalledTimes(1);
  });
  it.each(["escape", "click-away"])("%s sends closure to the document for canvas focus return", async method => {
    await open();
    await act(async () => {
      if (method === "escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      else native.dismiss?.();
    });
    expect(sendBondStereoPopoverAction).toHaveBeenCalledWith({ sessionId: "session-1", action: "close" });
    expect(native.hide).toHaveBeenCalledTimes(1);
  });
  it("keyboard opens focus the first action and Tab wraps within the native window", async () => {
    const buttons = await open(true);
    expect(native.focus).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(buttons[0]);
    await act(async () => buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(buttons[2]);
    await act(async () => buttons[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(buttons[0]);
  });
  it("does not let an older reveal hide a newly opened session", async () => {
    let finishReveal!: () => void;
    native.show.mockImplementationOnce(() => new Promise<void>(resolve => { finishReveal = resolve; }));
    await open();
    const next: ToolsetPopoverContentPayload = { toolsetId: "core.bondStereo", kind: "flyout", flyout: {
      id: "session-2", flyoutId: "core.bondStereo", title: "E/Z not specified", variant: "bondStereo",
      commands: [{ id: "molecule.bondStereo:geometry", title: "Use drawn geometry (E)", enabled: true, active: false }]
    } };
    await act(async () => { native.content?.(next); native.content?.(next); });
    expect(native.show).toHaveBeenCalledTimes(2);
    await act(async () => finishReveal());
    expect(native.hide).not.toHaveBeenCalled();
    await act(async () => container.querySelector("button")!.click());
    expect(sendBondStereoPopoverAction).toHaveBeenCalledWith({ sessionId: "session-2", action: "geometry" });
  });
  it("does not let an older failed reveal close a newly opened session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let failReveal!: (error: Error) => void;
    native.show.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { failReveal = reject; }));
    await open();
    await act(async () => native.content?.({ toolsetId: "core.bondStereo", kind: "flyout", flyout: {
      id: "session-2", flyoutId: "core.bondStereo", title: "E/Z not specified", variant: "bondStereo",
      commands: [{ id: "molecule.bondStereo:geometry", title: "Use drawn geometry (E)", enabled: true, active: false }]
    } }));
    const error = new Error("older reveal failed");
    await act(async () => failReveal(error));
    expect(warn).toHaveBeenCalledWith("Toolset popover reveal failed", error);
    expect(native.hide).not.toHaveBeenCalled();
    expect(sendBondStereoPopoverAction).not.toHaveBeenCalled();
    await act(async () => container.querySelector("button")!.click());
    expect(sendBondStereoPopoverAction).toHaveBeenCalledWith({ sessionId: "session-2", action: "geometry" });
  });
  it("keeps unavailable geometry choices disabled with their reason", async () => {
    await open();
    await act(async () => native.content?.({ toolsetId: "core.bondStereo", kind: "flyout", flyout: {
      id: "disabled-session", flyoutId: "core.bondStereo", title: "E/Z not specified", variant: "bondStereo",
      commands: [{ id: "molecule.bondStereo:flipped", title: "Use the other geometry", enabled: false,
        active: false, disabledReason: "Ring geometry cannot be flipped independently" }]
    } }));
    const disabled = container.querySelector("button")!;
    expect(disabled.disabled).toBe(true);
    expect(disabled.title).toBe("Ring geometry cannot be flipped independently");
    await act(async () => disabled.click());
    expect(sendBondStereoPopoverAction).not.toHaveBeenCalled();
    expect(native.hide).not.toHaveBeenCalled();
  });
});
