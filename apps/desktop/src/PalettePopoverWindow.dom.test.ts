// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultNativeTextStyle } from "@chemdraft/chem-core";
import type { ArtInspectorEffectKind } from "./artInspectorModel";
import { objectCustomColorCommandId, objectEffectColorCommandId } from "./commands";
import type { ToolsetArtStylePayload, ToolsetPopoverContentPayload, ToolsetTextStylePayload } from "./window-manager";
import { PalettePopoverWindow } from "./PalettePopoverWindow";

const bridge = vi.hoisted(() => ({
  content: undefined as ((payload: ToolsetPopoverContentPayload) => void) | undefined,
  style: undefined as ((payload: ToolsetTextStylePayload) => void) | undefined,
  dismiss: undefined as (() => void) | undefined,
  preview: vi.fn(async (_command: string) => undefined),
  commit: vi.fn(async (_command: string) => undefined),
  cancel: vi.fn(async (_command: string) => undefined)
}));
vi.mock("./window-manager", async (importOriginal) => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  listenForToolsetPopoverContent: async (handler: typeof bridge.content) => { bridge.content = handler; return () => {}; },
  listenForToolsetTextStyle: async (handler: typeof bridge.style) => { bridge.style = handler; return () => {}; },
  listenForToolsetPopoverDismiss: async (handler: typeof bridge.dismiss) => { bridge.dismiss = handler; return () => {}; },
  requestToolsetPopoverContent: vi.fn(async () => undefined), requestToolsetTextStyle: vi.fn(async () => undefined),
  setCurrentWindowLogicalSize: vi.fn(async () => undefined), setCurrentWindowLogicalPosition: vi.fn(async () => undefined),
  showCurrentToolsetPopoverWindow: vi.fn(async () => undefined),
  sendPaletteCommandPreview: bridge.preview, sendPaletteCommandCommit: bridge.commit,
  sendPaletteCommandCancel: bridge.cancel
}));
// Keep this test about the native host's target/color/command routing. The real picker widgets
// (wheel, RGB, hex and palettes) are exercised in ToolPalette.dom.test.ts.
vi.mock("./ToolPalette", () => ({
  ColorPickerPopoverBody: (props: {
    activeColor?: string; value: string;
    onPreviewColor: (color: string) => void; onCommitColor: (color: string) => void;
  }) => createElement("div", null,
    createElement("output", { "data-color": props.activeColor }, props.value),
    createElement("button", { onClick: () => props.onPreviewColor("#123456") }, "Preview"),
    createElement("button", { onClick: () => props.onCommitColor("#abcdef") }, "Commit")
  ),
  symbolToolGlyph: () => undefined, toolbarCommandFlyoutGridStyle: () => ({})
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("native palette color targets", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: "core.art", prewarm: true })));
    // A serialized color snapshot: unrelated inspector capabilities are not consumed by this host.
    const artStyle = {
      activePaintTarget: "fill",
      values: { fillColor: { value: "#112233" }, strokeColor: { value: "#445566" } },
      effectControls: {
        glow: { color: { value: "#aabbcc" } },
        shadow: { color: { value: "#ddeeff" } },
        sketch: { color: { value: "#778899" } }
      }
    } as ToolsetArtStylePayload;
    await act(async () => bridge.style!({ currentTextStyle: DefaultNativeTextStyle, currentTextScript: "normal", currentArtStyle: artStyle }));
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  async function open(effectKind?: ArtInspectorEffectKind) {
    await act(async () => bridge.content!({ toolsetId: "core.art", kind: "artColor", effectKind } as ToolsetPopoverContentPayload));
  }
  function click(text: string) {
    act(() => [...container.querySelectorAll("button")].find(button => button.textContent === text)!.click());
  }
  it.each([
    ["glow", "#aabbcc"], ["shadow", "#ddeeff"], ["sketch", "#778899"]
  ] as const)("previews and commits %s color without changing fill", async (kind, color) => {
    await open(kind);
    expect(container.querySelector("output")!.getAttribute("data-color")).toBe(color);
    click("Preview"); click("Commit");
    expect(bridge.preview).toHaveBeenCalledExactlyOnceWith(objectEffectColorCommandId(kind, "#123456"));
    expect(bridge.commit).toHaveBeenCalledExactlyOnceWith(objectEffectColorCommandId(kind, "#abcdef"));
  });
  it("clears drafts when reusing the same window for another effect or ordinary paint", async () => {
    await open("glow"); click("Preview");
    await open("shadow");
    expect(container.querySelector("output")!.textContent).toBe("#ddeeff");
    click("Preview");
    await open("shadow");
    expect(container.querySelector("output")!.textContent).toBe("#ddeeff");
    await open();
    expect(container.querySelector("output")!.textContent).toBe("#112233");
    click("Commit");
    expect(bridge.commit).toHaveBeenCalledExactlyOnceWith(objectCustomColorCommandId("#abcdef"));
  });
  it("refuses effect edits after dismissal and allows a fresh open", async () => {
    await open("glow");
    act(() => bridge.dismiss!());
    click("Preview"); click("Commit");
    expect(bridge.preview).not.toHaveBeenCalled(); expect(bridge.commit).not.toHaveBeenCalled();
    await open("shadow"); click("Commit");
    expect(bridge.commit).toHaveBeenCalledExactlyOnceWith(objectEffectColorCommandId("shadow", "#abcdef"));
  });
});
