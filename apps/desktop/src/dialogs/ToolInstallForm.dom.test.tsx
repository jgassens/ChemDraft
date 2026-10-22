// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ToolInstallForm } from "./ToolInstallForm";
import { toolInstallFixture } from "./toolInstallTestFixtures";

it.each(["Anthropic", "OpenAI"])('names %s in both download and consent copy', async publisher => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ToolInstallForm, { snapshot: toolInstallFixture(publisher), onAction: vi.fn(), platform: "macos" })));
    expect(container.textContent).toContain(`go to ${publisher} under your own Claude Code account.`);
    expect(container.textContent).toContain(`Download from ${publisher}: version 2.0.0, from downloads.example.test, 125 MB.`);
    await act(async () => root.render(createElement(ToolInstallForm, { snapshot: { ...toolInstallFixture(publisher), state: { status: "consent" }, buttons: ["allow", "close"] }, onAction: vi.fn(), platform: "windows" })));
    expect(container.textContent).toContain(`go to ${publisher} under your own Claude Code account.`);
    expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Allow", "Close"]);
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

it.each([
  [{ status: "notInstalled" } as const, ["install", "close"]],
  [{ status: "consent" } as const, ["allow", "close"]],
  [{ status: "installing", phase: "Downloading" } as const, ["cancelInstall", "close"]],
  [{ status: "installed" } as const, ["close"]],
  [{ status: "failed", message: "Checksum did not match." } as const, ["close"]],
  [{ status: "broken", detail: "Receipt missing." } as const, ["close"]]
])("shows only the state buttons for %s", async (state, buttons) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ToolInstallForm, { snapshot: { ...toolInstallFixture(), state, buttons: buttons as ("install" | "allow" | "cancelInstall" | "close")[] }, onAction: vi.fn() })));
    const labels: Record<string, string> = { install: "Install", allow: "Allow", cancelInstall: "Cancel installation", close: "Close" };
    expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual(buttons.map(button => labels[button]));
    if (state.status === "failed") expect(container.querySelector('[role="alert"]')?.textContent).toBe("Checksum did not match.");
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
