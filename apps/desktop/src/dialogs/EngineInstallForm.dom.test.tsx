// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { EngineInstallForm } from "./EngineInstallForm";
import { engineInstallFixture } from "./engineInstallTestFixtures";

it.each(["macos", "windows"] as const)("closes with Escape and the platform close shortcut on %s, including body focus", async platform => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); const onAction = vi.fn();
  try {
    await act(async () => root.render(createElement(EngineInstallForm, { snapshot: engineInstallFixture(), onAction, platform })));
    expect(document.activeElement?.textContent).toBe("Close");
    (document.activeElement as HTMLElement).blur();
    const close = new KeyboardEvent("keydown", { key: "w", metaKey: platform === "macos", ctrlKey: platform === "windows", cancelable: true });
    document.dispatchEvent(close);
    expect(close.defaultPrevented).toBe(true);
    expect(onAction).toHaveBeenLastCalledWith("close");
    onAction.mockClear();
    const composing = new KeyboardEvent("keydown", { key: "Escape", isComposing: true, cancelable: true });
    document.dispatchEvent(composing); expect(onAction).not.toHaveBeenCalled();
    const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(escape); expect(onAction).toHaveBeenCalledExactlyOnceWith("close");
  } finally {
    act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});
