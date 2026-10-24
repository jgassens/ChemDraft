// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ToolInstallForm } from "./ToolInstallForm";
import { toolInstallFixture } from "./toolInstallTestFixtures";
import { toolInstallSnapshot } from "../externalTools/toolInstallSnapshot";

it.each(["user", "managed"] as const)("asks only to use an installed %s tool, with disclosure said once", async source => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    for (const platform of ["macos", "windows"] as const) {
      const snapshot = toolInstallSnapshot({ tool: "codex", publisher: "OpenAI", state: "installed", source,
        pinnedVersion: "1", pinnedDownloadBytes: 167_000_000, freeDiskBytes: null, canInstall: true, consented: false, probedAt: "now" },
      { id: "plugin", name: "ChemDraft Assistant" }, { status: "consent" });
      await act(async () => root.render(createElement(ToolInstallForm, { snapshot, onAction: vi.fn(), platform })));
      expect(container.textContent).toContain("Allow ChemDraft Assistant to use Codex?");
      expect(container.textContent).not.toMatch(/download|MB|free while installing/i);
      expect(container.textContent?.match(/leave this computer and go to OpenAI/g)).toHaveLength(1);
      expect(container.textContent?.match(/The AI can search the web and read web pages\./g)).toHaveLength(1);
    }
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

it.each([["Anthropic", "Claude Code"], ["OpenAI", "Codex"]])('names %s and web access in both download and consent copy', async (publisher, toolName) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    const { disclosure } = toolInstallSnapshot({ tool: toolName === "Codex" ? "codex" : "claude", publisher, state: "missing", pinnedVersion: "2.0.0", pinnedDownloadBytes: 125_000_000, freeDiskBytes: 2_000_000_000, canInstall: true, consented: false, probedAt: "now" }, { id: "plugin", name: "Plugin" });
    await act(async () => root.render(createElement(ToolInstallForm, { snapshot: { ...toolInstallFixture(publisher), disclosure, toolName }, onAction: vi.fn(), platform: "macos" })));
    expect(container.textContent?.match(/leaves? this computer/g)).toHaveLength(1);
    expect(container.textContent?.match(/The AI can search the web and read web pages\./g)).toHaveLength(1);
    expect(container.textContent).toContain(`open page, including any unpublished structures, leave this computer and go to ${publisher}`);
    expect(container.textContent).toContain("The vendor program uses your own account; Clear conversation removes ChemDraft's local conversation files.");
    expect(container.textContent).toContain(`Download from ${publisher}: version 2.0.0, from downloads.example.test, 125 MB.`);
    await act(async () => root.render(createElement(ToolInstallForm, { snapshot: { ...toolInstallFixture(publisher), disclosure, toolName, state: { status: "consent" }, buttons: ["allow", "close"] }, onAction: vi.fn(), platform: "windows" })));
    expect(container.textContent?.match(/leaves? this computer/g)).toHaveLength(1);
    expect(container.textContent?.match(/The AI can search the web and read web pages\./g)).toHaveLength(1);
    expect(container.textContent).toContain(`open page, including any unpublished structures, leave this computer and go to ${publisher}`);
    expect(container.textContent).toContain("The vendor program uses your own account; Clear conversation removes ChemDraft's local conversation files.");
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
