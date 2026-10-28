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
import * as clipboard from "./clipboard";
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
vi.setConfig({ testTimeout: 60_000 });
describe("template SMILES paste", () => {
  // Exact 242-character Windows runbook input, retained here without an external-file dependency.
  const noStereoBetaCd = "C([CH]1[CH]2[CH]([CH]([CH](O1)O[CH]3[CH](O[CH]([CH]([CH]3O)O)O[CH]4[CH](O[CH]([CH]([CH]4O)O)O[CH]5[CH](O[CH]([CH]([CH]5O)O)O[CH]6[CH](O[CH]([CH]([CH]6O)O)O[CH]7[CH](O[CH]([CH]([CH]7O)O)O[CH]8[CH](O[CH](O2)[CH]([CH]8O)O)CO)CO)CO)CO)CO)CO)O)O)O";
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
  it.each([
    ["THF", "text/plain"], ["Hello", "text/plain"],
    ["THF", "chemical/x-daylight-smiles"], ["Hello", "chemical/x-daylight-smiles"]
  ])("pastes %s from %s as editable text without reporting an expected parse rejection", async (text, sourceType) => {
    const { port } = await mount(createEmptyDocument());
    vi.spyOn(depictionClient, "depictSmilesOffThread").mockRejectedValueOnce(
      Object.assign(new Error("SmilesParser: invalid input"), { notSmiles: true })
    );
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: [sourceType],
      getData: (type: string) => type === sourceType ? text : "" } });
    await act(async () => {
      window.dispatchEvent(event);
      await vi.waitFor(() => {
        expect(port.read("initial")!.pages[0]!.objects).toMatchObject([{ type: "text", text }]);
      });
    });
    expect(container.querySelector("[role=status]")?.textContent).toBe("Pasted editable text");
  });
  it("continues a three-item list after an empty depiction and reports its reason", async () => {
    const { port } = await mount(createEmptyDocument());
    const text = "CCO\nCCN\nCCC";
    const depiction = vi.spyOn(depictionClient, "depictSmilesOffThread")
      .mockResolvedValueOnce({ depiction: ocl.depictSmiles2D("CCO"), stereoCount: 0 })
      .mockResolvedValueOnce({ depiction: { atoms: [], bonds: [] }, stereoCount: 0 })
      .mockResolvedValueOnce({ depiction: ocl.depictSmiles2D("CCC"), stereoCount: 0 });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? text : "" } });
    await act(async () => {
      window.dispatchEvent(event);
      await vi.waitFor(() => {
        expect(port.read("initial")!.pages[0]!.objects).toMatchObject([
          { type: "molecule", compatibility: { unknown: { smiles: "CCO" } } },
          { type: "molecule", compatibility: { unknown: { smiles: "CCC" } } }
        ]);
      });
    });
    expect(container.querySelector("[role=status]")?.textContent)
      .toContain("1 item failed: The 2D depiction engine returned no atoms.");
    expect(depiction.mock.calls.map(([smiles]) => smiles)).toEqual(["CCO", "CCN", "CCC"]);
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.undo" } })); });
    expect(port.read("initial")!.pages[0]!.objects).toHaveLength(0);
  });
  it("draws the Windows stereo-free beta-CD input using ordinary depiction", async () => {
    expect(noStereoBetaCd).toHaveLength(242);
    const { port } = await mount(createEmptyDocument());
    Object.defineProperties(container.querySelector(".canvas-region")!, {
      clientWidth: { value: 600 }, clientHeight: { value: 600 }
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? noStereoBetaCd : "" } });
    await act(async () => {
      window.dispatchEvent(event);
      await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects).toHaveLength(1), { timeout: 30_000 });
    });
    const object = port.read("initial")!.pages[0]!.objects[0]!;
    expect(object.type).toBe("molecule");
    expect(object.style.source).not.toMatch(/^structure-template:/);
    if (object.type !== "molecule") throw new Error("Expected ordinary molecule");
    expect(object.atoms).toHaveLength(77);
    expect(object.bonds.filter(bond => bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed")).toHaveLength(0);
    const centers = ocl.perceiveStereoCentersFromMolfile(object.structure).filter(center => center.isStereoCenter);
    expect(centers).toHaveLength(35);
    expect(centers.every(center => center.descriptor === "unspecified")).toBe(true);
    expect(container.querySelector("[role=status]")?.textContent).toContain("Pasted SMILES structure — 77 atoms, 35 unspecified stereocenters");
    expect(container.querySelector("[role=status]")?.textContent).not.toContain("template layout");
  }, 60_000);
  it.each([
    ["C[C@H](F)[C@H](O)[C@H](Cl)Br", "8 atoms, 3 stereocenters"],
    ["CC(F)[C@H](O)C(Cl)Br", "8 atoms, 3 stereocenters (2 unspecified)"],
    ["C[C@H](F)Cl", "4 atoms, 1 stereocenter"]
  ])("reports specified and unspecified stereo honestly for %s", async (smiles, expected) => {
    const { port } = await mount(createEmptyDocument());
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? smiles : "" } });
    await act(async () => {
      window.dispatchEvent(event);
      await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects).toHaveLength(1));
    });
    expect(container.querySelector("[role=status]")?.textContent).toContain(`Pasted SMILES structure — ${expected}`);
  });
  it("names a bad list line in the displayed grid status", async () => {
    const { port } = await mount(createEmptyDocument());
    const text = "CCO\nC1CC(\nCCN";
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? text : "" } });
    await act(async () => {
      window.dispatchEvent(event);
      await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects).toHaveLength(2));
    });
    expect(container.querySelector("[role=status]")?.textContent)
      .toContain("grid; skipped line 2: 'C1CC(' (not valid SMILES)");
  });
  it.each(["2D depiction exceeded its 2000 ms layout deadline before a standard layout was available.",
    "The 2D depiction worker failed to load."])("shows a specific failure for the Windows input: %s", async reason => {
    const { port } = await mount(createEmptyDocument());
    vi.spyOn(depictionClient, "depictSmilesOffThread").mockRejectedValueOnce(new Error(reason));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? noStereoBetaCd : "" } });
    await act(async () => { window.dispatchEvent(event); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.querySelector("[role=status]")?.textContent)
        .toContain(`Clipboard SMILES could not be placed: ${reason}`);
    }, { timeout: 10_000 });
    expect(port.read("initial")!.pages[0]!.objects).toHaveLength(0);
  });
  it("reports an empty depiction instead of silently dropping a SMILES paste", async () => {
    await mount(createEmptyDocument());
    vi.spyOn(depictionClient, "depictSmilesOffThread").mockResolvedValueOnce({
      depiction: { atoms: [], bonds: [] }, stereoCount: 0
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? noStereoBetaCd : "" } });
    await act(async () => { window.dispatchEvent(event); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.querySelector("[role=status]")?.textContent)
        .toContain("Clipboard SMILES could not be placed: The 2D depiction engine returned no atoms.");
    });
  });
  it.each([false, true])("reports native clipboard %s failure/empty content", async empty => {
    await mount(createEmptyDocument());
    const read = vi.spyOn(clipboard, "readClipboardPayload");
    if (empty) read.mockResolvedValueOnce({ types: [], textItems: [] });
    else read.mockRejectedValueOnce(new Error("Windows clipboard is unavailable"));
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "clipboard.paste" } }));
    });
    expect(container.querySelector("[role=status]")?.textContent).toContain(empty
      ? "Couldn't paste: the clipboard contains no supported drawing or text content."
      : "Couldn't read the clipboard: Windows clipboard is unavailable");
  });
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
      await vi.waitFor(() => expect(port.read("initial")!.pages[0]!.objects,
        container.querySelector("[role=status]")?.textContent ?? "missing status").toHaveLength(count), { timeout: 10_000 });
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
