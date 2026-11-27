// @vitest-environment jsdom

import { act, createElement } from "react";
import { nativeTextStyleFromObjectStyle, type ChemDraftDocument, type TextObject } from "@chemdraft/chem-core";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { openNativeDocument, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

// Codex (1.2.3): selecting an imported caption and choosing Bold (italic, underline, a font or a
// size) changed nothing visible, because its runs stated the old values explicitly.
const source = '<CDXML><fonttable><font id="3" charset="iso-8859-1" name="Arial"/></fonttable><page>' +
  '<t id="10" p="52 210" BoundingBox="40 200 100 214" Justification="Left">' +
  '<s font="3" size="12" face="0">Yield </s><s font="3" size="9" face="32">2</s></t></page></CDXML>';

describe.each(["macos", "windows"] as const)("whole-object formatting of an imported caption (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
    saveKeybindingSettings({ scheme: "chemdraw" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "platform");
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
  });

  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const command = async (id: string) => { await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); }); };
  const canUndo = () => container.querySelector("main")?.getAttribute("data-can-undo");
  const captionOf = (doc: ChemDraftDocument) => doc.pages[0].objects.find((object): object is TextObject => object.type === "text")!;
  const resolvedRuns = (doc: ChemDraftDocument) => {
    const caption = captionOf(doc);
    return caption.spans.map(span => nativeTextStyleFromObjectStyle({ ...caption.style, ...span.style }));
  };

  it.each([
    ["text.bold", { fontWeight: 700 }],
    ["text.italic", { fontStyle: "italic" }],
    ["text.underline", { textDecoration: "underline" }],
    ["text.font.times", { fontFamily: "Times New Roman, Times, serif" }],
    ["text.size.20", { fontSizePx: 26.667 }]
  ])("%s reaches every run, and one Undo restores the caption exactly", async (commandId, expected) => {
    let doc = openNativeDocument(source).document!;
    doc = selectDocumentObjects(doc, doc.pages[0].id, [captionOf(doc).id]);
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialActiveToolCommandId: "tool.select", initialCrosshairsVisible: false,
      initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true
    })));
    const original = snapshot().document;
    expect(canUndo()).toBe("false");
    await command(commandId);
    const runs = resolvedRuns(snapshot().document);
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run).toMatchObject(expected);
    expect(captionOf(snapshot().document).spans.map(span => span.script)).toEqual(["normal", "subscript"]);
    expect(canUndo()).toBe("true");
    await command("edit.undo");
    expect(snapshot().document.pages).toEqual(original.pages);
    expect(canUndo()).toBe("false");
  });
});
