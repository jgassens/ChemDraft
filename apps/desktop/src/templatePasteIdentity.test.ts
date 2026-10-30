// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureRdkit } from "@chemdraft/rdkit-adapter";
import { ensureOclResources, perceiveDoubleBondStereoFromMolfile, perceiveStereoCentersFromMolfile } from "@chemdraft/ocl-adapter";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { resolveStructureTemplateName } from "@chemdraft/document-workflow-core";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { inspectStructureOffThread } from "./depiction2d/identityClient";
import { installDomRdkitLoader } from "./testSupport/rdkitIdentity";

// Keep both depiction and identity verification real; only adapt WASM loading to jsdom.
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./depiction2d/identityClient", async original => {
  const actual = await original<typeof import("./depiction2d/identityClient")>();
  return { inspectStructureOffThread: vi.fn(actual.inspectStructureOffThread) };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("template SMILES paste with chemical identity verification", () => {
  const template = resolveStructureTemplateName("beta-cyclodextrin")!;
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => {
    installDomRdkitLoader();
    await ensureOclResources();
    await ensureRdkit();
  }, 20_000);

  beforeEach(async () => {
    vi.mocked(inspectStructureOffThread).mockClear();
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.select",
        initialCrosshairsVisible: false,
        initialDocument: createPhase4Document("Template identity"),
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
  });

  async function paste(smiles: string) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { types: ["text/plain"], getData: (type: string) => type === "text/plain" ? smiles : "" }
    });
    await act(async () => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(container.querySelector('[role="status"]')?.textContent).toMatch(
        /Pasted SMILES structure|SMILES paste refused:/);
    }, { timeout: 30_000, interval: 50 });
    const status = container.querySelector('[role="status"]')!.textContent!;
    const drawing = getAssistantHistoryPort().read("initial")!;
    const molecule = drawing.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule");
    // The real #245 inspector must see the input, including stereo-free input at output verification.
    expect(inspectStructureOffThread).toHaveBeenCalledWith("smiles", smiles, undefined, undefined);
    expect(container.querySelectorAll(".text-object")).toHaveLength(0);
    return { status, molecule };
  }

  async function canonicalSmiles(value: string) {
    const rdkit = await ensureRdkit();
    const molecule = rdkit.get_mol(value);
    if (!molecule) throw new Error("RDKit could not parse the identity regression structure.");
    try { return molecule.get_smiles!(); }
    finally { molecule.delete(); }
  }

  it.each([
    ["CC=CC", "unspecified"],
    ["C/C=C/C", "E"],
    ["C/C=C\\C", "Z"]
  ] as const)("pastes %s through real identity verification and retains %s E/Z", async (smiles, descriptor) => {
    const { status, molecule } = await paste(smiles);
    const openCount = descriptor === "unspecified" ? 1 : 0;
    expect(status).toContain("Pasted SMILES structure");
    expect(status).not.toContain("refused");
    expect(molecule).toBeDefined();
    expect(molecule!.bonds.filter(bond => bond.stereo === "either")).toHaveLength(openCount);
    expect(parseMolfileGraph(molecule!.structure).bonds.filter(bond => bond.stereo === "either")).toHaveLength(openCount);
    // This API returns only specified parities; an open bond must have no E/Z assignment.
    expect(perceiveDoubleBondStereoFromMolfile(molecule!.structure).map(bond => bond.descriptor))
      .toEqual(descriptor === "unspecified" ? [] : [descriptor]);
    const input = await canonicalSmiles(smiles);
    expect(await canonicalSmiles(molecule!.structure)).toBe(input);
    expect(inspectStructureOffThread).toHaveBeenCalledWith("molfile", expect.any(String), input, undefined);
    expect(status.includes("E/Z was not specified for 1 double bond(s)")).toBe(openCount === 1);
  }, 40_000);

  it("pastes stereo-free beta-CD without a stereo template, invented stereo or refusal", async () => {
    const smiles = template.smiles.replaceAll("@", "");
    const { status, molecule } = await paste(smiles);
    expect(status).not.toContain("refused");
    expect(status).not.toContain("template layout");
    expect(molecule).toBeDefined();
    expect(molecule!.style.source).not.toMatch(/^structure-template:/);
    const output = await canonicalSmiles(molecule!.structure);
    expect(output).toBe(await canonicalSmiles(smiles));
    expect(output).not.toContain("@");
  }, 40_000);

  it("uses the fully specified beta-CD template and preserves all 35 stereocentres", async () => {
    const { status, molecule } = await paste(template.smiles);
    expect(status).not.toContain("refused");
    expect(status).toContain("Used the β-Cyclodextrin template layout");
    expect(molecule!.style.source).toBe(`structure-template:${template.id}`);
    const output = await canonicalSmiles(molecule!.structure);
    expect(output).toBe(await canonicalSmiles(template.smiles));
    expect(output.match(/@+/g)).toHaveLength(35);
    expect(perceiveStereoCentersFromMolfile(molecule!.structure).filter(centre =>
      centre.isStereoCenter && centre.descriptor !== "unspecified")).toHaveLength(35);
  }, 40_000);

  it("never fills in the missing centre of partially specified beta-CD", async () => {
    const smiles = template.smiles.replace(/@+/, "");
    const input = await canonicalSmiles(smiles);
    expect(input.match(/@+/g)).toHaveLength(34);
    const { status, molecule } = await paste(smiles);
    expect(status).not.toContain("template layout");
    if (!molecule) {
      expect(status).toContain("SMILES paste refused:");
      return;
    }
    expect(status).not.toContain("refused");
    expect(molecule.style.source).not.toMatch(/^structure-template:/);
    const output = await canonicalSmiles(molecule.structure);
    expect(output).toBe(input);
    expect(output.match(/@+/g)).toHaveLength(34);
  }, 40_000);
});
