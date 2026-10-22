import { describe, expect, it } from "vitest";
import { createViewportState, zoomViewportAtPoint } from "@chemdraft/viewport-engine";
import { DOCUMENT_ZOOM_PRESETS, documentZoomActions, documentZoomCommandId, documentZoomScaleForCommand,
  isDocumentZoomState, normalizeDocumentZoomRange, documentZoomClientCenter, documentZoomStepScale } from "./documentZoom";
import { allShellCommands } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { getToolsetItemGroups } from "./toolsets";
import { TOOLBAR_WIDGET_GRID_SPANS, TOOLBAR_WIDGET_IDS } from "./toolbars/toolbarWidgets";

describe("document zoom controls", () => {
  it("walks the agreed button steps in both directions and stays at the limits", () => {
    const stops = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8.5];
    for (const [index, scale] of stops.entries()) {
      const viewport = createViewportState({ scale });
      expect(documentZoomStepScale(viewport, 1)).toBe(stops[Math.min(index + 1, stops.length - 1)]);
      expect(documentZoomStepScale(viewport, -1)).toBe(stops[Math.max(index - 1, 0)]);
      expect(viewport.scale).toBe(scale);
    }
  });
  it("chooses the next stop from smooth zoom values and respects custom limits", () => {
    expect(documentZoomStepScale(createViewportState({ scale: 1.5625 }), 1)).toBe(2);
    expect(documentZoomStepScale(createViewportState({ scale: 1.5625 }), -1)).toBe(1.5);
    expect(documentZoomStepScale(createViewportState({ scale: 1.250000000001 }), -1)).toBe(1);
    expect(documentZoomStepScale(createViewportState({ scale: 0.3, minZoom: 0.3, maxZoom: 3.5 }), -1)).toBe(0.3);
    expect(documentZoomStepScale(createViewportState({ scale: 3, minZoom: 0.3, maxZoom: 3.5 }), 1)).toBe(3.5);
  });
  it("centers the visible client area, excluding scrollbars, borders and rulers", () => {
    const canvas = { clientLeft: 2, clientTop: 3, clientWidth: 1000, clientHeight: 700 };
    expect(documentZoomClientCenter({ left: 140, top: 90 }, canvas, 32)).toEqual({ x: 658, y: 459 });
    expect(documentZoomClientCenter({ left: 140, top: 90 }, canvas, 0)).toEqual({ x: 642, y: 443 });
  });
  it.each(DOCUMENT_ZOOM_PRESETS)("registers the exact %s%% preset and supports its scale", percent => {
    const id = documentZoomCommandId(percent);
    expect(documentZoomScaleForCommand(id)).toBe(percent / 100);
    expect(allShellCommands(createPhase4Document("Zoom"), undefined).some(command => command.id === id)).toBe(true);
    expect(zoomViewportAtPoint(createViewportState(), percent / 100, { x: 100, y: 100 }).scale).toBe(percent / 100);
  });
  it("rejects unregistered values and malformed state, and normalizes old view limits", () => {
    for (const command of ["view.zoomPercent.0", "view.zoomPercent.9999", "view.zoomPercent.25x", "view.zoomPercent.025", "view.zoomIn"]) {
      expect(documentZoomScaleForCommand(command)).toBeUndefined();
    }
    expect(documentZoomActions).toHaveLength(6);
    for (const state of [null, {}, { scale: NaN, minZoom: 0.25, maxZoom: 8.5 },
      { scale: 1, minZoom: 2, maxZoom: 1 }, { scale: 0, minZoom: 0, maxZoom: 4 }]) expect(isDocumentZoomState(state)).toBe(false);
    const old = createViewportState({ scale: 2, minZoom: 0.5, maxZoom: 3 });
    expect(normalizeDocumentZoomRange(old)).toMatchObject({ scale: 2, minZoom: 0.25, maxZoom: 4 });
    expect(old.minZoom).toBe(0.5);
    expect(isDocumentZoomState(createViewportState())).toBe(true);
  });
  it("ships a customizable grid widget on Main only", () => {
    expect(getToolsetItemGroups("core.main")[0][0].id).toBe(TOOLBAR_WIDGET_IDS.documentZoom);
    expect(getToolsetItemGroups("core.main").flat().find(item => item.id === TOOLBAR_WIDGET_IDS.documentZoom))
      .toMatchObject({ kind: "control", layout: { colSpan: 6, rowSpan: 1 } });
    expect(getToolsetItemGroups("core.art").flat().some(item => item.id === TOOLBAR_WIDGET_IDS.documentZoom)).toBe(false);
    expect(TOOLBAR_WIDGET_GRID_SPANS[TOOLBAR_WIDGET_IDS.documentZoom]).toEqual({ colSpan: 6, rowSpan: 1 });
  });
});
