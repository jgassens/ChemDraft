// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { toggleBracketRepeatUnit } from "./bracketCommands";
import {
  applyChargeToolAtNativeAtom, applyChargeToolAtPoint, createPhase4Document, groupSelectedDocumentObjects,
  insertNativeBracket, insertNativeSingleBondMolecule, selectDocumentObjects
} from "./documentWorkflow";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

describe.each(["macos", "windows"] as const)("drawing fixes on %s", shortcutPlatform => {
  let container: HTMLDivElement;
  let root: Root;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  const objectVisual = (id: string) => container.querySelector(`[data-page-svg-object-visual="${id}"]`)!;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      Object.defineProperty(Element.prototype, method, { configurable: true, value: vi.fn(() => false) });
    }
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/");
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      Reflect.deleteProperty(Element.prototype, method);
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount(initialDocument: ChemDraftDocument) {
    await act(async () => root.render(<MainWindow initialDocument={initialDocument} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false}
      nativePalette={false} shortcutPlatform={shortcutPlatform} />));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON() {} };
    for (const element of container.querySelectorAll(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    }
    const canvas = container.querySelector(".canvas-region")!;
    vi.spyOn(canvas, "clientWidth", "get").mockReturnValue(rect.width);
    vi.spyOn(canvas, "clientHeight", "get").mockReturnValue(rect.height);
  }

  async function command(id: string) {
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); });
  }

  async function pointer(target: Element, type: string, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => target.dispatchEvent(event));
  }

  function repeatUnit() {
    return toggleBracketRepeatUnit(insertNativeBracket(createPhase4Document("Repeat unit"),
      { x: 100, y: 100 }, "square", { x: 260, y: 200 }));
  }

  it.each(["Enter", "canvas press"])("repaints a committed repeat label while its bracket stays selected (%s)", async finish => {
    const drawing = repeatUnit();
    const closing = drawing.pages[0].objects.find(object => object.type === "bracket" && object.side === "close")!;
    await mount(drawing);
    const label = () => objectVisual(closing.id).querySelector(".bracket-repeat-label")?.textContent;
    expect(label()).toBe("n");
    await command("bracket.label.edit");
    const editor = container.querySelector<HTMLInputElement>("[data-bracket-label-editor]")!;
    expect(document.activeElement).toBe(editor);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(editor, "DP 20");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    if (finish === "Enter") {
      await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    } else {
      await pointer(objectVisual(closing.id), "pointerdown", closing.x + closing.width, closing.y + closing.height / 2);
      await pointer(objectVisual(closing.id), "pointerup", closing.x + closing.width, closing.y + closing.height / 2);
    }
    expect(snapshot().selection.objectIds).toContain(closing.id);
    expect(label()).toBe("DP 20");
    expect(container.querySelector("[data-bracket-label-editor]")).toBeNull();
  });

  it("reports a bracket in the status line when clicked", async () => {
    const drawing = repeatUnit();
    const bracket = drawing.pages[0].objects[0];
    await mount(selectDocumentObjects(drawing, drawing.pages[0].id, []));
    const page = container.querySelector(".page")!;
    await pointer(page, "pointerdown", 320, 250);
    await pointer(page, "pointerup", 320, 250);
    expect(status()).toBe("No selection");
    await pointer(objectVisual(bracket.id), "pointerdown", bracket.x, bracket.y + bracket.height / 2);
    await pointer(objectVisual(bracket.id), "pointerup", bracket.x, bracket.y + bracket.height / 2);
    expect(snapshot().selection.objectIds).toContain(bracket.id);
    expect(status()).toBe("Selected bracket");
  });

  it("names the selected charge, radical and lone pair in the status line", async () => {
    const marks = [
      [{ kind: "charge", charge: 1 }, "Selected charge"],
      [{ kind: "radical-dot" }, "Selected radical electron"],
      [{ kind: "lone-pair" }, "Selected lone pair"]
    ] as const;
    const drawing = marks.reduce((document, [spec], index) =>
      applyChargeToolAtPoint(document, spec, { x: 340 + index * 60, y: 250 }), repeatUnit());
    const page = drawing.pages[0];
    const bracket = page.objects.find(object => object.type === "bracket")!;
    await mount(selectDocumentObjects(drawing, page.id, []));
    await pointer(objectVisual(bracket.id), "pointerdown", bracket.x, bracket.y + bracket.height / 2);
    await pointer(objectVisual(bracket.id), "pointerup", bracket.x, bracket.y + bracket.height / 2);
    expect(status()).toBe("Selected bracket");
    const electronMarks = page.objects.filter(object => object.type === "electron-mark");
    for (const [index, mark] of electronMarks.entries()) {
      const x = mark.x + mark.width / 2;
      const y = mark.y + mark.height / 2;
      await pointer(objectVisual(mark.id), "pointerdown", x, y);
      await pointer(objectVisual(mark.id), "pointerup", x, y);
      expect(snapshot().selection.objectIds).toEqual([mark.id]);
      expect(status()).toBe(marks[index][1]);
    }
  });

  it("reports the whole selection when clicking one of several selected brackets", async () => {
    const drawing = repeatUnit();
    const page = drawing.pages[0];
    const bracket = page.objects[0];
    const ids = page.objects.map(object => object.id);
    await mount(selectDocumentObjects(drawing, page.id, ids));
    await pointer(objectVisual(bracket.id), "pointerdown", bracket.x, bracket.y + bracket.height / 2);
    await pointer(objectVisual(bracket.id), "pointerup", bracket.x, bracket.y + bracket.height / 2);
    expect(snapshot().selection.objectIds).toEqual(ids);
    expect(status()).toBe("Selected 2 objects");
  });

  it("updates the status when clicking a grouped atom replaces the bracket selection", async () => {
    let drawing = insertNativeSingleBondMolecule(repeatUnit(), { x: 340, y: 250 });
    drawing = insertNativeSingleBondMolecule(drawing, { x: 440, y: 250 });
    const page = drawing.pages[0];
    const bracket = page.objects.find(object => object.type === "bracket")!;
    const molecules = page.objects.filter(object => object.type === "molecule");
    drawing = groupSelectedDocumentObjects(selectDocumentObjects(drawing, page.id, molecules.map(object => object.id)));
    const group = drawing.pages[0].objects.find(object => object.type === "group")!;
    await mount(selectDocumentObjects(drawing, page.id, []));
    await pointer(objectVisual(bracket.id), "pointerdown", bracket.x, bracket.y + bracket.height / 2);
    await pointer(objectVisual(bracket.id), "pointerup", bracket.x, bracket.y + bracket.height / 2);
    expect(status()).toBe("Selected bracket");

    const atom = molecules[0].atoms[0];
    const atomTarget = container.querySelector(`[data-hit-target="atom"][data-atom-id="${atom.id}"]`)!;
    await pointer(atomTarget, "pointerdown", atom.x, atom.y);
    await pointer(atomTarget, "pointerup", atom.x, atom.y);
    expect(snapshot().selection.objectIds).toEqual([group.id]);
    expect(status()).toBe("Selected group");
  });

  it.each([true, false])("names the undo for a drag of electron marks (with molecule: %s)", async withMolecule => {
    let drawing = createPhase4Document("Move undo");
    if (withMolecule) {
      drawing = insertNativeSingleBondMolecule(drawing, { x: 150, y: 150 });
      const molecule = drawing.pages[0].objects.find(object => object.type === "molecule")!;
      drawing = applyChargeToolAtNativeAtom(drawing, { kind: "charge", charge: 1 },
        { objectId: molecule.id, atomId: molecule.atoms[0].id, kind: "atom", distanceToPointer: 0 });
    } else {
      drawing = applyChargeToolAtPoint(drawing, 1, { x: 150, y: 150 });
      drawing = applyChargeToolAtPoint(drawing, -1, { x: 220, y: 180 });
    }
    const page = drawing.pages[0];
    await mount(selectDocumentObjects(drawing, page.id, page.objects.map(object => object.id)));
    const before = snapshot().pages[0].objects;
    expect(before).toHaveLength(2);
    const mark = before.find(object => object.type === "electron-mark")!;
    if (withMolecule) expect(mark.anchor.kind).toBe("atom");
    const x = mark.x + mark.width / 2;
    const y = mark.y + mark.height / 2;
    await pointer(objectVisual(mark.id), "pointerdown", x, y);
    await pointer(objectVisual(mark.id), "pointermove", x + 40, y + 25);
    await pointer(objectVisual(mark.id), "pointerup", x + 40, y + 25);
    const after = snapshot().pages[0].objects;
    for (const original of before) expect(after.find(object => object.id === original.id)?.x).toBeCloseTo(original.x + 40);
    await command("edit.undo");
    expect(snapshot().pages[0].objects).toEqual(before);
    expect(status()).toBe(withMolecule ? "Undid Move" : "Undid Move electron mark");
  });

  it("avoids per-object page searches when labeling a large mixed drag", async () => {
    const drawing = applyChargeToolAtPoint(createPhase4Document("Large mixed move"), 1, { x: 150, y: 150 });
    const mark = drawing.pages[0].objects[0];
    const bracket = repeatUnit().pages[0].objects[0];
    const page = { ...drawing.pages[0], objects: [mark, ...Array.from({ length: 64 }, (_, index) =>
      ({ ...bracket, id: `bracket_${index}`, x: 200 + (index % 8) * 40, y: 150 + Math.floor(index / 8) * 20 }))] };
    await mount(selectDocumentObjects({ ...drawing, pages: [page] }, page.id, page.objects.map(object => object.id)));
    const x = mark.x + mark.width / 2;
    const y = mark.y + mark.height / 2;
    await pointer(objectVisual(mark.id), "pointerdown", x, y);
    await pointer(objectVisual(mark.id), "pointermove", x + 40, y + 25);
    const find = Array.prototype.find;
    let pageSearches = 0;
    const search = vi.spyOn(Array.prototype, "find").mockImplementation(function (this: unknown[], ...args) {
      if (this.length === page.objects.length && this[0] && (this[0] as { id?: string }).id === mark.id) pageSearches++;
      return Reflect.apply(find, this, args);
    });
    try {
      await pointer(objectVisual(mark.id), "pointerup", x + 40, y + 25);
    } finally {
      search.mockRestore();
    }
    expect(snapshot().pages[0].objects[0].x).toBeCloseTo(mark.x + 40);
    await command("edit.undo");
    expect(status()).toBe("Undid Move");
    expect(pageSearches).toBeLessThan(page.objects.length);
  });
});
