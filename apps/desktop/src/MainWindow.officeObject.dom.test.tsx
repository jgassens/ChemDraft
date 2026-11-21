// @vitest-environment jsdom
import { readChemDraftSelectionFromPng } from "@chemdraft/clipboard-adapter";
import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import type { InvokeArgs } from "@tauri-apps/api/core";
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
  invoke: vi.fn<(command: string, args?: InvokeArgs) => Promise<unknown>>(),
  setTitle: vi.fn<(title: string) => Promise<void>>(),
  message: vi.fn<(message: string, options: unknown) => Promise<string>>()
}));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: tauri.invoke, isTauri: () => tauri.desktop
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "office-object-17", setTitle: tauri.setTitle })
}));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(), isDesktopRuntime: () => tauri.desktop
}));
vi.mock("./window-manager/tauriEvents", async original => ({
  ...await original<typeof import("./window-manager/tauriEvents")>(),
  listenCurrentWindowEvent: async () => () => undefined,
  listenTauriEvent: async () => () => undefined
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The charged isotope and stereo case also used by bondStereo.test.ts and pageEnlargementShift.test.ts.
const stereoFixture = "[13CH3]/C=C/[C@@H]([NH3+])Cl";
const source = insertNativeMolfileMolecule(createPhase4Document(), { x: 240, y: 240 },
  depictSmiles2D(stereoFixture).molfile, "molfile-v2000");
const selectionJson = serializeSelectionClipboardPayload(createSelectionClipboardPayload(source)!);
const serverBlankJson = '{"kind":"chemdraft-selection","version":1,"objects":[],"selectionIds":[],"bounds":{"x":0,"y":0,"width":0,"height":0}}';
interface CloseRequest { requestId: number | null; prompt: boolean; unsaved: boolean }

function updatedContent(frame: InvokeArgs | undefined) {
  if (!(frame instanceof Uint8Array)) throw new Error("Expected a raw Office update frame");
  const jsonEnd = 4 + new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
  return { json: new TextDecoder().decode(frame.subarray(4, jsonEnd)), png: frame.subarray(jsonEnd) };
}

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
  let receiver: { onmessage: (request: CloseRequest) => void };
  let openPayload: { objectId: string; json: string; containerApp: string; containerDocument: string };

  const deliverClose = (requestId: number | null = null, prompt = true, unsaved = false) =>
    act(async () => receiver.onmessage({ requestId, prompt, unsaved }));
  const officeCalls = () => tauri.invoke.mock.calls.filter(([command]) =>
    command === "office_object_update" || command === "office_object_close");
  const status = () => host.querySelector("[data-status-message]")?.textContent;

  beforeEach(() => {
    openPayload = { objectId: "17", json: selectionJson, containerApp: "Microsoft Word", containerDocument: "Report.docx" };
    window.history.replaceState(null, "", "/?officeObject=17");
    tauri.desktop = true;
    tauri.setTitle.mockReset().mockResolvedValue(undefined);
    tauri.message.mockReset().mockResolvedValue("Cancel");
    tauri.invoke.mockReset().mockImplementation(async (command, args) => {
      const params = args as Record<string, unknown> | undefined;
      if (command === "office_object_connect") {
        receiver = params?.channel as typeof receiver;
        return openPayload;
      }
      if (command === "plugin:dialog|message") return tauri.message(String(params?.message), args);
      return command === "rasterize_svg" ? {
        bytes: Array.from(Buffer.from(picturePngBase64, "base64")), width: 144, height: 72, warnings: []
      } : null;
    });
    vi.stubGlobal("isTauri", true);
    vi.stubGlobal("__TAURI_INTERNALS__", {
      invoke: (command: string, args?: InvokeArgs) => tauri.invoke(command, args),
      metadata: { currentWindow: { label: "office-object-17" }, currentWebview: { label: "office-object-17" } },
      transformCallback: () => 1,
      unregisterCallback: () => undefined
    });
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
      nativePalette={false} initialPaletteMode={showTools ? "floating" : "hidden"} initialActiveToolCommandId="tool.select" initialRulersVisible={false}
      initialCrosshairsVisible={false} /></StrictMode>));
  }

  async function nativeMenu(commandId: string) {
    await act(async () => {
      window.dispatchEvent(new CustomEvent("chemdraft:native-command", { detail: { commandId } }));
    });
  }

  async function key(key: string, modifiers: KeyboardEventInit = {}) {
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key, bubbles: true, cancelable: true, ...modifiers
    })); });
  }

  async function edit() {
    await nativeMenu("page.setSize.legal");
    expect(status()).toContain("Page size:");
  }

  it("detects only nonempty Office object IDs and leaves regular windows off the bridge", async () => {
    expect(officeObjectIdFromSearch("?officeObject=object%2D17&extra=1")).toBe("object-17");
    expect(officeObjectIdFromSearch("?officeObject=")).toBeUndefined();
    expect(officeObjectIdFromSearch("?window=toolset")).toBeUndefined();
    window.history.replaceState(null, "", "/");
    tauri.desktop = false;
    vi.stubGlobal("isTauri", false);
    vi.stubGlobal("__TAURI_INTERNALS__", undefined);
    await mount();
    expect(tauri.invoke.mock.calls.map(([name]) => name)).not.toContain("office_object_connect");
  });

  it("connects once and waits for the document before processing native close", async () => {
    const invoke = tauri.invoke.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    tauri.invoke.mockImplementation(async (command, args) => {
      const response = await invoke(command, args);
      if (command === "office_object_connect") await gate;
      return response;
    });
    await mount();
    expect(tauri.invoke.mock.calls.filter(([name]) => name === "office_object_connect")).toHaveLength(1);
    await deliverClose();
    expect(officeCalls()).toEqual([]);
    await act(async () => release());
    expect(tauri.setTitle).toHaveBeenCalledExactlyOnceWith("ChemDraft Structure in Report.docx — test");
    expect(document.title).toBe("ChemDraft Structure in Report.docx — test");
    expect(officeCalls()).toEqual([["office_object_close", { objectId: "17", saveChanges: true }]]);
    expect(tauri.invoke.mock.calls.map(([name]) => name)).not.toContain("load_document_session");
  });

  it("syncs the Update label and refuses standalone document commands", async () => {
    await mount();
    expect(host.querySelector('[role="menubar"]')).toBeNull();
    expect(tauri.invoke).toHaveBeenCalledWith("set_toolbars_menu", expect.objectContaining({
      officeUpdateTitle: "Update Report.docx"
    }));
    await nativeMenu("document.open");
    expect(status()).toContain("This command is available in the main ChemDraft window.");
    await nativeMenu("document.saveAs");
    await nativeMenu("plugins.manage");
    expect(officeCalls()).toEqual([]);
    expect(host.querySelector('input[type="file"]')).toBeNull();
  });

  it("uses its owner-scoped toolset bridge for drawing tool state", async () => {
    await mount("windows", true);
    const drawingTools = () => host.querySelector('header [aria-label="Drawing tools"]');
    expect(drawingTools()).not.toBeNull();
    await act(async () => window.dispatchEvent(new CustomEvent("chemdraft:office-toolset:chemdraft://toolset-window-state", {
      detail: { toolsetId: "core.main", open: false }
    })));
    expect(drawingTools()).toBeNull();
    expect(tauri.invoke).toHaveBeenCalledWith("office_toolset_emit", expect.objectContaining({
      event: "chemdraft://toolset-active-tool"
    }));
  });

  it("opens editing dialogs with the embedded document as their owner", async () => {
    const invoke = tauri.invoke.getMockImplementation()!;
    tauri.invoke.mockImplementation(async (command, args) => command === "dialog_open"
      ? { hostId: "h1", windowLabel: "dialog-office-object-17-pageSize-1" }
      : invoke(command, args));
    await mount();
    await nativeMenu("page.setSizeCustom");
    expect(tauri.invoke).toHaveBeenCalledWith("dialog_open", expect.objectContaining({
      message: expect.objectContaining({ dialogKind: "pageSize", ownerWindowId: "office-object-17" })
    }));
  });

  it("falls back to the container app and accepts the server's blank object", async () => {
    openPayload.containerDocument = "";
    openPayload.json = serverBlankJson;
    await mount("windows", true);
    expect(document.title).toBe("ChemDraft Structure in Microsoft Word — test");
    expect(host.querySelector('header [aria-label="Drawing tools"] [data-command-id="tool.bond"]')).not.toBeNull();
    await nativeMenu("office.updateEmbeddedObject");
    const [, request] = officeCalls()[0]!;
    expect(parseSelectionClipboardPayload(updatedContent(request).json, { allowEmpty: true })?.objects).toEqual([]);
  });

  it("round-trips stereo, charge and isotope and sends the exact JSON in a raw carrier PNG", async () => {
    await mount();
    await nativeMenu("office.updateEmbeddedObject");
    expect(officeCalls(), status()).toEqual([["office_object_update", expect.any(Uint8Array)]]);
    const [, request] = officeCalls()[0]!;
    const { json, png } = updatedContent(request);
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
    await nativeMenu("office.updateEmbeddedObject");
    await key("s", platform === "windows" ? { ctrlKey: true } : { metaKey: true });
    expect(officeCalls().map(([command]) => command)).toEqual(["office_object_update", "office_object_update"]);
  });

  it("closes an unmodified structure without prompting, even after select all", async () => {
    await mount();
    await key("a", { ctrlKey: true });
    await deliverClose();
    expect(tauri.message).not.toHaveBeenCalled();
    expect(officeCalls()).toEqual([["office_object_close", { objectId: "17", saveChanges: true }]]);
  });

  it.each(["Update", "Don't update", "Cancel"])("handles %s in the native dirty-close prompt", async choice => {
    tauri.message.mockResolvedValue(choice);
    await mount();
    await edit();
    await deliverClose();
    expect(tauri.message, status()).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Report.docx"), expect.objectContaining({
      buttons: { YesNoCancelCustom: ["Update", "Don't update", "Cancel"] }
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
    await deliverClose();
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
    await deliverClose();
    expect(officeCalls().map(([command]) => command)).toEqual(["office_object_update"]);
    await act(async () => finishUpdate(null));
    expect(officeCalls().map(([command]) => command)).toEqual(["office_object_update", "office_object_close"]);
  });

  it.each(["Update", "Don't update", "Cancel"])("reports %s for an app quit request", async choice => {
    tauri.message.mockResolvedValue(choice);
    await mount();
    await edit();
    await deliverClose(41);
    expect(tauri.message).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Report.docx"), expect.anything());
    expect(officeCalls().map(([command]) => command)).toEqual(choice === "Update"
      ? ["office_object_update", "office_object_close"] : ["office_object_close"]);
    expect(officeCalls().at(-1)?.[1]).toEqual({
      objectId: "17", requestId: 41, ...(choice === "Cancel" ? {} : { saveChanges: choice === "Update" })
    });
  });

  it("cancels an app quit and keeps the editor open when Office rejects its update", async () => {
    const invoke = tauri.invoke.getMockImplementation()!;
    tauri.invoke.mockImplementation(async (command, args) => {
      if (command === "office_object_update") throw "Word rejected the preview";
      return invoke(command, args);
    });
    tauri.message.mockResolvedValue("Update");
    await mount();
    await edit();
    await deliverClose(41);
    expect(officeCalls().map(([command]) => command)).toEqual(["office_object_update", "office_object_close"]);
    expect(officeCalls().at(-1)?.[1]).toEqual({ objectId: "17", requestId: 41 });
    expect(status()).toBe("Could not update the structure in Report.docx: Word rejected the preview");
  });

  it("lets the user retry a pending native save without rendering the drawing again", async () => {
    tauri.message.mockResolvedValue("Update");
    await mount();
    await deliverClose(41, true, true);
    expect(tauri.message).toHaveBeenCalledTimes(1);
    expect(officeCalls()).toEqual([["office_object_close", { objectId: "17", requestId: 41, saveChanges: true }]]);
  });

  it("publishes a dirty editor without prompting for Office Save If Dirty", async () => {
    await mount();
    await edit();
    await deliverClose(42, false);
    expect(tauri.message).not.toHaveBeenCalled();
    expect(officeCalls().map(([command]) => command)).toEqual(["office_object_update", "office_object_close"]);
    expect(officeCalls().at(-1)?.[1]).toEqual({ objectId: "17", requestId: 42, saveChanges: true });
  });

  it("reports unsupported selection JSON and keeps the editor from updating the object", async () => {
    openPayload.json = "{}";
    await mount();
    expect(status()).toContain("invalid or unsupported ChemDraft selection JSON");
    await key("s", { ctrlKey: true });
    expect(officeCalls()).toEqual([]);
  });

  it("holds further edits until Office accepts the close", async () => {
    const invoke = tauri.invoke.getMockImplementation()!;
    let failClose!: (error: Error) => void;
    const pendingClose = new Promise<never>((_resolve, reject) => { failClose = reject; });
    tauri.invoke.mockImplementation((command, args) => command === "office_object_close" ? pendingClose : invoke(command, args));
    await mount();
    await deliverClose();
    await nativeMenu("page.setSize.legal");
    expect(status()).not.toContain("Page size:");
    await act(async () => failClose(new Error("Office is busy")));
    await edit();
  });

  it("shows a specific diagnostic when the native close fails", async () => {
    const invoke = tauri.invoke.getMockImplementation()!;
    tauri.invoke.mockImplementation(async (command, args) => {
      if (command === "office_object_close") throw "Word is busy";
      return invoke(command, args);
    });
    await mount();
    await nativeMenu("office.closeEmbeddedObject");
    expect(status()).toBe("Could not close the Office structure in Report.docx: Word is busy");
  });
});
