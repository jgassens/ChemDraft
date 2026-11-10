// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { pageCanvasMenu } from "./canvasContextMenuModel";
import { popupNativeCanvasMenu } from "./nativeCanvasContextMenu";
import { isDesktopRuntime } from "./window-manager";

vi.mock("./nativeCanvasContextMenu", () => ({ popupNativeCanvasMenu: vi.fn() }));
vi.mock("./window-manager", () => ({ isDesktopRuntime: vi.fn(() => true) }));
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); vi.mocked(isDesktopRuntime).mockReturnValue(true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function mount() {
  const onInvoke = vi.fn(), onDismiss = vi.fn();
  await act(async () => root.render(<StrictMode><CanvasContextMenu items={pageCanvasMenu} label="Page options"
    targetKind="page" position={{ x: 12, y: 34 }} onInvoke={onInvoke} onDismiss={onDismiss} /></StrictMode>));
  return { onInvoke, onDismiss };
}

describe("native popup lifecycle and HTML fallback", () => {
  it("opens once under StrictMode and routes the choice once", async () => {
    vi.mocked(popupNativeCanvasMenu).mockResolvedValue({ select: invoke => { invoke("clipboard.paste"); return true; } });
    const { onInvoke, onDismiss } = await mount();
    expect(popupNativeCanvasMenu).toHaveBeenCalledTimes(1);
    expect(onInvoke).toHaveBeenCalledExactlyOnceWith("clipboard.paste");
    expect(onDismiss).not.toHaveBeenCalled();
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
  it("dismisses without a command or fallback after Escape/outside click", async () => {
    vi.mocked(popupNativeCanvasMenu).mockResolvedValue({ select: () => false });
    const { onInvoke, onDismiss } = await mount();
    expect(onInvoke).not.toHaveBeenCalled(); expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
  it("uses the same HTML menu only when the native popup is unavailable", async () => {
    vi.mocked(popupNativeCanvasMenu).mockResolvedValue(undefined);
    const { onInvoke, onDismiss } = await mount();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-command-id="edit.selectAll"]')!.click());
    expect(onInvoke).toHaveBeenCalledExactlyOnceWith("edit.selectAll");
    expect(onDismiss).not.toHaveBeenCalled();
  });
  it("uses HTML directly in a web build", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(false);
    await mount();
    expect(popupNativeCanvasMenu).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute("data-command-id")).toBe("clipboard.paste");
  });
  it("ignores a stale choice after the owner unmounts", async () => {
    let finish!: (value: { select(invoke: (id: string) => void): boolean }) => void;
    vi.mocked(popupNativeCanvasMenu).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { onInvoke, onDismiss } = await mount();
    await act(async () => root.render(null));
    await act(async () => finish({ select: invoke => { invoke("clipboard.paste"); return true; } }));
    expect(onInvoke).not.toHaveBeenCalled(); expect(onDismiss).not.toHaveBeenCalled();
  });
});
