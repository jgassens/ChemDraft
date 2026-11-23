// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatches, moleculeToMolfileV2000, type GraphicObject, type MoleculeObject } from "@chemdraft/chem-core";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { MainWindow } from "./MainWindow";
import { createNativeSingleBondMolecule, createPhase4Document, insertNativeArtGraphicObject, selectDocumentObjects } from "./documentWorkflow";
import { objectWaveCommandId, objectWaveCommands, objectWaveForCommand } from "./commands";
import { PALETTE_COMMAND_CANCEL_EVENT, PALETTE_COMMAND_COMMIT_EVENT, PALETTE_COMMAND_PREVIEW_EVENT, type ToolsetWindowState } from "./window-manager";
import * as windowManager from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { paletteGestureTransport } from "./testSupport/paletteGestureTransport";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pointer(type: string, options: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, ...options });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

describe.each(["macos", "windows"] as const)("registered wave edits (%s)", platform => {
  let root: Root;
  let container: HTMLDivElement;
  let registry: CommandRegistry;
  let invokeSpy: MockInstance<CommandRegistry["invoke"]>;
  let waveIds: string[];
  let moleculeId: string;
  let windowState: (state: ToolsetWindowState) => void;
  let remote: ReturnType<typeof paletteGestureTransport> | undefined;
  let sequence = Math.floor(performance.timeOrigin * 1000);
  const gesture = () => `wave:${++sequence}`;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const objects = () => snapshot().pages[0].objects;
  const waves = () => objects().filter((object): object is GraphicObject => waveIds.includes(object.id) && object.type === "graphic");
  const molecule = () => objects().find(object => object.id === moleculeId) as MoleculeObject;
  const canonical = (object: MoleculeObject) => Molecule.fromMolfile(moleculeToMolfileV2000(object, { kekuleBondOrders: new Map() }).contents).toSmiles();
  const moleculeSvg = () => container.querySelector(`[data-object-id="${moleculeId}"].native-molecule-object`)?.innerHTML;
  async function palette(event: string, commandId = objectWaveCommandId("height", 18), gestureId?: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(event, { detail: { commandId, gestureId } })); });
  }
  async function command(id: string) {
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); });
  }
  beforeEach(async () => {
    vi.spyOn(windowManager, "listenForToolsetWindowStates").mockImplementation(async handler => {
      windowState = handler; return () => undefined;
    });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.history.replaceState(null, "", "/?agentBridge=1");
    let drawing = createPhase4Document("Wave registry integration");
    drawing = insertNativeArtGraphicObject(drawing, { x: 220, y: 180 }, "tool.art.lineWavy");
    drawing = insertNativeArtGraphicObject(drawing, { x: 320, y: 240 }, "tool.art.lineWavy");
    waveIds = drawing.pages[0].objects.map(object => object.id);
    drawing = applyPatches(drawing, [
      { op: "updateObject", objectId: waveIds[0], changes: { x: 220, y: 180, width: 2, height: 1,
        data: { artPathKind: "wavy", lineStart: { x: 220, y: 180 }, lineEnd: { x: 222, y: 180 } } } },
      { op: "updateObject", objectId: waveIds[1], changes: { x: 320, y: 240, width: 12, height: 16,
        data: { artPathKind: "wavy", lineStart: { x: 320, y: 240 }, lineEnd: { x: 332, y: 256 } } } }
    ]);
    drawing = insertNativeArtGraphicObject(drawing, { x: 520, y: 180 }, "tool.art.lineWavy");
    const unselectedWaveId = drawing.selection.objectIds[0];
    drawing = insertNativeArtGraphicObject(drawing, { x: 420, y: 180 }, "tool.art.rect");
    drawing = insertNativeArtGraphicObject(drawing, { x: 420, y: 260 }, "tool.art.line");
    const mol = createNativeSingleBondMolecule(drawing, { x: 100, y: 100 });
    moleculeId = mol.id;
    // V2000 stereo=4 is a source wavy/either single bond. Main has no native wavy
    // single-bond display enum: preserve its source and existing native display exactly.
    const lines = moleculeToMolfileV2000(mol, { kekuleBondOrders: new Map() }).contents.split("\n");
    const bondLine = lines.findIndex(line => line.includes("V2000")) + 1 + mol.atoms.length;
    lines[bondLine] = `${lines[bondLine].slice(0, 9)}  4${lines[bondLine].slice(12)}`;
    mol.structure = lines.join("\n"); mol.structureFormat = "molfile-v2000";
    drawing = applyPatches(drawing, [{ op: "addObject", pageId: drawing.pages[0].id, object: mol }]);
    drawing = selectDocumentObjects(drawing, drawing.pages[0].id, drawing.pages[0].objects.filter(object => object.id !== unselectedWaveId).map(object => object.id));
    const registerSpy = vi.spyOn(CommandRegistry.prototype, "register");
    invokeSpy = vi.spyOn(CommandRegistry.prototype, "invoke");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false}
      nativePalette={false} shortcutPlatform={platform} />));
    registry = registerSpy.mock.contexts.find((candidate): candidate is CommandRegistry =>
      candidate instanceof CommandRegistry && candidate.has(objectWaveCommands[0].id))!;
    expect(registry).toBeDefined();
  });
  afterEach(async () => {
    await remote?.destroy(); remote = undefined;
    await act(async () => root.unmount()); container.remove();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  async function openRemote() {
    remote = paletteGestureTransport(snapshot, platform);
    await remote.open();
    await act(async () => { windowState({ toolsetId: "core.art", open: true, focused: false }); });
    return remote;
  }
  async function documentEscape() {
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  }
  function expectCancelled(before: ReturnType<typeof objects>) {
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    expect(container.querySelector("main")?.getAttribute("data-can-redo")).toBe("false");
    expect(invokeSpy.mock.calls.filter(([id]) => id.startsWith("object.wave."))).toEqual([]);
  }
  async function freshRemoteDrag(before: ReturnType<typeof objects>, whileArmed?: () => Promise<void>) {
    await remote!.pointer("pointerdown", "width");
    await whileArmed?.();
    await remote!.pointer("pointerup", "width");
    await remote!.flush();
    expect(waves().every(object => object.data.waveWidth === 62)).toBe(true);
    await command("edit.undo");
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  }

  it("retires a destroyed toolbar mid-barrier, rejects its late traffic, and accepts a reopened toolbar", async () => {
    const link = await openRemote();
    const before = structuredClone(objects());
    await link.pointer("pointerdown");
    await link.deliver();
    expect(objects()).not.toEqual(before);
    await documentEscape();
    // Neither the request nor subsequent old-sender traffic reaches its destination yet.
    await link.pointer("pointermove");
    await link.pointer("pointerup");
    await link.destroy();
    await act(async () => { windowState({ toolsetId: "core.art", open: false, focused: false }); });
    expect(link.messages.filter(message => message.from === "document")).toHaveLength(1);
    expectCancelled(before);
    await link.open();
    await act(async () => { windowState({ toolsetId: "core.art", open: true, focused: false }); });
    await link.pointer("pointerdown", "width");
    // An old request delivered to the replacement window must not cancel its new drag.
    await link.flush();
    await link.pointer("pointerup", "width");
    await link.flush();
    expect(waves().every(object => object.data.waveWidth === 62 && object.data.waveHeight !== 24)).toBe(true);
    await command("edit.undo");
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it.each(["missing ack", "rejected ack", "rejected request", "missing request"] as const)(
    "resolves a %s as cancelled within the bound and accepts subsequent pointer input", async failure => {
      const link = await openRemote();
      const before = structuredClone(objects());
      const startValue = link.slider().value;
      if (failure === "rejected ack") link.rejectWhen(message => message.commandId.startsWith("palette.wave.cancel-ack:"));
      if (failure === "rejected request") link.rejectWhen(message => message.from === "document");
      await link.pointer("pointerdown");
      // Esc can beat even the first preview, including when its request is lost entirely.
      await documentEscape();
      const request = link.messages.findIndex(message => message.from === "document");
      let delayedRequest: typeof link.messages[number] | undefined;
      if (failure === "missing request") {
        expect(request).toBeGreaterThanOrEqual(0);
        [delayedRequest] = link.messages.splice(request, 1);
      } else if (request >= 0) {
        await link.deliver(request); // The real toolbar handler generates the ack (or send failure).
        expect(link.slider().value).toBe(startValue);
      }
      const ack = link.messages.findIndex(message => message.commandId.startsWith("palette.wave.cancel-ack:"));
      if (failure === "missing ack") {
        expect(ack).toBeGreaterThanOrEqual(0);
        link.messages.splice(ack, 1); // Drop an actual ack; never synthesize one.
      }
      // Retain old pointer messages until after the receiver has recovered.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_000)); });
      await link.pointer("pointerup");
      await link.flush();
      expectCancelled(before);
      link.rejectWhen();
      await freshRemoteDrag(before, async () => {
        if (delayedRequest) {
          link.messages.push(delayedRequest);
          await link.deliver(link.messages.length - 1); // Expired request must not cancel a new drag.
        }
      });
    }
  );

  it("cancels current B when document Esc still knows A across opposite transport directions", async () => {
    const link = await openRemote();
    const before = structuredClone(objects());
    await link.pointer("pointerdown");
    await link.deliver(); // A-preview reaches the document.
    expect(objects()).not.toEqual(before);
    await link.escapeToolbar(); // A-cancel is held in transit.
    const startValue = link.slider("width").value;
    await link.pointer("pointerdown", "width"); // B-preview is also held in transit.
    await documentEscape(); // The document can only name A here.
    const request = link.messages.findIndex(message => message.from === "document");
    expect(request).toBeGreaterThanOrEqual(0);
    await link.deliver(request);
    expect(link.slider("width").value).toBe(startValue);
    await link.pointer("pointerup", "width");
    await link.flush();
    expectCancelled(before);
    await freshRemoteDrag(before);
  });

  it("executes every registered slider value and leaves the mixed selection's molecule and other graphics unchanged", async () => {
    const before = structuredClone(objects().filter(object => !waveIds.includes(object.id)));
    const selection = structuredClone(snapshot().selection);
    const smiles = canonical(molecule());
    const sourceSmiles = Molecule.fromMolfile(molecule().structure).toSmiles();
    expect(smiles).toBe("CC");
    expect(sourceSmiles).toBe("CC");
    expect(molecule().structure.split("\n").some(line => /^  1  2  1  4/.test(line))).toBe(true);
    const svg = moleculeSvg();
    expect(svg).toBeTruthy();
    await act(async () => {
      for (const { id } of objectWaveCommands) {
        expect(registry.has(id), id).toBe(true);
        await registry.invoke(id);
        const parsed = objectWaveForCommand(id)!;
        const key = { smoothness: "waveSmoothness", height: "waveHeight", width: "waveWidth" }[parsed.setting] as "waveSmoothness" | "waveHeight" | "waveWidth";
        for (const object of waves()) expect(object.data[key], id).toBe(parsed.value);
      }
    });
    expect(objects().filter(object => !waveIds.includes(object.id))).toEqual(before);
    expect(snapshot().selection).toEqual(selection);
    expect(canonical(molecule())).toBe(smiles);
    expect(Molecule.fromMolfile(molecule().structure).toSmiles()).toBe(sourceSmiles);
    expect(moleculeSvg()).toBe(svg);
  });

  it("routes an app command through the registry and restores exact states on Undo/Redo", async () => {
    const before = structuredClone(objects());
    const id = objectWaveCommandId("width", 24);
    await command(id);
    expect(invokeSpy).toHaveBeenCalledWith(id);
    expect(waves().every(object => object.data.waveWidth === 24)).toBe(true);
    const after = structuredClone(objects());
    await command("edit.undo");
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    await command("edit.redo");
    expect(objects()).toEqual(after);
  });

  it.each(["smoothness", "height", "width"] as const)("labels a %s keyboard step in undo history", async setting => {
    await command("view.toolset.toggle.core.art");
    const slider = container.querySelector<HTMLInputElement>(`[aria-label="Wave ${setting}"]`)!;
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    const dataKey = ({ smoothness: "waveSmoothness", height: "waveHeight", width: "waveWidth" } as const)[setting];
    const value = waves()[0].data[dataKey];
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`Wave ${setting} set to ${value}${setting === "smoothness" ? "%" : " px"}`);
    await command("edit.undo");
    expect(container.textContent).toContain(`Undid Updated wave ${setting}`);
  });

  it("cancels a detached palette preview when Escape reaches the document window", async () => {
    const before = structuredClone(objects());
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("width", 59));
    expect(waves().every(object => object.data.waveWidth === 59)).toBe(true);
    const canceled = vi.fn();
    window.addEventListener(PALETTE_COMMAND_CANCEL_EVENT, canceled);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    window.removeEventListener(PALETTE_COMMAND_CANCEL_EVENT, canceled);
    expect(canceled).toHaveBeenCalledOnce();
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it("disarms the palette pointer when cancellation arrives from the document window", async () => {
    await command("view.toolset.toggle.core.art");
    const slider = container.querySelector<HTMLInputElement>('[aria-label="Wave width"]')!;
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
      right: 100, bottom: 20, width: 100, height: 20, toJSON: () => ({}) });
    const before = structuredClone(objects());
    await act(async () => { slider.dispatchEvent(pointer("pointerdown", { clientX: 45, buttons: 1 })); });
    await palette(PALETTE_COMMAND_CANCEL_EVENT, "palette.preview.cancel");
    invokeSpy.mockClear();
    await act(async () => { slider.dispatchEvent(pointer("pointerup", { clientX: 45 })); });
    expect(invokeSpy.mock.calls.filter(([id]) => id.startsWith("object.wave."))).toEqual([]);
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it.each(["document", "palette"])("lets an expanded menu own Escape before cancelling a wave drag in the %s", async source => {
    const before = structuredClone(objects());
    await command("view.toolset.toggle.core.art");
    const slider = container.querySelector<HTMLInputElement>('[aria-label="Wave width"]')!;
    if (source === "palette") {
      vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
        right: 100, bottom: 20, width: 100, height: 20, toJSON: () => ({}) });
      await act(async () => { slider.dispatchEvent(pointer("pointerdown", { clientX: 45, buttons: 1 })); });
    } else {
      await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("width", 59));
    }
    const preview = structuredClone(objects());
    expect(preview).not.toEqual(before);
    const menu = container.querySelector<HTMLButtonElement>('[data-menu-section="file"]')!;
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    const canceled = vi.fn();
    window.addEventListener(PALETTE_COMMAND_CANCEL_EVENT, canceled);
    try {
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
      expect(menu.getAttribute("aria-expanded")).toBe("false");
      expect(objects()).toEqual(preview);
      expect(canceled).not.toHaveBeenCalled();
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
      expect(objects()).toEqual(before);
      invokeSpy.mockClear();
      await act(async () => { slider.dispatchEvent(pointer("pointerup", { clientX: 45 })); });
      expect(invokeSpy.mock.calls.filter(([id]) => id.startsWith("object.wave."))).toEqual([]);
      expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    } finally {
      window.removeEventListener(PALETTE_COMMAND_CANCEL_EVENT, canceled);
    }
  });

  it.each(["document", "palette"])("lets a modal own Escape before cancelling a wave drag in the %s", async source => {
    const before = structuredClone(objects());
    if (source === "palette") {
      await command("view.toolset.toggle.core.art");
      const slider = container.querySelector<HTMLInputElement>('[aria-label="Wave width"]')!;
      vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
        right: 100, bottom: 20, width: 100, height: 20, toJSON: () => ({}) });
      await act(async () => { slider.dispatchEvent(pointer("pointerdown", { clientX: 45, buttons: 1 })); });
    } else {
      await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("width", 59));
    }
    const preview = structuredClone(objects());
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    container.append(modal);
    const close = vi.fn((event: KeyboardEvent) => { event.preventDefault(); modal.hidden = true; });
    modal.addEventListener("keydown", close);
    await act(async () => { modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(close).toHaveBeenCalledOnce();
    expect(modal.hidden).toBe(true);
    expect(objects()).toEqual(preview);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it.each(["smoothness", "height", "width"] as const)("rejects a %s release before the detached toolbar receives Escape cancellation", async setting => {
    const before = structuredClone(objects());
    const gestureId = gesture();
    const id = objectWaveCommandId(setting, 24);
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, id, gestureId);
    expect(objects()).not.toEqual(before);
    // Only the document receives Esc. Hold the outgoing notification so the detached toolbar
    // still believes it owns the pointer and sends its final preview and release commit.
    const notifyToolbar = vi.spyOn(windowManager, "sendPaletteCommandCancel").mockResolvedValue(undefined);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(objects()).toEqual(before);
    invokeSpy.mockClear();
    await palette(PALETTE_COMMAND_COMMIT_EVENT, id, gestureId);
    expect(objects()).toEqual(before);
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId(setting, 30), gestureId);
    expect(objects()).toEqual(before);
    expect(notifyToolbar).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^palette\.wave\.cancel-request:/), gestureId);
    expect(invokeSpy.mock.calls.filter(([commandId]) => commandId.startsWith("object.wave."))).toEqual([]);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    expect(container.querySelector("main")?.getAttribute("data-can-redo")).toBe("false");

    // A new drag still commits, even if the old cancel notification arrives while it previews.
    const request = notifyToolbar.mock.calls[0][0];
    await palette(PALETTE_COMMAND_CANCEL_EVENT, request.replace("cancel-request:", "cancel-ack:"), gestureId);
    const nextGestureId = gesture();
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, id, nextGestureId);
    const nextPreview = structuredClone(objects());
    await palette(PALETTE_COMMAND_CANCEL_EVENT, "palette.preview.cancel", gestureId);
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("width", 30), gestureId);
    await palette(PALETTE_COMMAND_COMMIT_EVENT, objectWaveCommandId("width", 30), gestureId);
    expect(objects()).toEqual(nextPreview);
    await palette(PALETTE_COMMAND_COMMIT_EVENT, id, nextGestureId);
    expect(invokeSpy.mock.calls.filter(([commandId]) => commandId === id)).toHaveLength(1);
    await command("edit.undo");
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it("rejects queued previews and releases after a toolbar cancellation reaches the document first", async () => {
    const before = structuredClone(objects());
    const gestureId = gesture();
    const id = objectWaveCommandId("height", 24);
    // Cancellation can beat even the first queued preview from the other window.
    await palette(PALETTE_COMMAND_CANCEL_EVENT, "palette.preview.cancel", gestureId);
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, id, gestureId);
    expect(objects()).toEqual(before);
    await palette(PALETTE_COMMAND_COMMIT_EVENT, id, gestureId);
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    // Keyboard steps have no drag ID and retain their normal command/history behavior.
    await command(id);
    await command("edit.undo");
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it("cancels a pending drag when Escape beats its first preview and release", async () => {
    await command("view.toolset.toggle.core.art");
    const before = structuredClone(objects());
    const id = gesture();
    const notify = vi.spyOn(windowManager, "sendPaletteCommandCancel").mockResolvedValue(undefined);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("height", 24), id);
    await palette(PALETTE_COMMAND_COMMIT_EVENT, objectWaveCommandId("height", 24), id);
    expect(objects()).toEqual(before);
    expect(notify).toHaveBeenCalledOnce();
    const request = notify.mock.calls[0][0];
    await palette(PALETTE_COMMAND_CANCEL_EVENT, request.replace("cancel-request:", "cancel-ack:"), id);
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("height", 30), id);
    await palette(PALETTE_COMMAND_COMMIT_EVENT, objectWaveCommandId("height", 30), id);
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    const next = gesture();
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("width", 24), next);
    await palette(PALETTE_COMMAND_COMMIT_EVENT, objectWaveCommandId("width", 24), next);
    expect(waves().every(object => object.data.waveWidth === 24)).toBe(true);
    await command("edit.undo");
    expect(objects()).toEqual(before);
  });

  it("restores cancelled Height A when Width B arrives before A's cancel", async () => {
    const before = structuredClone(objects());
    const a = gesture(), b = gesture();
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("height", 24), a);
    // The toolbar has cancelled A locally, but transport delivery of that cancel is delayed.
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("width", 30), b);
    expect(waves().every(object => object.data.waveHeight !== 24)).toBe(true);
    await palette(PALETTE_COMMAND_COMMIT_EVENT, objectWaveCommandId("width", 30), b);
    const after = structuredClone(objects());
    await palette(PALETTE_COMMAND_CANCEL_EVENT, "palette.preview.cancel", a);
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("height", 35), a);
    await palette(PALETTE_COMMAND_COMMIT_EVENT, objectWaveCommandId("height", 35), a);
    expect(objects()).toEqual(after);
    await command("edit.undo");
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it("keeps a fresh drag whose messages beat the cancellation acknowledgement", async () => {
    const before = structuredClone(objects());
    const a = gesture(), b = gesture();
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("height", 24), a);
    const notify = vi.spyOn(windowManager, "sendPaletteCommandCancel").mockResolvedValue(undefined);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    // The toolbar handled Esc, then started B; its acknowledgement has not reached the document.
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("width", 30), b);
    await palette(PALETTE_COMMAND_COMMIT_EVENT, objectWaveCommandId("width", 30), b);
    expect(objects()).toEqual(before);
    const request = notify.mock.calls[0][0];
    await palette(PALETTE_COMMAND_CANCEL_EVENT, request.replace("cancel-request:", "cancel-ack:"), a);
    expect(waves().every(object => object.data.waveWidth === 30 && object.data.waveHeight !== 24)).toBe(true);
    await palette(PALETTE_COMMAND_CANCEL_EVENT, "palette.preview.cancel", a);
    await command("edit.undo");
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it("refuses a delayed preview or duplicate release after a committed gesture", async () => {
    const before = structuredClone(objects());
    const id = gesture();
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("height", 24), id);
    await palette(PALETTE_COMMAND_COMMIT_EVENT, objectWaveCommandId("height", 24), id);
    const committed = structuredClone(objects());
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("height", 35), id);
    await palette(PALETTE_COMMAND_COMMIT_EVENT, objectWaveCommandId("height", 35), id);
    expect(objects()).toEqual(committed);
    await command("edit.undo");
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it("cancels on native toolbar hide before its input acquires focus", async () => {
    await command("view.toolset.toggle.core.art");
    const slider = container.querySelector<HTMLInputElement>('[aria-label="Wave height"]')!;
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
      right: 100, bottom: 20, width: 100, height: 20, toJSON: () => ({}) });
    const before = structuredClone(objects());
    await act(async () => { slider.dispatchEvent(pointer("pointerdown", { clientX: 55, buttons: 1 })); });
    expect(document.activeElement).not.toBe(slider);
    expect(objects()).not.toEqual(before);
    await act(async () => { windowState({ toolsetId: "core.art", open: false, focused: false }); });
    expect(objects()).toEqual(before);
    await act(async () => { slider.dispatchEvent(pointer("pointerup", { clientX: 55 })); });
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it("excludes per-value wave tiles from the mounted Customize gallery", async () => {
    await command("view.customizeMainToolbar");
    const gallery = container.querySelector('[aria-label="Toolbar item gallery"]');
    expect(gallery).not.toBeNull();
    const waveTitles = new Set(objectWaveCommands.map(command => command.title));
    const waveTiles = [...gallery!.querySelectorAll("button")].filter(button =>
      waveTitles.has(button.getAttribute("aria-label") ?? ""));
    expect(waveTiles).toHaveLength(0);
  });

  it.each(["release", "Escape", "pointercancel", "blur"])("handles a real slider drag ending in %s", async ending => {
    await command("view.toolset.toggle.core.art");
    const slider = container.querySelector<HTMLInputElement>('[aria-label="Wave height"]')!;
    expect(slider).not.toBeNull();
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ x: 10, y: 4, left: 10, top: 4,
      right: 110, bottom: 22, width: 100, height: 18, toJSON: () => ({}) });
    const before = structuredClone(objects());
    invokeSpy.mockClear();
    await act(async () => {
      slider.focus();
      slider.dispatchEvent(pointer("pointerdown", { clientX: 35, buttons: 1 }));
      slider.dispatchEvent(pointer("pointermove", { clientX: 60, buttons: 1 }));
    });
    expect(waves().every(object => object.data.waveHeight === 24)).toBe(true);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    await act(async () => {
      if (ending === "Escape") slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (ending === "pointercancel") slider.dispatchEvent(pointer("pointercancel"));
      if (ending === "blur") slider.blur();
      slider.dispatchEvent(pointer("pointerup", { clientX: 60 }));
    });
    const invocations = invokeSpy.mock.calls.filter(([id]) => id.startsWith("object.wave."));
    if (ending === "release") {
      expect(invocations).toEqual([[objectWaveCommandId("height", 24)]]);
      const after = structuredClone(objects());
      await command("edit.undo");
      expect(objects()).toEqual(before);
      expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
      await command("edit.redo");
      expect(objects()).toEqual(after);
    } else {
      expect(invocations).toEqual([]);
      expect(objects()).toEqual(before);
      expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    }
  });

  it("commits successive palette previews once through the registry, then undoes/redoes exactly", async () => {
    const before = structuredClone(objects());
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("height", 12));
    await palette(PALETTE_COMMAND_PREVIEW_EVENT, objectWaveCommandId("height", 18));
    expect(waves().every(object => object.data.waveHeight === 18)).toBe(true);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    invokeSpy.mockClear();
    await palette(PALETTE_COMMAND_COMMIT_EVENT);
    expect(invokeSpy.mock.calls.filter(([id]) => id === objectWaveCommandId("height", 18))).toHaveLength(1);
    const after = structuredClone(objects());
    await command("edit.undo");
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    await command("edit.redo");
    expect(objects()).toEqual(after);
  });

  it("cancels palette previews without metadata, chemistry, display or history changes", async () => {
    const before = structuredClone(objects());
    await palette(PALETTE_COMMAND_PREVIEW_EVENT);
    expect(waves().every(object => object.data.waveHeight === 18)).toBe(true);
    await palette(PALETTE_COMMAND_CANCEL_EVENT);
    expect(objects()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });
});
