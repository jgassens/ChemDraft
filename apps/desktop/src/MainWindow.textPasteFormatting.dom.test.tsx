// @vitest-environment jsdom

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

  const clipboardBusy = "The clipboard is in use by another application.";

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
