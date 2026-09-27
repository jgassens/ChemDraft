// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createEmptyDocument, moleculeToMolfileV2000, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { massAnalyzeCommandId } from "@chemdraft/plugin-mass-fragment";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { describe, expect, it, vi } from "vitest";
import { MainWindow, nativeMoleculeRingSelectionFromPointerTarget, spin3dHydrogenWarnings, spin3dPrefetchMolfile } from "./MainWindow";
import { nativeMoleculeInvalidAtomStates } from "./documentWorkflow";
import { buildPluginSelectionSnapshot } from "./plugins/selectionSnapshot";
import type { PluginRuntimeProviders } from "./plugins/usePluginRuntime";

const pluginCalls = vi.hoisted(() => ({
  providers: undefined as PluginRuntimeProviders | undefined,
  invoke: undefined as (() => Promise<unknown>) | undefined
}));
vi.mock("./plugins/usePluginRuntime", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plugins/usePluginRuntime")>();
  return { ...original, usePluginRuntime: (providers: PluginRuntimeProviders) => {
    pluginCalls.providers = providers;
    const runtime = original.usePluginRuntime(providers);
    return { ...runtime, invokePluginCommand: pluginCalls.invoke ?? runtime.invokePluginCommand };
  } };
});
vi.mock("./plugins/selectionSnapshot", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plugins/selectionSnapshot")>();
  return { ...original, buildPluginSelectionSnapshot: vi.fn(original.buildPluginSelectionSnapshot) };
});

