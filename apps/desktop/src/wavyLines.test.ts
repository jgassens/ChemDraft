import { describe, expect, it } from "vitest";
import { deserializeDocument, serializeDocument, type GraphicObject } from "@chemdraft/chem-core";
import { planNativeArtVisual } from "@chemdraft/art-engine";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { applyGraphicWaveSettingToSelection, createPhase4Document, insertNativeArtGraphicObject } from "./documentWorkflow";
import { allShellCommands, objectWaveCommandId, objectWaveCommands, objectWaveForCommand } from "./commands";
import { buildGalleryModel } from "./toolbars/CustomizeMainToolbar/galleryModel";
import { createArtInspectorModel, selectedGraphicObjectsForArtInspector } from "./artInspectorModel";
import legacyWavyPaths from "./testSupport/legacyWavyPaths.json";

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
    for (const id of ["object.wave.width:0", "object.wave.height:49", "object.wave.smoothness:NaN", "object.wave.width:12px",
      "object.wave.height:12.25", "object.wave.width:12.5", "object.wave.smoothness:0.5", "object.wave.height:012.5", "object.wave.height:12.50"])
      expect(objectWaveForCommand(id)).toBeUndefined();
  });
  it("keeps every wave value in the shell without flooding the Customize gallery", () => {
    const commands = allShellCommands(fixture());
    expect(objectWaveCommands).toHaveLength(315);
    expect(new Set(objectWaveCommands.map(command => command.id)).size).toBe(315);
    for (const command of objectWaveCommands) {
      expect(objectWaveForCommand(command.id)).toBeDefined();
      expect(commands.find(spec => spec.id === command.id)).toMatchObject({ category: "object-style", source: "core" });
    }
    for (const search of ["", "Wave", "object.wave.height:"]) {
      const gallery = buildGalleryModel(commands, [], new Set(), search);
      expect(gallery.filter(entry => entry.commandId?.startsWith("object.wave."))).toHaveLength(0);
    }
    // Existing style families offer a small preset list, not every possible control value.
    const gallery = buildGalleryModel(commands, [], new Set(), "");
    for (const [prefix, count] of [["object.stroke.width.", 5], ["text.size.", 6],
      ["text.color.", 11], ["object.color.", 11]] as const) {
      expect(gallery.filter(entry => entry.commandId?.startsWith(prefix))).toHaveLength(count);
    }
  });
  it.each(legacyWavyPaths)("keeps main's legacy $name SVG/canvas path data without adding metadata", ({ object: raw, paths }) => {
    // Captured from HEAD^ (78f82a1e), not from the adjustable-wave renderer.
    const object = raw as GraphicObject;
    const document = structuredClone(fixture());
    document.pages[0].objects = [object];
    document.selection.objectIds = [object.id];
    const reopened = deserializeDocument(serializeDocument(document));
    const before = serializeDocument(reopened);
    createArtInspectorModel({ document: reopened, selectedGraphicObjects: selectedGraphicObjectsForArtInspector(reopened), requestedPaintTarget: "stroke" });
    expect(serializeDocument(reopened)).toBe(before);
    expect(wave(reopened).data.waveHeight).toBeUndefined();
    for (const coordinateSpace of ["local", "page"] as const) {
      const plan = planNativeArtVisual(wave(reopened), { coordinateSpace });
      expect(plan.pathD).toBe(paths[coordinateSpace].pathD);
      expect(plan.visiblePathD).toBe(paths[coordinateSpace].visiblePathD);
    }
    expect(exportDocumentToSvg(reopened).contents).toContain(paths.page.visiblePathD ?? paths.page.pathD);
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
  it.each([
    { name: "short", dx: 2, dy: 0 },
    { name: "diagonal", dx: 12, dy: 16 },
    { name: "reversed diagonal", dx: -12, dy: -16 },
    { name: "zero length", dx: 0, dy: 0 }
  ])("keeps finite geometry and pinned endpoints for an adjusted $name line", ({ dx, dy }) => {
    const document = structuredClone(fixture());
    const object = wave(document);
    object.x = 220; object.y = 180; object.width = Math.max(1, Math.abs(dx)); object.height = Math.max(1, Math.abs(dy));
    object.data = { artPathKind: "wavy", lineStart: { x: 220, y: 180 }, lineEnd: { x: 220 + dx, y: 180 + dy } };
    for (const smoothness of [0, 100]) {
      let edited = applyGraphicWaveSettingToSelection(document, "height", 16);
      edited = applyGraphicWaveSettingToSelection(edited, "width", 120);
      edited = applyGraphicWaveSettingToSelection(edited, "smoothness", smoothness);
      const plan = planNativeArtVisual(wave(edited), { coordinateSpace: "page" });
      expect(plan.pathD).toMatch(/^M 220 180 /);
      expect(plan.pathD!.endsWith(`${220 + dx} ${180 + dy}`)).toBe(true);
      expect(plan.pathD).not.toMatch(/NaN|Infinity/);
      expect(exportDocumentToSvg(edited).contents).toContain(plan.pathD!);
    }
  });
  it("ignores invalid values and non-wave selections", () => {
    const document = fixture();
    expect(applyGraphicWaveSettingToSelection(document, "width", Infinity)).toBe(document);
    expect(applyGraphicWaveSettingToSelection(document, "height", 12.25)).toBe(document);
    const rect = insertNativeArtGraphicObject(document, { x: 360, y: 180 }, "tool.art.rect");
    expect(applyGraphicWaveSettingToSelection(rect, "height", 12)).toBe(rect);
  });
});
