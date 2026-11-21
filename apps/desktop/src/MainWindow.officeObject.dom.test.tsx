// @vitest-environment jsdom
import { readChemDraftSelectionFromPng } from "@chemdraft/clipboard-adapter";
import { applyPatch, type MoleculeObject } from "@chemdraft/chem-core";
import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import { Molecule } from "openchemlib";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { runUpdateFlow } from "./appUpdates";
import {
  createPhase4Document, createSelectionClipboardPayload, insertNativeMolfileMolecule, insertNativeReactionArrow,
  parseSelectionClipboardPayload, selectDocumentObjects, serializeSelectionClipboardPayload
} from "./documentWorkflow";
import { officeObjectIdFromSearch } from "./officeObject";
import { picturePngBase64 } from "./testSupport/imageFixture";
import { MemoryStorage } from "./testSupport/memoryStorage";

const tauri = vi.hoisted(() => ({
  desktop: true,
  invoke: vi.fn<(command: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<unknown>>(),
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
function reactionFixture() {
  let drawing = createPhase4Document();
  for (const [smiles, x] of [[stereoFixture, 160], ["[CH2]/C=C/CC", 280], ["CCO", 540]] as const) {
    drawing = insertNativeMolfileMolecule(drawing, { x, y: 240 }, depictSmiles2D(smiles).molfile, "molfile-v2000");
  }
  drawing = insertNativeReactionArrow(drawing, { x: 360, y: 240 }, { x: 460, y: 240 }, "forward");
  const page = drawing.pages[0]!;
  const molecules = page.objects.filter(object => object.type === "molecule");
  drawing = applyPatch(drawing, { op: "addObject", pageId: page.id, object: {
    id: "fixture-reaction", type: "reaction", x: 100, y: 200, width: 500, height: 80, rotation: 0, style: {},
    components: molecules.map((object, index) => ({ objectId: object.id, role: index === 2 ? "product" : "reactant" })),
    arrowObjectIds: [page.objects.find(object => object.type === "reaction-arrow")!.id],
    conditionsTextObjectIds: [], mappingState: "absent"
  } });
  return selectDocumentObjects(drawing, page.id, drawing.pages[0]!.objects.map(object => object.id));
}
const selectionJson = serializeSelectionClipboardPayload(createSelectionClipboardPayload(reactionFixture())!);
const serverBlankJson = '{"kind":"chemdraft-selection","version":1,"objects":[],"selectionIds":[],"bounds":{"x":0,"y":0,"width":0,"height":0}}';
interface CloseRequest { requestId: number | null; prompt: boolean; unsaved: boolean; discard: boolean }

function updatedContent(frame: InvokeArgs | undefined) {
  if (!(frame instanceof Uint8Array)) throw new Error("Expected a raw Office update frame");
  const jsonEnd = 4 + new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
  return { json: new TextDecoder().decode(frame.subarray(4, jsonEnd)), png: frame.subarray(jsonEnd) };
}

function chemistry(molecule: MoleculeObject) {
  const molfile = Molecule.fromMolfile(stereoPerceptionMolfile(molecule));
  const native = Molecule.fromMolfile(molecule.structure);
  return {
    smiles: molfile.toIsomericSmiles(), formula: molfile.getMolecularFormula().formula,
    charge: molecule.atoms.reduce((sum, atom) => sum + atom.formalCharge, 0),
    atomCount: molecule.atoms.length, bondCount: molecule.bonds.length,
    isotopes: molecule.atoms.map(atom => atom.isotope),
    radicals: Array.from({ length: native.getAllAtoms() }, (_, i) => native.getAtomRadical(i))
  };
}

describe("Office embedded document window", () => {
  let host: HTMLDivElement;
  let root: Root;
  let receiver: { onmessage: (request: CloseRequest) => void };
  let openPayload: { objectId: string; json: string; containerApp: string; containerDocument: string };

  const deliverClose = (requestId: number | null = null, prompt = true, unsaved = false, discard = false) =>
    act(async () => receiver.onmessage({ requestId, prompt, unsaved, discard }));
  const officeCalls = () => tauri.invoke.mock.calls.filter(([command]) =>
    command === "office_object_update" || command === "office_object_close").map(([command, args]) => [command, args] as const);
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

  it("round-trips chemistry and geometry in a multi-component reaction and embeds its exact JSON in the preview", async () => {
    await mount();
    await nativeMenu("office.updateEmbeddedObject");
    expect(officeCalls(), status()).toEqual([["office_object_update", expect.any(Uint8Array)]]);
    const [, request] = officeCalls()[0]!;
    const { json, png } = updatedContent(request);
    expect(await readChemDraftSelectionFromPng(png)).toEqual({ kind: "found", chunk: "iTXt", json });
    expect(tauri.invoke).toHaveBeenCalledWith("rasterize_svg", { request: expect.objectContaining({
      format: "png", scale: 4, cssPxPerInch: 96
    }) });
    const before = parseSelectionClipboardPayload(selectionJson)!.objects;
    const after = parseSelectionClipboardPayload(json)!.objects;
    const beforeMolecules = before.filter(object => object.type === "molecule");
    const afterMolecules = after.filter(object => object.type === "molecule");
    const expected = beforeMolecules.map(chemistry);
    expect(expected[0]).toMatchObject({ smiles: Molecule.fromSmiles(stereoFixture).toIsomericSmiles(), charge: 1 });
    expect(expected[0]!.isotopes).toContain(13);
    expect(expected[1]!.radicals.filter(Boolean)).toHaveLength(1);
    expect(afterMolecules.map(chemistry)).toEqual(expected);
    for (const [index, molecule] of afterMolecules.entries()) {
      const original = beforeMolecules[index]!;
      expect(molecule.x).toBeCloseTo(original.x, 8);
      expect(molecule.y).toBeCloseTo(original.y, 8);
      for (const [atomIndex, atom] of molecule.atoms.entries()) {
        expect(atom.x).toBeCloseTo(original.atoms[atomIndex]!.x, 8);
        expect(atom.y).toBeCloseTo(original.atoms[atomIndex]!.y, 8);
      }
    }
    const originalArrow = before.find(object => object.type === "reaction-arrow")!;
    const arrow = after.find(object => object.type === "reaction-arrow")!;
    expect(arrow).toMatchObject({ arrowKind: "forward", start: originalArrow.start, end: originalArrow.end });
    expect(after.find(object => object.type === "reaction")).toMatchObject({
      components: afterMolecules.map((object, index) => ({ objectId: object.id, role: index === 2 ? "product" : "reactant" })),
      arrowObjectIds: [arrow.id]
    });
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

  it.each([[51, true], [52, false]] as const)("queues close request %s behind an active update", async (requestId, prompt) => {
    const invoke = tauri.invoke.getMockImplementation()!;
    let finish!: (value: null) => void;
    const pending = new Promise<null>(resolve => { finish = resolve; });
    tauri.invoke.mockImplementation((command, args) => command === "office_object_update" ? pending : invoke(command, args));
    await mount();
    await edit();
    await nativeMenu("office.updateEmbeddedObject");
    await deliverClose(requestId, prompt);
    expect(officeCalls().map(([command]) => command)).toEqual(["office_object_update"]);
    await act(async () => finish(null));
    expect(tauri.message).not.toHaveBeenCalled();
    expect(officeCalls().at(-1)).toEqual(["office_object_close", { objectId: "17", requestId, saveChanges: true }]);
  });

  it("queues Office's explicit discard behind an active update without prompting", async () => {
    const invoke = tauri.invoke.getMockImplementation()!;
    let finish!: (value: null) => void;
    const pending = new Promise<null>(resolve => { finish = resolve; });
    tauri.invoke.mockImplementation((command, args) => command === "office_object_update" ? pending : invoke(command, args));
    await mount();
    await nativeMenu("office.updateEmbeddedObject");
    await deliverClose(53, false, false, true);
    expect(officeCalls()).toHaveLength(1);
    await act(async () => finish(null));
    expect(tauri.message).not.toHaveBeenCalled();
    expect(officeCalls().at(-1)).toEqual(["office_object_close", { objectId: "17", requestId: 53, saveChanges: false }]);
  });

  it("prompts for edits made after the in-flight update took its snapshot", async () => {
    const invoke = tauri.invoke.getMockImplementation()!;
    let finish!: (value: null) => void;
    const pending = new Promise<null>(resolve => { finish = resolve; });
    tauri.invoke.mockImplementation((command, args) => command === "office_object_update" ? pending : invoke(command, args));
    await mount();
    await nativeMenu("office.updateEmbeddedObject");
    await edit();
    tauri.message.mockResolvedValue("Cancel");
    await deliverClose(57);
    expect(tauri.message).not.toHaveBeenCalled();
    await act(async () => finish(null));
    expect(tauri.message).toHaveBeenCalledOnce();
    expect(officeCalls().at(-1)).toEqual(["office_object_close", { objectId: "17", requestId: 57 }]);
  });

  it("publishes for Windows session end without a prompt and unlocks if Windows cancels", async () => {
    await mount();
    await edit();
    await act(async () => window.dispatchEvent(new CustomEvent("chemdraft:office-toolset:office-session-publish", { detail: 54 })));
    expect(tauri.invoke).toHaveBeenCalledWith("office_object_update", expect.any(Uint8Array), {
      headers: { "x-chemdraft-session-publish": "54" }
    });
    tauri.message.mockResolvedValue("Update");
    await deliverClose(55);
    expect(tauri.message).not.toHaveBeenCalled();
    expect(officeCalls().map(([command]) => command)).toEqual(["office_object_update"]);
    await act(async () => window.dispatchEvent(new CustomEvent("chemdraft:office-toolset:office-session-cancel", { detail: 54 })));
    expect(tauri.message).toHaveBeenCalledOnce();
    expect(officeCalls().map(([command]) => command)).toEqual(["office_object_update", "office_object_update", "office_object_close"]);
  });

  it("answers a Windows session end as unchanged when Office already holds the drawing", async () => {
    await mount();
    await act(async () => window.dispatchEvent(new CustomEvent("chemdraft:office-toolset:office-session-publish", { detail: 58 })));
    expect(officeCalls()).toEqual([["office_object_update", new Uint8Array(0)]]);
    expect(tauri.invoke).toHaveBeenCalledWith("office_object_update", new Uint8Array(0), {
      headers: { "x-chemdraft-session-publish": "58", "x-chemdraft-session-unchanged": "1" }
    });
    await act(async () => window.dispatchEvent(new CustomEvent("chemdraft:office-toolset:office-session-cancel", { detail: 58 })));
    await deliverClose(59);
    expect(tauri.message).not.toHaveBeenCalled();
    expect(officeCalls().at(-1)).toEqual(["office_object_close", { objectId: "17", requestId: 59, saveChanges: true }]);
  });

  it("answers a Windows session end as unchanged when the editor never received its document", async () => {
    const invoke = tauri.invoke.getMockImplementation()!;
    tauri.invoke.mockImplementation(async (command, args) => {
      if (command === "office_object_connect") throw new Error("Office object STA has exited");
      return invoke(command, args);
    });
    await mount();
    await act(async () => window.dispatchEvent(new CustomEvent("chemdraft:office-toolset:office-session-publish", { detail: 60 })));
    expect(officeCalls()).toEqual([["office_object_update", new Uint8Array(0)]]);
    expect(tauri.invoke).toHaveBeenCalledWith("office_object_update", new Uint8Array(0), {
      headers: { "x-chemdraft-session-publish": "60", "x-chemdraft-session-unchanged": "1" }
    });
  });

  it("reports a session-end answer Windows did not accept", async () => {
    const invoke = tauri.invoke.getMockImplementation()!;
    tauri.invoke.mockImplementation(async (command, args) => {
      if (command === "office_object_update") throw new Error("The Office session-end publish request has expired");
      return invoke(command, args);
    });
    await mount();
    await act(async () => window.dispatchEvent(new CustomEvent("chemdraft:office-toolset:office-session-publish", { detail: 61 })));
    expect(status()).toContain("Could not answer the Windows session end: The Office session-end publish request has expired");
    expect(tauri.invoke).toHaveBeenCalledWith("office_object_update", new Uint8Array(0), {
      headers: { "x-chemdraft-session-publish": "61", "x-chemdraft-session-failed": "1" }
    });
    // The failed answer unlocked the editor: Office's close goes through without a cancel.
    await deliverClose(63);
    expect(officeCalls().at(-1)).toEqual(["office_object_close", { objectId: "17", requestId: 63, saveChanges: true }]);
  });

  it("reports a drawing it could not send for a Windows session end and unlocks Update and Close", async () => {
    const invoke = tauri.invoke.getMockImplementation()!;
    tauri.invoke.mockImplementation(async (command, args, options) => {
      const headers = (options?.headers ?? {}) as Record<string, string>;
      if (command === "office_object_update" && headers["x-chemdraft-session-publish"] && !headers["x-chemdraft-session-failed"]) {
        throw new Error("IPC channel closed");
      }
      return invoke(command, args, options);
    });
    await mount();
    await edit();
    await act(async () => window.dispatchEvent(new CustomEvent("chemdraft:office-toolset:office-session-publish", { detail: 62 })));
    expect(status()).toBe("Could not update the structure in Report.docx: IPC channel closed");
    const sessionCalls = tauri.invoke.mock.calls.filter(([command]) => command === "office_object_update").map(([, , options]) => options);
    expect(sessionCalls).toEqual([
      { headers: { "x-chemdraft-session-publish": "62" } },
      { headers: { "x-chemdraft-session-publish": "62", "x-chemdraft-session-failed": "1" } }
    ]);
    // No cancel arrives; Update and Close work again anyway.
    await nativeMenu("office.updateEmbeddedObject");
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "office_object_update").at(-1)?.[2]).toBeUndefined();
    expect(status()).toBe("Updated structure in Report.docx.");
    await deliverClose(64);
    expect(officeCalls().at(-1)).toEqual(["office_object_close", { objectId: "17", requestId: 64, saveChanges: true }]);
  });

  it("aborts an accepted app update when the user cancels an embedded editor's close prompt", async () => {
    tauri.message.mockResolvedValue("Cancel");
    await mount();
    await edit();
    const update = { version: "2", currentVersion: "1", download: vi.fn(), install: vi.fn(), close: vi.fn(async () => {}) };
    const flushSession = vi.fn();
    const outcome = await runUpdateFlow("manual", {
      check: async () => update, confirm: async () => true, message: vi.fn(), setStatus: vi.fn(), flushSession,
      prepareEmbeddedEditors: async () => {
        await deliverClose(56);
        const response = officeCalls().find(([command]) => command === "office_object_close")?.[1];
        if (!response || !("saveChanges" in response)) throw new Error("An Office editor stayed open.");
        return async () => {};
      }
    });
    expect(tauri.message).toHaveBeenCalledWith(expect.stringContaining("Report.docx"), expect.objectContaining({
      buttons: { YesNoCancelCustom: ["Update", "Don't update", "Cancel"] }
    }));
    expect(outcome).toBe("install-failed");
    expect(officeCalls()).toEqual([["office_object_close", { objectId: "17", requestId: 56 }]]);
    expect(update.install).not.toHaveBeenCalled();
    expect(flushSession).not.toHaveBeenCalled();
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
