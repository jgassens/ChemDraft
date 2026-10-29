// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  depictSmiles2D, ensureOclResources, UnrequestedSmilesHydrogenError, UnrequestedSmilesRadicalError
} from "@chemdraft/ocl-adapter";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, pastedStructureDepictionFromMolfile } from "./documentWorkflow";
import * as depictionClient from "./depiction2d/client";
import { ensureRdkit } from "../../../packages/rdkit-adapter/src/conformer";
import { installDomRdkitLoader } from "./testSupport/rdkitIdentity";
import { loadRdkitWithAppLoader } from "./plugins/rdkitAppLoader";

// Exercise the OCL depiction fallback with a real RDKit identity inspector.
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./plugins/rdkitAppLoader", () => ({ loadRdkitWithAppLoader: vi.fn(async () => ({ ensureRdkit })) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("MainWindow SMILES paste failure notices", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => { installDomRdkitLoader(); await ensureOclResources(); });

  beforeEach(async () => {
    vi.mocked(loadRdkitWithAppLoader).mockClear().mockResolvedValue({ ensureRdkit });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.select",
        initialCrosshairsVisible: false,
        initialDocument: createPhase4Document("SMILES paste errors"),
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function dispatchPaste(text: string, type = "text/plain") {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { types: [type], getData: (requested: string) => requested === type ? text : "" }
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }

  async function paste(
    text: string, type = "text/plain", statusNeedle = new UnrequestedSmilesRadicalError("n1cccc1").message
  ) {
    await act(async () => { dispatchPaste(text, type); });
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(container.querySelector('[role="status"]')?.textContent).toContain(statusNeedle);
    }, { timeout: 15_000, interval: 50 });
    return container.querySelector('[role="status"]')?.textContent;
  }

  it.each(["CCO", "CCO\n"])("pastes %j as text when the injected RDKit loader fails", async text => {
    vi.mocked(loadRdkitWithAppLoader).mockRejectedValueOnce(new Error("test WASM unavailable"));
    const status = await paste(text, "text/plain", "SMILES pasted as text:");
    expect(status).toBe("SMILES pasted as text: the structure could not be verified because " +
      "the RDKit engine did not load: test WASM unavailable");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
    expect(container.querySelectorAll(".text-object")).toHaveLength(1);
  });

  it.each(["N[Pt@SP1](N)(Cl)Cl", "N[Pt@SP1](N)(Cl)Cl\nOC(Cl)=[C@]=C(C)F"])(
    "keeps the text fallback when stereo inspection cannot load RDKit: %s", async text => {
      vi.mocked(loadRdkitWithAppLoader).mockRejectedValue(new Error("test WASM unavailable"));
      const status = await paste(text, "text/plain", "test WASM unavailable");
      expect(status).toContain("pasted as text");
      expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
      expect(container.querySelectorAll(".text-object")).toHaveLength(1);
    });

  it("inserts into the current document after an edit while identity verification waits", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const load = vi.mocked(loadRdkitWithAppLoader);
    const original = load.getMockImplementation()!;
    load.mockImplementationOnce(async loader => { await wait; return original(loader); });
    await act(async () => { dispatchPaste("CCO"); });
    await vi.waitFor(() => { expect(load).toHaveBeenCalled(); });
    await paste("a caption added while waiting", "text/plain", "Pasted editable text");
    const noteId = container.querySelector<HTMLElement>(".text-object")!.dataset.objectId;
    await act(async () => { release(); await wait; });
    await vi.waitFor(() => {
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Pasted SMILES structure");
    });
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(1);
    expect(container.querySelectorAll(".text-object")).toHaveLength(1);
    expect(container.querySelector<HTMLElement>(".text-object")!.dataset.objectId).toBe(noteId);
  });

  it("caps all-failed list reasons and avoids a zero-sized grid success message", async () => {
    vi.spyOn(depictionClient, "depictSmilesOffThread").mockResolvedValue({
      depiction: pastedStructureDepictionFromMolfile(depictSmiles2D("C").molfile), stereoCount: 0
    });
    const status = await paste("CCO\nCCN\nCCC\nCCCl\nCCBr", "text/plain", "No SMILES structures were pasted");
    expect(status).toContain("5 items failed:");
    expect(status).toContain("and 2 more");
    expect(status).not.toContain("CCCl:");
    expect(status).not.toContain("Pasted 0");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
  });

  it("refuses a depiction that loses an isotope without inserting structure or text", async () => {
    vi.spyOn(depictionClient, "depictSmilesOffThread").mockResolvedValueOnce({
      depiction: pastedStructureDepictionFromMolfile(depictSmiles2D("Cc1ccccc1").molfile), stereoCount: 0
    });
    const status = await paste("[13CH3]c1ccccc1", "text/plain", "SMILES paste refused:");
    expect(status).toContain("isotope labels or their positions");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
    expect(container.querySelectorAll(".text-object")).toHaveLength(0);
  }, 20_000);

  it.each([
    ["OC(Cl)=[C@]=C(C)F", "allene (axial)"],
    ["OC(Cl)=[C@@]=C(C)F", "allene (axial)"],
    ["OC(Cl)=[C@AL1]=C(C)F", "allene (axial)"],
    ["OC(Cl)=[C@AL2]=C(C)F", "allene (axial)"],
    ["F/C=C=C=C/F", "cumulene cis/trans"],
    ["F/C=C=C=C\\F", "cumulene cis/trans"],
    ["N[Pt@SP1](N)(Cl)Cl", "square-planar"],
    ["F[P@TB1](Cl)(Br)(N)I", "trigonal-bipyramidal"],
    ["F[Co@OH1](Cl)(Br)(N)(O)I", "octahedral"]
  ])("refuses %s before depiction without inserting structure or text", async (smiles, kind) => {
    const depict = vi.spyOn(depictionClient, "depictSmilesOffThread")
      .mockRejectedValue({ notSmiles: true });
    const status = await paste(smiles, "text/plain", "SMILES paste refused:");
    expect(status).toContain(`${kind} stereochemistry cannot be verified or drawn`);
    expect(depict).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
    expect(container.querySelectorAll(".text-object")).toHaveLength(0);
  }, 20_000);

  it("refuses square-planar input from a SMILES clipboard format", async () => {
    const status = await paste("N[Pt@SP1](N)(Cl)Cl", "chemical/x-daylight-smiles", "SMILES paste refused:");
    expect(status).toContain("square-planar stereochemistry cannot be verified or drawn");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
    expect(container.querySelectorAll(".text-object")).toHaveLength(0);
  }, 20_000);

  it.each([
    ["OC(Cl)=[C@]=C(C)F", "allene (axial)"],
    ["OC(Cl)=[C@AL1]=C(C)F", "allene (axial)"],
    ["F/C=C=C=C/F", "cumulene cis/trans"],
    ["N[Pt@SP1](N)(Cl)Cl", "square-planar"]
  ])("skips only the unverifiable stereo entry in a two-item list: %s", async (smiles, kind) => {
    const status = await paste(`${smiles}\nCCO`, "text/plain", "SMILES paste refused:");
    expect(status).toContain(`1 item failed: ${smiles}`);
    expect(status).toContain(`${kind} stereochemistry cannot be verified or drawn`);
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(1);
    expect(container.querySelectorAll(".text-object")).toHaveLength(0);
  }, 20_000);

  it("refuses an all-unsupported stereo list without falling back to text", async () => {
    const status = await paste("N[Pt@SP1](N)(Cl)Cl\nOC(Cl)=[C@]=C(C)F",
      "text/plain", "No SMILES structures were pasted");
    expect(status).toContain("2 items failed:");
    expect(status).toContain("square-planar stereochemistry");
    expect(status).toContain("allene (axial) stereochemistry");
    expect(status).not.toContain("pasted as text");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
    expect(container.querySelectorAll(".text-object")).toHaveLength(0);
  }, 20_000);

  it("skips only an isotope-losing list entry and names it", async () => {
    const original = depictionClient.depictSmilesOffThread;
    vi.spyOn(depictionClient, "depictSmilesOffThread").mockImplementation((smiles, options) =>
      smiles === "[13CH3]c1ccccc1"
        ? Promise.resolve({
          depiction: pastedStructureDepictionFromMolfile(depictSmiles2D("Cc1ccccc1").molfile),
          stereoCount: 0 })
        : original(smiles, options));
    const status = await paste("[13CH3]c1ccccc1\nCCO\nCCN", "text/plain", "SMILES paste refused:");
    expect(status).toContain("1 item failed: [13CH3]c1ccccc1");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(2);
    expect(container.querySelectorAll(".text-object")).toHaveLength(0);
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

  it("counts C1CC as skipped while placing the other list entries", async () => {
    const status = await paste("CCO\nC1CC\nCCN\nCCC", "text/plain", "1 token skipped");
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
      `No SMILES structures were pasted; 2 items failed: n1cccc1: ` +
      `${new UnrequestedSmilesRadicalError("n1cccc1").message}; c1cccc1: ` +
      `${new UnrequestedSmilesRadicalError("c1cccc1").message}; pasted as text`
    );
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
    expect(container.querySelectorAll(".text-object")).toHaveLength(1);
  }, 20_000);
});
