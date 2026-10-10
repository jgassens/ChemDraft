// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { exportDocumentToCdxml } from "@chemdraft/cdx-compat";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";
import { NO_OPEN_WARNINGS_REASON, TOGGLE_OPEN_WARNINGS_COMMAND_ID } from "./openWarnings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const pageRect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
const tenMetals = readFileSync("packages/fixtures/cdxml/ten-metals.cdxml", "utf8");
const invalidElement = readFileSync("packages/fixtures/cdxml/invalid-element.cdxml", "utf8");
const cleanEnvelope = exportDocumentToCdxml(createPhase4Document("Clean")).contents;
const textOnly = `<CDXML><page id="1"><t id="t1" p="100 100"><s>Reaction notes</s></t></page></CDXML>`;

const openHash = (contents: string, displayName: string) =>
  `#${new URLSearchParams({ openDocumentText: contents, displayName }).toString()}`;

type CaptureMethods = Pick<Element, "setPointerCapture" | "releasePointerCapture" | "hasPointerCapture">;

// The status line keeps the warnings a file open reported: "N warnings" opens a list of them, each
// naming what it is about. Pointer and key events here are DOM events through the app's own
// handlers (not the agent bridge), so focus and Esc are exercised the way a person meets them.
describe("open warnings list", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let originalCapture: CaptureMethods;
  let captured: Element | undefined;

  beforeEach(() => {
    saveKeybindingSettings({ scheme: "chemdraft" });
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    originalCapture = {
      setPointerCapture: Element.prototype.setPointerCapture,
      releasePointerCapture: Element.prototype.releasePointerCapture,
      hasPointerCapture: Element.prototype.hasPointerCapture
    };
    captured = undefined;
    Element.prototype.setPointerCapture = function setPointerCapture(this: Element) {
      captured = this;
    };
    Element.prototype.releasePointerCapture = function releasePointerCapture(this: Element) {
      if (captured === this) {
        captured = undefined;
      }
    };
    Element.prototype.hasPointerCapture = function hasPointerCapture(this: Element) {
      return captured === this;
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    Element.prototype.setPointerCapture = originalCapture.setPointerCapture;
    Element.prototype.releasePointerCapture = originalCapture.releasePointerCapture;
    Element.prototype.hasPointerCapture = originalCapture.hasPointerCapture;
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  /**
   * Mount the window, then open a file through the location hash as the agent-bridge open path takes
   * it. Opening after mount keeps the open's status line; at mount the bridge announces itself there.
   */
  async function mountWithFile(contents: string, displayName: string, initialActiveToolCommandId = "tool.bond") {
    window.history.replaceState(null, "", "/?agentBridge=1");
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId,
        initialCrosshairsVisible: false,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        // In-window toolbars: native palette windows cannot open here, and giving up on them
        // writes its own status line some time later, racing the status this suite reads.
        nativePalette: false
      }));
    });
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      element.getBoundingClientRect = () => pageRect;
    }
    await act(async () => {
      await Promise.resolve();
    });
    await openAnother(contents, displayName);
  }

  async function openAnother(contents: string, displayName: string) {
    await act(async () => {
      window.location.hash = openHash(contents, displayName);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  const bridge = () => window.__CHEMDRAFT_AGENT__!;
  const statusText = () => container.querySelector("[data-status-message]")?.textContent ?? "";
  const button = () => container.querySelector<HTMLButtonElement>("[data-open-warnings-button]");
  const list = () => container.querySelector<HTMLElement>("[data-open-warnings-list]");
  const rows = () => [...container.querySelectorAll<HTMLElement>("[data-open-warning-row]")];
  const row = (code: string) => rows().find((candidate) => candidate.dataset.warningCode === code)!;
  const molecules = () => bridge().snapshot().document.pages[0].objects.filter((object): object is MoleculeObject => object.type === "molecule");

  /** A mouse click as a browser delivers it. Returns whether the press was kept from moving focus. */
  async function click(target: Element): Promise<boolean> {
    let keptFocus = false;
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type.endsWith("down") ? 1 : 0 });
        if (type.startsWith("pointer")) {
          Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
        }
        target.dispatchEvent(event);
        if (type === "mousedown") {
          keptFocus = event.defaultPrevented;
        }
      }
    });
    return keptFocus;
  }

  async function press(key: string, target: EventTarget = document.activeElement ?? document.body) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => {
      target.dispatchEvent(event);
    });
    return event;
  }

  async function pagePointer(type: "pointerdown" | "pointermove" | "pointerup", point: { x: number; y: number }) {
    const page = container.querySelector<HTMLElement>(".page")!;
    await act(async () => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y });
      Object.defineProperties(event, { pointerId: { value: 9 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      (captured ?? page).dispatchEvent(event);
    });
  }

  /** Hover an atom with no button pressed, as the pointer passing over it does. */
  async function hoverAtom(atom: { x: number; y: number }) {
    const client = bridge().resolvePoint({ page: atom }).client;
    const page = container.querySelector<HTMLElement>(".page")!;
    await act(async () => {
      const event = new MouseEvent("pointermove", { bubbles: true, clientX: client.x, clientY: client.y, buttons: 0 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      page.dispatchEvent(event);
    });
  }

  /** A typed key, with the browser's text-entry default applied when it lands in a focused field. */
  async function type(key: string) {
    const target = document.activeElement ?? document.body;
    const event = await press(key, target);
    if (!event.defaultPrevented && target instanceof HTMLInputElement && key.length === 1) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, target.value.slice(0, start) + key + target.value.slice(end));
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.setSelectionRange(start + 1, start + 1);
      });
    }
  }

  it("keeps the count in the status line and lists every warning with what it is about", async () => {
    await mountWithFile(tenMetals, "ten-metals.cdxml");

    expect(statusText()).toContain("Opened ten-metals.cdxml as external CDXML subset with 11 warnings");
    expect(button()?.textContent).toBe("11 warnings");
    expect(button()?.getAttribute("aria-expanded")).toBe("false");
    expect(button()?.hasAttribute("aria-controls")).toBe(false);
    expect(list()).toBeNull();

    await click(button()!);
    expect(list()?.getAttribute("aria-label")).toBe("Opened ten-metals.cdxml as external CDXML subset: 11 warnings");
    expect(button()?.getAttribute("aria-expanded")).toBe("true");
    expect(button()?.getAttribute("aria-controls")).toBe(list()?.id);
    // A list, not a modal: tool shortcuts and the canvas stay live behind it.
    expect(list()?.getAttribute("aria-modal")).toBeNull();
    expect(rows()).toHaveLength(11);
    expect(row("cdxml.external_subset_imported").querySelector("[data-open-warning-target]")?.textContent).toBe("Whole file");
    expect(row("cdxml.external_subset_imported").querySelector("[data-open-warning-show]")).toBeNull();
    const perMolecule = rows().filter((candidate) => candidate.dataset.warningCode === "cdxml.structure_string_not_derived");
    expect(perMolecule).toHaveLength(10);
    for (const candidate of perMolecule) {
      expect(candidate.querySelector("[data-open-warning-target]")?.textContent).toMatch(/^Molecule \(CDXML fragment [^)]+\)$/);
      expect(candidate.querySelector("[data-open-warning-show]")).not.toBeNull();
      expect(candidate.querySelector(".open-warnings-message")?.textContent?.length).toBeGreaterThan(0);
    }

    // The same button closes it.
    await click(button()!);
    expect(list()).toBeNull();
    expect(button()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("says \"1 warning\", not \"1 warnings\"", async () => {
    // External CDXML with text and no structure opens with one warning: it is the external subset.
    await mountWithFile(textOnly, "note.cdxml");
    expect(statusText()).toContain("Opened note.cdxml as external CDXML subset with 1 warning");
    expect(statusText()).not.toContain("1 warnings");
    expect(button()?.textContent).toBe("1 warning");
    await click(button()!);
    expect(list()?.getAttribute("aria-label")).toBe("Opened note.cdxml as external CDXML subset: 1 warning");
    expect(rows()).toHaveLength(1);
  });

  it("Show selects the atom an unknown Element became, with the Select tool", async () => {
    await mountWithFile(invalidElement, "invalid-element.cdxml");
    expect(statusText()).toContain("with 3 warnings");
    const [molecule] = molecules();
    const star = molecule.atoms.find((atom) => atom.element === "*")!;

    await click(button()!);
    const unknown = row("cdxml.atom_element_unknown");
    expect(unknown.querySelector(".open-warnings-message")?.textContent).toContain("CDXML atom a2 has Element=\"119\"");
    expect(unknown.querySelector("[data-open-warning-target]")?.textContent).toBe(`Atom * in Molecule (CDXML fragment ${molecule.compatibility?.originalId})`);

    await click(unknown.querySelector("[data-open-warning-show]")!);
    expect(bridge().snapshot().document.selection.objectIds).toEqual([molecule.id]);
    expect(container.querySelector(`[data-object-id="${molecule.id}"]`)?.getAttribute("data-selected-native-atom-id")).toBe(star.id);
    expect(bridge().snapshot().activeToolCommandId).toBe("tool.select");
    expect(statusText()).toBe(`Selected atom * in Molecule (CDXML fragment ${molecule.compatibility?.originalId})`);
    // Show leaves the list open, to walk through the rest.
    expect(list()).not.toBeNull();
  });

  it("never takes keyboard focus on a click, so tool shortcuts work at once", async () => {
    await mountWithFile(invalidElement, "invalid-element.cdxml");

    expect(await click(button()!)).toBe(true);
    expect(list()?.contains(document.activeElement)).toBe(false);
    // Shortcuts reach the canvas while the list is open: it is not modal.
    await press("e");
    expect(bridge().snapshot().activeToolCommandId).toBe("tool.eraser");

    expect(await click(row("cdxml.atom_element_unknown").querySelector("[data-open-warning-show]")!)).toBe(true);
    expect(list()?.contains(document.activeElement)).toBe(false);
    await press("e");
    expect(bridge().snapshot().activeToolCommandId).toBe("tool.eraser");

    expect(await click(container.querySelector(".open-warnings-close")!)).toBe(true);
    expect(list()).toBeNull();
    expect(button()?.contains(document.activeElement)).toBe(false);
  });

  it("Esc from a keyboard-focused row closes the list and hands focus back to the count", async () => {
    await mountWithFile(invalidElement, "invalid-element.cdxml");
    await click(button()!);
    const show = row("cdxml.atom_element_unknown").querySelector<HTMLButtonElement>("[data-open-warning-show]")!;
    act(() => show.focus());
    expect(document.activeElement).toBe(show);

    const escape = await press("Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(button());
    // A focused button passes letter shortcuts on.
    await press("e");
    expect(bridge().snapshot().activeToolCommandId).toBe("tool.eraser");
  });

  it("Esc goes to a label being typed first; the list closes on the next one", async () => {
    await mountWithFile(invalidElement, "invalid-element.cdxml");
    await click(button()!);
    expect(list()).not.toBeNull();

    // Hover-typing over the * atom: the first letter assigns at once, the second opens the label editor.
    const star = molecules()[0].atoms.find((atom) => atom.element === "*")!;
    await hoverAtom(star);
    expect(bridge().snapshot().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: star.id });
    await type("O");
    await type("M");
    const editor = () => container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
    expect(editor()?.value).toBe("OM");
    expect(document.activeElement).toBe(editor());

    await press("Escape");
    expect(editor()).toBeNull();
    expect(molecules()[0].atoms.find((atom) => atom.id === star.id)?.element).toBe("O");
    expect(list()).not.toBeNull();

    await press("Escape");
    expect(list()).toBeNull();
  });

  it("Esc goes to an open web menu first; the list closes on the next one", async () => {
    await mountWithFile(invalidElement, "invalid-element.cdxml");
    const fileMenu = container.querySelector<HTMLButtonElement>('[role="menubar"] [data-menu-section="file"]')!;
    await click(fileMenu);
    expect(fileMenu.getAttribute("aria-expanded")).toBe("true");
    // Opened by command (a shortcut, say): a click on the count would have closed the menu.
    await act(async () => {
      await bridge().command(TOGGLE_OPEN_WARNINGS_COMMAND_ID);
    });
    expect(list()).not.toBeNull();

    await press("Escape");
    expect(fileMenu.getAttribute("aria-expanded")).toBe("false");
    expect(list()).not.toBeNull();

    await press("Escape", document.body);
    expect(list()).toBeNull();
  });

  it("Esc closes the list and nothing else; with the list closed, Esc does what it always did", async () => {
    await mountWithFile(invalidElement, "invalid-element.cdxml");
    await act(async () => {
      await bridge().command("tool.art.eyedropper");
    });
    expect(bridge().snapshot().activeToolCommandId).toBe("tool.art.eyedropper");

    await click(button()!);
    await press("Escape");
    expect(list()).toBeNull();
    expect(bridge().snapshot().activeToolCommandId).toBe("tool.art.eyedropper");

    await press("Escape");
    expect(bridge().snapshot().activeToolCommandId).not.toBe("tool.art.eyedropper");
  });

  it("Esc with the list open leaves a drag running; with it closed, Esc cancels the drag as before", async () => {
    await mountWithFile(invalidElement, "invalid-element.cdxml", "tool.chain");
    const before = molecules().length;
    const start = { x: 300, y: 200 };
    const end = { x: 420, y: 200 };

    // A press on the canvas closes the list, so it is opened again by command during the drag.
    await pagePointer("pointerdown", start);
    for (let step = 1; step <= 6; step += 1) {
      await pagePointer("pointermove", { x: start.x + ((end.x - start.x) * step) / 6, y: start.y });
    }
    await act(async () => {
      await bridge().command(TOGGLE_OPEN_WARNINGS_COMMAND_ID);
    });
    expect(list()).not.toBeNull();
    await press("Escape");
    expect(list()).toBeNull();
    await pagePointer("pointerup", end);
    expect(molecules()).toHaveLength(before + 1);

    await pagePointer("pointerdown", { x: start.x, y: 300 });
    for (let step = 1; step <= 6; step += 1) {
      await pagePointer("pointermove", { x: start.x + ((end.x - start.x) * step) / 6, y: 300 });
    }
    await press("Escape");
    await pagePointer("pointerup", { x: end.x, y: 300 });
    expect(molecules()).toHaveLength(before + 1);
  });

  it("a press outside the list closes it and still does its own job", async () => {
    await mountWithFile(invalidElement, "invalid-element.cdxml", "tool.chain");
    const before = molecules().length;
    await click(button()!);
    expect(list()).not.toBeNull();

    await pagePointer("pointerdown", { x: 300, y: 300 });
    expect(list()).toBeNull();
    for (let step = 1; step <= 6; step += 1) {
      await pagePointer("pointermove", { x: 300 + step * 20, y: 300 });
    }
    await pagePointer("pointerup", { x: 420, y: 300 });
    expect(molecules()).toHaveLength(before + 1);
  });

  it("goes away with the document: New, or a file that opens cleanly; the command then says why", async () => {
    await mountWithFile(tenMetals, "ten-metals.cdxml");
    expect(button()).not.toBeNull();

    await act(async () => {
      await bridge().command("document.new");
    });
    expect(button()).toBeNull();
    await act(async () => {
      await bridge().command(TOGGLE_OPEN_WARNINGS_COMMAND_ID);
    });
    expect(list()).toBeNull();
    expect(statusText()).toBe(NO_OPEN_WARNINGS_REASON);

    await openAnother(invalidElement, "invalid-element.cdxml");
    expect(button()?.textContent).toBe("3 warnings");
    await click(button()!);
    expect(list()).not.toBeNull();

    await openAnother(cleanEnvelope, "clean.cdxml");
    expect(statusText()).toBe("Opened clean.cdxml as ChemDraft CDXML envelope");
    expect(button()).toBeNull();
    expect(list()).toBeNull();
  });
});
