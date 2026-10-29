// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { sendBondStereoPopoverAction, sendPaletteCommand, type ToolsetPopoverContentPayload } from "./window-manager";

const native = vi.hoisted(() => ({
  content: undefined as undefined | ((payload: ToolsetPopoverContentPayload) => void),
  action: undefined as undefined | ((payload: { sessionId: string; action: string }) => void),
  dismiss: undefined as undefined | (() => void),
  hide: vi.fn(async () => {}), focus: vi.fn(async () => {}), show: vi.fn(async () => {})
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: native.hide, setFocus: native.focus }) }));
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
  sendPaletteCommandCancel: vi.fn(async () => {})
}));

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
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
  expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("E/Z not specified");
  expect(container.querySelector("p")?.textContent).toBe("This double bond's geometry wasn't given, so ChemDraft shows it as either E or Z.");
  return [...container.querySelectorAll("button")];
}

describe("open-bond native popover body", () => {
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
