// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { depictSmiles2D, ensureOclResources } from "@chemdraft/ocl-adapter";
import type { TextObject } from "@chemdraft/chem-core";
import type { ClipboardReadPayload } from "@chemdraft/clipboard-adapter";
import { invoke } from "@tauri-apps/api/core";
import { MainWindow } from "./MainWindow";
import {
  CHEMDRAFT_SELECTION_CLIPBOARD_TYPE,
  createPhase4Document,
  createSelectionClipboardPayload,
  insertNativeTextObject,
  pastedStructureDepictionFromMolfile,
  serializeSelectionClipboardPayload
} from "./documentWorkflow";
import { depictSmilesForPaste } from "./smilesListPaste";
import { installDomRdkitLoader } from "./testSupport/rdkitIdentity";
import { inspectStructureOffThread } from "./depiction2d/identityClient";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./depiction2d/identityClient", () => ({ inspectStructureOffThread: vi.fn() }));

beforeAll(async () => {
  installDomRdkitLoader();
  await ensureOclResources();
  const actual = await vi.importActual<typeof import("./depiction2d/identityClient")>("./depiction2d/identityClient");
  vi.mocked(inspectStructureOffThread).mockImplementation(actual.inspectStructureOffThread);
}, 20_000);

const runtime = vi.hoisted(() => ({ desktop: true }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => runtime.desktop
}));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn()
}));
vi.mock("./smilesListPaste", async original => ({
  ...await original<typeof import("./smilesListPaste")>(),
  depictSmilesForPaste: vi.fn()
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const formattedRuns: TextObject["spans"] = [
  { text: "H", script: "normal", style: {} },
  { text: "2", script: "subscript", style: {} },
  { text: "O", script: "normal", style: {} }
];

function formattedSelection(runs = formattedRuns) {
  const source = structuredClone(insertNativeTextObject(createPhase4Document("Formatted copy"), { x: 120, y: 140 }, "H2O"));
  const text = source.pages[0]!.objects.find((object): object is TextObject => object.type === "text")!;
  text.spans = runs;
  return serializeSelectionClipboardPayload(createSelectionClipboardPayload(source)!);
}

const cdxml = '<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0"/><n id="4" p="30 0" Element="8"/><b id="5" B="3" E="4" Order="1"/></fragment></page></CDXML>';

describe.each(["macos", "windows"] as const)("text paste formatting (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;

  // lib.rs returns pasteboard UTIs unchanged; windows_clipboard.rs maps CF_UNICODETEXT to
  // text/plain and passes registered names (including ChemDraft's private flavor) through.
  function nativeClipboard(text: string, selection?: string): ClipboardReadPayload {
    const textItems = [
      ...(selection ? [{ type: CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, text: selection }] : []),
      ...(text ? [{ type: platform === "macos" ? "public.utf8-plain-text" : "text/plain", text }] : [])
    ];
    return { types: textItems.map(item => item.type), textItems };
  }

  beforeEach(() => {
    runtime.desktop = true;
    vi.mocked(invoke).mockReset();
    vi.mocked(depictSmilesForPaste).mockReset();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    // Pass the shortcut platform explicitly, and match detection used by other UI helpers.
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "platform");
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
  });

  async function mount(payload: ClipboardReadPayload | string | Error = nativeClipboard("")) {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "read_clipboard_payload") {
        if (typeof payload === "string" || payload instanceof Error) throw payload;
        return payload;
      }
      if (command === "write_clipboard_items") return {
        ok: true, written: [CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, "text/plain"], failed: [], warnings: []
      };
      throw new Error(`Unexpected native command: ${command}`);
    });
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: createPhase4Document("Paste formatting"),
      initialActiveToolCommandId: "tool.select",
      initialCrosshairsVisible: false,
      initialRulersVisible: false,
      initialPaletteMode: "hidden",
      nativePalette: true,
      shortcutPlatform: platform
    })));
  }

  const objects = () => window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0]!.objects;
  const status = () => container.querySelector('[role="status"]')?.textContent;
  const nativeReads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "read_clipboard_payload");

  async function paste(items: Record<string, string>, target: EventTarget = window, prevented = false) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    let readable = true;
    Object.defineProperty(event, "clipboardData", {
      value: { types: Object.keys(items), getData: (type: string) => {
        if (!readable) throw new Error("DataTransfer expired after the paste handler returned");
        return items[type] ?? "";
      } }
    });
    if (prevented) event.preventDefault();
    await act(async () => {
      target.dispatchEvent(event);
      readable = false;
    });
    return event;
  }

  function expectFormatting(runs = formattedRuns) {
    expect(objects()).toHaveLength(1);
    const pasted = objects()[0]!;
    expect(pasted.type).toBe("text");
    if (pasted.type !== "text") throw new Error("Expected pasted text object");
    expect(pasted.text).toBe("H2O");
    expect(pasted.spans).toEqual(runs);
    expect(status()).toBe("Pasted ChemDraft selection");
    expect(status()).not.toBe("Pasted editable text");
  }

  it.each(["subscript", "superscript"] as const)("keeps native %s runs when the DOM event exposes only plain text", async script => {
    const runs = formattedRuns.map(run => run.text === "2" ? { ...run, script } : run);
    await mount(nativeClipboard("H2O", formattedSelection(runs)));
    const event = await paste({ "text/plain": "H2O" });
    expect(event.defaultPrevented).toBe(true);
    expect(nativeReads()).toHaveLength(1);
    expectFormatting(runs);
  });

  it("pastes external plain text through the native reader as editable text", async () => {
    await mount(nativeClipboard("hello"));
    expect((await paste({ "text/plain": "hello" })).defaultPrevented).toBe(true);
    expect(nativeReads()).toHaveLength(1);
    expect(objects()).toHaveLength(1);
    expect(objects()[0]).toMatchObject({ type: "text", text: "hello" });
    expect(status()).toBe("Pasted editable text");
  });

  it.each([
    ["event", "shortcut"], ["event", "menu"], ["menu", "shortcut"], ["menu", "menu"]
  ] as const)("undoes plain text pasted into a new empty document once (paste: %s, undo: %s), then redoes", async (route, undoRoute) => {
    const sentence = "Please leave this note beside the drawing.";
    await mount(nativeClipboard(sentence));
    // Exercise File > New, rather than relying on the initial document's history.
    const menu = async (commandId: string) => {
      await act(async () => {
        window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
      });
    };
    await menu("document.new");
    const empty = window.__CHEMDRAFT_AGENT__!.snapshot().document;
    expect(empty.pages.every(page => page.objects.length === 0)).toBe(true);
    if (route === "event") {
      expect((await paste({ "text/plain": sentence })).defaultPrevented).toBe(true);
    } else {
      // The same command event is emitted by the desktop Edit > Paste menu.
      await menu("clipboard.paste");
    }
    expect(nativeReads()).toHaveLength(1);
    expect(objects()).toHaveLength(1);
    expect(objects()[0]).toMatchObject({ type: "text", text: sentence });
    expect(status()).toBe("Pasted editable text");
    const pasted = window.__CHEMDRAFT_AGENT__!.snapshot().document;
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().selection.objectIds).toEqual([objects()[0]!.id]);
    // Real key events exercise focus-sensitive Undo immediately after the paste.
    const undoKey = new KeyboardEvent("keydown", {
      key: "z", code: "KeyZ", bubbles: true, cancelable: true,
      metaKey: platform === "macos", ctrlKey: platform === "windows"
    });
    if (undoRoute === "shortcut") {
      await act(async () => { (document.activeElement ?? window).dispatchEvent(undoKey); });
    } else await menu("edit.undo");
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().document).toEqual(empty);
    if (undoRoute === "shortcut") expect(undoKey.defaultPrevented).toBe(true);
    expect(objects()).toHaveLength(0);
    expect(container.querySelector('[data-page-svg-object-visual][data-object-type="text"]')).toBeNull();
    await menu("edit.redo");
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().document).toEqual(pasted);
    expect(objects()[0]).toMatchObject({ type: "text", text: sentence });
    expect(container.querySelector(".text-object-editor")).toBeNull();
    expect(nativeReads()).toHaveLength(1);
  });

  const clipboardBusy = "The clipboard is in use by another application.";

  it.each(["native", "snapshot"] as const)("pastes a Word table once from the desktop %s path, preserving formatting and warnings", async source => {
    // Keep the Office-shaped markup, and include a dropped image to exercise a nonempty warning.
    const html = readFileSync("packages/fixtures/clipboard-tables/word-like.html", "utf8")
      .replace("allyl alcohol<o:p>", 'allyl alcohol<img src="reagent.png"><o:p>');
    const htmlType = platform === "macos" ? "public.html" : "HTML Format";
    const nativePayload = nativeClipboard("native fallback text");
    nativePayload.types.push(htmlType);
    nativePayload.textItems.push({ type: htmlType, text: html });
    await mount(source === "native" ? nativePayload : new Error(clipboardBusy));
    // A different table in DataTransfer proves usable native content wins; the snapshot case
    // expires DataTransfer as soon as the event handler returns, before the native rejection.
    const event = await paste({
      "text/html": source === "native" ? "<table><tr><td>DOM</td><td>fallback</td></tr></table>" : html,
      "text/plain": "DOM fallback text"
    });
    expect(event.defaultPrevented).toBe(true);
    expect(nativeReads()).toHaveLength(1);
    expect(objects()).toHaveLength(1);
    const table = objects()[0]!;
    expect(table.type).toBe("table");
    if (table.type !== "table") throw new Error("Expected a pasted native table");
    expect(table.rows.map(row => row.cells.map(cell => cell.text))).toEqual([
      ["Material", "MW (g/mol)", "Density (g/mL)"],
      ["allyl alcohol", "58.08", "0.854"],
      ["Ti(OiPr)4", "284.22", "0.96"],
      ["TBHPa", "90.12", "—"]
    ]);
    expect(table.rows[0]!.cells[0]!.spans).toContainEqual(expect.objectContaining({ text: "Material", style: { fontWeight: 700 } }));
    expect(table.rows[2]!.cells[0]!.spans).toContainEqual(expect.objectContaining({ text: "4", script: "subscript" }));
    expect(table.rows[3]!.cells[0]!.spans).toContainEqual(expect.objectContaining({ text: "a", script: "superscript" }));
    expect(table.columns[1]!.align).toBe("decimal");
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().selection.objectIds).toEqual([table.id]);
    expect(status()).toBe("Pasted table; Images in the table were not imported.");
    // Paste failures now use the current user-facing status wording.
    expect(status()).not.toMatch(/Couldn't paste|Couldn't read the clipboard/);
    expect(depictSmilesForPaste).not.toHaveBeenCalled();
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
    expect(objects()).toHaveLength(0);
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.redo"); });
    expect(objects()).toEqual([table]);
    expect(nativeReads()).toHaveLength(1);
  });

  it("uses the synchronous DataTransfer snapshot when the native read rejects", async () => {
    await mount(clipboardBusy);
    expect((await paste({ "text/plain": "external text" })).defaultPrevented).toBe(true);
    expect(nativeReads()).toHaveLength(1);
    expect(objects()).toHaveLength(1);
    expect(objects()[0]).toMatchObject({ type: "text", text: "external text" });
    expect(status()).toBe("Pasted editable text");
  });

  it.each([false, true])("reports a native read failure with no usable content (missing DataTransfer: %s)", async missing => {
    await mount(clipboardBusy);
    if (missing) {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      await act(async () => { window.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
    } else {
      await paste({});
    }
    expect(nativeReads()).toHaveLength(1);
    expect(objects()).toHaveLength(0);
    // Keep the templates branch's specific paste-failure wording for native read errors.
    expect(status()).toBe(`Couldn't read the clipboard: ${clipboardBusy}`);
  });

  async function cacheSelection() {
    await paste({ [CHEMDRAFT_SELECTION_CLIPBOARD_TYPE]: formattedSelection() });
    await act(async () => { window.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true })); });
    expect(status()).toBe("Copied ChemDraft selection");
    expect(objects()).toHaveLength(1);
  }

  it.each(["empty", "failed"])("prefers DataTransfer content over the cached selection when the native read is %s", async read => {
    await mount(read === "empty" ? nativeClipboard("") : clipboardBusy);
    await cacheSelection();
    await paste({ "text/plain": "external text" });
    expect(nativeReads()).toHaveLength(1);
    expect(objects()).toHaveLength(2);
    expect(objects()[1]).toMatchObject({ type: "text", text: "external text" });
    expect(status()).toBe("Pasted editable text");
  });

  it.each(["empty", "failed"])("uses the cached selection when the native read is %s and DataTransfer has no content", async read => {
    await mount(read === "empty" ? nativeClipboard("") : clipboardBusy);
    await cacheSelection();
    await paste({});
    expect(objects()).toHaveLength(2);
    expect(objects()[1]).toMatchObject({ type: "text", text: "H2O", spans: formattedRuns });
    expect(status()).toBe("Pasted ChemDraft selection");
  });

  it("reports an empty clipboard when neither reader nor cache has content", async () => {
    await mount();
    await paste({});
    expect(objects()).toHaveLength(0);
    // Keep the templates branch's specific paste-failure wording for unsupported clipboard content.
    expect(status()).toBe("Couldn't paste: the clipboard contains no supported drawing or text content.");
  });

  it("prefers usable native content over the DataTransfer fallback", async () => {
    await mount(nativeClipboard("native text"));
    await paste({ "text/plain": "DOM text" });
    expect(objects()).toHaveLength(1);
    expect(objects()[0]).toMatchObject({ type: "text", text: "native text" });
  });

  it("pastes external SMILES through the native reader as a structure", async () => {
    vi.mocked(depictSmilesForPaste).mockResolvedValue({
      depiction: pastedStructureDepictionFromMolfile(depictSmiles2D("c1ccccc1O").molfile),
      stereoCount: 0
    });
    await mount(nativeClipboard("c1ccccc1O"));
    expect((await paste({ "text/plain": "c1ccccc1O" })).defaultPrevented).toBe(true);
    expect(nativeReads()).toHaveLength(1);
    // The templates branch also passes depiction options and document placement context.
    expect(depictSmilesForPaste).toHaveBeenCalledExactlyOnceWith("c1ccccc1O", {}, {
      document: expect.objectContaining({ title: "Paste formatting" }),
      centre: expect.any(Object),
      reservedObjectIds: expect.any(Set)
    });
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(objects()).toHaveLength(1);
    }, { timeout: 15_000, interval: 50 });
    expect(objects()[0]).toMatchObject({ type: "molecule", atoms: expect.any(Array) });
    expect(status()).toContain("Pasted SMILES structure");
  });

  it("keeps the existing unsupported-CDXML notice for external CDXML text from the native reader", async () => {
    await mount(nativeClipboard(cdxml));
    expect((await paste({ "text/plain": cdxml })).defaultPrevented).toBe(true);
    expect(nativeReads()).toHaveLength(1);
    expect(objects()).toHaveLength(0);
    expect(status()).toBe("The clipboard contains CDXML, but CDXML paste parsing is not implemented yet.");
  });

  it.each([CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, "text/plain"])("applies a web-written selection in %s directly without a native read", async type => {
    await mount(nativeClipboard("different native text"));
    expect((await paste({ [type]: formattedSelection() })).defaultPrevented).toBe(true);
    expectFormatting();
    expect(nativeReads()).toHaveLength(0);
  });

  it("keeps web plain-text paste on the DataTransfer path", async () => {
    runtime.desktop = false;
    await mount(nativeClipboard("H2O", formattedSelection()));
    expect((await paste({ "text/plain": "hello" })).defaultPrevented).toBe(true);
    expect(objects()).toHaveLength(1);
    expect(objects()[0]).toMatchObject({ type: "text", text: "hello" });
    expect(status()).toBe("Pasted editable text");
    expect(nativeReads()).toHaveLength(0);
  });

  it("keeps web private-flavor paste on the DataTransfer path", async () => {
    runtime.desktop = false;
    await mount();
    await paste({ [CHEMDRAFT_SELECTION_CLIPBOARD_TYPE]: formattedSelection(), "text/plain": "H2O" });
    expectFormatting();
    expect(nativeReads()).toHaveLength(0);
  });

  it("keeps formatting through the right-click Paste command", async () => {
    await mount(nativeClipboard("H2O", formattedSelection()));
    await act(async () => {
      container.querySelector(".page")!.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2, clientX: 320, clientY: 260
      }));
    });
    const pasteButton = container.querySelector<HTMLButtonElement>('[data-context-target-kind="page"] [data-command-id="clipboard.paste"]');
    expect(pasteButton).not.toBeNull();
    await act(async () => pasteButton!.click());
    expectFormatting();
    expect(nativeReads()).toHaveLength(1);
  });

  it("reports a failed right-click Paste without a DataTransfer argument", async () => {
    await mount(new Error(clipboardBusy));
    await act(async () => {
      container.querySelector(".page")!.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2, clientX: 320, clientY: 260
      }));
    });
    const button = container.querySelector<HTMLButtonElement>('[data-context-target-kind="page"] [data-command-id="clipboard.paste"]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(nativeReads()).toHaveLength(1);
    expect(objects()).toHaveLength(0);
    // Keep the templates branch's specific paste-failure wording for right-click native read errors.
    expect(status()).toBe(`Couldn't read the clipboard: ${clipboardBusy}`);
  });

  it("leaves paste to an open modal dialog", async () => {
    await mount(nativeClipboard("H2O", formattedSelection()));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    container.append(dialog);
    expect((await paste({ "text/plain": "hello" })).defaultPrevented).toBe(false);
    expect(objects()).toHaveLength(0);
    expect(nativeReads()).toHaveLength(0);
  });

  it("leaves paste into a canvas text object to its editor", async () => {
    await mount(nativeClipboard("H2O", formattedSelection()));
    await paste({ [CHEMDRAFT_SELECTION_CLIPBOARD_TYPE]: formattedSelection() });
    await act(async () => {
      container.querySelector('[data-page-svg-object-visual][data-object-type="text"]')!.dispatchEvent(new MouseEvent("dblclick", {
        bubbles: true, cancelable: true
      }));
    });
    const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor");
    expect(editor).not.toBeNull();
    editor!.setSelectionRange(0, editor!.value.length);
    expect((await paste({ "text/plain": "hello" }, editor!)).defaultPrevented).toBe(true);
    expect(objects()).toHaveLength(1);
    expect(objects()[0]).toMatchObject({ type: "text", text: "hello" });
    expect(nativeReads()).toHaveLength(0);
  });

  it("leaves contenteditable paste to the editor, including a nested target", async () => {
    await mount(nativeClipboard("H2O", formattedSelection()));
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const target = document.createElement("span");
    editor.append(target);
    container.append(editor);
    expect((await paste({ "text/plain": "hello" }, target)).defaultPrevented).toBe(false);
    expect(objects()).toHaveLength(0);
    expect(nativeReads()).toHaveLength(0);
  });

  it("leaves text-field paste native", async () => {
    await mount(nativeClipboard("H2O", formattedSelection()));
    const field = document.createElement("input");
    container.append(field);
    expect((await paste({ "text/plain": "hello" }, field)).defaultPrevented).toBe(false);
    expect(objects()).toHaveLength(0);
    expect(nativeReads()).toHaveLength(0);
  });

  it("leaves an already prevented paste alone", async () => {
    await mount(nativeClipboard("H2O", formattedSelection()));
    await paste({ "text/plain": "H2O" }, window, true);
    expect(objects()).toHaveLength(0);
    expect(nativeReads()).toHaveLength(0);
  });
});
