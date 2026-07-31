// @vitest-environment jsdom

// The Molecule Inspector is the plan's hard acceptance test for Phase 4: a selection-driven,
// preview/commit/cancel panel running inside a *native palette window* rather than the main
// window. ToolPalette.dom.test.ts already covers the inspector controls themselves; this test
// covers the seam unique to the native window — that PaletteWindow (a) receives the inspector
// model over the toolset broadcast bridge and renders it, and (b) routes an edit back out to the
// main window over the palette-command bridge. Both halves run through the real window-manager
// event channel (DOM CustomEvents in jsdom), so a regression in either direction fails here.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches, createEmptyDocument, DefaultNativeTextStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaletteWindow } from "./PaletteWindow";
import { createMoleculeInspectorModel } from "./moleculeInspectorModel";
import { moleculeStructureBondLengthCommandId } from "./commands";
import {
  broadcastToolsetTextStyle,
  createToolsetTextStylePayload,
  PALETTE_COMMAND_COMMIT_EVENT,
  PALETTE_COMMAND_EVENT,
  PALETTE_COMMAND_PREVIEW_EVENT
} from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function selectedMoleculeDocument() {
  const document = createEmptyDocument({
    id: "doc_palette_inspector",
    pageId: "page_palette_inspector",
    title: "Palette Inspector"
  });
  const molecule: MoleculeObject = {
    id: "mol_palette",
    type: "molecule",
    x: 120,
    y: 120,
    width: 80,
    height: 40,
    rotation: 0,
    style: {},
    structureFormat: "smiles",
    structure: "CO",
    atoms: [
      { id: "atom_001", element: "C", x: 140, y: 160, formalCharge: 0 },
      { id: "atom_002", element: "O", x: 200, y: 160, formalCharge: 0 }
    ],
    bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }],
    superatoms: [],
    rGroups: []
  };
  return applyPatches(document, [
    { op: "addObject", pageId: document.pages[0].id, object: molecule },
    { op: "setSelection", pageId: document.pages[0].id, objectIds: [molecule.id] }
  ]);
}

describe("PaletteWindow molecule inspector bridge", () => {
  const PALETTE_CHANNELS = [PALETTE_COMMAND_EVENT, PALETTE_COMMAND_PREVIEW_EVENT, PALETTE_COMMAND_COMMIT_EVENT];

  let container: HTMLDivElement;
  let root: Root;
  // Commands routed back to the main window, bucketed by channel. Asserting on the specific channel
  // matters: a numeric edit must COMMIT (persist to the document). If a regression rewired Enter to
  // preview-only, the command would still appear on the preview channel but the user's edit would be
  // silently dropped — so a union assertion would pass green. We assert on the commit channel.
  let commandsByChannel: Map<string, string[]>;
  let listeners: Array<[string, (event: Event) => void]>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    commandsByChannel = new Map(PALETTE_CHANNELS.map((channel) => [channel, []]));
    listeners = PALETTE_CHANNELS.map((channel) => {
      const handler = (event: Event) => {
        const detail = (event as CustomEvent<{ commandId?: string }>).detail;
        if (detail?.commandId) {
          commandsByChannel.get(channel)?.push(detail.commandId);
        }
      };
      window.addEventListener(channel, handler);
      return [channel, handler];
    });
  });

  afterEach(() => {
    for (const [channel, handler] of listeners) {
      window.removeEventListener(channel, handler);
    }
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the broadcast inspector model and commits an edit back to the main window", async () => {
    await act(async () => {
      root.render(createElement(PaletteWindow, { toolsetId: "core.drawnStructureSettings" }));
    });
    // Let the async listener-attachment effects settle before the main window "broadcasts".
    await act(async () => {
      await Promise.resolve();
    });

    const model = createMoleculeInspectorModel(selectedMoleculeDocument(), {
      selectedObjectIds: ["mol_palette"]
    });

    // Stand in for the main window pushing the current selection's inspector model.
    await act(async () => {
      await broadcastToolsetTextStyle(
        createToolsetTextStylePayload(DefaultNativeTextStyle, "normal", undefined, "fill", model)
      );
    });

    // Receive path: the Structure tab's numeric field is enabled only when the broadcast model
    // carried a selected molecule — proof the native window received and applied the model.
    act(() => {
      container
        .querySelector<HTMLButtonElement>("#molecule-inspector-tab-structure")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const bondLengthInput = container.querySelector<HTMLInputElement>('input[aria-label="Target bond length"]');
    if (!bondLengthInput) {
      throw new Error("Expected the Target bond length field to render from the broadcast model.");
    }
    expect(bondLengthInput.disabled).toBe(false);
    // Value fidelity: the field shows the broadcast model's bond length, not a static fallback — so
    // the model's values, not just its shape, survived the bridge.
    const expectedBondLength = model.structure.values.bondLengthPx.value;
    if (expectedBondLength === null) {
      throw new Error("Fixture should yield a single (non-mixed) bond length.");
    }
    expect(Math.round(Number(bondLengthInput.value))).toBe(Math.round(expectedBondLength));

    // Forward path: editing the field COMMITS the command out through the palette bridge (Enter ->
    // onMoleculeInspectorCommit -> sendPaletteCommandCommit -> COMMIT channel) so the main window
    // applies it to the document. A preview-only regression would leave this channel empty.
    act(() => {
      bondLengthInput.value = "20";
      bondLengthInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(commandsByChannel.get(PALETTE_COMMAND_COMMIT_EVENT)).toContain(moleculeStructureBondLengthCommandId(20));
  });
});
