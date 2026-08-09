// @vitest-environment jsdom

// The selection-aware Main Toolbar style widget swaps layouts inside a *native palette window*.
// mainStyleWidget.dom.test.ts covers the variants themselves; this test covers the seam unique to
// the detached window: PaletteWindow receives the selection model over the text-style broadcast
// (the real window-manager channel — a DOM CustomEvent in jsdom) and renders the matching variant
// with the broadcast values, then drops back to the text layout when a later broadcast carries no
// model (the version-skew/normalization path). The OUTBOUND half of the bridge — a widget control
// invoking a command id back to the main window — is plain `sendPaletteCommand`, Tauri-only IPC
// shared by every toolbar button and untouched by the variant work, so it is not asserted here.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DefaultNativeTextStyle } from "@chemdraft/chem-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaletteWindow } from "./PaletteWindow";
import { createPhase4Document, insertNativeArtGraphicObject } from "./documentWorkflow";
import { createArtInspectorModel, selectedGraphicObjectsForArtInspector } from "./artInspectorModel";
import { classifyToolbarSelection } from "./toolbars/toolbarSelectionKind";
import { broadcastToolsetTextStyle, createToolsetTextStylePayload } from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PaletteWindow main style widget variant bridge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the arrow variant from a broadcast selection model and reverts without one", async () => {
    await act(async () => {
      root.render(createElement(PaletteWindow, { toolsetId: "core.main" }));
    });
    // Let the async listener-attachment effects settle before the main window "broadcasts".
    await act(async () => {
      await Promise.resolve();
    });

    // Before any broadcast: the widget shows the default text layout.
    const widget = () => container.querySelector<HTMLElement>('[data-toolbar-style-controls="main"]');
    expect(widget()?.dataset.mainStyleVariant).toBe("text");

    // Stand in for the main window pushing an arrow selection.
    const arrowDocument = insertNativeArtGraphicObject(
      createPhase4Document("Palette arrow variant"),
      { x: 220, y: 180 },
      "tool.art.reactionArrow"
    );
    const selection = classifyToolbarSelection({ document: arrowDocument, moleculeContext: "none" });
    const artStyle = createArtInspectorModel({
      document: arrowDocument,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(arrowDocument),
      requestedPaintTarget: "fill"
    });
    await act(async () => {
      await broadcastToolsetTextStyle(
        createToolsetTextStylePayload(DefaultNativeTextStyle, "normal", artStyle, "fill", undefined, selection)
      );
    });

    // Receive path: the detached window swapped to the arrow layout with the broadcast values —
    // value fidelity proves the model's contents, not just its shape, survived the bridge.
    expect(widget()?.dataset.mainStyleVariant).toBe("arrow");
    const headKindSelect = container.querySelector<HTMLSelectElement>('[aria-label="Arrowhead style"]');
    if (!headKindSelect) {
      throw new Error("Expected the arrowhead style select to render from the broadcast model.");
    }
    expect(headKindSelect.value).toBe("object.marker.end.kind.filledArrow");
    const headSizeSelect = container.querySelector<HTMLSelectElement>('[aria-label="Arrowhead size"]');
    expect(headSizeSelect?.value).toBe("object.marker.size:16");

    // A follow-up broadcast with no selection model drops back to the text layout.
    await act(async () => {
      await broadcastToolsetTextStyle(createToolsetTextStylePayload(DefaultNativeTextStyle, "normal"));
    });
    expect(widget()?.dataset.mainStyleVariant).toBe("text");
  });
});
