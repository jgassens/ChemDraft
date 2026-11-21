// @vitest-environment jsdom
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

it("mounts the shared ChemDraft canvas and command controls in Office's browser runtime", async () => {
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    expect("__TAURI__" in window).toBe(false);
    await act(async () => root.render(<OfficePane adapter={adapter} document={host} />));
    // Await the same module that the task pane loads lazily, then flush the Suspense retry.
    await act(async () => { await import("../MainWindow"); });
    expect(container.querySelector(".canvas-region")).toBeTruthy();
    expect(container.querySelector(".tool-palette")).toBeTruthy();
    expect(container.querySelector('[data-object-id]')).toBeTruthy();
    expect(container.querySelector(".menu-bar")).toBeNull();
    expect(container.querySelector(".document-tab-strip")).toBeNull();
    expect(container.querySelector(".office-update")).toMatchObject({ disabled: true, textContent: "Update" });
    expect(container.querySelector(".office-controls [role=status]")?.textContent).toBe("Structure ready to edit.");
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
}, 15_000);
