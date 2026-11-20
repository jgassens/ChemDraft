// @vitest-environment jsdom
import { readChemDraftSelectionFromPng } from "@chemdraft/clipboard-adapter";
import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import type { EventCallback } from "@tauri-apps/api/event";
import { Molecule } from "openchemlib";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import {
  createPhase4Document, createSelectionClipboardPayload, insertNativeMolfileMolecule, parseSelectionClipboardPayload,
  serializeSelectionClipboardPayload
} from "./documentWorkflow";
import { officeObjectIdFromSearch } from "./officeObject";
import { picturePngBase64 } from "./testSupport/imageFixture";
import { MemoryStorage } from "./testSupport/memoryStorage";

const tauri = vi.hoisted(() => ({
  desktop: true,
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  emitTo: vi.fn<(label: string, event: string) => Promise<void>>(),
  listen: vi.fn<(event: string, handler: EventCallback<unknown>) => Promise<() => void>>(),
  setTitle: vi.fn<(title: string) => Promise<void>>(),
  message: vi.fn<(message: string, options: unknown) => Promise<string>>()
}));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: tauri.invoke, isTauri: () => tauri.desktop
}));
vi.mock("@tauri-apps/api/event", async original => ({
  ...await original<typeof import("@tauri-apps/api/event")>(), emitTo: tauri.emitTo
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "office-object-17", listen: tauri.listen })
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "office-object-17", listen: tauri.listen, setTitle: tauri.setTitle })
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: tauri.message }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(), isDesktopRuntime: () => tauri.desktop
}));
vi.mock("./window-manager/tauriEvents", async original => ({
  ...await original<typeof import("./window-manager/tauriEvents")>(), listenTauriEvent: async () => () => undefined
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The charged isotope and stereo case also used by bondStereo.test.ts and pageEnlargementShift.test.ts.
const stereoFixture = "[13CH3]/C=C/[C@@H]([NH3+])Cl";
const source = insertNativeMolfileMolecule(createPhase4Document(), { x: 240, y: 240 },
  depictSmiles2D(stereoFixture).molfile, "molfile-v2000");
const selectionJson = serializeSelectionClipboardPayload(createSelectionClipboardPayload(source)!);
const serverBlankJson = '{"kind":"chemdraft-selection","version":1,"objects":[],"selectionIds":[],"bounds":{"x":0,"y":0,"width":0,"height":0}}';
const closeEvent = "tauri://close-requested";
const openEvent = "office-object://open";

function chemistry(json: string) {
  const molecule = parseSelectionClipboardPayload(json)?.objects[0];
  if (molecule?.type !== "molecule") throw new Error("Expected a molecule in the Office selection");
  const molfile = Molecule.fromMolfile(stereoPerceptionMolfile(molecule));
  return {
    smiles: molfile.toIsomericSmiles(), formula: molfile.getMolecularFormula().formula,
    charge: molecule.atoms.reduce((sum, atom) => sum + atom.formalCharge, 0),
    atomCount: molecule.atoms.length, bondCount: molecule.bonds.length
  };
}

describe("Office embedded document window", () => {
  let host: HTMLDivElement;
  let root: Root;
  let listeners: Map<string, Set<EventCallback<unknown>>>;
  let openPayload: { objectId: string; json: string; containerApp: string; containerDocument: string };

  const deliver = (event: string, payload?: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener({ event, payload, id: 1 });
  };
  const officeCalls = () => tauri.invoke.mock.calls.filter(([command]) => command.startsWith("office_object_"));
  const status = () => host.querySelector("[data-status-message]")?.textContent;

  beforeEach(() => {
    listeners = new Map();
    openPayload = { objectId: "17", json: selectionJson, containerApp: "Microsoft Word", containerDocument: "Report.docx" };
    window.history.replaceState(null, "", "/?officeObject=17");
    tauri.desktop = true;
    tauri.listen.mockReset().mockImplementation(async (event, listener) => {
      const set = listeners.get(event) ?? new Set<EventCallback<unknown>>();
      listeners.set(event, set);
      set.add(listener);
      return () => { set.delete(listener); };
    });
    tauri.emitTo.mockReset().mockImplementation(async () => { deliver(openEvent, openPayload); });
    tauri.setTitle.mockReset().mockResolvedValue(undefined);
    tauri.message.mockReset().mockResolvedValue("Cancel");
    tauri.invoke.mockReset().mockImplementation(async command => command === "rasterize_svg" ? {
      bytes: Array.from(Buffer.from(picturePngBase64, "base64")), width: 144, height: 72, warnings: []
    } : null);
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  async function mount(platform: "windows" | "macos" = "windows", showTools = false) {
    await act(async () => root.render(<StrictMode><MainWindow shortcutPlatform={platform}
      initialPaletteMode={showTools ? "floating" : "hidden"} initialActiveToolCommandId="tool.select" initialRulersVisible={false}
      initialCrosshairsVisible={false} /></StrictMode>));
  }

  async function fileItem(label: string) {
    const file = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "File")!;
    await act(async () => file.click());
    const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find(button => button.textContent?.startsWith(label));
    expect(item, `File → ${label}`).toBeDefined();
    await act(async () => item!.click());
  }

  async function key(key: string, modifiers: KeyboardEventInit = {}) {
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key, bubbles: true, cancelable: true, ...modifiers
    })); });
  }

  async function edit() {
    await key("a", { ctrlKey: true });
    await key("Delete");
  }

  it("detects only nonempty Office object IDs and leaves regular windows off the bridge", async () => {
    expect(officeObjectIdFromSearch("?officeObject=object%2D17&extra=1")).toBe("object-17");
    expect(officeObjectIdFromSearch("?officeObject=")).toBeUndefined();
    expect(officeObjectIdFromSearch("?window=toolset")).toBeUndefined();
    window.history.replaceState(null, "", "/");
    tauri.desktop = false;
    await mount();
    expect(tauri.listen).not.toHaveBeenCalledWith(openEvent, expect.anything());
    expect(tauri.emitTo).not.toHaveBeenCalled();
  });

  it("attaches window listeners before announcing ready and titles the editor from the container document", async () => {
    const listen = tauri.listen.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    tauri.listen.mockImplementation(async (event, handler) => {
      if (event === openEvent) await gate;
      return listen(event, handler);
    });
    await mount();
    expect(tauri.emitTo).not.toHaveBeenCalled();
    expect(listeners.get(closeEvent)?.size).toBe(1);
    await act(async () => release());
    expect(tauri.emitTo).toHaveBeenCalledExactlyOnceWith("office-object-17", "office-object://ready");
    expect(tauri.setTitle).toHaveBeenCalledExactlyOnceWith("ChemDraft Structure in Report.docx — test");
    expect(document.title).toBe("ChemDraft Structure in Report.docx — test");
    expect(tauri.invoke.mock.calls.map(([name]) => name)).not.toContain("load_document_session");
  });

  it("falls back to the container app and accepts the server's blank object", async () => {
    openPayload.containerDocument = "";
    openPayload.json = serverBlankJson;
    await mount("windows", true);
    expect(document.title).toBe("ChemDraft Structure in Microsoft Word — test");
    expect(host.querySelector('header [aria-label="Drawing tools"] [data-command-id="tool.bond"]')).not.toBeNull();
    await fileItem("Update Microsoft Word");
    const [, request] = officeCalls()[0]!;
    expect(parseSelectionClipboardPayload(String(request?.json), { allowEmpty: true })?.objects).toEqual([]);
  });

  it("round-trips stereo, charge and isotope and sends the exact JSON in a standard-base64 PNG", async () => {
    await mount();
    await fileItem("Update Report.docx");
    expect(officeCalls()).toEqual([["office_object_update", {
      objectId: "17", json: expect.any(String), pngBase64: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/)
    }]]);
    const [, request] = officeCalls()[0]!;
    const json = String(request?.json);
    const png = Uint8Array.from(Buffer.from(String(request?.pngBase64), "base64"));
    expect(await readChemDraftSelectionFromPng(png)).toEqual({ kind: "found", chunk: "iTXt", json });
    expect(tauri.invoke).toHaveBeenCalledWith("rasterize_svg", { request: expect.objectContaining({
      format: "png", scale: 4, cssPxPerInch: 96
    }) });
    const expected = chemistry(selectionJson);
    expect(expected.smiles).toBe(Molecule.fromSmiles(stereoFixture).toIsomericSmiles());
    expect(expected.charge).toBe(1);
    expect(chemistry(json)).toEqual(expected);
  });

  it.each(["windows", "macos"] as const)("routes File Save and the %s save chord to Office Update", async platform => {
    await mount(platform);
    await fileItem("Save");
    await key("s", platform === "windows" ? { ctrlKey: true } : { metaKey: true });
    expect(officeCalls().map(([command]) => command)).toEqual(["office_object_update", "office_object_update"]);
  });

  it("closes an unmodified structure without prompting, even after select all", async () => {
    await mount();
    await key("a", { ctrlKey: true });
    await act(async () => deliver(closeEvent));
    expect(tauri.message).not.toHaveBeenCalled();
    expect(officeCalls()).toEqual([["office_object_close", { objectId: "17", saveChanges: true }]]);
  });

  it.each(["Update", "Don't update", "Cancel"])("handles %s in the native dirty-close prompt", async choice => {
    tauri.message.mockResolvedValue(choice);
    await mount();
    await edit();
    await fileItem("Close");
    expect(tauri.message).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Report.docx"), expect.objectContaining({
      buttons: { yes: "Update", no: "Don't update", cancel: "Cancel" }
    }));
    expect(officeCalls().map(([command]) => command)).toEqual(choice === "Update"
      ? ["office_object_update", "office_object_close"] : choice === "Don't update" ? ["office_object_close"] : []);
    if (choice !== "Cancel") expect(officeCalls().at(-1)?.[1]).toEqual({ objectId: "17", saveChanges: choice === "Update" });
  });

  it("keeps the editor open with the native diagnostic when its update fails", async () => {
    const invoke = tauri.invoke.getMockImplementation()!;
    tauri.invoke.mockImplementation(async (command, args) => {
      if (command === "office_object_update") throw "Word rejected the preview";
      return invoke(command, args);
    });
    tauri.message.mockResolvedValue("Update");
    await mount();
    await edit();
    await act(async () => deliver(closeEvent));
    expect(officeCalls().map(([command]) => command)).toEqual(["office_object_update"]);
    expect(status()).toBe("Could not update the structure in Report.docx: Word rejected the preview");
  });

  it("waits for Office to accept an update before closing", async () => {
    const invoke = tauri.invoke.getMockImplementation()!;
    let finishUpdate!: (result: null) => void;
    const pendingUpdate = new Promise<null>(resolve => { finishUpdate = resolve; });
    tauri.invoke.mockImplementation((command, args) => command === "office_object_update" ? pendingUpdate : invoke(command, args));
    tauri.message.mockResolvedValue("Update");
    await mount();
    await edit();
    await act(async () => deliver(closeEvent));
    expect(officeCalls().map(([command]) => command)).toEqual(["office_object_update"]);
    await act(async () => finishUpdate(null));
    expect(officeCalls().map(([command]) => command)).toEqual(["office_object_update", "office_object_close"]);
  });

  it("reports unsupported selection JSON and keeps the editor from updating the object", async () => {
    openPayload.json = "{}";
    await mount();
    expect(status()).toContain("invalid or unsupported ChemDraft selection JSON");
    await key("s", { ctrlKey: true });
    expect(officeCalls()).toEqual([]);
  });

  it("shows a specific diagnostic when the native close fails", async () => {
    const invoke = tauri.invoke.getMockImplementation()!;
    tauri.invoke.mockImplementation(async (command, args) => {
      if (command === "office_object_close") throw "Word is busy";
      return invoke(command, args);
    });
    await mount();
    await fileItem("Close");
    expect(status()).toBe("Could not close the Office structure in Report.docx: Word is busy");
  });
});
