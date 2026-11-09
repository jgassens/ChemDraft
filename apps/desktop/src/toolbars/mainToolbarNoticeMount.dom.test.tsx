// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "../MainWindow";
import { createPhase4Document } from "../documentWorkflow";
import { MemoryStorage } from "../testSupport/memoryStorage";

const layout = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => null }));
vi.mock("../window-manager", async original => ({ ...await original<typeof import("../window-manager")>(),
  loadToolsetLayoutState: layout.load, saveToolsetLayoutState: layout.save
}));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MainWindow toolbar migration notice", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it.each(["macos", "windows"] as const)("mounts after asynchronous layout hydration and persists dismissal on %s", async platform => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    let resolveLayout!: (state: unknown) => void;
    layout.load.mockReturnValue(new Promise(resolve => { resolveLayout = resolve; }));
    layout.save.mockReset().mockResolvedValue(undefined);
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(MainWindow, { initialDocument: createPhase4Document(),
        nativePalette: true, initialPaletteMode: "hidden", initialRulersVisible: false,
        initialCrosshairsVisible: false, shortcutPlatform: platform })));
      expect(host.querySelector(".main-toolbar-migration-notice")).toBeNull();
      await act(async () => resolveLayout({ version: 1, toolsetOverrides: [{ toolsetId: "core.main", hiddenCommandIds: ["tool.text"] }], userToolsets: [] }));
      const notice = host.querySelector<HTMLElement>(".main-toolbar-migration-notice")!;
      expect(notice).not.toBeNull();
      expect(notice.closest(".canvas-region")).toBeNull();
      expect(notice.textContent).toContain("Your toolbar layout was rearranged into groups.");
      await act(async () => notice.querySelector<HTMLButtonElement>('[aria-label="Dismiss toolbar layout notice"]')!.click());
      expect(host.querySelector(".main-toolbar-migration-notice")).toBeNull();
      expect(layout.save).toHaveBeenLastCalledWith(expect.objectContaining({ mainToolbarGroupsMigration: { version: 1, noticePending: false } }));
    } finally {
      await act(async () => root.unmount()); host.remove();
    }
  });
});
