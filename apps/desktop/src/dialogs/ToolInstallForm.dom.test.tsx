// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ToolInstallForm } from "./ToolInstallForm";
import { toolInstallFixture } from "./toolInstallTestFixtures";

it.each([["Anthropic", "Claude Code"], ["OpenAI", "Codex"]])('names %s and web access in both download and consent copy', async (publisher, toolName) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ToolInstallForm, { snapshot: { ...toolInstallFixture(publisher), toolName }, onAction: vi.fn(), platform: "macos" })));
    expect(container.textContent).toContain("The AI can search the web and read web pages.");
    expect(container.textContent).toContain("the open page — including any unpublished structures — leave this computer");
    expect(container.textContent).toContain(`go to ${publisher} under your own ${toolName} account.`);
    expect(container.textContent).toContain(`Download from ${publisher}: version 2.0.0, from downloads.example.test, 125 MB.`);
    await act(async () => root.render(createElement(ToolInstallForm, { snapshot: { ...toolInstallFixture(publisher), toolName, state: { status: "consent" }, buttons: ["allow", "close"] }, onAction: vi.fn(), platform: "windows" })));
    expect(container.textContent).toContain("The AI can search the web and read web pages.");
    expect(container.textContent).toContain("the open page — including any unpublished structures — leave this computer");
    expect(container.textContent).toContain(`go to ${publisher} under your own ${toolName} account.`);
    expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Allow", "Close"]);
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

it("shows unknown when free disk space cannot be determined", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ToolInstallForm, { snapshot: { ...toolInstallFixture(), freeDiskBytes: null }, onAction: vi.fn() })));
    expect(container.textContent).toContain("Free space on this disk: unknown.");
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
