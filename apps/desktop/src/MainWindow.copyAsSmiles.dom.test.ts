// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { writeClipboardText } from "./clipboard";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import type { MoleculeObject } from "@chemdraft/chem-core";

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
