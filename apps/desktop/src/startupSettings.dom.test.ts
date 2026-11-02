// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { PreferencesWindow } from "./PreferencesWindow";
import { loadStartWithFreshDocument } from "./startupSettings";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("persists the launch checkbox in StrictMode and reflects it on reopen", async () => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  const container = document.createElement("div"); document.body.append(container);
  let root = createRoot(container);
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(PreferencesWindow))));
    const label = [...container.querySelectorAll("label")].find(label => label.textContent?.includes("Start with a fresh document"))!;
    const checkbox = label.querySelector<HTMLInputElement>("input")!;
    expect(checkbox.checked).toBe(false);
    expect(label.textContent).toContain("on the next launch");
    await act(async () => checkbox.click()); expect(loadStartWithFreshDocument()).toBe(true);
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(createElement(PreferencesWindow)));
    const reopened = [...container.querySelectorAll("label")].find(label => label.textContent?.includes("Start with a fresh document"))!.querySelector<HTMLInputElement>("input")!;
    expect(reopened.checked).toBe(true);
    await act(async () => reopened.click()); expect(loadStartWithFreshDocument()).toBe(false);
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
