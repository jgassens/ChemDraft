// @vitest-environment jsdom
// Saving while a typed rotate/stretch entry shows its live preview, then restoring the entry's start
// document (an unparseable draft, Cancel, or stretch Home). The tab's dirty flag must follow the
// saved document: it is dirty exactly when the document now on the page differs from what was saved.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { createSmilesMolecule } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { createPhase4Document } from "./documentWorkflow";

const native = vi.hoisted(() => ({
  writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(async () => {}),
  // Set by a test to make the commit funnel's chemistry guard refuse the next numeric-entry Keep.
  refuseTransform: false
}));
vi.mock("./commitChemistryGuard", async original => {
  const actual = await original<typeof import("./commitChemistryGuard")>();
  return {
    ...actual,
    policyChemistryRefusals: ((...args: Parameters<typeof actual.policyChemistryRefusals>) =>
      native.refuseTransform ? ["the test refuses this transform"] : actual.policyChemistryRefusals(...args)) as typeof actual.policyChemistryRefusals
  };
});
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => null }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => true,
  loadDocumentSession: async () => undefined,
  saveDocumentSession: async () => {},
  loadToolsetLayoutState: async () => undefined,
  listToolsetWindowStates: async () => [],
  setToolbarsMenu: async () => {},
  listenForQuitFlushRequest: async () => () => {},
  listenForQuitPromptRequest: async () => () => {},
  listenForQuitSettings: async () => () => {},
  setQuitPromptEnabled: async () => {}
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => "/tmp/numeric-entry-dirty.chemdraft" }));
vi.mock("@tauri-apps/plugin-fs", async original => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(), writeTextFile: native.writeFile
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("numeric entry restore after a save keeps the dirty flag honest", () => {
  let container: HTMLDivElement;
  let root: Root;
  function drawing(): ChemDraftDocument {
    const doc = createPhase4Document("Numeric entry dirty");
    const molecule = createSmilesMolecule(doc, { x: 200, y: 200 }, depictSmiles2D("CCO"), "CCO") as MoleculeObject;
    molecule.id = "rotate-me";
    doc.pages[0].objects = [molecule];
    doc.selection.objectIds = [molecule.id];
    return doc;
  }
  beforeEach(() => {
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
    delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function mount() {
    const doc = drawing();
    await act(async () => root.render(<MainWindow initialDocument={doc} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false} nativePalette={false} />));
    const { width, height } = doc.pages[0];
    const rect = { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const dirty = () => snapshot().file.dirty;
  const objects = () => structuredClone(snapshot().document.pages[0].objects);
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function type(label: string, value: string) {
    const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
    expect(input, label).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(label: string) {
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    expect(button, label).not.toBeNull();
    await act(async () => { button!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  }

  const kinds = [
    { kind: "rotation", field: "Z rotation degrees", valid: "30", home: "0", popover: "[data-rotation-input-popover]",
      restores: ["an unparseable draft", "Cancel", "Home", "a typed home value", "a refused Keep"],
      open: () => command("layout.rotateMolecule") },
    { kind: "stretch", field: "X stretch percent", valid: "150", home: "100", popover: "[data-scale-input-popover]",
      restores: ["an unparseable draft", "Cancel", "Home", "a typed home value", "a refused Keep"],
      open: async () => {
        const corner = container.querySelector("[data-object-resize-corner]");
        expect(corner).not.toBeNull();
        await act(async () => { corner!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
      } }
  ] as const;

  describe.each(kinds)("$kind entry", entry => {
    async function restore(how: string) {
      if (how === "an unparseable draft") await type(entry.field, "abc");
      else if (how === "Cancel") await click(entry.kind === "rotation" ? "Cancel rotation entry" : "Cancel stretch entry");
      else if (how === "Home") await click(entry.kind === "rotation" ? "Set Z rotation to 0 degrees" : "Restore stretch home");
      else if (how === "a typed home value") await type(entry.field, entry.home);
      else {
        // Keep submits the entry form; the guard refuses, so the start document returns.
        native.refuseTransform = true;
        try {
          const form = container.querySelector<HTMLFormElement>(`form${entry.popover}`) ??
            container.querySelector<HTMLInputElement>(`[aria-label="${entry.field}"]`)!.form!;
          await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
        } finally { native.refuseTransform = false; }
        expect(container.querySelector(entry.popover)).toBeNull();
      }
    }

    it.each(entry.restores)("saved at the preview, then %s: dirty", async how => {
      await mount();
      await command("document.save");
      expect(dirty(), "saved start").toBe(false);
      const start = objects();
      await entry.open();
      expect(container.querySelector(entry.popover)).not.toBeNull();
      await type(entry.field, entry.valid);
      const preview = objects();
      expect(preview).not.toEqual(start);
      // Whether a live preview itself marks the tab dirty is not asserted here; only the states
      // after a save and after a restore are.
      await command("document.save");
      expect(native.writeFile).toHaveBeenCalled();
      expect(dirty(), "saved at the preview").toBe(false);
      await restore(how);
      expect(objects()).toEqual(start);
      // The page now shows the start document, not the saved preview.
      expect(dirty(), "start document differs from the saved preview").toBe(true);
    });

    it.each(entry.restores)("saved at the start, then a preview, then %s: clean", async how => {
      await mount();
      const start = objects();
      await entry.open();
      expect(container.querySelector(entry.popover)).not.toBeNull();
      await command("document.save");
      expect(dirty(), "saved at the start with the entry open").toBe(false);
      await type(entry.field, entry.valid);
      expect(objects()).not.toEqual(start);
      await restore(how);
      expect(objects()).toEqual(start);
      expect(dirty(), "back at the saved document").toBe(false);
    });

    it("saved at the preview, then a tab switch rolls the entry back: closing that background tab asks to save", async () => {
      await mount();
      await command("document.save");
      const start = objects();
      await entry.open();
      expect(container.querySelector(entry.popover)).not.toBeNull();
      await type(entry.field, entry.valid);
      await command("document.save");
      expect(dirty(), "saved at the preview").toBe(false);
      const tabs = () => container.querySelectorAll<HTMLButtonElement>(".document-tab-close");
      expect(tabs()).toHaveLength(1);
      // The switch cancels the entry on the outgoing tab, restoring its start document.
      await command("document.new");
      expect(tabs()).toHaveLength(2);
      expect(dirty(), "the new tab").toBe(false);
      // Close the first (now background) tab: its snapshot must record that it differs from the save.
      await act(async () => tabs()[0]!.click());
      expect(tabs(), "the background tab was closed without a save prompt").toHaveLength(2);
      expect(objects()).toEqual(start);
      expect(dirty(), "the restored tab differs from the saved preview").toBe(true);
    });
  });
});
