// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { parseDocument, type ChemDraftDocument } from "@chemdraft/chem-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createNativeSavePayload, createPhase4Document } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";
import { tableInsertCommandId } from "./tableCommands";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { buildDocumentSessionEnvelope } from "./documentSession";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const native = vi.hoisted(() => ({
  desktop: false,
  session: undefined as unknown,
  flush: undefined as (() => Promise<void>) | undefined,
  loadSession: vi.fn<() => Promise<unknown>>(),
  saveSession: vi.fn<(value: unknown) => Promise<void>>(),
  save: vi.fn<() => Promise<string | null>>(),
  write: vi.fn<() => Promise<void>>()
}));
vi.mock("./window-manager", async (original) => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => native.desktop,
  loadDocumentSession: native.loadSession,
  saveDocumentSession: native.saveSession,
  listenForQuitFlushRequest: async (handler: () => Promise<void>) => {
    native.flush = handler;
    return () => { if (native.flush === handler) native.flush = undefined; };
  },
  confirmQuitAfterFlush: vi.fn()
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

it("keeps empty status space click-through and only the truncated text interactive", () => {
  const css = readFileSync("apps/desktop/src/App.css", "utf8");
  function rule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`, "m"));
    expect(match, selector).not.toBeNull();
    return match![1]!;
  }
  expect(rule(".status-row")).toContain("pointer-events: none;");
  expect(rule(".status-row")).toContain("align-items: baseline;");
  expect(rule(".status-row-main")).toContain("align-items: baseline;");
  expect(rule(".status-row-main")).toContain("flex: 1 1 auto;");
  const slot = rule(".status-message-slot");
  expect(slot).toContain("pointer-events: none;");
  expect(slot).toContain("flex: 1 1 0;");
  expect(slot).toContain("min-width: 0;");
  expect(slot).toContain("display: flex;");
  const text = rule(".status-message,\n.status-modifier-hint");
  expect(text).toContain("flex: 0 1 auto;");
  expect(text).toContain("min-width: 0;");
  expect(text).toContain("text-overflow: ellipsis;");
  expect(text).toContain("overflow: hidden;");
  expect(text).toContain("white-space: nowrap;");
  const interactive = rule(".status-message");
  expect(interactive).toContain("pointer-events: auto;");
  expect(interactive).not.toMatch(/flex(?:-grow)?:/);
  expect(css).not.toContain(".status-message[data-file-warning-help]");
  expect(rule(".open-warnings-button")).toContain("flex: 0 0 auto;");
  expect(rule(".open-warnings-message")).not.toMatch(/(?:display|color|white-space):/);
});

describe("save warnings in the existing file warnings list", () => {
  let container: HTMLDivElement;
  let root: Root;
  let styles: HTMLStyleElement;

  beforeAll(() => {
    styles = document.createElement("style");
    styles.textContent = readFileSync("apps/desktop/src/App.css", "utf8");
    document.head.append(styles);
  });

  afterAll(() => styles.remove());

  beforeEach(() => {
    native.desktop = false;
    native.session = undefined;
    native.flush = undefined;
    native.loadSession.mockReset().mockImplementation(async () => native.session);
    native.saveSession.mockReset().mockImplementation(async (value) => {
      native.session = JSON.parse(JSON.stringify(value));
    });
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

  async function remount() {
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(createPhase4Document());
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

  async function expectHoverHelp(messages: readonly string[]) {
    const previousStatus = status().textContent;
    const slot = status().parentElement!;
    expect(slot.className).toBe("status-message-slot");
    expect(getComputedStyle(slot).pointerEvents).toBe("none");
    expect(getComputedStyle(container.querySelector(".status-row-main")!).pointerEvents).toBe("none");
    for (const target of [status(), button()!]) {
      // React's mouse-enter/leave handlers are reached through real bubbling DOM events.
      expect(getComputedStyle(target).pointerEvents).toBe("auto");
      await act(async () => { target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
      for (const message of messages) expect(status().textContent).toContain(message);
      expect(status().hasAttribute("data-file-warning-help")).toBe(true);
      expect(getComputedStyle(status()).whiteSpace).toBe("nowrap");
      expect(getComputedStyle(status()).flexGrow).toBe("0");
      expect(getComputedStyle(status()).textOverflow).toBe("ellipsis");
      expect(status().parentElement).toBe(slot);
      expect(slot.nextElementSibling).toBe(button());
      await act(async () => {
        target.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
        await new Promise(resolve => window.setTimeout(resolve, 120));
      });
      expect(status().textContent).toBe(previousStatus);
      expect(status().hasAttribute("data-file-warning-help")).toBe(false);
    }
    await act(async () => { button()!.focus(); });
    for (const message of messages) expect(status().textContent).toContain(message);
    await act(async () => { button()!.blur(); });
    expect(status().textContent).toBe(previousStatus);
  }

  function expectReadableMessages(scope: Element, messages: readonly string[]) {
    const entries = [...scope.querySelectorAll<HTMLElement>(".open-warnings-message")];
    expect(entries.map(entry => entry.textContent)).toEqual(messages);
    for (const entry of entries) {
      expect(getComputedStyle(entry).visibility).toBe("visible");
    }
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

  it("shows every save warning in status hover help and as readable text in the list", async () => {
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
    await expectHoverHelp(payload.warnings.map(warning => warning.message));

    await click(button()!);
    expect(list()?.getAttribute("aria-label")).toBe(`Saved ${payload.filename}: ${payload.warnings.length} warnings`);
    const row = list()?.querySelector('[data-warning-code="cdxml.table_approximated"]');
    expect(row?.querySelector(".open-warnings-message")?.textContent).toBe(warning.message);
    for (const warning of payload.warnings) expect(list()?.textContent).toContain(warning.message);
    expectReadableMessages(list()!, payload.warnings.map(warning => warning.message));
    expect(warning.message).toContain("so other programs will not edit it as a table; ChemDraft reopens it exactly from the embedded ChemDraft payload.");
    expect(button()?.getAttribute("aria-controls")).toBe(list()?.id);
    expect(button()?.title).toBe("Hide the warnings from saving this document");
    const show = row!.querySelector<HTMLButtonElement>("[data-open-warning-show]")!;
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => { show.dispatchEvent(press); });
    expect(press.defaultPrevented).toBe(true);
    await click(show);
    expect(bridge().snapshot().selection.objectIds).toEqual([table.id]);

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

  it.each(["hover", "focus"])("clears %s help when a clean save removes the button, including for later reports", async interaction => {
    await mount();
    await command("document.save");
    await act(async () => {
      if (interaction === "focus") button()!.focus();
      else button()!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(status().hasAttribute("data-file-warning-help")).toBe(true);
    await command("edit.selectAll");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    });
    await command("document.save");
    expect(button()).toBeNull();
    expect(status().hasAttribute("data-file-warning-help")).toBe(false);
    expect(status().textContent).toMatch(/^Saved /);

    await command("edit.undo");
    await command("document.save");
    expect(button()).not.toBeNull();
    expect(status().title).toContain(warningFor(tableDocument()).message);
    expect(status().hasAttribute("data-file-warning-help")).toBe(false);
    expect(status().textContent).toMatch(/^Saved /);
  });

  it("resets hovered help when switching between tabs that both have warnings", async () => {
    await mount();
    await command("document.save");
    await command("document.new");
    await command(tableInsertCommandId(2, 2, 1));
    await command("document.save");
    await activate(0);
    await act(async () => { button()!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    expect(status().hasAttribute("data-file-warning-help")).toBe(true);
    await activate(1);
    expect(button()).not.toBeNull();
    expect(status().hasAttribute("data-file-warning-help")).toBe(false);
    await activate(0);
    expect(status().hasAttribute("data-file-warning-help")).toBe(false);
  });

  it("keeps help visible while moving between the status text and warnings button", async () => {
    await mount();
    await command("document.save");
    await act(async () => { status().dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    const help = status().textContent;
    const changes: string[] = [];
    const observer = new MutationObserver(() => { changes.push(status().textContent!); });
    observer.observe(status(), { childList: true, characterData: true, subtree: true });
    try {
      for (const [from, to] of [[status(), button()!], [button()!, status()]]) {
        await act(async () => {
          from!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: to }));
        });
        expect(status().textContent).toBe(help);
        expect(status().hasAttribute("data-file-warning-help")).toBe(true);
      }
      // Real pointer travel crosses the slot's empty space and the flex gap before reaching the button.
      await act(async () => {
        status().dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
        await new Promise(resolve => window.setTimeout(resolve, 30));
      });
      expect(status().textContent).toBe(help);
      await act(async () => {
        button()!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await new Promise(resolve => window.setTimeout(resolve, 120));
      });
      expect(status().textContent).toBe(help);
      expect(changes.every(text => text === help)).toBe(true);
    } finally {
      observer.disconnect();
    }
    await act(async () => {
      button()!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      await new Promise(resolve => window.setTimeout(resolve, 120));
    });
    expect(status().hasAttribute("data-file-warning-help")).toBe(false);
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
    const messages = [...list()!.querySelectorAll(".open-warnings-message")].map((row) => row.textContent!);
    expectReadableMessages(list()!, messages);
    await expectHoverHelp(messages);
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
    const allMessages = [...list()!.querySelectorAll(".open-warnings-message")].map(row => row.textContent!);
    await expectHoverHelp(allMessages);
    expectReadableMessages(list()!, allMessages);
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

  it("serializes and restores separate open and save reports, including an inactive tab", async () => {
    native.desktop = true;
    await mount(createPhase4Document());
    const openTooltip = await openWithWarnings();
    await command(tableInsertCommandId(2, 2, 1));
    await command("document.save");
    const combinedTooltip = status().title;
    expect(combinedTooltip).toContain(openTooltip);
    expect(combinedTooltip).toContain("Saved table.chemdraft");
    await click(button()!);
    const headings = [...list()!.querySelectorAll("section")].map(section => section.getAttribute("aria-label"));
    expect(headings).toHaveLength(2);

    await command("document.new");
    await act(async () => { await native.flush!(); });
    const saved = native.session as { tabs: { openWarnings: unknown; saveWarnings: unknown }[] };
    expect(saved.tabs[0]!.openWarnings).toMatchObject({ displayName: "import.cdxml" });
    expect(saved.tabs[0]!.saveWarnings).toMatchObject({ operation: "save", displayName: "table.chemdraft" });
    await remount();
    expect(button()).toBeNull();
    await activate(0);
    expect(status().title).toBe(combinedTooltip);
    await click(button()!);
    expect([...list()!.querySelectorAll("section")].map(section => section.getAttribute("aria-label"))).toEqual(headings);
  });

  it("round-trips a save-only tab without inventing an open report", async () => {
    native.desktop = true;
    await mount();
    await command("document.save");
    const tooltip = status().title;
    const count = button()!.textContent;
    await act(async () => { await native.flush!(); });
    const saved = native.session as { tabs: { openWarnings?: unknown; saveWarnings?: unknown }[] };
    expect(saved.tabs[0]!.openWarnings).toBeUndefined();
    expect(saved.tabs[0]!.saveWarnings).toMatchObject({ operation: "save" });

    await remount();
    expect(status().title).toBe(tooltip);
    expect(button()?.textContent).toBe(count);
    expect(button()?.title).toBe("Show the warnings from saving this document");
    await click(button()!);
    expect(list()?.getAttribute("aria-label")).toMatch(/^Saved table.chemdraft/);
    expect(list()?.textContent).not.toContain("Opened ");
    await act(async () => { await native.flush!(); });
    expect((native.session as typeof saved).tabs[0]!.openWarnings).toBeUndefined();
    expect((native.session as typeof saved).tabs[0]!.saveWarnings).toEqual(saved.tabs[0]!.saveWarnings);
  });

  it.each([undefined, "open", "save"] as const)("restores a legacy single report with operation %s", async operation => {
    native.desktop = true;
    const report = {
      ...(operation ? { operation } : {}),
      displayName: "legacy.chemdraft", sourceLabel: "ChemDraft CDXML envelope",
      warnings: [{ code: "legacy", message: "Kept legacy warning." }]
    };
    native.session = {
      ...buildDocumentSessionEnvelope(createNativeSavePayload(tableDocument()),
        { dirty: false }, "legacy.chemdraft", false),
      openWarnings: report
    };
    await mount(createPhase4Document());
    await click(button()!);
    expect(list()?.getAttribute("aria-label")).toMatch(operation === "save" ? /^Saved legacy/ : /^Opened legacy/);
    expect(list()?.textContent).toContain("Kept legacy warning.");
    // A clean save clears only save findings, proving legacy reports landed in the right slot.
    await command("edit.selectAll");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    });
    await command("document.save");
    if (operation === "save") expect(button()).toBeNull();
    else expect(status().title).toContain("Kept legacy warning.");
  });

  it.each(["openWarnings", "saveWarnings"])("drops malformed %s without losing the other report or document", async field => {
    native.desktop = true;
    const report = { displayName: "kept.chemdraft", sourceLabel: "ChemDraft CDXML envelope",
      warnings: [{ code: "kept", message: "Kept valid report." }] };
    native.session = {
      ...buildDocumentSessionEnvelope(createNativeSavePayload(tableDocument()),
        { dirty: false }, "kept.chemdraft", false),
      openWarnings: report,
      saveWarnings: { ...report, operation: "save" },
      [field]: { ...report, warnings: [{ code: "bad", message: "Malformed report.", atomIds: [42] }] }
    };
    await mount(createPhase4Document());
    expect(bridge().snapshot().document.pages[0]!.objects[0]!.type).toBe("table");
    await click(button()!);
    expect(list()?.getAttribute("aria-label")).toMatch(field === "openWarnings" ? /^Saved kept/ : /^Opened kept/);
    expect(list()?.textContent).toContain("Kept valid report.");
    expect(list()?.textContent).not.toContain("Malformed report.");
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
