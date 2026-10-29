// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { parseDocument, type ChemDraftDocument } from "@chemdraft/chem-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createNativeSavePayload, createPhase4Document } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const native = vi.hoisted(() => ({
  desktop: false,
  save: vi.fn<() => Promise<string | null>>(),
  write: vi.fn<() => Promise<void>>()
}));
vi.mock("./window-manager", async (original) => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => native.desktop
}));
vi.mock("./nativeFileDialog", () => ({ save: native.save, prewarmNativeFileDialogs: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", async (original) => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(),
  writeTextFile: native.write
}));

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const tableDocument = () => parseDocument(JSON.parse(readFileSync("packages/fixtures/tables/sharpless-reagent-table.json", "utf8")));

describe("save warnings in the existing file warnings list", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    native.desktop = false;
    native.save.mockReset().mockResolvedValue("/tmp/table.chemdraft");
    native.write.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveKeybindingSettings({ scheme: "chemdraft" });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:save-warning-test");
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    native.desktop = false;
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount(initialDocument = tableDocument()) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialDocument,
        initialCrosshairsVisible: false,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: false
      }));
    });
  }

  const bridge = () => window.__CHEMDRAFT_AGENT__!;
  const status = () => container.querySelector<HTMLElement>("[data-status-message]")!;
  const button = () => container.querySelector<HTMLButtonElement>("[data-open-warnings-button]");
  const list = () => container.querySelector<HTMLElement>("[data-open-warnings-list]");

  async function command(id: string) {
    await act(async () => { await bridge().command(id); });
  }

  async function click(target: HTMLElement) {
    await act(async () => { target.click(); });
  }

  async function activate(index: number) {
    await click(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]!);
  }

  function warningFor(document: ChemDraftDocument) {
    const warning = createNativeSavePayload(document).warnings.find((warning) => warning.code === "cdxml.table_approximated");
    expect(warning).toBeDefined();
    return warning!;
  }

  it("makes every save warning message reachable from the existing button and status tooltip", async () => {
    const document = tableDocument();
    // Also prove the tooltip retains multiple full messages, rather than only the first warning.
    const table = document.pages[0]!.objects[0]!;
    if (table.type !== "table") throw new Error("Expected the table fixture");
    table.rotation = 30;
    const payload = createNativeSavePayload(document);
    const warning = warningFor(document);
    await mount(document);
    expect(button()).toBeNull();

    await command("document.save");
    expect(status().textContent).toBe(`Saved ${payload.filename} with ${payload.warnings.length} compatibility warning(s)`);
    expect(status().title).toBe(payload.warnings.map((warning) => warning.message).join("\n"));
    expect(button()?.textContent).toBe(`${payload.warnings.length} warnings`);
    expect(button()?.title).toBe("Show the warnings from saving this document");
    expect(list()).toBeNull();

    await click(button()!);
    expect(list()?.getAttribute("aria-label")).toBe(`Saved ${payload.filename}: ${payload.warnings.length} warnings`);
    const row = list()?.querySelector('[data-warning-code="cdxml.table_approximated"]');
    expect(row?.querySelector(".open-warnings-message")?.textContent).toBe(warning.message);
    for (const warning of payload.warnings) expect(list()?.textContent).toContain(warning.message);
    expect(button()?.getAttribute("aria-controls")).toBe(list()?.id);
    expect(button()?.title).toBe("Hide the warnings from saving this document");

    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(list()).toBeNull();
    expect(button()).not.toBeNull();
    await click(button()!);
    expect(list()).not.toBeNull();
  });

  it("offers neither a button nor a list for a clean save", async () => {
    await mount(createPhase4Document("Clean"));
    await command("document.save");
    expect(status().textContent).toBe("Saved Clean.chemdraft");
    expect(status().getAttribute("title")).toBeNull();
    expect(button()).toBeNull();
    expect(list()).toBeNull();
  });

  it("clears an earlier save report and its open list when the next save has no warnings", async () => {
    await mount();
    await command("document.save");
    await click(button()!);
    await command("edit.selectAll");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    });
    expect(bridge().snapshot().document.pages[0]!.objects).toHaveLength(0);
    await command("document.save");
    expect(button()).toBeNull();
    expect(list()).toBeNull();
    expect(status().getAttribute("title")).toBeNull();
  });

  it("keeps save warnings with their tab and clears the visible list on tab changes", async () => {
    await mount();
    await command("document.save");
    const warningText = status().title;
    await click(button()!);
    await command("document.new");
    expect(button()).toBeNull();
    expect(list()).toBeNull();
    expect(status().getAttribute("title")).toBeNull();
    await command("document.save");

    await activate(0);
    expect(button()?.textContent).toBe("1 warning");
    expect(status().title).toBe(warningText);
    expect(list()).toBeNull();
    await click(button()!);
    expect(list()?.textContent).toContain(warningText);

    await activate(1);
    expect(button()).toBeNull();
    expect(list()).toBeNull();
    expect(status().textContent).toBe("Saved Untitled.chemdraft");
    expect(status().getAttribute("title")).toBeNull();
  });

  it("attaches warnings to the saved tab when a native write completes after switching tabs", async () => {
    await mount();
    let finishWrite!: () => void;
    native.write.mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    // Mount in browser mode; only the save boundary needs the native picker and write mocks.
    native.desktop = true;
    let saving!: Promise<unknown>;
    await act(async () => {
      saving = bridge().command("document.save");
      await vi.waitFor(() => expect(native.write).toHaveBeenCalled());
    });
    native.desktop = false;
    await command("document.new");
    await act(async () => { finishWrite(); await saving; });
    expect(button()).toBeNull();
    expect(status().getAttribute("title")).toBeNull();

    await activate(0);
    expect(status().textContent).toBe("Saved table.chemdraft with 1 compatibility warning(s)");
    expect(button()?.textContent).toBe("1 warning");
    await click(button()!);
    expect(list()?.getAttribute("aria-label")).toBe("Saved table.chemdraft: 1 warning");
    expect(list()?.textContent).toContain(warningFor(tableDocument()).message);
    expect(status().title).toBe(warningFor(tableDocument()).message);
  });
});
