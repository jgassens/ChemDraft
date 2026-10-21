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

it.each([
  [16_730_000_000, "Needs about 1.0 GB free while installing. Free now: 16.7 GB.", false],
  [600_000_000, "Needs about 1.0 GB free while installing; only 0.6 GB is free.", true]
])("states the install space in one sentence (free %d)", async (free, sentence, disabled) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(EngineInstallForm, { snapshot: { ...engineInstallFixture(), freeDiskBytes: free }, onAction: vi.fn(), platform: "macos" })));
    const text = container.textContent ?? "";
    expect(text).toContain(sentence);
    expect(text).toContain("Downloads about 100 MB and uses about 0.3 GB once installed.");
    expect(text).not.toContain("Naming engine");
    expect(text).not.toContain("1.00");
    expect(container.querySelector("h2")?.textContent).toBe("Naming needs a local engine");
    expect([...container.querySelectorAll("button")].find(b => b.textContent === "Install")?.disabled).toBe(disabled);
  } finally {
    act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});

it("presents a user-cancelled install as neutral status text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(EngineInstallForm, {
      snapshot: { ...engineInstallFixture(), state: { status: "failed", message: "Installation was cancelled." }, buttons: ["close"] },
      onAction: vi.fn(),
      platform: "windows"
    })));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Installation was cancelled.");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});