describe("aromatic warnings at the plugin action boundary", () => {
  it.each([true, false])("reuses the command's selection read for warnings (reads selection: %s)", async (readsSelection) => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
    window.ResizeObserver ??= TestResizeObserver as typeof ResizeObserver;
    globalThis.ResizeObserver ??= TestResizeObserver as typeof ResizeObserver;
    window.requestAnimationFrame ??= (callback) => window.setTimeout(() => callback(Date.now()), 0);
    window.cancelAnimationFrame ??= (id) => window.clearTimeout(id);
    const molecule: MoleculeObject = { id: "unresolved", type: "molecule", x: 0, y: 0, width: 100,
      height: 100, rotation: 0, style: {}, structureFormat: "molfile-v2000", structure: "",
      superatoms: [], rGroups: [], ...testMoleculeFromSmiles("c1cccc1") };
    const source = createEmptyDocument();
    source.pages[0]!.objects = [molecule];
    source.selection.objectIds = [molecule.id];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const invoke = vi.fn(async () => {
      if (readsSelection) expect(pluginCalls.providers!.getSelection().molecules).toHaveLength(1);
      return { ok: true };
    });
    pluginCalls.invoke = invoke;
    const status = () => container.querySelector('[role="status"]')?.textContent;
    const click = async (selector: string) => {
      const button = container.querySelector(selector);
      expect(button).not.toBeNull();
      await act(async () => {
        button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
    };
    try {
      await act(async () => {
        root.render(createElement(MainWindow, { initialDocument: source, initialPaletteMode: "hidden",
          initialRulersVisible: false, nativePalette: false }));
      });
      const before = status();
      await act(async () => {
        for (let read = 0; read < 3; read += 1) {
          expect(pluginCalls.providers!.getSelection().molecules[0]!.structure).toContain("V2000");
        }
      });
      expect(status()).toBe(before);
      await click('button[data-menu-section="analyze"]');
      const snapshotsBefore = vi.mocked(buildPluginSelectionSnapshot).mock.calls.length;
      await click(`button[data-command-id="${massAnalyzeCommandId}"]`);
      expect(invoke).toHaveBeenCalledOnce();
      expect(vi.mocked(buildPluginSelectionSnapshot).mock.calls.length - snapshotsBefore).toBe(readsSelection ? 1 : 0);
      if (readsSelection) {
        expect(status()).toContain("no resolved Kekulé order");
        expect(status()).toContain("preserved as type 4");
      } else {
        expect(status()).toBe(before);
      }
    } finally {
      act(() => root.unmount());
      container.remove();
      pluginCalls.invoke = undefined;
      pluginCalls.providers = undefined;
    }
  });
});

describe("Spin 3D speculative structure reliability", () => {
  it.each([
    ["unresolved aromatic ring", "c1cccc1", false],
    ["unique pyrrole N–H", "c1ccnc1", true],
    ["unique indole N–H", "c1ccc2nccc2c1", true],
    ["unique imidazole N–H", "c1c[n]cn1", true],
    ["unique imidazole N–H with an explicit double bond", "c1cn=cn1", true],
    ["guessed tautomer", "c1cncn1", false],
    ["declined purine N–H", "O=c1nc(=O)c2ncnc2n1", false],
    ["stated hydrogen", "c1cc[nH]c1", true],
    ["dative flattening", "N->[Zn]", true],
    ["settled aromatic ring", "c1ccccc1", true]
  ] as const)("%s: prefetch eligibility follows chemistry, not generic writer warnings", (_name, smiles, eligible) => {
    const molecule: MoleculeObject = { id: "prefetch", type: "molecule", x: 0, y: 0, width: 100,
      height: 100, rotation: 0, style: {}, structureFormat: "molfile-v2000", structure: "",
      superatoms: [], rGroups: [], ...testMoleculeFromSmiles(smiles) };
    const written = moleculeToMolfileV2000(molecule, {
      fromDocFrame: true, kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders
    });
    if (smiles.includes("->")) expect(written.warnings.length).toBeGreaterThan(0);
    expect(spin3dPrefetchMolfile(molecule)).toBe(eligible ? written.contents : undefined);
  });

  it.each([
    ["pyrrole", "c1ccnc1"],
    ["indole", "c1ccc2nccc2c1"],
    ["imidazole with one N's H stated", "c1c[n]cn1"],
    ["imidazole with one explicit double bond", "c1cn=cn1"]
  ])("%s: unique inferred N–H stays badged but contributes no guessed-H Spin status", (_name, smiles) => {
    const molecule: MoleculeObject = { id: "unique", type: "molecule", x: 0, y: 0, width: 100,
      height: 100, rotation: 0, style: {}, structureFormat: "molfile-v2000", structure: "",
      superatoms: [], rGroups: [], ...testMoleculeFromSmiles(smiles) };
    expect(nativeMoleculeInvalidAtomStates(molecule).filter((state) => state.tautomerGuessed)).toHaveLength(1);
    expect(spin3dHydrogenWarnings(molecule)).toEqual([]);
  });

  it("an ambiguous imidazole retains its guessed-H Spin warning", () => {
    const molecule: MoleculeObject = { id: "ambiguous", type: "molecule", x: 0, y: 0, width: 100,
      height: 100, rotation: 0, style: {}, structureFormat: "molfile-v2000", structure: "",
      superatoms: [], rGroups: [], ...testMoleculeFromSmiles("c1cncn1") };
    expect(spin3dHydrogenWarnings(molecule)).toHaveLength(2);
    expect(spin3dHydrogenWarnings(molecule).every((warning) => warning.includes("hydrogen count was guessed"))).toBe(true);
  });

  it("still prefetches an abbreviation serialized as a dummy atom", () => {
    const graph = testMoleculeFromSmiles("CC");
    graph.atoms[1]!.element = "Ph";
    const molecule: MoleculeObject = { id: "abbreviation", type: "molecule", x: 0, y: 0, width: 100,
      height: 100, rotation: 0, style: {}, structureFormat: "molfile-v2000", structure: "",
      superatoms: [], rGroups: [], ...graph };
    const written = moleculeToMolfileV2000(molecule, {
      fromDocFrame: true, kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders
    });
    expect(written.warnings.length).toBeGreaterThan(0);
    expect(spin3dPrefetchMolfile(molecule)).toBe(written.contents);
  });
});

describe("aromatic warning marker explanations", () => {
  it("leaves the ring hit target under a badge available to the shipped picking path", () => {
    const graph = testMoleculeFromSmiles("c1cccc1");
    const molecule: MoleculeObject = {
      id: "badged-ring", type: "molecule", x: 0, y: 0, width: 200, height: 200,
      rotation: 0, style: {}, structureFormat: "molfile-v2000", structure: "",
      superatoms: [], rGroups: [], bonds: graph.bonds,
      atoms: graph.atoms.map((atom, index) => ({ ...atom,
        x: 100 + 40 * Math.cos(3 * Math.PI / 4 + index * 2 * Math.PI / 5),
        y: 100 + 40 * Math.sin(3 * Math.PI / 4 + index * 2 * Math.PI / 5)
      }))
    };
    const source = createEmptyDocument();
    source.pages[0]!.objects = [molecule];
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(createElement(MainWindow, {
      initialDocument: source, initialPaletteMode: "hidden", nativePalette: true
    }));
    const style = document.createElement("style");
    style.textContent = readFileSync("apps/desktop/src/App.css", "utf8")
      .match(/\.native-atom-invalid-marker\s*\{[^}]+\}/)![0];
    document.body.append(style, container);
    try {
      const marker = container.querySelector(".native-atom-invalid-marker")!;
      expect(getComputedStyle(marker).pointerEvents).toBe("none");
      const ringTarget = container.querySelector(".native-molecule-ring-hit-target")!;
      const atom = molecule.atoms[0]!;
      const hit = nativeMoleculeRingSelectionFromPointerTarget(molecule, ringTarget, { x: atom.x + 9, y: atom.y - 9 });
      expect(hit).toMatchObject({ objectId: molecule.id, kind: "ring", ringKey: ringTarget.getAttribute("data-ring-hit-key") });
    } finally {
      style.remove();
      container.remove();
    }
  });
  it.each([
    ["guessed tautomer", "Cc1cncn1", "hydrogen count was guessed"],
    ["unresolved ring", "c1cccc1", "could not be resolved"],
    ["impossible stated H", "c1cc[nH2]c1", "states 2 hydrogens"]
  ])("shows the existing %s reason in the valence marker tooltip", (_name, smiles, reason) => {
    const molecule: MoleculeObject = {
      id: "warning-molecule", type: "molecule", x: 0, y: 0, width: 100, height: 100,
      rotation: 0, style: {}, structureFormat: "molfile-v2000", structure: "",
      superatoms: [], rGroups: [], ...testMoleculeFromSmiles(smiles)
    };
    const document = createEmptyDocument({ title: "Aromatic warning" });
    document.pages[0]!.objects = [molecule];
    const markup = renderToStaticMarkup(createElement(MainWindow, {
      initialDocument: document, initialPaletteMode: "hidden", nativePalette: true
    }));
    const markers = [...markup.matchAll(/<g class="native-atom-invalid-marker"[^>]*>([\s\S]*?)<\/g>/g)];
    const warnings = nativeMoleculeInvalidAtomStates(molecule);
    expect(markers).toHaveLength(warnings.length);
    expect(markers.some((marker) => marker[1]!.includes(reason))).toBe(true);
    for (const [index, warning] of warnings.entries()) {
      expect(markers[index]![1]).toContain(`<title>${warning.invalidReason}</title>`);
      expect(markers[index]![0]).not.toContain("pointer-events:all");
    }
  });
});
