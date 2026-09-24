// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenStructureRecognitionInstall } from "./StructureRecognitionController";
import { StructureRecognitionInstallDialog } from "./StructureRecognitionInstallDialog";

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

    const progress = document.querySelector<HTMLProgressElement>("progress");
    expect(progress?.value).toBe(gib / 2);
    expect(progress?.max).toBe(gib);
    expect(document.body.textContent).toContain("Downloading the recognition model…");
    expect(document.body.textContent).toContain("0.5 GB of 1 GB");
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
    expect(document.querySelector("progress")).toBeNull();
    expect(document.body.textContent).toContain("Installing Python…");
    const cancel = button("Cancel");
    expect(document.activeElement).toBe(cancel);
    act(() => cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(cancel);
    act(() => cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(callbacks.onCancel).toHaveBeenCalledWith(7);
    expect(callbacks.onDecline).not.toHaveBeenCalled();
  });
});
