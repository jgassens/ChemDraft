// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ExportDialog, createDefaultExportDialogState, createDialogExportResult } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";
import { rasterizeSvgNative } from "./nativeRasterExport";

vi.mock("./window-manager", async (original) => ({
  ...await original<typeof import("./window-manager")>(), isDesktopRuntime: () => true
}));

vi.mock("./nativeRasterExport", () => ({
  rasterizeSvgNative: vi.fn(async () => ({ bytes: new Uint8Array([1]), mimeType: "image/png", warnings: [] }))
}));

it("debounces the 7200 px poster preset and renders an 800 px preview, preserving final export size", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }));
  const document = createPhase4Document();
  const initial = { ...createDefaultExportDialogState(document), format: "png" as const };
  let selected = initial;
  function Dialog() {
    const [state, setState] = useState(initial);
    selected = state;
    return createElement(ExportDialog, {
      document, state,
      onPresentationChange: (options) => setState((current) => ({ ...current, presentation: { ...current.presentation, ...options } })),
      onRasterOptionsChange: (options) => setState((current) => ({ ...current, raster: { ...current.raster, ...options } })),
      onCancel: vi.fn(), onChooseDestination: vi.fn(), onFilenameChange: vi.fn(), onFormatChange: vi.fn(),
      onSvgOptionsChange: vi.fn(), onPdfOptionsChange: vi.fn(), onCdxmlOptionsChange: vi.fn(), onSubmit: vi.fn()
    });
  }
  const host = window.document.createElement("div");
  const root = createRoot(host);
  try {
    vi.mocked(rasterizeSvgNative).mockClear();
    await act(async () => root.render(createElement(Dialog)));
    const preset = [...host.querySelectorAll("select")].find((select) => select.querySelector('option[value="poster"]'))!;
    await act(async () => {
      preset.value = "poster";
      preset.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(selected.presentation.width).toBe(7200);
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(rasterizeSvgNative).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(rasterizeSvgNative).toHaveBeenCalledTimes(1);
    const preview = new DOMParser().parseFromString(vi.mocked(rasterizeSvgNative).mock.calls[0][0], "image/svg+xml").documentElement;
    expect(Math.max(Number(preview.getAttribute("width")), Number(preview.getAttribute("height")))).toBe(800);
    expect(Number(preview.getAttribute("width"))).not.toBe(7200);
    // Use a landscape frame so the requested poster dimensions are valid for the final export.
    const landscape = { ...document, pages: [{ ...document.pages[0], width: 1000, height: 500 }] };
    await createDialogExportResult(landscape, { ...selected, presentation: { ...selected.presentation, crop: "page" } });
    const finalSvg = new DOMParser().parseFromString(vi.mocked(rasterizeSvgNative).mock.calls[1][0], "image/svg+xml").documentElement;
    expect(finalSvg.getAttribute("width")).toBe("7200");
    expect(finalSvg.getAttribute("height")).toBe("3600");
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
