// @vitest-environment jsdom
import { act } from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, DocumentStylePreset, type ChemDraftDocument } from "@chemdraft/chem-core";
import * as workflow from "@chemdraft/document-workflow-core";
import * as ocl from "@chemdraft/ocl-adapter";
import * as rdkit from "@chemdraft/rdkit-adapter";
import * as depictionClient from "./depiction2d/client";
import { resolveStructureTemplateName } from "@chemdraft/document-workflow-core";
import { setRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/conformer";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { MainWindow } from "./MainWindow";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./plugins/rdkitAppLoader", () => ({ loadRdkitWithAppLoader: (load: () => Promise<unknown>) => load() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("@chemdraft/document-workflow-core", async original => ({ ...await original<typeof import("@chemdraft/document-workflow-core")>() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
let root: Root;
let container: HTMLDivElement;
describe("template SMILES paste", () => {
  beforeEach(() => {
    const glue = resolve("packages/rdkit-adapter/vendor/RDKit_minimal.js");
    const factory = new Function("require", "__dirname", `${readFileSync(glue, "utf8")}\n;return initRDKitModule;`)(createRequire(glue), resolve("packages/rdkit-adapter/vendor"));
    setRdkitModuleLoader(() => factory({ wasmBinary: new Uint8Array(readFileSync(resolve("packages/rdkit-adapter/vendor/RDKit_minimal.wasm"))) }));
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function mount(drawing: ChemDraftDocument) {
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    return { port: getAssistantHistoryPort() };
  }
  it("assigns distinct IDs to successive single-template pastes and undoes only the last paste", async () => {
    const { port } = await mount(createEmptyDocument());
    // jsdom has no layout; give paste a visible centre inside the page so the page-fit
    // confirmation does not intercept the next clipboard event.
    Object.defineProperties(container.querySelector(".canvas-region")!, {
      clientWidth: { value: 600 }, clientHeight: { value: 600 }
    });
    const template = resolveStructureTemplateName("18-crown-6")!;
    for (const count of [1, 2]) {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
        getData: (type: string) => type === "text/plain" ? template.smiles : "" } });
      await act(async () => {
        window.dispatchEvent(event);
        await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects).toHaveLength(count));
      });
    }
    const after = port.read("initial")!;
    const objects = after.pages[0]!.objects;
    expect(new Set(objects.map(object => object.id)).size).toBe(2);
    expect(after.selection.objectIds).toEqual([objects[1]!.id]);
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.undo" } })); });
    expect(port.read("initial")!.pages[0]!.objects).toEqual([objects[0]]);
  });
  it.each([1, 2])("constructs each of %i template entries once without generic depiction, with selection and one undo", async count => {
    const { port } = await mount(createEmptyDocument());
    const construction = vi.spyOn(workflow, "structureTemplateMolecule");
    const unavailable = () => { throw new Error("Generic depiction must not run for a template"); };
    const oclDepiction = vi.spyOn(ocl, "depictSmiles2D").mockImplementation(unavailable);
    const rdkitDepiction = vi.spyOn(rdkit, "generateSmiles2DMolfile").mockImplementation(unavailable);
    const workerDepiction = vi.spyOn(depictionClient, "depictSmilesOffThread").mockImplementation(unavailable);
    const template = resolveStructureTemplateName("beta-cyclodextrin")!;
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? Array(count).fill(template.smiles).join("\n") : "" } });
    await act(async () => {
      window.dispatchEvent(event);
      await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects).toHaveLength(count));
    });
    const after = port.read("initial")!;
    expect(new Set(after.selection.objectIds).size).toBe(count);
    expect(after.selection.objectIds).toEqual(after.pages[0]!.objects.map(object => object.id));
    expect(after.pages[0]!.objects.every(object => object.style.source === `structure-template:${template.id}`)).toBe(true);
    expect(container.querySelector("[role=status]")?.textContent).toContain("Used the β-Cyclodextrin template layout");
    expect(container.querySelector("[role=status]")?.textContent?.match(/Used the β-Cyclodextrin template layout/g)).toHaveLength(1);
    expect(construction).toHaveBeenCalledTimes(count);
    expect(oclDepiction).not.toHaveBeenCalled();
    expect(rdkitDepiction).not.toHaveBeenCalled();
    expect(workerDepiction).not.toHaveBeenCalled();
    for (const [index, object] of after.pages[0]!.objects.entries()) {
      if (object.type !== "molecule") throw new Error("Expected template molecule");
      const built = construction.mock.results[index]!.value;
      expect(object.structure).toBe(built.structure);
      expect(object.bonds).toEqual(built.bonds);
      expect(object.style.bondLengthPx).toBe(DocumentStylePreset.drawing.bondLengthPx);
      // Grid placement may translate, but never rescale or regenerate the authored geometry.
      object.atoms.forEach((atom, atomIndex) => {
        expect(atom.x - object.x).toBeCloseTo(built.atoms[atomIndex]!.x - built.x, 8);
        expect(atom.y - object.y).toBeCloseTo(built.atoms[atomIndex]!.y - built.y, 8);
      });
      expect(object.bonds.some(bond => bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed")).toBe(true);
      if (count === 1) {
        const stereoCount = ocl.perceiveStereoCentersFromMolfile(object.structure)
          .filter(centre => centre.isStereoCenter && centre.descriptor !== "unspecified").length;
        expect(container.querySelector("[role=status]")?.textContent).toContain(`${stereoCount} stereocenters`);
      }
    }
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.undo" } })); });
    expect(port.read("initial")!.pages[0]!.objects).toHaveLength(0);
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.redo" } })); });
    expect(port.read("initial")!.pages[0]!.objects).toEqual(after.pages[0]!.objects);
    expect(construction).toHaveBeenCalledTimes(count);
  }, 60_000);

});
