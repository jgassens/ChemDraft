import { describe, expect, it, vi } from "vitest";

/**
 * `createArtInspectorModel` is keyed on `document`, which is replaced on every pointermove frame, so
 * every plan it builds is per-frame work. It planned each selected graphic once up front and then
 * called the planless `graphicObjectSupportsMarkers` twice more — the `supportsMarkers` map and
 * `skippedForControl` — planning a selected path two to three times a frame with the answer already
 * in hand. Planning samples path geometry; it is not a lookup.
 *
 * Counted rather than timed: a timing assertion on a machine under load is a flake, and the claim
 * being made here is exactly "once per object", which is countable.
 */
const planSpy = vi.fn();

vi.mock("@chemdraft/art-engine", async () => {
  const actual = await vi.importActual<typeof import("@chemdraft/art-engine")>("@chemdraft/art-engine");
  return {
    ...actual,
    planNativeArtVisual: (...args: Parameters<typeof actual.planNativeArtVisual>) => {
      planSpy(args[0]?.id);
      return actual.planNativeArtVisual(...args);
    }
  };
});

const { createArtInspectorModel } = await import("./artInspectorModel");
const { createEmptyDocument } = await import("@chemdraft/chem-core");
type GraphicObject = import("@chemdraft/chem-core").GraphicObject;

describe("art inspector planning", () => {
  function arrow(id: string): GraphicObject {
    return {
      id,
      type: "graphic",
      x: 100,
      y: 100,
      width: 120,
      height: 24,
      rotation: 0,
      style: { strokeColor: "#111111", strokeWidth: 2 },
      graphicKind: "path",
      data: {
        artPathKind: "line",
        artToolId: "reactionArrow",
        lineStart: { x: 100, y: 112 },
        lineEnd: { x: 220, y: 112 },
        markerEnd: { kind: "filled-arrow", sizePx: 16 }
      }
    } satisfies GraphicObject;
  }

  it("plans each selected graphic exactly once", () => {
    const objects = [arrow("art_1"), arrow("art_2"), arrow("art_3")];
    planSpy.mockClear();

    const model = createArtInspectorModel({
      document: createEmptyDocument({ now: "2026-01-01T00:00:00.000Z" }),
      selectedGraphicObjects: objects,
      requestedPaintTarget: "stroke"
    });

    // The model still answers the marker questions — this is not "fewer plans because less work".
    expect(model.supportsMarkersAll).toBe(true);
    expect(model.markersSupportedCount).toBe(3);
    expect(model.skippedObjectIdsByControl.markers ?? []).toEqual([]);

    expect(planSpy).toHaveBeenCalledTimes(objects.length);
    expect(planSpy.mock.calls.map(([id]) => id).sort()).toEqual(["art_1", "art_2", "art_3"]);
  });
});
