// @vitest-environment jsdom
import { act } from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, DocumentStylePreset, type ChemDraftDocument } from "@chemdraft/chem-core";
import * as workflow from "@chemdraft/document-workflow-core";
import * as ocl from "@chemdraft/ocl-adapter";
import * as rdkit from "@chemdraft/rdkit-adapter";
import * as depictionClient from "./depiction2d/client";
import * as clipboard from "./clipboard";
import { resolveStructureTemplateName } from "@chemdraft/document-workflow-core";
// Configure the same adapter instance used by template lookup, including with shared node_modules.
import { setRdkitModuleLoader } from "@chemdraft/rdkit-adapter";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { MainWindow } from "./MainWindow";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";
import { CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, createSelectionClipboardPayload, documentObjectVisualBounds,
  insertSmilesMolecule, serializeSelectionClipboardPayload, setDocumentCustomPageSize } from "./documentWorkflow";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./plugins/rdkitAppLoader", () => ({ loadRdkitWithAppLoader: (load: () => Promise<unknown>) => load() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("@chemdraft/document-workflow-core", async original => ({ ...await original<typeof import("@chemdraft/document-workflow-core")>() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
let root: Root;
let container: HTMLDivElement;
let restorePrompt: (() => void) | undefined;
vi.setConfig({ testTimeout: 60_000 });
describe("template SMILES paste", () => {
  // Exact 242-character Windows runbook input, retained here without an external-file dependency.
  const noStereoBetaCd = "C([CH]1[CH]2[CH]([CH]([CH](O1)O[CH]3[CH](O[CH]([CH]([CH]3O)O)O[CH]4[CH](O[CH]([CH]([CH]4O)O)O[CH]5[CH](O[CH]([CH]([CH]5O)O)O[CH]6[CH](O[CH]([CH]([CH]6O)O)O[CH]7[CH](O[CH]([CH]([CH]7O)O)O[CH]8[CH](O[CH](O2)[CH]([CH]8O)O)CO)CO)CO)CO)CO)CO)O)O)O";
  beforeEach(() => {
    const glue = resolve("packages/rdkit-adapter/vendor/RDKit_minimal.js");
    const factory = new Function("require", "__dirname", `${readFileSync(glue, "utf8")}\n;return initRDKitModule;`)(createRequire(glue), resolve("packages/rdkit-adapter/vendor"));
    setRdkitModuleLoader(() => factory({ wasmBinary: new Uint8Array(readFileSync(resolve("packages/rdkit-adapter/vendor/RDKit_minimal.wasm"))) }));
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); restorePrompt?.(); restorePrompt = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function mount(drawing: ChemDraftDocument, platform?: "macos" | "windows") {
    await act(async () => root.render(<MainWindow initialDocument={drawing} shortcutPlatform={platform} initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    return { port: getAssistantHistoryPort() };
  }
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  describe.each(["macos", "windows"] as const)("repeat paste (%s clipboard)", platform => {
    it.each(["text", "SMILES", "SMILES list", "native selection"])("offers page fit for an oversized first %s paste and inserts only after accepting", async kind => {
      const drawing = setDocumentCustomPageSize(createEmptyDocument(), { width: 20, height: 20, unit: "css-px" });
      const { port } = await mount(drawing, platform);
      let answer!: (choice: string) => void;
      const prompt = vi.fn((_options: NativePromptOptions) => new Promise<string>(resolve => { answer = resolve; }));
      restorePrompt = setNativePromptProvider(prompt);
      vi.spyOn(depictionClient, "depictSmilesOffThread").mockImplementation(async smiles => ({
        depiction: ocl.depictSmiles2D(smiles), stereoCount: 0
      }));
      const source = insertSmilesMolecule(createEmptyDocument(), { x: 300, y: 300 }, ocl.depictSmiles2D("CCO"), "CCO");
      const type = kind === "native selection" ? CHEMDRAFT_SELECTION_CLIPBOARD_TYPE
        : platform === "macos" ? "public.utf8-plain-text" : "text/plain";
      const text = kind === "native selection" ? serializeSelectionClipboardPayload(createSelectionClipboardPayload(source)!)
        : kind === "text" ? "Ordinary caption" : kind === "SMILES" ? "CCO" : "CCO\nCCN";
      vi.spyOn(clipboard, "readClipboardPayload").mockResolvedValueOnce({ types: [type], textItems: [{ type, text }] });
      const before = port.read("initial")!;
      await command("clipboard.paste");
      await act(async () => { await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce(), { timeout: 5_000 }); });
      expect(prompt.mock.calls[0]![0]).toMatchObject({ owner: "document",
        message: "This doesn't fit on the page. Enlarge the page to fit? Content on the page may shift to make room.",
        choices: [{ id: "enlarge" }, { id: "keep" }] });
      expect(port.read("initial")).toEqual(before);
      await act(async () => { answer("enlarge"); });
      const after = port.read("initial")!;
      const objects = after.pages[0]!.objects;
      expect(objects).toHaveLength(kind === "SMILES list" ? 2 : 1);
      expect(after.selection.objectIds).toEqual(objects.map(object => object.id));
      expect(after.pages[0]!.width > 20 || after.pages[0]!.height > 20).toBe(true);
      for (const object of objects) {
        const bounds = documentObjectVisualBounds(object, objects);
        expect(bounds.x).toBeGreaterThanOrEqual(-1e-6);
        expect(bounds.y).toBeGreaterThanOrEqual(-1e-6);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(after.pages[0]!.width + 1e-6);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(after.pages[0]!.height + 1e-6);
      }
      await command("edit.undo");
      expect(port.read("initial")).toEqual(before);
      await command("edit.redo");
      expect(port.read("initial")).toEqual(after);
      expect(prompt).toHaveBeenCalledOnce();
    });
    const strings = ["[2H]C", "[3H]C", "C[13CH3]", "[18OH2]", "[15NH3]"];
    async function setup(edge: false | true | "bottom-right" = false) {
      const { port } = await mount(createEmptyDocument(), platform);
      if (edge) for (let i = 0; i < 5; i++) await command("view.zoomIn");
      const scale = edge ? 1.25 ** 5 : 1;
      const page = port.read("initial")!.pages[0]!;
      // jsdom has no layout. Model a scrolled viewport whose visible centre is x=5
      // on the page, and use the real zoom commands for its page-to-client scale.
      const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
      Object.defineProperties(canvas, { clientWidth: { value: 600 }, clientHeight: { value: 600 } });
      vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600 } as DOMRect);
      vi.spyOn(container.querySelector(".page")!, "getBoundingClientRect").mockReturnValue({
        left: edge ? 300 - (edge === "bottom-right" ? page.width - 5 : 5) * scale : 0,
        top: edge ? 300 - (edge === "bottom-right" ? page.height - 5 : 300) * scale : 0
      } as DOMRect);
      const read = vi.spyOn(clipboard, "readClipboardPayload");
      async function paste(text: string, type = platform === "macos" ? "public.utf8-plain-text" : "text/plain") {
        const count = port.read("initial")!.pages[0]!.objects.length;
        read.mockResolvedValueOnce({ types: [type], textItems: [{ type, text }] });
        await command("clipboard.paste");
        await act(async () => {
          await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects,
            container.querySelector("[role=status]")?.textContent ?? "missing status").toHaveLength(count + 1), { timeout: 5_000 });
        });
        const after = port.read("initial")!;
        const object = after.pages[0]!.objects.at(-1)!;
        expect(after.selection.objectIds).toEqual([object.id]);
        const bounds = documentObjectVisualBounds(object, after.pages[0]!.objects);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(after.pages[0]!.width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(after.pages[0]!.height);
        expect(container.textContent).not.toContain("Enlarge page");
        return { object, centre: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } };
      }
      return { port, paste };
    }
    async function pointer(type: string, x: number, y: number) {
      const page = container.querySelector<HTMLElement>(".page")!;
      page.setPointerCapture = () => {};
      page.releasePointerCapture = () => {};
      page.hasPointerCapture = () => false;
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons: type === "pointerdown" ? 1 : 0, clientX: x, clientY: y });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      await act(async () => page.dispatchEvent(event));
    }
    async function drawAndSelect() {
      await command("tool.bond");
      await pointer("pointerdown", 300, 300);
      await pointer("pointermove", 340, 300);
      await pointer("pointerup", 340, 300);
      await command("tool.select");
      await command("edit.selectAll");
    }
    async function copy(mode = "copy") {
      const write = vi.spyOn(clipboard, "writeClipboardItems").mockImplementation(async items => ({
        ok: true, written: items.map(item => item.type), failed: [], warnings: []
      }));
      await command(`clipboard.${mode}`);
      expect(write).toHaveBeenCalledOnce();
      const copied = write.mock.calls[0]![0].find(item => item.type === CHEMDRAFT_SELECTION_CLIPBOARD_TYPE)!;
      if (!("text" in copied)) throw new Error("Expected native selection text");
      return copied;
    }
    it("offsets the first in-place canvas copy by one step, then keeps stepping with one undo per paste", async () => {
      const { port, paste } = await setup();
      await drawAndSelect();
      const before = port.read("initial")!;
      const original = before.pages[0]!.objects[0]!;
      expect(before.pages[0]!.objects).toHaveLength(1);
      if (original.type !== "molecule") throw new Error("Expected drawn molecule");
      const bounds = documentObjectVisualBounds(original);
      await pointer("pointermove", bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      const copied = await copy();
      const first = await paste(copied.text, copied.type);
      const second = await paste(copied.text, copied.type);
      for (const [index, pasted] of [first.object, second.object].entries()) {
        if (pasted.type !== "molecule") throw new Error("Expected pasted molecule");
        const step = (index + 1) * 24;
        expect(pasted.x - original.x).toBeCloseTo(step, 6);
        expect(pasted.y - original.y).toBeCloseTo(step, 6);
        expect(pasted.structure).toBe(original.structure);
        expect(pasted.bonds).toEqual(original.bonds);
        expect(pasted.atoms).toEqual(original.atoms.map(atom => ({ ...atom, x: atom.x + step, y: atom.y + step })));
      }
      await command("edit.undo");
      expect(port.read("initial")!.pages[0]!.objects).toEqual([original, first.object]);
      await command("edit.undo");
      expect(port.read("initial")).toEqual(before);
      await command("edit.redo");
      expect(port.read("initial")!.pages[0]!.objects).toEqual([original, first.object]);
    });
    it.each(["move source", "cut source", "new pointer"])("keeps invocation-point placement after %s", async change => {
      const { port, paste } = await setup();
      await drawAndSelect();
      const bounds = createSelectionClipboardPayload(port.read("initial")!)!.bounds;
      let point = { x: bounds.centerX, y: bounds.centerY };
      await pointer("pointermove", point.x, point.y);
      const copied = await copy(change === "cut source" ? "cut" : "copy");
      if (change === "move source") await command("selection.nudge.right.large");
      if (change === "new pointer") {
        point = { x: 180, y: 240 };
        await pointer("pointermove", point.x, point.y);
      }
      const first = await paste(copied.text, copied.type);
      expect(first.centre.x).toBeCloseTo(point.x, 6);
      expect(first.centre.y).toBeCloseTo(point.y, 6);
    });
    it("keeps the first unmatched SMILES text paste at its invocation point", async () => {
      const { paste } = await setup();
      await drawAndSelect();
      await pointer("pointermove", 180, 240);
      vi.spyOn(depictionClient, "depictSmilesOffThread").mockImplementation(async smiles => ({
        depiction: ocl.depictSmiles2D(smiles), stereoCount: 0
      }));
      const first = await paste("CCO");
      expect(first.centre.x).toBeCloseTo(180, 6);
      expect(first.centre.y).toBeCloseTo(240, 6);
    });
    it.each([false, true])("keeps the invocation anchor and repeat count when the pointer moves during slow depiction (list=%s)", async list => {
      const { port, paste } = await setup();
      const movePointer = async (x: number, y: number) => {
        const event = new MouseEvent("pointermove", {
          bubbles: true, clientX: x, clientY: y
        });
        Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
        await act(async () => container.querySelector(".page")!.dispatchEvent(event));
      };
      await movePointer(180, 240);
      let finish!: (result: Awaited<ReturnType<typeof depictionClient.depictSmilesOffThread>>) => void;
      const slow = vi.spyOn(depictionClient, "depictSmilesOffThread")
        .mockImplementation(async smiles => ({ depiction: ocl.depictSmiles2D(smiles), stereoCount: 0 }))
        .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      const type = platform === "macos" ? "public.utf8-plain-text" : "text/plain";
      vi.mocked(clipboard.readClipboardPayload).mockResolvedValueOnce({ types: [type],
        textItems: [{ type, text: list ? "CCO\nCCN" : "CCO" }] });
      await command("clipboard.paste");
      await act(async () => { await vi.waitFor(() => expect(slow).toHaveBeenCalled()); });
      await movePointer(420, 460);
      expect(port.read("initial")!.pages[0]!.objects).toHaveLength(0);
      await act(async () => {
        finish({ depiction: ocl.depictSmiles2D("CCO"), stereoCount: 0 });
        await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects,
          container.querySelector("[role=status]")?.textContent ?? "missing status").toHaveLength(list ? 2 : 1), { timeout: 5_000 });
      });
      expect(port.read("initial")!.pages[0]!.objects.every(object => object.type === "molecule")).toBe(true);
      const payload = createSelectionClipboardPayload(port.read("initial")!)!;
      expect(payload.bounds.centerX).toBeCloseTo(180, 6);
      expect(payload.bounds.centerY).toBeCloseTo(240, 6);
      // Returning to the invocation point must continue the first paste's counter.
      await movePointer(180, 240);
      const next = await paste("CCO");
      expect(next.centre.x).toBeCloseTo(204, 6);
      expect(next.centre.y).toBeCloseTo(264, 6);
    });
    it("offsets the same asynchronous SMILES pasted twice through clipboard.paste", async () => {
      const { paste, port } = await setup();
      const first = await paste(strings[0]!);
      const second = await paste(strings[0]!);
      expect(second.centre.x - first.centre.x).toBeCloseTo(24, 6);
      expect(second.centre.y - first.centre.y).toBeCloseTo(24, 6);
      if (first.object.type !== "molecule" || second.object.type !== "molecule") throw new Error("Expected molecules");
      expect(second.object.structure).toBe(first.object.structure);
      expect(second.object.bonds).toEqual(first.object.bonds);
      expect(second.object.atoms).toEqual(first.object.atoms.map(atom => ({ ...atom, x: atom.x + 24, y: atom.y + 24 })));
      await command("edit.undo");
      expect(port.read("initial")!.pages[0]!.objects).toEqual([first.object]);
      await command("edit.redo");
      expect(port.read("initial")!.pages[0]!.objects).toEqual([first.object, second.object]);
    });
    it.each([false, true])("offsets five different SMILES, fully on page (zoomed/scrolled edge=%s)", async edge => {
      const { paste } = await setup(edge);
      let previous: { x: number; y: number } | undefined;
      for (const smiles of strings) {
        const { object, centre } = await paste(smiles);
        expect(object).toMatchObject({ type: "molecule", compatibility: { unknown: { smiles } } });
        if (previous) {
          expect(centre.x - previous.x).toBeCloseTo(24, 6);
          expect(centre.y - previous.y).toBeCloseTo(24, 6);
        }
        previous = centre;
      }
    });
    it("continues the offset from a native selection to SMILES", async () => {
      const { paste } = await setup();
      const source = insertSmilesMolecule(createEmptyDocument(), { x: 300, y: 300 }, ocl.depictSmiles2D("CC"), "CC");
      const native = await paste(serializeSelectionClipboardPayload(createSelectionClipboardPayload(source)!), CHEMDRAFT_SELECTION_CLIPBOARD_TYPE);
      const smiles = await paste(strings[0]!);
      expect(smiles.centre.x - native.centre.x).toBeCloseTo(24, 6);
      expect(smiles.centre.y - native.centre.y).toBeCloseTo(24, 6);
    });
    it("continues across SMILES, editable text, MOL and different native selections", async () => {
      const { paste } = await setup();
      let previous = await paste(strings[0]!);
      const source = insertSmilesMolecule(createEmptyDocument(), { x: 100, y: 100 }, ocl.depictSmiles2D("CCO"), "CCO");
      const molecule = source.pages[0]!.objects[0]!;
      if (molecule.type !== "molecule") throw new Error("Expected molecule");
      for (const [text, type] of [
        ["Hello", "text/plain"], [molecule.structure, "chemical/x-mdl-molfile"],
        [serializeSelectionClipboardPayload(createSelectionClipboardPayload(source)!), CHEMDRAFT_SELECTION_CLIPBOARD_TYPE],
        [serializeSelectionClipboardPayload(createSelectionClipboardPayload(insertSmilesMolecule(
          createEmptyDocument(), { x: 500, y: 500 }, ocl.depictSmiles2D("CCN"), "CCN"))!), CHEMDRAFT_SELECTION_CLIPBOARD_TYPE]
      ]) {
        const next = await paste(text!, type!);
        expect(next.centre.x - previous.centre.x).toBeCloseTo(24, 6);
        expect(next.centre.y - previous.centre.y).toBeCloseTo(24, 6);
        previous = next;
      }
    });
    it("keeps five edge pastes on page without bouncing back onto an earlier paste", async () => {
      const { paste } = await setup("bottom-right");
      const centres: { x: number; y: number }[] = [];
      for (const smiles of strings) {
        const next = await paste(smiles);
        expect(centres.some(point => Math.hypot(point.x - next.centre.x, point.y - next.centre.y) < 1)).toBe(false);
        centres.push(next.centre);
      }
    });
    it.each(["selection.nudge.right.large", "edit.undo", "selection.delete"])("resets after %s of the last pasted structure", async reset => {
      const { paste, port } = await setup();
      const first = await paste(strings[0]!);
      const second = await paste(strings[0]!);
      if (reset === "selection.delete") {
        await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
      } else await command(reset);
      const afterReset = port.read("initial")!.pages[0]!.objects;
      if (reset === "selection.nudge.right.large") {
        expect(afterReset.at(-1)!.x).toBeCloseTo(second.object.x + 10, 6);
      } else expect(afterReset).toEqual([first.object]);
      const next = await paste(strings[0]!);
      expect(next.centre.x).toBeCloseTo(first.centre.x, 6);
      expect(next.centre.y).toBeCloseTo(first.centre.y, 6);
    });
    it("resets an explicit context-menu paste even when the pointer stays at the same point", async () => {
      const { paste, port } = await setup();
      await paste(strings[0]!);
      await paste(strings[0]!);
      const read = vi.mocked(clipboard.readClipboardPayload);
      const placed: { x: number; y: number }[] = [];
      for (let index = 0; index < 2; index++) {
        read.mockResolvedValueOnce({ types: ["text/plain"], textItems: [{ type: "text/plain", text: strings[0]! }] });
        await act(async () => container.querySelector(".page")!.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, button: 2, clientX: 180, clientY: 240
        })));
        const button = container.querySelector<HTMLButtonElement>('[data-context-target-kind="page"] [data-command-id="clipboard.paste"]')!;
        expect(button).not.toBeNull();
        await act(async () => {
          button.click();
          await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects).toHaveLength(3 + index));
        });
        const object = port.read("initial")!.pages[0]!.objects.at(-1)!;
        const bounds = documentObjectVisualBounds(object);
        placed.push({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
      }
      expect(placed[0]!.x).toBeCloseTo(180, 6);
      expect(placed[0]!.y).toBeCloseTo(240, 6);
      expect(placed[1]).toEqual(placed[0]);
    });
  });
  it.each([
    ["THF", "text/plain"], ["Hello", "text/plain"],
    ["THF", "chemical/x-daylight-smiles"], ["Hello", "chemical/x-daylight-smiles"]
  ])("pastes %s from %s as editable text without reporting an expected parse rejection", async (text, sourceType) => {
    const { port } = await mount(createEmptyDocument());
    vi.spyOn(depictionClient, "depictSmilesOffThread").mockRejectedValueOnce(
      Object.assign(new Error("SmilesParser: invalid input"), { notSmiles: true })
    );
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: [sourceType],
      getData: (type: string) => type === sourceType ? text : "" } });
    await act(async () => {
      window.dispatchEvent(event);
      // Paste now includes identity verification.
      await vi.waitFor(() => {
        expect(port.read("initial")!.pages[0]!.objects).toMatchObject([{ type: "text", text }]);
      }, { timeout: 5_000 });
    });
    expect(container.querySelector("[role=status]")?.textContent).toBe("Pasted editable text");
  });
  it("continues a three-item list after an empty depiction and reports its reason", async () => {
    const { port } = await mount(createEmptyDocument());
    const text = "CCO\nCCN\nCCC";
    const depiction = vi.spyOn(depictionClient, "depictSmilesOffThread")
      .mockResolvedValueOnce({ depiction: ocl.depictSmiles2D("CCO"), stereoCount: 0 })
      .mockResolvedValueOnce({ depiction: { atoms: [], bonds: [] }, stereoCount: 0 })
      .mockResolvedValueOnce({ depiction: ocl.depictSmiles2D("CCC"), stereoCount: 0 });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? text : "" } });
    await act(async () => {
      window.dispatchEvent(event);
      await vi.waitFor(() => {
        expect(port.read("initial")!.pages[0]!.objects).toMatchObject([
          { type: "molecule", compatibility: { unknown: { smiles: "CCO" } } },
          { type: "molecule", compatibility: { unknown: { smiles: "CCC" } } }
        ]);
      }, { timeout: 5_000 });
    });
    // Keep the reported reason tied to the failed input in the standard input: reason format.
    expect(container.querySelector("[role=status]")?.textContent)
      .toContain("1 item failed: CCN: The 2D depiction engine returned no atoms.");
    expect(depiction.mock.calls.map(([smiles]) => smiles)).toEqual(["CCO", "CCN", "CCC"]);
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.undo" } })); });
    expect(port.read("initial")!.pages[0]!.objects).toHaveLength(0);
  });
  it("draws the Windows stereo-free beta-CD input using ordinary depiction", async () => {
    expect(noStereoBetaCd).toHaveLength(242);
    const { port } = await mount(createEmptyDocument());
    Object.defineProperties(container.querySelector(".canvas-region")!, {
      clientWidth: { value: 600 }, clientHeight: { value: 600 }
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? noStereoBetaCd : "" } });
    await act(async () => {
      window.dispatchEvent(event);
      await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects).toHaveLength(1), { timeout: 30_000 });
    });
    const object = port.read("initial")!.pages[0]!.objects[0]!;
    expect(object.type).toBe("molecule");
    expect(object.style.source).not.toMatch(/^structure-template:/);
    if (object.type !== "molecule") throw new Error("Expected ordinary molecule");
    expect(object.atoms).toHaveLength(77);
    expect(object.bonds.filter(bond => bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed")).toHaveLength(0);
    const centers = ocl.perceiveStereoCentersFromMolfile(object.structure).filter(center => center.isStereoCenter);
    expect(centers).toHaveLength(35);
    expect(centers.every(center => center.descriptor === "unspecified")).toBe(true);
    expect(container.querySelector("[role=status]")?.textContent).toContain("Pasted SMILES structure — 77 atoms, 35 unspecified stereocenters");
    expect(container.querySelector("[role=status]")?.textContent).not.toContain("template layout");
  }, 60_000);
  it.each([
    ["C[C@H](F)[C@H](O)[C@H](Cl)Br", "8 atoms, 3 stereocenters"],
    ["CC(F)[C@H](O)C(Cl)Br", "8 atoms, 3 stereocenters (2 unspecified)"],
    ["C[C@H](F)Cl", "4 atoms, 1 stereocenter"]
  ])("reports specified and unspecified stereo honestly for %s", async (smiles, expected) => {
    const { port } = await mount(createEmptyDocument());
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? smiles : "" } });
    await act(async () => {
      window.dispatchEvent(event);
      await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects).toHaveLength(1), { timeout: 5_000 });
    });
    expect(container.querySelector("[role=status]")?.textContent).toContain(`Pasted SMILES structure — ${expected}`);
  });
  it("names a bad list line in the displayed grid status", async () => {
    const { port } = await mount(createEmptyDocument());
    const text = "CCO\nC1CC(\nCCN";
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? text : "" } });
    await act(async () => {
      window.dispatchEvent(event);
      await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects).toHaveLength(2), { timeout: 5_000 });
    });
    expect(container.querySelector("[role=status]")?.textContent)
      .toContain("grid; skipped line 2: 'C1CC(' (not valid SMILES)");
  });
  it.each(["2D depiction exceeded its 2000 ms layout deadline before a standard layout was available.",
    "The 2D depiction worker failed to load."])("shows a specific failure for the Windows input: %s", async reason => {
    const { port } = await mount(createEmptyDocument());
    vi.spyOn(depictionClient, "depictSmilesOffThread").mockRejectedValueOnce(new Error(reason));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? noStereoBetaCd : "" } });
    await act(async () => { window.dispatchEvent(event); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.querySelector("[role=status]")?.textContent)
        .toContain(`Clipboard SMILES could not be placed: ${reason}`);
    }, { timeout: 10_000 });
    expect(port.read("initial")!.pages[0]!.objects).toHaveLength(0);
  });
  it("reports an empty depiction instead of silently dropping a SMILES paste", async () => {
    await mount(createEmptyDocument());
    vi.spyOn(depictionClient, "depictSmilesOffThread").mockResolvedValueOnce({
      depiction: { atoms: [], bonds: [] }, stereoCount: 0
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? noStereoBetaCd : "" } });
    await act(async () => { window.dispatchEvent(event); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.querySelector("[role=status]")?.textContent)
        .toContain("Clipboard SMILES could not be placed: The 2D depiction engine returned no atoms.");
    }, { timeout: 5_000 });
  });
  it.each([false, true])("reports native clipboard %s failure/empty content", async empty => {
    await mount(createEmptyDocument());
    const read = vi.spyOn(clipboard, "readClipboardPayload");
    if (empty) read.mockResolvedValueOnce({ types: [], textItems: [] });
    else read.mockRejectedValueOnce(new Error("Windows clipboard is unavailable"));
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "clipboard.paste" } }));
    });
    expect(container.querySelector("[role=status]")?.textContent).toContain(empty
      ? "Couldn't paste: the clipboard contains no supported drawing or text content."
      : "Couldn't read the clipboard: Windows clipboard is unavailable");
  });
  it("assigns distinct IDs to successive single-template pastes and undoes only the last paste", async () => {
    const { port } = await mount(createEmptyDocument());
    // jsdom has no layout; give paste a visible centre inside the page so the page-fit
    // confirmation does not intercept the next clipboard event.
    Object.defineProperties(container.querySelector(".canvas-region")!, {
      clientWidth: { value: 600 }, clientHeight: { value: 600 }
    });
    const template = resolveStructureTemplateName("18-crown-6")!;
    for (const count of [1, 2]) {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
        getData: (type: string) => type === "text/plain" ? template.smiles : "" } });
      await act(async () => {
        window.dispatchEvent(event);
        await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects).toHaveLength(count), { timeout: 5_000 });
      });
    }
    const after = port.read("initial")!;
    const objects = after.pages[0]!.objects;
    expect(new Set(objects.map(object => object.id)).size).toBe(2);
    expect(after.selection.objectIds).toEqual([objects[1]!.id]);
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.undo" } })); });
    expect(port.read("initial")!.pages[0]!.objects).toEqual([objects[0]]);
  });
  it.each([1, 2])("constructs each of %i template entries once without generic depiction, with selection and one undo", async count => {
    const { port } = await mount(createEmptyDocument());
    const construction = vi.spyOn(workflow, "structureTemplateMolecule");
    const unavailable = () => { throw new Error("Generic depiction must not run for a template"); };
    const oclDepiction = vi.spyOn(ocl, "depictSmiles2D").mockImplementation(unavailable);
    const rdkitDepiction = vi.spyOn(rdkit, "generateSmiles2DMolfile").mockImplementation(unavailable);
    const workerDepiction = vi.spyOn(depictionClient, "depictSmilesOffThread").mockImplementation(unavailable);
    const template = resolveStructureTemplateName("beta-cyclodextrin")!;
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? Array(count).fill(template.smiles).join("\n") : "" } });
    await act(async () => {
      window.dispatchEvent(event);
      await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects,
        container.querySelector("[role=status]")?.textContent ?? "missing status").toHaveLength(count), { timeout: 10_000 });
    });
    const after = port.read("initial")!;
    expect(new Set(after.selection.objectIds).size).toBe(count);
    expect(after.selection.objectIds).toEqual(after.pages[0]!.objects.map(object => object.id));
    expect(after.pages[0]!.objects.every(object => object.style.source === `structure-template:${template.id}`)).toBe(true);
    expect(container.querySelector("[role=status]")?.textContent).toContain("Used the β-Cyclodextrin template layout");
    expect(container.querySelector("[role=status]")?.textContent?.match(/Used the β-Cyclodextrin template layout/g)).toHaveLength(1);
    expect(construction).toHaveBeenCalledTimes(count);
    expect(oclDepiction).not.toHaveBeenCalled();
    expect(rdkitDepiction).not.toHaveBeenCalled();
    expect(workerDepiction).not.toHaveBeenCalled();
    for (const [index, object] of after.pages[0]!.objects.entries()) {
      if (object.type !== "molecule") throw new Error("Expected template molecule");
      const built = construction.mock.results[index]!.value;
      expect(object.structure).toBe(built.structure);
      expect(object.bonds).toEqual(built.bonds);
      expect(object.style.bondLengthPx).toBe(DocumentStylePreset.drawing.bondLengthPx);
      // Grid placement may translate, but never rescale or regenerate the authored geometry.
      object.atoms.forEach((atom, atomIndex) => {
        expect(atom.x - object.x).toBeCloseTo(built.atoms[atomIndex]!.x - built.x, 8);
        expect(atom.y - object.y).toBeCloseTo(built.atoms[atomIndex]!.y - built.y, 8);
      });
      expect(object.bonds.some(bond => bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed")).toBe(true);
      if (count === 1) {
        const stereoCount = ocl.perceiveStereoCentersFromMolfile(object.structure)
          .filter(centre => centre.isStereoCenter && centre.descriptor !== "unspecified").length;
        expect(container.querySelector("[role=status]")?.textContent).toContain(`${stereoCount} stereocenters`);
      }
    }
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.undo" } })); });
    expect(port.read("initial")!.pages[0]!.objects).toHaveLength(0);
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.redo" } })); });
    expect(port.read("initial")!.pages[0]!.objects).toEqual(after.pages[0]!.objects);
    expect(construction).toHaveBeenCalledTimes(count);
  }, 60_000);

});
