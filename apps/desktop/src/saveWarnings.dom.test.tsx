// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { parseDocument, type ChemDraftDocument } from "@chemdraft/chem-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createNativeSavePayload, createPhase4Document } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";
import { tableInsertCommandId } from "./tableCommands";
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

  async function openWithWarnings() {
    const contents = readFileSync("packages/fixtures/cdxml/single-bond.cdxml", "utf8");
    const hash = new URLSearchParams({ openDocumentText: contents, displayName: "import.cdxml" });
    await act(async () => {
      window.history.replaceState(null, "", `/?agentBridge=1#${hash}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await bridge().waitForIdle();
    });
    expect(button()).not.toBeNull();
    expect(status().title).toContain("Opened import.cdxml");
    return status().title;
  }

  function saveTooltip(filename: string, warnings: readonly { message: string }[]) {
    const count = warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`;
    return [`Saved ${filename}: ${count}`, ...warnings.map((warning) => warning.message)].join("\n");
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
    expect(status().title).toBe(saveTooltip(payload.filename, payload.warnings));
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

  it("keeps the open report, button, list and tooltip after an unchanged clean save", async () => {
    await mount(createPhase4Document());
    const openTooltip = await openWithWarnings();
    const count = button()!.textContent;
    await click(button()!);
    const openHeading = list()!.getAttribute("aria-label");
    const messages = [...list()!.querySelectorAll(".open-warnings-message")].map((row) => row.textContent);
    expect(createNativeSavePayload(bridge().snapshot().document).warnings).toHaveLength(0);

    await command("document.save");
    expect(status().textContent).toMatch(/^Saved .*\.chemdraft$/);
    expect(status().title).toBe(openTooltip);
    expect(button()?.textContent).toBe(count);
    expect(button()?.title).toBe("Show the warnings from opening this document");
    await click(button()!);
    expect(list()?.getAttribute("aria-label")).toBe(openHeading);
    expect([...list()!.querySelectorAll(".open-warnings-message")].map((row) => row.textContent)).toEqual(messages);
  });

  it("shows labelled open and save groups in order, replacing and clearing only save findings", async () => {
    await mount(createPhase4Document());
    const openTooltip = await openWithWarnings();
    const openCount = Number(button()!.textContent!.split(" ")[0]);
    await command(tableInsertCommandId(2, 2, 1));
    const payload = createNativeSavePayload(bridge().snapshot().document);
    expect(payload.warnings.length).toBeGreaterThan(0);
    await command("document.save");
    expect(status().title).toBe(`${openTooltip}\n\n${saveTooltip(payload.filename, payload.warnings)}`);
    expect(button()?.textContent).toBe(`${openCount + payload.warnings.length} warnings`);
    expect(button()?.title).toBe("Show the warnings from opening and saving this document");
    await click(button()!);
    const groups = list()!.querySelectorAll("section");
    expect(groups).toHaveLength(2);
    expect(groups[0]!.getAttribute("aria-label")).toMatch(/^Opened import.cdxml/);
    expect(groups[1]!.getAttribute("aria-label")).toMatch(/^Saved /);
    expect(groups[0]!.textContent).not.toContain("Table written");
    for (const warning of payload.warnings) expect(groups[1]!.textContent).toContain(warning.message);
    expect(button()?.getAttribute("aria-controls")).toBe(list()?.id);

    // Repeating the save replaces its report, without duplicating findings or changing the open report.
    await command("document.save");
    expect(status().title).toBe(`${openTooltip}\n\n${saveTooltip(payload.filename, payload.warnings)}`);
    await click(button()!);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(list()).toBeNull();
    expect(button()).not.toBeNull();

    // Undo the inserted table, then a clean save leaves only the original open report.
    await command("edit.undo");
    expect(createNativeSavePayload(bridge().snapshot().document).warnings).toHaveLength(0);
    await command("document.save");
    expect(status().title).toBe(openTooltip);
    await click(button()!);
    expect(list()?.getAttribute("aria-label")).toMatch(/^Opened import.cdxml/);
    expect(list()?.textContent).not.toContain("Saved ");
  });

  it("keeps both reports on tab A apart from saves on tab B and drops both on close", async () => {
    await mount(createPhase4Document());
    const openTooltip = await openWithWarnings();
    await command(tableInsertCommandId(2, 2, 1));
    await command("document.save");
    const combinedTooltip = status().title;
    expect(combinedTooltip).toContain(openTooltip);
    await click(button()!);

    await command("document.new");
    expect(button()).toBeNull();
    expect(list()).toBeNull();
    await command("document.save");
    expect(status().getAttribute("title")).toBeNull();
    await activate(0);
    expect(status().title).toBe(combinedTooltip);
    expect(list()).toBeNull();
    await click(button()!);
    expect(list()!.querySelectorAll("section")).toHaveLength(2);

    // Saving B with its own warnings must not show A's import findings there.
    await activate(1);
    await command(tableInsertCommandId(3, 2, 1));
    await command("document.save");
    expect(status().title).not.toContain(openTooltip);
    await click(button()!);
    expect(list()?.getAttribute("aria-label")).toMatch(/^Saved /);
    expect(list()?.textContent).not.toContain("Opened import.cdxml");

    await activate(0);
    expect(status().title).toBe(combinedTooltip);
    await command("document.closeTab");
    expect(status().title).not.toContain(openTooltip);
    await command("document.new");
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
    expect(list()?.textContent).toContain(warningFor(tableDocument()).message);

    await activate(1);
    expect(button()).toBeNull();
    expect(list()).toBeNull();
    expect(status().textContent).toBe("Saved Untitled.chemdraft");
    expect(status().getAttribute("title")).toBeNull();
  });

  it("preserves open warnings on the saved tab when a native write completes after switching tabs", async () => {
    await mount(createPhase4Document());
    const openTooltip = await openWithWarnings();
    const openCount = Number(button()!.textContent!.split(" ")[0]);
    await command(tableInsertCommandId(2, 2, 1));
    const payload = createNativeSavePayload(bridge().snapshot().document);
    expect(payload.warnings).toHaveLength(1);
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
    expect(button()?.textContent).toBe(`${openCount + payload.warnings.length} warnings`);
    await click(button()!);
    expect(list()?.getAttribute("aria-label")).toContain("Saved table.chemdraft: 1 warning");
    expect(list()?.getAttribute("aria-label")).toContain("Opened import.cdxml");
    expect(list()!.querySelectorAll("section")).toHaveLength(2);
    expect(list()?.textContent).toContain(payload.warnings[0]!.message);
    expect(status().title).toBe(`${openTooltip}\n\n${saveTooltip("table.chemdraft", payload.warnings)}`);
  });
});
