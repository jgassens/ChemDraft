// @vitest-environment jsdom
// Numeric rotate/stretch entries opened from a menu or with a drawing tool active. Cancel must never
// discard an edit made after the entry opened, and every kept change must have exactly one undo entry.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { MainWindow } from "./MainWindow";
import { createSmilesMolecule } from "@chemdraft/document-workflow-core";
import { createPhase4Document } from "./documentWorkflow";
import { DOM_COMMAND_EVENT, PALETTE_COMMAND_CANCEL_EVENT, PALETTE_COMMAND_PREVIEW_EVENT } from "./window-manager";
import { moleculeStructureBondColorCommandId } from "./commands";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@scena/react-ruler", () => ({ default: () => null }));

describe.each(["macos", "windows"] as const)("numeric entry sessions (%s)", platform => {
  const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
  let container: HTMLDivElement;
  let root: Root;
  const pointerMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  const pointerDescriptors = pointerMethods.map(method => Object.getOwnPropertyDescriptor(Element.prototype, method));
  function drawing(): ChemDraftDocument {
    const doc = createPhase4Document("Numeric entry");
    const graph = depictSmiles2D("CCO");
    const molecule = createSmilesMolecule(doc, { x: 200, y: 200 }, graph, "CCO") as MoleculeObject;
    molecule.id = "rotate-me";
    doc.pages[0].objects = [molecule];
    doc.selection.objectIds = [molecule.id];
    return doc;
  }
  beforeEach(() => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
    for (const method of pointerMethods) {
      Object.defineProperty(Element.prototype, method, { configurable: true,
        value: method === "hasPointerCapture" ? () => false : () => {} });
    }
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform); else Reflect.deleteProperty(navigator, "platform");
    delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    pointerMethods.forEach((method, index) => {
      const descriptor = pointerDescriptors[index];
      if (descriptor) Object.defineProperty(Element.prototype, method, descriptor);
      else Reflect.deleteProperty(Element.prototype, method);
    });
  });
  async function mount(doc = drawing()) {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden",
      initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false
    })));
    const { width, height } = doc.pages[0];
    const rect = { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const objects = () => snapshot().document.pages[0].objects;
  const molecule = () => objects().find(object => object.id === "rotate-me") as MoleculeObject;
  const bondCount = () => objects().reduce((count, object) => count + (object.type === "molecule" ? object.bonds.length : 0), 0);
  const status = () => container.querySelector('[role="status"]')?.textContent ?? "";
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  async function drawBond(x: number, y: number) {
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.click({ page: { x, y } }); });
  }
  async function type(label: string, value: string) {
    const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function escape(selector: string) {
    const form = container.querySelector(selector);
    expect(form).not.toBeNull();
    await act(async () => form!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  }
  async function openStretch() {
    const corner = container.querySelector('[data-object-resize-corner]');
    expect(corner).not.toBeNull();
    await act(async () => corner!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  }
  const rotationPopover = '[data-rotation-input-popover]';
  const stretchPopover = '[data-scale-input-popover]';

  // Reported path: Rotate Molecule chosen while the bond tool is active, bonds then drawn onto the
  // molecule, selection tool, Escape. Before the fix the entry stayed open but hidden and Escape
  // restored the document it opened on, deleting the drawn bond with no undo entry.
  it("Rotate Molecule from a drawing tool never lets a later Escape delete what was drawn", async () => {
    await mount();
    const before = molecule();
    await command("tool.bond");
    await command("layout.rotateMolecule");
    await command("tool.bond");
    const atom = before.atoms[2];
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.click({ atom: { objectId: before.id, atomId: atom.id } }); });
    expect(bondCount()).toBe(before.bonds.length + 1);
    const drawn = molecule();
    await command("tool.select");
    if (container.querySelector(rotationPopover)) await escape(rotationPopover);
    expect(molecule()).toEqual(drawn);
    await command("edit.undo");
    expect(molecule()).toEqual(before);
    await command("edit.redo");
    expect(molecule()).toEqual(drawn);
  });

  it("Rotate Molecule from a drawing tool opens a visible entry", async () => {
    await mount();
    await command("tool.bond");
    await command("layout.rotateMolecule");
    expect(container.querySelector('[aria-label="Z rotation degrees"]')).not.toBeNull();
  });

  // Reported: an open stretch was dropped without being kept, so the rotation started from the
  // stretched document and undo could not get back to before the stretch.
  it("Rotate Molecule keeps an open numeric stretch as its own undo step", async () => {
    await mount();
    const before = molecule();
    await openStretch();
    await type("X stretch percent", "150");
    const stretched = molecule();
    expect(stretched.atoms).not.toEqual(before.atoms);
    await command("layout.rotateMolecule");
    await type("Z rotation degrees", "45");
    await act(async () => container.querySelector(rotationPopover)!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(molecule().atoms).not.toEqual(stretched.atoms);
    await command("edit.undo");
    expect(status()).toBe("Undid Rotate molecule");
    expect(molecule()).toEqual(stretched);
    await command("edit.undo");
    expect(molecule()).toEqual(before);
  });

  it("canceling a rotation opened over a stretch keeps the stretch undoable", async () => {
    await mount();
    const before = molecule();
    await openStretch();
    await type("X stretch percent", "150");
    const stretched = molecule();
    await command("layout.rotateMolecule");
    await type("Z rotation degrees", "45");
    await escape(rotationPopover);
    expect(molecule()).toEqual(stretched);
    await command("edit.undo");
    expect(molecule()).toEqual(before);
  });

  it("opening the X/Y rotation entry keeps an open stretch as its own undo step", async () => {
    await mount();
    const before = molecule();
    await openStretch();
    await type("X stretch percent", "150");
    const stretched = molecule();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true })));
    const tilt = container.querySelector("[data-selection-tilt3d-handle='true']");
    expect(tilt).not.toBeNull();
    await act(async () => tilt!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(container.querySelector('[aria-label="X rotation degrees"]')).not.toBeNull();
    await escape(rotationPopover);
    expect(molecule()).toEqual(stretched);
    await command("edit.undo");
    expect(molecule()).toEqual(before);
  });

  it("opening a stretch entry keeps an open rotation as its own undo step", async () => {
    await mount();
    const before = molecule();
    await command("layout.rotateMolecule");
    await type("Z rotation degrees", "30");
    const rotated = molecule();
    await openStretch();
    await type("X stretch percent", "150");
    await escape(stretchPopover);
    expect(molecule()).toEqual(rotated);
    await command("edit.undo");
    expect(status()).toBe("Undid Rotate molecule");
    expect(molecule()).toEqual(before);
  });

  it.each(["rotation", "stretch"] as const)("switching to a drawing tool keeps an open %s preview", async kind => {
    await mount();
    const before = molecule();
    if (kind === "rotation") {
      await command("layout.rotateMolecule");
      await type("Z rotation degrees", "30");
    } else {
      await openStretch();
      await type("X stretch percent", "150");
    }
    const previewed = molecule();
    expect(previewed.atoms).not.toEqual(before.atoms);
    await command("tool.bond");
    const bondsBefore = bondCount();
    await drawBond(520, 420);
    expect(bondCount()).toBeGreaterThan(bondsBefore);
    const drawn = bondCount();
    await command("tool.select");
    const popover = kind === "rotation" ? rotationPopover : stretchPopover;
    if (container.querySelector(popover)) await escape(popover);
    expect(bondCount()).toBe(drawn);
    expect(molecule()).toEqual(previewed);
    await command("edit.undo");
    expect(bondCount()).toBe(bondsBefore);
    expect(molecule()).toEqual(previewed);
    await command("edit.undo");
    expect(molecule()).toEqual(before);
  });

  // Another document edit while an entry is open (the selection tool stays active and the molecule
  // stays selected): a hover-key bond or a menu command. Cancel must not discard it. (Undo, paste,
  // templates and plugin writes are already refused while an entry is open.)
  describe.each(["rotation", "stretch"] as const)("an edit while a %s entry is open", kind => {
    const popover = () => kind === "rotation" ? rotationPopover : stretchPopover;
    async function openEntry() {
      if (kind === "rotation") {
        await command("layout.rotateMolecule");
        await type("Z rotation degrees", "30");
      } else {
        await openStretch();
        await type("X stretch percent", "150");
      }
    }

    it("a hover-key bond survives Escape and undo reaches every prior state", async () => {
      await mount();
      const before = molecule();
      await openEntry();
      const previewed = molecule();
      const atom = previewed.atoms[2];
      await act(async () => { window.__CHEMDRAFT_AGENT__!.pointerMove({ atom: { objectId: before.id, atomId: atom.id } }); });
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })));
      expect(bondCount()).toBe(before.bonds.length + 1);
      const drawn = molecule();
      if (container.querySelector(popover())) await escape(popover());
      expect(molecule()).toEqual(drawn);
      await command("edit.undo");
      expect(molecule()).toEqual(previewed);
      await command("edit.undo");
      expect(molecule()).toEqual(before);
    });

    it("a menu command survives Escape and undo reaches every prior state", async () => {
      await mount();
      const before = molecule();
      await openEntry();
      const previewed = molecule();
      await command("layout.rotate90");
      const turned = molecule();
      expect(turned.atoms).not.toEqual(previewed.atoms);
      if (container.querySelector(popover())) await escape(popover());
      expect(molecule()).toEqual(turned);
      await command("edit.undo");
      expect(molecule()).toEqual(previewed);
      await command("edit.undo");
      expect(molecule()).toEqual(before);
    });
  });


  // Keeping an entry that changes nothing must add nothing: no undo step and no change to the
  // drawing, whether it was never typed in or holds a half-typed or invalid value. A valid value is
  // kept as exactly one labelled undo step. Covers every path that keeps an open entry first.
  describe.each(["rotation", "stretch"] as const)("keeping a %s entry", kind => {
    const popover = () => kind === "rotation" ? rotationPopover : stretchPopover;
    const field = () => kind === "rotation" ? "Z rotation degrees" : "X stretch percent";
    const valid = () => kind === "rotation" ? "30" : "150";
    const undoLabel = () => kind === "rotation" ? "Undid Rotate molecule" : "Undid Stretch molecule";
    const canUndo = () => container.querySelector("[data-can-undo]")?.getAttribute("data-can-undo") === "true";
    const objectsCopy = () => structuredClone(objects());
    async function open() {
      if (kind === "rotation") await command("layout.rotateMolecule");
      else await openStretch();
      expect(container.querySelector(popover())).not.toBeNull();
    }
    async function hoverKeyBond() {
      const atom = molecule().atoms[2];
      await act(async () => { window.__CHEMDRAFT_AGENT__!.pointerMove({ atom: { objectId: "rotate-me", atomId: atom.id } }); });
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })));
    }
    async function palette(event: string) {
      await act(async () => window.dispatchEvent(new CustomEvent(event, { detail: { commandId: moleculeStructureBondColorCommandId("#0000ff") } })));
    }
    // Each path keeps the open entry first. `edits` is whether the path makes its own undo step.
    const paths: Array<{ name: string; edits: boolean; run(): Promise<void> }> = [
      { name: "Enter", edits: false, run: async () => {
        await act(async () => container.querySelector(popover())!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      } },
      { name: "another document edit (menu command)", edits: true, run: () => command("layout.rotate90") },
      { name: "a hover-key edit", edits: true, run: hoverKeyBond },
      { name: "opening another entry", edits: false, run: async () => {
        if (kind === "rotation") { await openStretch(); await escape(stretchPopover); }
        else { await command("layout.rotateMolecule"); await escape(rotationPopover); }
      } },
      { name: "switching to a drawing tool", edits: false, run: () => command("tool.bond") },
      { name: "a palette hover preview", edits: false, run: async () => {
        await palette(PALETTE_COMMAND_PREVIEW_EVENT);
        await palette(PALETTE_COMMAND_CANCEL_EVENT);
      } }
    ];
    // Each draft is typed in order; a valid value typed first must not survive an unparseable one.
    const noOpDrafts: Array<{ name: string; values: () => string[] }> = [
      { name: "untouched", values: () => [] },
      { name: "'-'", values: () => ["-"] },
      { name: "'1.'", values: () => ["1."] },
      { name: "empty", values: () => [""] },
      { name: "'abc'", values: () => ["abc"] },
      { name: "equal to the current value", values: () => [kind === "rotation" ? "0" : "100"] },
      { name: "a valid value then cleared", values: () => [valid(), ""] },
      { name: "a valid value then '1.'", values: () => [valid(), "1."] },
      { name: "a valid value then '-'", values: () => [valid(), "-"] },
      { name: "a valid value then 'abc'", values: () => [valid(), "abc"] },
      { name: "a valid value backspaced to empty", values: () => [valid().slice(0, 1), valid().slice(0, 2), valid().slice(0, 1), ""] }
    ];

    // The kept entry's label belongs to its own step; an unchanged keep must not relabel the
    // earlier step it leaves in place.
    it("an unchanged keep leaves the previous undo step's label alone", async () => {
      await mount();
      await command("layout.rotate90");
      await command("edit.undo");
      const earlierLabel = status();
      await command("edit.redo");
      await open();
      await act(async () => container.querySelector(popover())!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      await command("edit.undo");
      expect(status()).toBe(earlierLabel);
      expect(canUndo()).toBe(false);
    });

    // A decimal typed one key at a time passes through "1." (which shows the start document) and
    // still ends at the full value, kept as one step.
    it("typing 1, 1. then 1.5 previews and keeps 1.5", async () => {
      await mount();
      const before = objectsCopy();
      const target = kind === "rotation" ? "1.5" : "101.5";
      await open();
      await type(field(), target);
      const direct = objectsCopy();
      expect(direct).not.toEqual(before);
      await escape(popover());
      expect(objects()).toEqual(before);
      await open();
      const prefix = target.slice(0, -2);
      await type(field(), prefix);
      expect(objects()).not.toEqual(before);
      await type(field(), `${prefix}.`);
      expect(objects()).toEqual(before);
      await type(field(), target);
      expect(objects()).toEqual(direct);
      await act(async () => container.querySelector(popover())!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(objects()).toEqual(direct);
      await command("edit.undo");
      expect(status()).toBe(undoLabel());
      expect(objects()).toEqual(before);
      expect(canUndo()).toBe(false);
    });

    describe.each(paths)("on $name", path => {
      it.each(noOpDrafts)("adds no undo step and no change when $name", async draft => {
        await mount();
        const before = objectsCopy();
        await open();
        for (const value of draft.values()) await type(field(), value);
        await path.run();
        expect(container.querySelector(popover())).toBeNull();
        if (path.edits) {
          expect(canUndo()).toBe(true);
          await command("edit.undo");
        }
        expect(objects()).toEqual(before);
        expect(canUndo()).toBe(false);
      });

      it("keeps a valid value as exactly one labelled undo step", async () => {
        await mount();
        const before = objectsCopy();
        await open();
        await type(field(), valid());
        const previewed = objectsCopy();
        expect(previewed).not.toEqual(before);
        await path.run();
        expect(container.querySelector(popover())).toBeNull();
        if (path.edits) {
          await command("edit.undo");
          expect(objects()).toEqual(previewed);
        } else {
          expect(objects().find(object => object.id === "rotate-me")).toEqual(previewed.find(object => object.id === "rotate-me"));
        }
        await command("edit.undo");
        expect(status()).toBe(undoLabel());
        expect(objects()).toEqual(before);
        expect(canUndo()).toBe(false);
      });
    });
  });

  // A transform drag records from the document it started on. An entry opened over its preview (the
  // command still works while the button is held, e.g. from the agent bridge or a shortcut) was
  // overwritten on release, leaving the typed value unreachable by undo.
  describe.each(["stretch", "rotate"] as const)("during an active %s drag", gesture => {
    const canUndo = () => container.querySelector("[data-can-undo]")?.getAttribute("data-can-undo") === "true";
    const canRedo = () => container.querySelector("[data-can-redo]")?.getAttribute("data-can-redo") === "true";
    async function pointer(target: Element, type: string, point: { x: number; y: number }) {
      // jsdom has no PointerEvent constructor; dispatch pointer events with the real React handlers.
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1, clientX: point.x, clientY: point.y });
      Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
      await act(async () => target.dispatchEvent(event));
    }
    let clockSkew = 0;
    async function startDrag() {
      // Two presses on one handle in quick succession open its entry; keep reference drags apart.
      clockSkew += 10_000;
      if (!vi.isMockFunction(Date.now)) {
        const realNow = Date.now.bind(Date);
        vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockSkew);
      }
      // The Z rotation handle shows while Shift is held.
      if (gesture === "rotate") await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true })));
      const handle = container.querySelector(gesture === "stretch" ? '[data-object-resize-corner="bottom-right"]' : ".object-rotate-handle");
      expect(handle).not.toBeNull();
      const page = container.querySelector(".page")!;
      const before = molecule();
      const center = before.atoms.reduce((sum, atom) => ({ x: sum.x + atom.x / before.atoms.length, y: sum.y + atom.y / before.atoms.length }), { x: 0, y: 0 });
      const start = gesture === "stretch" ? { x: center.x + 40, y: center.y + 40 } : { x: center.x, y: center.y - 60 };
      const end = gesture === "stretch" ? { x: center.x + 70, y: center.y + 70 } : { x: center.x + 60, y: center.y };
      await pointer(handle!, "pointerdown", start);
      await pointer(page, "pointermove", { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
      await pointer(page, "pointermove", end);
      expect(molecule().atoms, "the drag must preview").not.toEqual(before.atoms);
      return { page, handle: handle!, end };
    }
    async function release(drag: { page: Element; end: { x: number; y: number } }) {
      await pointer(drag.page, "pointerup", drag.end);
    }
    async function dragged() {
      // The same drag with nothing in between: what the release alone records.
      const drag = await startDrag();
      await release(drag);
      const result = molecule();
      await command("edit.undo");
      return result;
    }

    it.each(["rotation", "stretch"] as const)("a %s entry cannot open, and the release is one undo step", async entry => {
      await mount();
      const before = molecule();
      const expected = await dragged();
      expect(expected.atoms).not.toEqual(before.atoms);
      expect(molecule()).toEqual(before);
      const drag = await startDrag();
      if (entry === "rotation") await command("layout.rotateMolecule");
      else await openStretch();
      const popover = entry === "rotation" ? rotationPopover : stretchPopover;
      const field = entry === "rotation" ? "Z rotation degrees" : "X stretch percent";
      // Whatever might be typed must survive; the fix refuses the entry so nothing can be typed.
      if (container.querySelector(popover)) await type(field, entry === "rotation" ? "30" : "150");
      expect(container.querySelector(popover)).toBeNull();
      expect(status()).toBe("Finish the current drag, then enter a value");
      await release(drag);
      expect(molecule()).toEqual(expected);
      await command("edit.undo");
      expect(molecule()).toEqual(before);
      expect(canUndo()).toBe(false);
      await command("edit.redo");
      expect(molecule()).toEqual(expected);
      expect(canRedo()).toBe(false);
    });

    // Any other write that records an undo step disarms the drag: its release must not replace it.
    it("a menu command during the drag is not overwritten by the release", async () => {
      await mount();
      const drag = await startDrag();
      await command("layout.rotate90");
      const turned = molecule();
      expect(canUndo()).toBe(true);
      await release(drag);
      expect(molecule()).toEqual(turned);
      await pointer(drag.page, "pointermove", { x: drag.end.x + 50, y: drag.end.y + 50 });
      expect(molecule()).toEqual(turned);
      await command("edit.undo");
      expect(molecule()).not.toEqual(turned);
      await command("edit.redo");
      expect(molecule()).toEqual(turned);
      expect(canRedo()).toBe(false);
    });
  });
});
