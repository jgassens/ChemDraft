// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule, pastedStructureDepictionFromMolfile } from "@chemdraft/document-workflow-core";
import { nativeAtomLabelReading } from "@chemdraft/layout-engine";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import type { PluginCommandContext } from "@chemdraft/plugin-api";
import { MainWindow } from "./MainWindow";
import {
  applyChargeToolAtNativeAtom,
  createPhase4Document,
  insertNativeTemplateMolecule,
  normalizeCommittedDocument,
  selectDocumentObjects
} from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";
import type { DesktopPluginRuntime } from "./plugins/createPluginRuntime";
import { ANALYSIS_WINDOW_ACTION_EVENT } from "./plugins/panelBridge";

/** What the outside-edit plugin proposes, accepted as the user would: one atom's formal charge. */
const outsideCharge = vi.hoisted(() => ({ objectId: "", atomId: "", formalCharge: 0, proposalId: "" }));

// Another writer that changes an atom's charge while its label editor is open, by the same runtime
// registration and proposal path the bundled plugins use; the user accepts its proposal.
vi.mock("./plugins/registerBundledPlugins", async importOriginal => {
  const actual = await importOriginal<typeof import("./plugins/registerBundledPlugins")>();
  const { PluginManifestSchema } = await import("@chemdraft/plugin-api");
  return {
    ...actual,
    registerBundledPlugins(runtime: DesktopPluginRuntime, disabledIds?: ReadonlySet<string>) {
      const descriptors = [...actual.registerBundledPlugins(runtime, disabledIds), {
        manifest: PluginManifestSchema.parse({
          id: "org.chemdraft.test.outsideCharge", name: "Outside Charge Test", version: "1.0.0",
          apiVersion: "^0.1.6", entry: "test:outside-charge", permissions: ["document.read", "document.proposePatch"],
          contributes: { commands: [
            { id: "plugin.outsideCharge.set", title: "Set an atom's charge", requiredPermissions: ["document.read", "document.proposePatch"], enabled: true }
          ] }
        }),
        options: { commandHandlers: {
          "plugin.outsideCharge.set": async (context: PluginCommandContext) => {
            const document = (await context.documents.getActiveDocument())!;
            const molecule = document.pages[0].objects.find((object): object is MoleculeObject =>
              object.id === outsideCharge.objectId && object.type === "molecule")!;
            const receipt = await context.documents.proposePatch({
              reason: "Set an atom's charge",
              patch: { op: "updateObject", objectId: molecule.id, changes: {
                atoms: molecule.atoms.map(atom => atom.id === outsideCharge.atomId
                  ? { ...atom, formalCharge: outsideCharge.formalCharge } : atom)
              } }
            });
            outsideCharge.proposalId = receipt.id;
          }
        } }
      }];
      actual.applyEnabledPlugins(runtime, disabledIds ?? new Set(), descriptors);
      return descriptors;
    }
  };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// A charged label ("N+", "Ac+") typed in the atom label editor is refused, with a status naming why
// and nothing changed, where the atom could not hold it faithfully: an atom carrying a charge mark,
// a bonded atom whose symbol reads as a group there, or an atom whose charge another edit changed
// while the label was being typed. Ordinary charged relabels still apply and undo in one step.
describe.each(["macos", "windows"] as const)("refused charged atom labels (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    saveKeybindingSettings({ scheme: "chemdraw" });
    Object.defineProperty(navigator, "platform", {
      configurable: true, value: platform === "macos" ? "MacIntel" : "Win32"
    });
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let initial = createPhase4Document("Charged label refusals");
    for (const [smiles, point] of [
      ["CCCC", { x: 250, y: 200 }],
      ["CC", { x: 500, y: 400 }],
      ["C", { x: 250, y: 450 }]
    ] as const) {
      const depiction = pastedStructureDepictionFromMolfile(depictSmiles2D(smiles).molfile);
      const object = createSmilesMolecule(initial, point, depiction, smiles);
      initial = applyPatches(initial, [{ op: "addObject", pageId: initial.pages[0].id, object }]);
    }
    // A + mark on the ethane's first carbon: its +1 is all the mark's (`markCharge`).
    const ethane = initial.pages[0].objects[1] as MoleculeObject;
    initial = normalizeCommittedDocument(applyChargeToolAtNativeAtom(initial, 1, {
      objectId: ethane.id, kind: "atom", atomId: ethane.atoms[0]!.id, distanceToPointer: 0
    }));
    // A ring drawn on the canvas, whose stored chemistry is its own graph's: a plugin's proposal for
    // it is verified against that graph and lands.
    initial = insertNativeTemplateMolecule(initial, { x: 600, y: 160 }, "cyclohexane");
    initial = selectDocumentObjects(initial, initial.pages[0].id, []);
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.text",
        initialCrosshairsVisible: false,
        initialDocument: initial,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
    const rect = {
      x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612,
      width: 792, height: 612, toJSON: () => ({})
    };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      element.getBoundingClientRect = () => rect;
    }
    expect(molecule(0).atoms[0]).toMatchObject({ element: "C", formalCharge: 0 });
    expect(molecule(0).bonds.some(bond => bond.fromAtomId === molecule(0).atoms[0]!.id ||
      bond.toAtomId === molecule(0).atoms[0]!.id)).toBe(true);
    expect(molecule(1).atoms[0]).toMatchObject({ element: "C", formalCharge: 1, markCharge: 1 });
    expect(chargeMarks()).toHaveLength(1);
    expect(molecule(2).atoms).toHaveLength(1);
    expect(molecule(2).bonds).toHaveLength(0);
    expect(molecule(3).atoms[0]).toMatchObject({ element: "C", formalCharge: 0 });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    saveKeybindingSettings({ scheme: "chemdraw" });
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  });

  function snapshot() {
    return window.__CHEMDRAFT_AGENT__!.snapshot();
  }

  function molecule(index: number): MoleculeObject {
    const object = snapshot().document.pages[0].objects.filter(candidate => candidate.type === "molecule")[index];
    if (object?.type !== "molecule") throw new Error("Expected molecule");
    return object;
  }

  function chargeMarks() {
    return snapshot().document.pages[0].objects.filter(object => object.type === "electron-mark");
  }

  function editor() {
    return container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
  }

  function status() {
    return container.querySelector('[role="status"]')?.textContent;
  }

  async function openEditor(index: number) {
    const object = molecule(index);
    const atom = object.atoms[0]!;
    const wrapper = container.querySelector<HTMLElement>(`[data-object-id="${object.id}"]`)!;
    await act(async () => {
      const event = new MouseEvent("pointerdown", {
        bubbles: true, cancelable: true, button: 0, buttons: 1,
        clientX: atom.x, clientY: atom.y, detail: 1
      });
      Object.defineProperties(event, {
        pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true }
      });
      wrapper.dispatchEvent(event);
    });
    expect(editor()?.getAttribute("data-atom-id")).toBe(atom.id);
    expect(document.activeElement).toBe(editor());
  }

  /** Types the label one character at a time, as a keyboard does: "N", "N+". */
  async function typeLabel(value: string) {
    const characters = Array.from(value);
    for (let length = 1; length <= characters.length; length += 1) {
      const input = editor()!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, characters.slice(0, length).join(""));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
  }

  async function press(key: string) {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", {
        key, bubbles: true, cancelable: true
      }));
    });
  }

  async function history(redo = false) {
    await act(async () => {
      container.querySelector<HTMLElement>(".page")!.dispatchEvent(new KeyboardEvent("keydown", {
        key: "z", bubbles: true, cancelable: true, shiftKey: redo,
        metaKey: platform === "macos", ctrlKey: platform === "windows"
      }));
    });
  }

  function expectNoUndo() {
    expect(container.querySelector("[data-can-undo]")?.getAttribute("data-can-undo")).toBe("false");
  }

  it.each(["N+", "N-", "Zn2+"])("refuses %s over an atom carrying a charge mark, element, charge and mark unchanged", async label => {
    const before = molecule(1);
    const marks = chargeMarks();
    await openEditor(1);
    await typeLabel(label);
    await press("Enter");
    expect(editor()).toBeNull();
    expect(status()).toBe("Remove the charge mark before typing a charged label.");
    expect(molecule(1)).toEqual(before);
    expect(molecule(1).atoms[0]).toMatchObject({ element: "C", formalCharge: 1, markCharge: 1 });
    expect(chargeMarks()).toEqual(marks);
    expectNoUndo();
  });

  it("still relabels an atom carrying a charge mark with an uncharged label, its charge and mark kept", async () => {
    await openEditor(1);
    await typeLabel("N");
    await press("Enter");
    expect(molecule(1).atoms[0]).toMatchObject({ element: "N", formalCharge: 1, markCharge: 1 });
  });

  it.each([
    ["Ac+", "acetyl"], ["Pr3+", "n-propyl"], ["Ts-", "p-toluenesulfonyl (tosyl)"]
  ] as const)("refuses %s on a bonded atom with a status naming the %s group", async (label, group) => {
    const before = molecule(0);
    await openEditor(0);
    await typeLabel(label);
    await press("Enter");
    expect(editor()).toBeNull();
    expect(status()).toBe(`${label} on a bonded atom reads as the ${group} group; draw the ion unbonded or set the charge separately.`);
    expect(molecule(0)).toEqual(before);
    expect(molecule(0).atoms[0]).toMatchObject({ element: "C", formalCharge: 0 });
    expectNoUndo();
  });

  it("keeps an uncharged Ac typed on a bonded atom the acetyl abbreviation", async () => {
    await openEditor(0);
    await typeLabel("Ac");
    await press("Enter");
    const atom = molecule(0).atoms[0]!;
    expect(atom).toMatchObject({ element: "Ac", formalCharge: 0, labelLiteral: true });
    expect(nativeAtomLabelReading(atom.element, { bonded: true, typed: atom.labelLiteral })).toMatchObject({
      kind: "group", group: { kind: "abbreviation", definition: { name: "acetyl" } }
    });
  });

  it("relabels an unbonded atom typed Ac+ as actinium with charge +1", async () => {
    await openEditor(2);
    await typeLabel("Ac+");
    await press("Enter");
    expect(editor()).toBeNull();
    expect(molecule(2).atoms).toEqual([expect.objectContaining({ element: "Ac", formalCharge: 1, labelLiteral: true })]);
  });

  it("applies an ordinary charged relabel on a bonded atom and undoes it in one step", async () => {
    const before = molecule(0);
    await openEditor(0);
    await typeLabel("Na+");
    await press("Enter");
    expect(editor()).toBeNull();
    const after = molecule(0);
    expect(after.atoms[0]).toMatchObject({ element: "Na", formalCharge: 1, labelLiteral: true });
    await history();
    expect(molecule(0)).toEqual(before);
    expectNoUndo();
    await history(true);
    expect(molecule(0)).toEqual(after);
  });

  /** Another edit sets the edited atom's charge while its label editor stays open: an accepted plugin proposal. */
  async function setChargeOutside(index: number, formalCharge: number) {
    // The proposal's chemistry is verified on a worker, on real time.
    vi.useRealTimers();
    const object = molecule(index);
    Object.assign(outsideCharge, { objectId: object.id, atomId: object.atoms[0]!.id, formalCharge, proposalId: "" });
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("plugin.outsideCharge.set"); });
    await act(async () => { await vi.waitFor(() => expect(outsideCharge.proposalId).not.toBe(""), { timeout: 5000 }); });
    await act(async () => { window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_ACTION_EVENT, {
      detail: { kind: "acceptPluginProposal", proposalId: outsideCharge.proposalId }
    })); });
    await act(async () => {
      await vi.waitFor(() => expect(molecule(index).atoms[0]!.formalCharge).toBe(formalCharge), { timeout: 20000, interval: 20 });
    });
    expect(editor()?.getAttribute("data-atom-id")).toBe(object.atoms[0]!.id);
    return molecule(index).atoms[0]!;
  }

  it("refuses to close a charged draft over a charge another edit changed while typing", async () => {
    await openEditor(3);
    await typeLabel("Zn2+");
    expect(molecule(3).atoms[0]).toMatchObject({ element: "Zn", formalCharge: 2 });
    const changed = await setChargeOutside(3, -1);
    const marks = chargeMarks();
    await press("Enter");
    expect(editor()).toBeNull();
    expect(status()).toBe("The charge changed while you were typing; type the label again.");
    // The typed label is not written over the other edit: the atom keeps its element and the charge
    // that edit set.
    const atom = molecule(3).atoms[0]!;
    expect(changed.formalCharge).toBe(-1);
    expect(atom).toMatchObject({ element: "C", formalCharge: -1 });
    expect(atom.markCharge).toBeUndefined();
    expect(atom.labelLiteral).toBeUndefined();
    expect(chargeMarks()).toEqual(marks);
    // Typed again, with no other edit meanwhile, the label applies.
    await openEditor(3);
    await typeLabel("Zn2+");
    await press("Enter");
    expect(editor()).toBeNull();
    expect(molecule(3).atoms[0]).toMatchObject({ element: "Zn", formalCharge: 2, labelLiteral: true });
  }, 60000);

  it("closes an uncharged draft over another edit's charge as before, keeping that charge", async () => {
    await openEditor(3);
    await typeLabel("N");
    const changed = await setChargeOutside(3, -1);
    await press("Enter");
    expect(editor()).toBeNull();
    expect(changed.formalCharge).toBe(-1);
    expect(molecule(3).atoms[0]).toMatchObject({ element: "N", formalCharge: -1 });
  }, 60000);
});
