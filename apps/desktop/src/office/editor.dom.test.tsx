// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  createPhase4Document, createSelectionClipboardPayload, insertNativeSingleBondMolecule, serializeSelectionClipboardPayload,
} from "../documentWorkflow";
import type { OfficeDocument, OfficeHostAdapter } from "./host";
import * as officeEditor from "./editorHost";
import * as officeControls from "./controls";

vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn(async () => { throw new Error("Native calls are unavailable in Office."); }),
}));
vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

async function mountPane() {
  // Match the two module substitutions the Office build makes for MainWindow.
  vi.doMock("../officeObject", () => officeEditor);
  vi.doMock("../MenuBar", () => officeControls);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const { OfficePane } = await import("./Pane");
  const source = insertNativeSingleBondMolecule(createPhase4Document(), { x: 40, y: 40 });
  const json = serializeSelectionClipboardPayload(createSelectionClipboardPayload(source)!);
  const adapter: OfficeHostAdapter = {
    readSelectedStructure: vi.fn<OfficeHostAdapter["readSelectedStructure"]>().mockResolvedValue({ kind: "structure", key: "1", json }),
    replaceSelectedStructure: vi.fn(),
  };
  const host: OfficeDocument = {
    addHandlerAsync: (_event, _listener, done) => done({ status: "succeeded", value: undefined }),
    removeHandlerAsync: vi.fn(),
    getFileAsync: vi.fn(),
    setSelectedDataAsync: vi.fn(),
  };
  // The task pane renders into #root, which pane.css styles.
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OfficePane adapter={adapter} document={host} />));
  // Await the same module that the task pane loads lazily, then flush the Suspense retry.
  await act(async () => { await import("../MainWindow"); });
  return {
    container, adapter,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("mounts the shared ChemDraft canvas and command controls in Office's browser runtime", async () => {
  expect("__TAURI__" in window).toBe(false);
  const { container, unmount } = await mountPane();
  try {
    expect(container.querySelector(".canvas-region")).toBeTruthy();
    expect(container.querySelector(".canvas-region")?.hasAttribute("inert")).toBe(false);
    expect(container.querySelector(".tool-palette")).toBeTruthy();
    expect(container.querySelector('[data-object-id]')).toBeTruthy();
    expect(container.querySelector(".menu-bar")).toBeNull();
    expect(container.querySelector(".document-tab-strip")).toBeNull();
    expect(container.querySelector(".office-update")).toMatchObject({ disabled: true, textContent: "Update" });
    expect(container.querySelector(".office-controls [role=status]")?.textContent).toBe("Structure ready to edit.");
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await unmount();
  }
}, 15_000);

it("sizes the Office toolbar's tools as buttons, so the toolbar cannot take the canvas's height", async () => {
  // jsdom does no layout, so check the cascaded styles that decide it. App.css sizes a tool slot to
  // fill a grid cell (width 100%). In the header's wrapping flex row that made each tool as wide as
  // the pane: the tools stacked in one column taller than the pane and left the canvas row 0px high.
  const style = document.createElement("style");
  style.textContent = readFileSync("apps/desktop/src/App.css", "utf8") + readFileSync("apps/desktop/src/office/pane.css", "utf8");
  document.head.append(style);
  const { container, unmount } = await mountPane();
  try {
    const shell = container.querySelector<HTMLElement>(":scope > .app-shell")!;
    const [header, workspace, ...rest] = [...shell.children];
    expect(header?.matches("header")).toBe(true);
    expect(workspace?.matches(".workspace")).toBe(true);
    expect(rest).toEqual([]);
    const groups = [...container.querySelectorAll<HTMLElement>(".command-bar .tool-group")];
    expect(groups.length).toBeGreaterThan(0);
    const slots = groups.flatMap(group => [...group.children] as HTMLElement[]);
    expect(slots.length).toBeGreaterThan(10);
    for (const group of groups) expect(getComputedStyle(group)).toMatchObject({ display: "flex", flexWrap: "wrap" });
    for (const slot of slots) {
      expect(slot.matches(".toolbar-item-grid-slot")).toBe(true);
      expect(getComputedStyle(slot)).toMatchObject({ width: "28px", height: "28px" });
    }
    // And the canvas row keeps some height even if the header ever grows past the pane.
    expect(getComputedStyle(shell).gridTemplateRows).toBe("auto minmax(160px, 1fr)");
  } finally {
    await unmount();
    style.remove();
  }
}, 15_000);

it("closes the editor and returns the pane to its prompt when Cancel is clicked", async () => {
  const { container, adapter, unmount } = await mountPane();
  try {
    const reads = vi.mocked(adapter.readSelectedStructure).mock.calls.length;
    const cancel = [...container.querySelectorAll<HTMLButtonElement>(".office-controls button")]
      .find(button => button.textContent === "Cancel")!;
    await act(async () => { cancel.click(); });
    await vi.waitFor(() => expect(container.querySelector(".canvas-region")).toBeNull());
    expect(container.querySelector(".office-message")?.textContent).toBe("Editing cancelled. Select a ChemDraft structure");
    expect(adapter.readSelectedStructure).toHaveBeenCalledTimes(reads);
    expect(adapter.replaceSelectedStructure).not.toHaveBeenCalled();
  } finally {
    await unmount();
  }
}, 15_000);
