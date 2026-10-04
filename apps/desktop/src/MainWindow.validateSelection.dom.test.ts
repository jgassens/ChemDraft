// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTemplateMolecule } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("Validate Selected Structure", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  function documentWithUnknownBond(): { document: ChemDraftDocument; bondId: string } {
    const withMolecule = insertNativeTemplateMolecule(
      createPhase4Document("Validate unknown bond"),
      { x: 300, y: 300 },
      "cyclohexane"
    );
    const page = withMolecule.pages[0];
    const molecule = page?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected a selected molecule.");
    }
    const bond = molecule.bonds[0];
    if (!bond) {
      throw new Error("Expected a molecule bond.");
    }
    const document: ChemDraftDocument = {
      ...withMolecule,
      pages: withMolecule.pages.map((currentPage) => currentPage.id === page.id
        ? {
            ...currentPage,
            objects: currentPage.objects.map((object) => object.id === molecule.id
              ? {
                  ...molecule,
                  bonds: molecule.bonds.map((currentBond) => currentBond.id === bond.id
                    ? { ...currentBond, order: "unknown" }
                    : currentBond)
                }
              : object)
          }
        : currentPage)
    };
    return { document, bondId: bond.id };
  }

  async function renderMainWindow(initialDocument: ChemDraftDocument) {
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.select",
        initialCrosshairsVisible: false,
        initialDocument,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
    await act(async () => { await Promise.resolve(); });
  }

  it("names the unknown-order bond instead of sending it to the chemistry engine", async () => {
    const { document, bondId } = documentWithUnknownBond();
    await renderMainWindow(document);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, {
        detail: { commandId: "chemistry.validateSelection" }
      }));
      await Promise.resolve();
    });

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      `Cannot write SMILES: bond ${bondId} has an unknown bond order.`
    );
  });
});
