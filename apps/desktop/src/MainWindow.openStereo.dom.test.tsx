// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultNativeTextStyle, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { depictSmiles2D, ensureOclResources, perceiveDoubleBondStereoFromMolfile } from "@chemdraft/ocl-adapter";
import { MainWindow } from "./MainWindow";
import { OPEN_DOUBLE_BOND_TOOLTIP } from "./BondStereoBadges";
import {
  applyMoleculeBondStylePatch, createPhase4Document, exportPhase4Cdxml, exportPhase4Pdf, exportPhase4Svg,
  getSelectedMolecule, insertNativeMolfileMolecule, selectDocumentObjects
} from "./documentWorkflow";
import { moleculeBondStereoCommandId } from "./commands";
import { DOM_COMMAND_EVENT, broadcastToolsetTextStyle, createToolsetTextStylePayload, PALETTE_COMMAND_COMMIT_EVENT } from "./window-manager";
import { createMoleculeInspectorModel } from "./moleculeInspectorModel";
import { PaletteWindow } from "./PaletteWindow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe("editor open E/Z", () => {
  let container: HTMLDivElement, root: Root;
  const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let captures: (PropertyDescriptor | undefined)[];
  let originalPlatform: PropertyDescriptor | undefined;
  beforeAll(async () => { await ensureOclResources(); });
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
    captures = captureMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    for (const name of captureMethods) Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true, value: name === "hasPointerCapture" ? () => false : () => {}
    });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove();
    captures.forEach((descriptor, i) => {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, captureMethods[i], descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, captureMethods[i]);
    });
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
    else Reflect.deleteProperty(navigator, "platform");
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });
  async function mount(initialDocument: ChemDraftDocument, tool = "tool.select") {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument, initialActiveToolCommandId: tool, initialCrosshairsVisible: false,
      initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    const canvas = container.querySelector(".canvas-region")!;
    Object.defineProperties(canvas, { clientWidth: { value: 792 }, clientHeight: { value: 612 } });
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const molecule = () => snapshot().document.pages[0].objects.find((o): o is MoleculeObject => o.type === "molecule")!;
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function bondClick(mol: MoleculeObject, shiftKey = true) {
    const bond = mol.bonds.find(b => b.order === "double")!;
    const from = mol.atoms.find(a => a.id === bond.fromAtomId)!, to = mol.atoms.find(a => a.id === bond.toAtomId)!;
    const target = container.querySelector(`[data-object-id="${mol.id}"]`)!;
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1,
          clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2, shiftKey });
        Object.defineProperties(event, { pointerId: { value: 77 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
        target.dispatchEvent(event);
      }
    });
  }
  function drawing(smiles: string, open = false) {
    return insertNativeMolfileMolecule(createPhase4Document("Open E/Z"), { x: 250, y: 250 },
      depictSmiles2D(smiles, { openUnspecifiedDoubleBonds: open }).molfile, "molfile-v2000");
  }

  it("renders the exact badge in interaction chrome and excludes it from SVG, PDF, CDXML and print", async () => {
    const doc = drawing("CC=CC", true);
    await mount(doc);
    const badge = container.querySelector(".native-bond-stereo-marker")!;
    expect(badge).not.toBeNull();
    expect(badge.closest(".page-interaction-layer")).not.toBeNull();
    expect(badge.querySelector("text")?.textContent).toBe("!");
    expect(badge.querySelector("title")?.textContent).toBe(OPEN_DOUBLE_BOND_TOOLTIP);
    const mol = molecule(), bond = mol.bonds.find(b => b.stereo === "either")!;
    const from = mol.atoms.find(a => a.id === bond.fromAtomId)!, to = mol.atoms.find(a => a.id === bond.toAtomId)!;
    const circle = badge.querySelector("circle")!;
    const dx = Number(circle.getAttribute("cx")) + mol.x - (from.x + to.x) / 2;
    const dy = Number(circle.getAttribute("cy")) + mol.y - (from.y + to.y) / 2;
    expect(dx * (to.x - from.x) + dy * (to.y - from.y)).toBeCloseTo(0);
    expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(14 - 1e-8);
    expect(container.querySelector(".page-object-stack .native-bond-stereo-marker")).toBeNull();
    const before = snapshot().document;
    act(() => { badge.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 })); });
    expect(snapshot().document).toEqual(before);
    const svg = exportPhase4Svg(doc).contents, cdxml = exportPhase4Cdxml(doc).contents;
    vi.stubGlobal("getComputedStyle", window.getComputedStyle.bind(window));
    const pdf = await exportPhase4Pdf(doc, { compress: false });
    for (const output of [svg, cdxml, new TextDecoder().decode(pdf.bytes)]) {
      expect(output).not.toContain("native-bond-stereo-marker");
      expect(output).not.toContain("E/Z was not specified");
      expect(output).not.toMatch(/>!<|\(!\) Tj/);
    }
    // jsdom does not emulate print media. Apply the actual print rules to the rendered editor.
    const css = readFileSync(resolve("apps/desktop/src/App.css"), "utf8");
    const printRule = css.match(/@media print\s*\{\s*(\.native-bond-stereo-marker\s*\{[^}]+\})\s*\}/)![1];
    const style = document.createElement("style"); style.textContent = printRule; document.head.append(style);
    try { expect(window.getComputedStyle(badge).display).toBe("none"); }
    finally { style.remove(); }
  }, 20_000);

  it.each(["MacIntel", "Win32"])("runs registered stereo commands as single labelled undo entries with selection kept (%s)", async platform => {
    Object.defineProperty(navigator, "platform", { configurable: true, get: () => platform });
    const doc = drawing("C/C=C/C"), original = getSelectedMolecule(doc)!;
    await mount(selectDocumentObjects(doc, doc.pages[0].id, []));
    await bondClick(original);
    expect(snapshot().selectedNativeMoleculePart).toMatchObject({ kind: "bond", bondId: original.bonds.find(b => b.order === "double")!.id });
    const selection = snapshot().selectedNativeMoleculePart;
    await command(moleculeBondStereoCommandId("either"));
    const open = molecule();
    expect(open.bonds.filter(b => b.stereo === "either")).toHaveLength(1);
    expect(parseMolfileGraph(open.structure).bonds.filter(b => b.stereo === "either")).toHaveLength(1);
    expect(snapshot().selectedNativeMoleculePart).toEqual(selection);
    await command("edit.undo");
    expect(molecule()).toEqual(original);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid E/Z unspecified");
    await command("edit.redo"); expect(molecule()).toEqual(open);
    await command(moleculeBondStereoCommandId("geometry"));
    const geometry = molecule();
    expect(geometry.bonds.every(b => b.stereo === undefined)).toBe(true);
    expect(snapshot().selectedNativeMoleculePart).toEqual(selection);
    await command("edit.undo"); expect(molecule()).toEqual(open);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Use drawn geometry");
    await command("edit.redo"); expect(molecule()).toEqual(geometry);
    await command("edit.undo"); await command("edit.undo");
    expect(molecule()).toEqual(original);
    Reflect.deleteProperty(navigator, "platform");
  }, 20_000);

  it("keeps the badge clear of a double bond with wide spacing", async () => {
    const doc = drawing("CC=CC", true), mol = getSelectedMolecule(doc)!;
    const bond = mol.bonds.find(b => b.stereo === "either")!;
    const styled = applyMoleculeBondStylePatch(doc, [{ objectId: mol.id, bondId: bond.id }], { bondSpacingMode: "absolute", multipleBondGapPx: 28 });
    await mount(styled);
    const circle = container.querySelector(".native-bond-stereo-marker circle")!;
    const from = mol.atoms.find(a => a.id === bond.fromAtomId)!, to = mol.atoms.find(a => a.id === bond.toAtomId)!;
    const distance = Math.hypot(Number(circle.getAttribute("cx")) + mol.x - (from.x + to.x) / 2,
      Number(circle.getAttribute("cy")) + mol.y - (from.y + to.y) / 2);
    expect(distance).toBeGreaterThan(28 + 6);
  }, 20_000);

  it("a real bond-tool click redraws an either double bond as geometry-defined", async () => {
    const doc = drawing("CC=CC", true);
    await mount(doc, "tool.bond"); await bondClick(molecule(), false);
    expect(molecule().bonds.find(b => b.order === "double")?.stereo).toBeUndefined();
    expect(container.querySelector(".native-bond-stereo-marker")).toBeNull();
    await command("edit.undo"); expect(molecule().bonds.filter(b => b.stereo === "either")).toHaveLength(1);
  }, 20_000);

  it("reapplying double order through the registered hovered-bond command clears the flag", async () => {
    const doc = drawing("CC=CC", true), original = getSelectedMolecule(doc)!;
    await mount(selectDocumentObjects(doc, doc.pages[0].id, [])); await bondClick(original);
    await command("bond.setHoveredBondOrder.double");
    expect(molecule().bonds.find(b => b.order === "double")?.stereo).toBeUndefined();
    expect(parseMolfileGraph(molecule().structure).bonds.every(b => b.stereo === undefined)).toBe(true);
    expect(container.querySelector(".native-bond-stereo-marker")).toBeNull();
  }, 20_000);

  it("the floating bond inspector shows perceived E/Z labels and commits each value command once", async () => {
    const doc = drawing("C/C=C\\C"), mol = getSelectedMolecule(doc)!;
    const bond = mol.bonds.find(b => b.order === "double")!;
    const model = createMoleculeInspectorModel(doc, {
      selectedObjectIds: [], selectedPart: { kind: "bond", objectId: mol.id, bondId: bond.id }
    }, perceiveDoubleBondStereoFromMolfile);
    await act(async () => { root.render(createElement(PaletteWindow, { toolsetId: "core.drawnStructureSettings" })); });
    await act(async () => { await broadcastToolsetTextStyle(createToolsetTextStylePayload(DefaultNativeTextStyle, "normal", undefined, "fill", model)); });
    act(() => container.querySelector<HTMLButtonElement>("#molecule-inspector-tab-structure")!.click());
    const sent: string[] = [];
    const listener = (event: Event) => sent.push((event as CustomEvent<{ commandId: string }>).detail.commandId);
    window.addEventListener(PALETTE_COMMAND_COMMIT_EVENT, listener);
    try {
      for (const title of ["E/Z unspecified", "Use drawn geometry (Z)"]) {
        const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${title}"]`)!;
        expect(button.disabled).toBe(false); act(() => button.click());
      }
      expect(sent).toEqual([moleculeBondStereoCommandId("either"), moleculeBondStereoCommandId("geometry")]);
    } finally { window.removeEventListener(PALETTE_COMMAND_COMMIT_EVENT, listener); }
  }, 20_000);

  it("pastes single and list SMILES with native flags and the exact total notice in status", async () => {
    await mount(createPhase4Document());
    const paste = async (text: string) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { types: ["chemical/x-daylight-smiles"], getData: (requested: string) => requested === "chemical/x-daylight-smiles" ? text : "" } });
      await act(async () => { window.dispatchEvent(event); });
    };
    await paste("CC=CC");
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(container.querySelector('[role="status"]')?.textContent).toContain("E/Z was not specified for 1 double bond(s) in the pasted structure. Confirm the geometry.");
    }, { timeout: 15_000 });
    expect(molecule().bonds.filter(b => b.stereo === "either")).toHaveLength(1);
    await paste("CC=CC\nCC=CC\nC/C=C/C\nCC=O\nCC=C(C)C");
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(container.querySelector('[role="status"]')?.textContent).toContain("E/Z was not specified for 2 double bond(s) in the pasted structure. Confirm the geometry.");
    }, { timeout: 15_000 });
    expect(snapshot().document.pages[0].objects.flatMap(o => o.type === "molecule" ? o.bonds.filter(b => b.stereo === "either") : [])).toHaveLength(3);
  }, 30_000);

  it.each(["text/plain", "chemical/x-daylight-smiles"])("keeps defined E/Z and non-stereogenic bonds without a notice through %s", async type => {
    await mount(createPhase4Document());
    for (const text of ["C/C=C/C", "CC=O", "CC=C(C)C"]) {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { types: [type], getData: (requested: string) => requested === type ? text : "" } });
      const before = snapshot().document.pages[0].objects.length;
      await act(async () => { window.dispatchEvent(event); });
      await vi.waitFor(async () => {
        await act(async () => { await Promise.resolve(); });
        expect(snapshot().document.pages[0].objects, `${text}: ${container.querySelector('[role="status"]')?.textContent}`).toHaveLength(before + 1);
      }, { timeout: 15_000 });
      const pasted = getSelectedMolecule(snapshot().document)!;
      expect(pasted.bonds.every(b => b.stereo === undefined)).toBe(true);
      expect(container.querySelector('[role="status"]')?.textContent).not.toContain("E/Z was not specified");
      if (text === "C/C=C/C") expect(perceiveDoubleBondStereoFromMolfile(pasted.structure)[0].descriptor).toBe("E");
    }
  }, 30_000);
});
