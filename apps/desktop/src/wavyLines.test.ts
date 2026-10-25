import { describe, expect, it } from "vitest";
import { deserializeDocument, serializeDocument, type GraphicObject } from "@chemdraft/chem-core";
import { planNativeArtVisual } from "@chemdraft/art-engine";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { applyGraphicWaveSettingToSelection, createPhase4Document, insertNativeArtGraphicObject } from "./documentWorkflow";
import { objectWaveCommandId, objectWaveForCommand } from "./commands";

function fixture() {
  return insertNativeArtGraphicObject(createPhase4Document("Wave"), { x: 220, y: 180 }, "tool.art.lineWavy");
}
function wave(document: ReturnType<typeof fixture>) { return document.pages[0].objects.find(o => o.type === "graphic") as GraphicObject; }
function path(object: GraphicObject) {
  return planNativeArtVisual(object, { coordinateSpace: "local" }).pathD!;
}

function height(pathD: string) {
  // Each quarter-wave cubic ends at a crest/trough or baseline; inspect those exact authored
  // points rather than an arclength sampler that may skip narrow crests.
  const ys = [...pathD.matchAll(/[MC] ([^MC]+)/g)].map(match => Number(match[1].trim().split(/\s+/).at(-1)));
  return Math.max(...ys) - Math.min(...ys);
}

describe("adjustable wavy lines", () => {
  it("strictly parses bounded commands", () => {
    expect(objectWaveForCommand(objectWaveCommandId("height", 12.5))).toEqual({ setting: "height", value: 12.5 });
    for (const id of ["object.wave.width:0", "object.wave.height:49", "object.wave.smoothness:NaN", "object.wave.width:12px"])
      expect(objectWaveForCommand(id)).toBeUndefined();
  });
  it("persists all settings, exports the shared geometry and leaves the source untouched", () => {
    const original = fixture();
    let edited = applyGraphicWaveSettingToSelection(original, "height", 16);
    edited = applyGraphicWaveSettingToSelection(edited, "width", 24);
    edited = applyGraphicWaveSettingToSelection(edited, "smoothness", 75);
    const reopened = deserializeDocument(serializeDocument(edited));
    expect(wave(reopened).data).toMatchObject({ waveHeight: 16, waveWidth: 24, waveSmoothness: 75 });
    expect(wave(original).data.waveHeight).toBeUndefined();
    expect(exportDocumentToSvg(reopened).contents).toContain(planNativeArtVisual(wave(reopened), { coordinateSpace: 'page' }).pathD!);
    expect(path(wave(reopened))).toBe(path(wave(edited)));
    expect(applyGraphicWaveSettingToSelection(edited, "height", 16)).toBe(edited);
  });
  it("independently changes height, spacing and roundness while pinning endpoints", () => {
    const object: GraphicObject = { ...wave(fixture()), x: 220, y: 180, width: 100, height: 40,
      data: { artPathKind: "wavy", lineStart: { x: 220, y: 200 }, lineEnd: { x: 320, y: 200 }, waveHeight: 16, waveWidth: 25, waveSmoothness: 100 } };
    const smooth = path(object);
    expect(height(smooth)).toBeCloseTo(16, 3);
    expect(height(path({ ...object, data: { ...object.data, waveHeight: 32 } }))).toBeCloseTo(32, 3);
    const angular = path({ ...object, data: { ...object.data, waveSmoothness: 0 } });
    expect(angular).not.toBe(smooth);
    expect(angular.split(" C ").length).toBe(smooth.split(" C ").length);
    expect(path({ ...object, data: { ...object.data, waveWidth: 50 } }).split(" C ").length).toBeLessThan(smooth.split(" C ").length);
    expect(smooth.startsWith("M 0 20")).toBe(true);
    expect(smooth.endsWith("100 20")).toBe(true);
  });
  it("retains dense wave crests with arrowheads and reversed endpoints", () => {
    const object: GraphicObject = { ...wave(fixture()), width: 400, height: 40,
      data: { artPathKind: "wavy", lineStart: { x: 620, y: 200 }, lineEnd: { x: 220, y: 200 }, waveHeight: 16, waveWidth: 4, waveSmoothness: 100,
        markerEnd: { kind: "filled-arrow", sizePx: 12 } } };
    const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
    expect(plan.markerEndTerminal).toBeDefined();
    const ys = [...plan.visiblePathD!.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map(match => Number(match[2]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(16, 1);
    expect(ys.length).toBeGreaterThan(100);
  });
  it("ignores invalid values and non-wave selections", () => {
    const document = fixture();
    expect(applyGraphicWaveSettingToSelection(document, "width", Infinity)).toBe(document);
    const rect = insertNativeArtGraphicObject(document, { x: 360, y: 180 }, "tool.art.rect");
    expect(applyGraphicWaveSettingToSelection(rect, "height", 12)).toBe(rect);
  });
});
