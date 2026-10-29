// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { resolveStructureTemplateName } from "@chemdraft/document-workflow-core";
import * as atomLabelDraft from "./atomLabelDraft";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { applyNativeChainTool, insertNativeSingleBondMolecule } from "./documentWorkflow";
import { MainWindow } from "./MainWindow";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe("template insertion during an atom-label edit", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function command(commandId: string) {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
    });
  }

  it("commits and closes the label once before inserting, retaining selection and separate undo labels", async () => {
    const initial = insertNativeSingleBondMolecule(createEmptyDocument(), { x: 200, y: 200 });
    const original = initial.pages[0]!.objects[0] as MoleculeObject;
    const atom = original.atoms[0]!;
    await act(async () => root.render(<MainWindow initialDocument={initial} initialActiveToolCommandId="tool.atom"
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const port = getAssistantHistoryPort();
    const current = () => port.read("initial")!;
    const editedMolecule = () => current().pages[0]!.objects.find(object => object.id === original.id) as MoleculeObject;
    const editor = () => container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
    const status = () => container.querySelector("[role=status]")?.textContent;
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      element.getBoundingClientRect = () => rect;
    }
    await act(async () => {
      const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0,
        buttons: 1, clientX: atom.x, clientY: atom.y, detail: 1 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector(`[data-object-id="${original.id}"]`)!.dispatchEvent(event);
    });
    expect(editor()).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(editor(), "O");
      editor()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(editor()?.value).toBe("O");
    // Menu commands do not perform browser pointer focus changes. Keep the draft alive while
    // the picker opens, as when the native Templates window takes focus from the document.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await act(async () => { await import("./dialogs/StructureTemplatePicker"); });
    await command("template.insertDialog");
    const template = resolveStructureTemplateName("18-crown-6")!;
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.querySelector(`[data-template-id="${template.id}"]`)).not.toBeNull();
    });
    expect(editor()?.value).toBe("O");
    const finalize = vi.spyOn(atomLabelDraft, "restoreAtomLabelDraft");
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-template-id="${template.id}"]`)!.click();
    });
    expect(finalize).toHaveBeenCalledOnce();
    expect(editor()).toBeNull();
    expect(editedMolecule().atoms.find(candidate => candidate.id === atom.id)?.element).toBe("O");
    expect(current().pages[0]!.objects).toHaveLength(2);
    const inserted = current().pages[0]!.objects[1]!;
    expect(current().selection.objectIds).toEqual([inserted.id]);
    // Closing the picker later must neither finalize again nor restore the old selection.
    await act(async () => {
      const close = [...container.querySelectorAll<HTMLButtonElement>(".cd-template-picker button")]
        .find(button => button.textContent === "Close")!;
      close.click();
    });
    expect(finalize).toHaveBeenCalledOnce();
    expect(current().selection.objectIds).toEqual([inserted.id]);
    await command("edit.undo");
    expect(status()).toBe(`Undid Insert ${template.name}`);
    expect(current().pages[0]!.objects).toHaveLength(1);
    expect(editedMolecule().atoms.find(candidate => candidate.id === atom.id)?.element).toBe("O");
    await command("edit.undo");
    expect(status()).toBe("Undid Edit Atom Label");
    expect(editedMolecule()).toEqual(original);
    await command("edit.undo");
    expect(status()).toBe("Nothing to undo");
    await command("edit.redo");
    expect(status()).toBe("Redid Edit Atom Label");
    await command("edit.redo");
    expect(status()).toBe(`Redid Insert ${template.name}`);
    expect(current().selection.objectIds).toEqual([inserted.id]);
    expect(editor()).toBeNull();
  });

  it("commits a Text-tool N label before inserting, retaining selection and separate undo labels", async () => {
    const initial = applyNativeChainTool(createEmptyDocument(), { x: 200, y: 200 }, { x: 280, y: 200 });
    const original = initial.pages[0]!.objects[0] as MoleculeObject;
    const atom = original.atoms[1]!;
    expect(original.bonds.filter(bond => bond.fromAtomId === atom.id || bond.toAtomId === atom.id)).toHaveLength(2);
    await act(async () => root.render(<MainWindow initialDocument={initial} initialActiveToolCommandId="tool.text"
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const port = getAssistantHistoryPort();
    const current = () => port.read("initial")!;
    const editedMolecule = () => current().pages[0]!.objects.find(object => object.id === original.id) as MoleculeObject;
    const editor = () => container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
    const status = () => container.querySelector("[role=status]")?.textContent;
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      element.getBoundingClientRect = () => rect;
    }
    await act(async () => {
      const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0,
        buttons: 1, clientX: atom.x, clientY: atom.y, detail: 1 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector(`[data-object-id="${original.id}"]`)!.dispatchEvent(event);
    });
    expect(editor()).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(editor(), "N");
      editor()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(editor()?.value).toBe("N");
    // Menu commands do not perform browser pointer focus changes. Keep the draft alive while
    // the picker opens, as when the native Templates window takes focus from the document.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await act(async () => { await import("./dialogs/StructureTemplatePicker"); });
    await command("template.insertDialog");
    const template = resolveStructureTemplateName("18-crown-6")!;
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.querySelector(`[data-template-id="${template.id}"]`)).not.toBeNull();
    });
    expect(editor()?.value).toBe("N");
    const finalize = vi.spyOn(atomLabelDraft, "restoreAtomLabelDraft");
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-template-id="${template.id}"]`)!.click();
    });
    expect(finalize).toHaveBeenCalledOnce();
    expect(editor()).toBeNull();
    expect(editedMolecule().atoms.find(candidate => candidate.id === atom.id)?.element).toBe("N");
    expect(container.querySelector(`[data-invalid-atom-id="${atom.id}"] title`)?.textContent).toBe("N has 2 of 3 bonds.");
    expect(current().pages[0]!.objects).toHaveLength(2);
    const inserted = current().pages[0]!.objects[1]!;
    expect(current().selection.objectIds).toEqual([inserted.id]);
    // The shared canvas policy (also on main) hides chrome while Text is active.
    expect(container.querySelector("[data-molecule-transform-frame]")).toBeNull();
    // Closing the picker later must neither finalize again nor restore the old selection.
    await act(async () => {
      const close = [...container.querySelectorAll<HTMLButtonElement>(".cd-template-picker button")]
        .find(button => button.textContent === "Close")!;
      close.click();
    });
    expect(finalize).toHaveBeenCalledOnce();
    expect(current().selection.objectIds).toEqual([inserted.id]);
    await command("tool.select");
    expect(container.querySelector(`[data-object-id="${inserted.id}"].native-molecule-selected`)).not.toBeNull();
    expect(container.querySelector("[data-molecule-transform-frame]")).not.toBeNull();
    await command("edit.undo");
    expect(status()).toBe(`Undid Insert ${template.name}`);
    expect(current().pages[0]!.objects).toHaveLength(1);
    expect(editedMolecule().atoms.find(candidate => candidate.id === atom.id)?.element).toBe("N");
    await command("edit.undo");
    expect(status()).toBe("Undid Edit Atom Label");
    expect(editedMolecule()).toEqual(original);
    await command("edit.undo");
    expect(status()).toBe("Nothing to undo");
    await command("edit.redo");
    expect(status()).toBe("Redid Edit Atom Label");
    await command("edit.redo");
    expect(status()).toBe(`Redid Insert ${template.name}`);
    expect(current().selection.objectIds).toEqual([inserted.id]);
    expect(editor()).toBeNull();
  });

  it.each(["tool.text", "tool.select"])("plain insertion sets selection with %s active; chrome follows the shared tool policy", async tool => {
    await act(async () => root.render(<MainWindow initialDocument={createEmptyDocument()} initialActiveToolCommandId={tool}
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const template = resolveStructureTemplateName("18-crown-6")!;
    await command(`template.insert.${template.id}`);
    const current = getAssistantHistoryPort().read("initial")!;
    const inserted = current.pages[0]!.objects[0]!;
    expect(current.selection.objectIds).toEqual([inserted.id]);
    const frame = container.querySelector("[data-molecule-transform-frame]");
    expect(frame !== null).toBe(tool === "tool.select");
  });
});
