// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, insertNativeBracket, selectDocumentObjects } from "./documentWorkflow";
import { toggleBracketRepeatUnit } from "./bracketCommands";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { writeClipboardText } from "./clipboard";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { invalidCarbonDocument, invalidCarbonWarning } from "../../../packages/document-workflow-core/test/invalidStructureFixtures";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@chemdraft/rdkit-adapter/identifiers", () => ({ computeStructureIdentifiers: vi.fn() }));
vi.mock("./clipboard", async (original) => ({
  ...await original<typeof import("./clipboard")>(), writeClipboardText: vi.fn()
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe("Copy As SMILES status line", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.mocked(writeClipboardText).mockReset().mockResolvedValue(true);
    vi.mocked(computeStructureIdentifiers).mockReset().mockResolvedValue({ smiles: "*C" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  it.each(["smiles", "mol", "molV2000", "cdxml"])("shows suppressed invalidity in Copy As %s status while hiding its badge", async format => {
    vi.mocked(computeStructureIdentifiers).mockResolvedValue(undefined);
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialDocument: invalidCarbonDocument(true), initialActiveToolCommandId: "tool.select",
        initialCrosshairsVisible: false, initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true
      }));
    });
    expect(container.querySelector('[data-invalid-atom-id="a1"]')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: `clipboard.copyAs.${format}` } }));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[role="status"]')?.textContent).toContain(invalidCarbonWarning);
    });
    expect(writeClipboardText).toHaveBeenCalledOnce();
  });
  it.each(["macos", "windows"])("warns on %s when copying only a repeat unit's molecule", async platform => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform === "macos" ? "MacIntel" : "Win32");
    let doc = structuredClone(insertNativeSingleBondMolecule(createPhase4Document("Ethylene repeat unit"), { x: 160, y: 140 }));
    const molecule = doc.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    molecule.bonds[0].order = "double";
    molecule.structure = "C=C";
    doc = toggleBracketRepeatUnit(insertNativeBracket(doc, { x: 100, y: 90 }, "square", { x: 260, y: 200 }));
    doc = selectDocumentObjects(doc, doc.pages[0].id, [molecule.id]);
    vi.mocked(computeStructureIdentifiers).mockResolvedValue({ smiles: "C=C" });
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialActiveToolCommandId: "tool.select", initialCrosshairsVisible: false,
      initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true
    })));
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT,
      { detail: { commandId: "clipboard.copyAs.smiles" } })));
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith("C=C");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("SMILES cannot hold the repeat unit n around 2 atoms");
    vi.restoreAllMocks();
  });
  it.each(["success", "empty", "clipboard unavailable", "clipboard rejection", "unknown order", "second molecule refusal"])("shows specific SMILES status for %s", async (path) => {
    let doc = createPhase4Document("Copy SMILES");
    if (path !== "empty") {
      doc = structuredClone(insertNativeSingleBondMolecule(doc, { x: 300, y: 300 }));
      const mol = doc.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
      mol.atoms[1].element = "Phe";
      if (path === "unknown order") mol.bonds[0].order = "unknown";
      if (path === "second molecule refusal") {
        const second = structuredClone(mol);
        second.id = "refused";
        second.bonds[0].order = "unknown";
        doc.pages[0].objects.push(second);
        doc.selection.objectIds = [mol.id, second.id];
      }
    }
    if (path === "clipboard unavailable") vi.mocked(writeClipboardText).mockResolvedValue(false);
    if (path === "clipboard rejection") vi.mocked(writeClipboardText).mockRejectedValue(new Error("permission denied"));
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialDocument: doc, initialActiveToolCommandId: "tool.select",
        initialCrosshairsVisible: false, initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true
      }));
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "clipboard.copyAs.smiles" } }));
    });
    const expected = path === "empty" ? "Nothing to copy as SMILES"
      : path === "clipboard unavailable" ? "Copy as SMILES failed: clipboard unavailable"
      : path === "clipboard rejection" ? "Copy as SMILES failed: permission denied"
      : path === "unknown order" || path === "second molecule refusal" ? "Copy as SMILES failed: Cannot write SMILES:"
      : "Copied SMILES to clipboard";
    await vi.waitFor(() => {
      const status = container.querySelector('[role="status"]')?.textContent;
      expect(status).toContain(expected);
      expect(status).not.toMatch(/molfile|\bMOL\b|V2000|V3000/i);
      if (["success", "clipboard unavailable", "clipboard rejection", "second molecule refusal"].includes(path)) {
        expect(status).toContain(" — Atom label");
        expect(status).toContain("the label's group is not represented in SMILES.");
      }
      if (path === "unknown order" || path === "second molecule refusal") expect(status).toContain("has an unknown bond order.");
    });
    if (path === "empty" || path === "unknown order" || path === "second molecule refusal") expect(writeClipboardText).not.toHaveBeenCalled();
    else expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith("*C");
  });
});
