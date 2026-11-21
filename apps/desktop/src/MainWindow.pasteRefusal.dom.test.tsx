// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MainWindow } from "./MainWindow";
import {
  CHEMDRAFT_SELECTION_CLIPBOARD_TYPE,
  createPhase4Document,
  createSelectionClipboardPayload,
  insertNativeTextObject,
  pasteSelectionClipboardPayload,
  serializeSelectionClipboardPayload
} from "./documentWorkflow";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn()
}));
vi.mock("./documentWorkflow", async original => ({
  ...await original<typeof import("./documentWorkflow")>(),
  pasteSelectionClipboardPayload: vi.fn()
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A realistic refusal needs a pre-existing molecule whose chemistry a pasted mark would change
// (d4682e11b). Building that through the UI is brittle, so the paste step is stubbed to refuse
// the way the real one does: return the same document and report the reason in `warnings`.
const refusal = 'Cannot paste without changing the chemistry of molecule "mol_001": a copied charge mark would attach to it.';

describe("MainWindow paste refusal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(invoke).mockReset().mockImplementation(async command => {
      if (command === "read_clipboard_payload") return { types: [], textItems: [] };
      throw new Error(`Unexpected native command: ${String(command)}`);
    });
    vi.mocked(pasteSelectionClipboardPayload).mockReset();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
  });

  const status = () => container.querySelector('[role="status"]')?.textContent;

  async function pasteSelection() {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: createPhase4Document("Paste refusal"),
      initialActiveToolCommandId: "tool.select",
      initialCrosshairsVisible: false,
      initialRulersVisible: false,
      initialPaletteMode: "hidden",
      shortcutPlatform: "macos"
    })));
    const source = insertNativeTextObject(createPhase4Document("Source"), { x: 120, y: 140 }, "H2O");
    const text = serializeSelectionClipboardPayload(createSelectionClipboardPayload(source)!);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { types: [CHEMDRAFT_SELECTION_CLIPBOARD_TYPE], getData: (type: string) => type === CHEMDRAFT_SELECTION_CLIPBOARD_TYPE ? text : "" }
    });
    await act(async () => { window.dispatchEvent(event); });
  }

  it("shows the specific refusal instead of 'Clipboard selection unchanged'", async () => {
    vi.mocked(pasteSelectionClipboardPayload).mockImplementation((document, _payload, _point, warnings) => {
      warnings?.push(refusal);
      return document;
    });
    await pasteSelection();
    expect(pasteSelectionClipboardPayload).toHaveBeenCalled();
    expect(status()).toBe(refusal);
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0]!.objects).toHaveLength(0);
  });

  it("keeps 'Clipboard selection unchanged' when nothing changed and nothing was refused", async () => {
    vi.mocked(pasteSelectionClipboardPayload).mockImplementation(document => document);
    await pasteSelection();
    expect(status()).toBe("Clipboard selection unchanged");
  });
});
