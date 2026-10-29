// @vitest-environment jsdom

import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureOclResources, UnrequestedSmilesHydrogenError, UnrequestedSmilesRadicalError } from "@chemdraft/ocl-adapter";
import * as ocl from "@chemdraft/ocl-adapter";
import * as workflow from "@chemdraft/document-workflow-core";
import { generateSmiles2DMolfile } from "@chemdraft/rdkit-adapter";
import { setRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/conformer";
import * as depictionClient from "./depiction2d/client";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { MainWindow } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";

// Exercise the real paste helper and OCL refusal, with RDKit's unavailable-engine fallback.
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@chemdraft/rdkit-adapter", async original => ({
  ...await original<typeof import("@chemdraft/rdkit-adapter")>(),
  generateSmiles2DMolfile: vi.fn().mockRejectedValue(new Error("WASM unavailable"))
}));
vi.mock("@chemdraft/document-workflow-core", async original => ({
  ...await original<typeof import("@chemdraft/document-workflow-core")>()
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("MainWindow SMILES paste", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => {
    await ensureOclResources();
    const glue = resolve("packages/rdkit-adapter/vendor/RDKit_minimal.js");
    const factory = new Function("require", "__dirname", `${readFileSync(glue, "utf8")}\n;return initRDKitModule;`)(
      createRequire(glue), resolve("packages/rdkit-adapter/vendor"));
    setRdkitModuleLoader(() => factory({
      wasmBinary: new Uint8Array(readFileSync(resolve("packages/rdkit-adapter/vendor/RDKit_minimal.wasm")))
    }));
  });

  beforeEach(async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const drawing = createPhase4Document("SMILES paste");
    drawing.styles.drawing = { ...workflow.documentDrawingDefaults(drawing).drawing, bondLengthPx: 34, bondStrokeWidthPx: 2.4 };
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.select",
        initialCrosshairsVisible: false,
        initialDocument: drawing,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function paste(text: string, type = "text/plain", statusNeedle = new UnrequestedSmilesRadicalError("n1cccc1").message) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { types: [type], getData: (requested: string) => requested === type ? text : "" }
    });
    await act(async () => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(container.querySelector('[role="status"]')?.textContent).toContain(statusNeedle);
    }, { timeout: 15_000, interval: 50 });
    return container.querySelector('[role="status"]')?.textContent;
  }

  it("pastes beta-cyclodextrin once with the active document's style and bond length without coordinate generation", async () => {
    const template = workflow.resolveStructureTemplateName("beta-cyclodextrin")!;
    const before = getAssistantHistoryPort().read("initial")!;
    const defaults = workflow.documentDrawingDefaults(before);
    expect(defaults.bondLengthPx).toBe(34);
    expect(defaults.objectStyle.bondStrokeWidthPx).toBe(2.4);
    const construction = vi.spyOn(workflow, "structureTemplateMolecule");
    const unavailable = () => { throw new Error("Template paste must not generate coordinates"); };
    const oclDepiction = vi.spyOn(ocl, "depictSmiles2D").mockImplementation(unavailable);
    const workerDepiction = vi.spyOn(depictionClient, "depictSmilesOffThread").mockImplementation(unavailable);
    vi.mocked(generateSmiles2DMolfile).mockClear();

    await paste(template.smiles, "text/plain", "Used the β-Cyclodextrin template layout");

    const after = getAssistantHistoryPort().read("initial")!;
    expect(after.pages[0]!.objects).toHaveLength(1);
    const molecule = after.pages[0]!.objects[0]!;
    if (molecule.type !== "molecule") throw new Error("Expected template molecule");
    expect(molecule.style).toMatchObject(defaults.objectStyle);
    expect(molecule.style.source).toBe(`structure-template:${template.id}`);
    const atoms = new Map(molecule.atoms.map(atom => [atom.id, atom]));
    const lengths = molecule.bonds.map(bond => {
      const a = atoms.get(bond.fromAtomId)!, b = atoms.get(bond.toAtomId)!;
      return Math.hypot(a.x - b.x, a.y - b.y);
    });
    expect(lengths.reduce((sum, length) => sum + length, 0) / lengths.length).toBeCloseTo(defaults.bondLengthPx, 6);
    expect(after.selection.objectIds).toEqual([molecule.id]);
    expect(construction).toHaveBeenCalledOnce();
    expect(construction.mock.calls[0]![1].document).toBe(before);
    expect(oclDepiction).not.toHaveBeenCalled();
    expect(workerDepiction).not.toHaveBeenCalled();
    expect(generateSmiles2DMolfile).not.toHaveBeenCalled();
  }, 20_000);

  it.each(["text/plain", "chemical/x-daylight-smiles"])(
    "shows the specific n1cccc1 refusal pasted as %s, while preserving the input as text",
    async (type) => {
      const status = await paste("n1cccc1", type);
      expect(status).toContain("Clipboard SMILES could not be parsed:");
      expect(status).toContain("pasted as text");
      expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
      expect(container.querySelectorAll(".text-object")).toHaveLength(1);
      expect(container.querySelector("[data-object-controls] .text-object-content")?.textContent).toContain("n1cccc1");
    },
    20_000
  );

  it.each([
    ["CCO\nn1cccc1\nCCN\nc1ccccc1", "1 item failed", 3],
    ["CCO\nn1cccc1\nc1cccc1\nCCN\nCCCl\nc1ccccc1", "2 items failed", 4]
  ])("reports refused SMILES only as failures while inserting valid entries from %s", async (text, count, molecules) => {
    const status = await paste(text);
    expect(status).toContain(count);
    expect(status).not.toContain("token skipped");
    expect(status).not.toContain("tokens skipped");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(molecules);
    expect(container.querySelectorAll(".text-object")).toHaveLength(0);
  }, 20_000);

  it("shows an invented-hydrogen refusal for a single paste and preserves the input as text", async () => {
    const message = new UnrequestedSmilesHydrogenError("O=[N]=O", { bracket: "[N]", atomNumber: 2, written: 0, parsed: 1 }).message;
    const status = await paste("O=[N]=O", "text/plain", message);
    expect(status).toContain("Clipboard SMILES could not be parsed:");
    expect(status).toContain("pasted as text");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
    expect(container.querySelectorAll(".text-object")).toHaveLength(1);
  }, 20_000);

  it("reports an invented-hydrogen refusal as a list failure while inserting valid entries", async () => {
    const message = new UnrequestedSmilesHydrogenError("O=[N]=O", { bracket: "[N]", atomNumber: 2, written: 0, parsed: 1 }).message;
    const status = await paste("CCO\nO=[N]=O\nCCN\nc1ccccc1", "text/plain", message);
    expect(status).toContain("1 item failed");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(3);
    expect(container.querySelectorAll(".text-object")).toHaveLength(0);
  }, 20_000);

  it("names the skipped line for C1CC while placing the other list entries", async () => {
    const status = await paste("CCO\nC1CC\nCCN\nCCC", "text/plain", "skipped line 2: 'C1CC' (not valid SMILES)");
    expect(status).not.toContain("failed");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(3);
  }, 20_000);

  it("pastes prose with all-caps acronyms as editable text without a failure notice", async () => {
    const status = await paste("The NMR and HPLC data for THF", "text/plain", "Pasted editable text");
    expect(status).toBe("Pasted editable text");
    expect(status).not.toContain("could not be placed");
    expect(status).not.toContain("failed");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
    expect(container.querySelectorAll(".text-object")).toHaveLength(1);
  }, 20_000);

  it("reports both failures and the first reason when the whole list falls back to text", async () => {
    const status = await paste("n1cccc1\nc1cccc1");
    expect(status).toBe(
      `Clipboard SMILES list could not be placed; 2 items failed: ${new UnrequestedSmilesRadicalError("n1cccc1").message}; pasted as text`
    );
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
    expect(container.querySelectorAll(".text-object")).toHaveLength(1);
  }, 20_000);
});
