// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenStructureRecognitionInstall } from "./StructureRecognitionController";
import { StructureRecognitionInstallDialog } from "./StructureRecognitionInstallDialog";
import type { StructureRecognitionInstallProgress } from "./structureRecognitionEngine";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

const gib = 1024 ** 3;

function request(overrides: Partial<OpenStructureRecognitionInstall> = {}): OpenStructureRecognitionInstall {
  return {
    id: 7,
    pluginId: "org.chemdraft.ocsr.molscribe",
    pluginName: "MolScribe OCSR",
    status: {
      state: "notInstalled",
      requiredDiskBytes: 2 * gib,
      freeDiskBytes: 3 * gib
    },
    installing: false,
    ...overrides
  };
}

function renderDialog(open: OpenStructureRecognitionInstall, callbacks = {
  onInstall: vi.fn(),
  onCancel: vi.fn(),
  onDecline: vi.fn()
}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(StructureRecognitionInstallDialog, { request: open, ...callbacks })));
  return callbacks;
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label
  );
  if (!match) throw new Error(`Missing ${label} button`);
  return match;
}

describe("StructureRecognitionInstallDialog", () => {
  it("names the plugin, install contents, disk sizes, privacy boundary, and explicit choices", () => {
    const callbacks = renderDialog(request());

    expect(document.body.textContent).toContain("Requested by MolScribe OCSR");
    expect(document.body.textContent).toContain("a private Python, PyTorch and a 1.1 GB model");
    expect(document.body.textContent).toContain("Space needed: 2 GB. Free space: 3 GB.");
    expect(document.body.textContent).toContain("Images never leave it.");

    act(() => button("Install").click());
    expect(callbacks.onInstall).toHaveBeenCalledWith(7);
    act(() => button("Not now").click());
    expect(callbacks.onDecline).toHaveBeenCalledWith(7);
  });

  it("shows byte progress and allows the in-flight install to be cancelled", () => {
    const callbacks = renderDialog(
      request({
        installing: true,
        progress: {
          phase: "downloadingModel",
          message: "Downloading the recognition model…",
          bytesDone: gib / 2,
          bytesTotal: gib
        }
      })
    );

    const progress = document.querySelector<HTMLProgressElement>('[data-testid="recognition-install-phase"]');
    expect(progress?.value).toBe(gib / 2);
    expect(progress?.max).toBe(gib);
    expect(document.querySelector('[data-testid="recognition-install-step"]')?.textContent).toBe(
      "Step 4 of 5: Downloading the recognition model"
    );
    expect(document.querySelector('[data-testid="recognition-install-phase-text"]')?.textContent).toBe(
      "537 MB of 1,074 MB"
    );
    expect(() => button("Install")).toThrow();
    act(() => button("Cancel").click());
    expect(callbacks.onCancel).toHaveBeenCalledWith(7);
  });

  it.each([
    ["insufficientDisk", "2 GB is needed; 3 GB is free."],
    ["network", "could not be downloaded"],
    ["checksumMismatch", "did not pass its integrity check"],
    ["cancelled", "Installation was cancelled"],
    ["unsupported", "isn’t supported"],
    ["failed", "could not be installed: native setup failed"]
  ] as const)("explains the %s install error in plain words", (code, expected) => {
    renderDialog(request({ error: { code, message: code === "failed" ? "native setup failed" : "fixture" } }));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(expected);
  });

  it("withholds Install for an unsupported computer", () => {
    renderDialog(
      request({
        status: {
          state: "unsupported",
          requiredDiskBytes: 2 * gib,
          freeDiskBytes: 3 * gib
        }
      })
    );

    expect(document.body.textContent).toContain("isn’t supported");
    expect(document.querySelector("h2")?.textContent).toBe("Recognition engine unavailable");
    expect(() => button("Install")).toThrow();
    expect(button("Not now")).toBeDefined();
  });

  it("maps Escape to decline before install and cancel during install", () => {
    const callbacks = renderDialog(request());
    act(() => button("Install").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(callbacks.onDecline).toHaveBeenCalledWith(7);
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });

  it("maps Escape to cancel while installing, and keeps Tab inside the dialog", () => {
    const callbacks = renderDialog(request({ installing: true, progress: { phase: "installingPython", message: "Installing Python…" } }));
    expect(document.querySelector('[data-testid="recognition-install-step"]')?.textContent).toBe(
      "Step 2 of 5: Installing Python"
    );
    const cancel = button("Cancel");
    expect(document.activeElement).toBe(cancel);
    act(() => cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(cancel);
    act(() => cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(callbacks.onCancel).toHaveBeenCalledWith(7);
    expect(callbacks.onDecline).not.toHaveBeenCalled();
  });

  it.each<[string, StructureRecognitionInstallProgress, string, string]>([
    ["checkingDisk", { phase: "checkingDisk", message: "m" }, "Step 1 of 5: Checking free disk space", "usually takes"],
    [
      "downloadingUv",
      { phase: "downloadingUv", message: "m", bytesDone: 5e6, bytesTotal: 17e6 },
      "Step 1 of 5: Downloading the installer",
      "5 MB of 17 MB"
    ],
    ["installingPython", { phase: "installingPython", message: "m" }, "Step 2 of 5: Installing Python", "usually takes"],
    [
      "installingPackages without bytes",
      { phase: "installingPackages", message: "Installing pinned MolScribe dependencies." },
      "Step 3 of 5: Installing PyTorch and MolScribe",
      "usually takes about 4 minutes"
    ],
    [
      "installingPackages estimated",
      { phase: "installingPackages", message: "m", bytesDone: 600e6, bytesTotal: 1200e6, estimated: true },
      "Step 3 of 5: Installing PyTorch and MolScribe",
      "About 600 MB of 1,200 MB (estimated)"
    ],
    [
      "downloadingModel",
      { phase: "downloadingModel", message: "m", bytesDone: 100e6, bytesTotal: 1134.9e6 },
      "Step 4 of 5: Downloading the recognition model",
      "100 MB of 1,135 MB"
    ],
    ["verifying", { phase: "verifying", message: "m" }, "Step 5 of 5: Checking the installation", "usually takes"],
    ["done", { phase: "done", message: "m" }, "Step 5 of 5: Finished", "installed"]
  ])("keeps the step, overall bar and a step estimate visible while %s", (_label, progress, step, detail) => {
    renderDialog(request({ installing: true, progress, startedAt: Date.now() - 65_000 }));
    expect(document.querySelector('[data-testid="recognition-install-step"]')?.textContent).toBe(step);
    const overall = document.querySelector<HTMLProgressElement>('[data-testid="recognition-install-overall"]');
    expect(overall).not.toBeNull();
    expect(overall!.max).toBe(100);
    expect(document.querySelector('[data-testid="recognition-install-overall-text"]')?.textContent).toMatch(
      /^\d+% overall · Elapsed 1:0[5-6]$/
    );
    expect(document.querySelector('[data-testid="recognition-install-phase"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="recognition-install-phase-text"]')?.textContent).toContain(detail);
  });

  it("moves the overall bar forward across phases, weighted by size", () => {
    const overallAt = (progress: StructureRecognitionInstallProgress): number => {
      renderDialog(request({ installing: true, progress }));
      const value = document.querySelector<HTMLProgressElement>('[data-testid="recognition-install-overall"]')!.value;
      act(() => root?.unmount());
      container?.remove();
      document.body.innerHTML = "";
      return value;
    };
    const values = [
      overallAt({ phase: "checkingDisk", message: "m" }),
      overallAt({ phase: "installingPython", message: "m", bytesDone: 1, bytesTotal: 1 }),
      overallAt({ phase: "installingPackages", message: "m", bytesDone: 600e6, bytesTotal: 1200e6, estimated: true }),
      overallAt({ phase: "downloadingModel", message: "m", bytesDone: 0, bytesTotal: 1 }),
      overallAt({ phase: "downloadingModel", message: "m", bytesDone: 1, bytesTotal: 1 }),
      overallAt({ phase: "done", message: "m" })
    ];
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values[0]).toBe(0);
    expect(values[2]).toBeGreaterThan(20);
    expect(values[2]).toBeLessThan(40);
    expect(values[5]).toBe(100);
  });
});
