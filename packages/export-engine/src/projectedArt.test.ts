import { createEmptyDocument, type ArrowObject, type BracketObject } from "@chemdraft/chem-core";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { exportDocumentToSvg } from "./index";

const base = { id: "projected-art", x: 100, y: 100, width: 120, height: 24, rotation: 0, style: {} };
const arrow: ArrowObject = { ...base, type: "reaction-arrow", arrowKind: "forward", labels: [],
  start: { kind: "point", point: { x: 100, y: 112 } },
  end: { kind: "point", point: { x: 220, y: 112 } } };
const bracket: BracketObject = { ...base, type: "bracket", bracketKind: "square", containedObjectIds: [] };

function svg(object: ArrowObject | BracketObject) {
  const document = createEmptyDocument({ title: "Projection" });
  document.pages[0]!.objects = [object];
  return exportDocumentToSvg(document).contents;
}

describe("projected reaction arrows and brackets", () => {
  function horizontalInkWidth(output: string, x: number, y: number) {
    const scale = 8;
    const crop = output.replace(/<svg\b[^>]*>/,
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="4" viewBox="${x - 5} ${y - 2} 10 4">`);
    const raster = new Resvg(crop, { background: "white", fitTo: { mode: "zoom", value: scale } }).render();
    let coverage = 0;
    for (let column = 0; column < raster.width; column++) {
      // The authored ink is #172026 (red = 23), rather than pure black.
      coverage += (255 - raster.pixels[(2 * scale * raster.width + column) * 4]!) / (255 - 23);
    }
    return coverage / scale;
  }

  it("keeps a tilted vertical bracket stroke at 1.5 units in the rendered export", () => {
    expect(horizontalInkWidth(svg({ ...bracket, style: { tiltYDegrees: 60 } }), 130, 112)).toBeCloseTo(1.5, 1);
  });

  it.each(["square", "round", "curly", "polymer", "unknown"] as const)(
    "projects %s bracket points without scaling the stroke", bracketKind => {
      const output = svg({ ...bracket, bracketKind, rotation: 37, style: { tiltXDegrees: 30, tiltYDegrees: 60 } });
      expect(output).not.toContain('transform="matrix(');
      expect(output.match(/<path\b[^>]*>/)![0]).toContain('stroke-width="1.5"');
    }
  );

  it.each(["forward", "resonance", "equilibrium", "retrosynthesis", "unknown"] as const)(
    "keeps a rotated, tilted %s arrow shaft at 1.5 units in the rendered export", arrowKind => {
      const object = { ...arrow, arrowKind, rotation: 90, style: { tiltYDegrees: 60 } };
      const output = svg(object);
      expect(output).not.toContain('transform="matrix(');
      const shaftX = arrowKind === "equilibrium" ? 161.5 : arrowKind === "retrosynthesis" ? 161.25 : 160;
      // Parallel arrows are sampled away from the neighboring shaft.
      const isolatedShaft = output.replace(/<line\b[^>]*>/g, (line, offset) =>
        offset === output.indexOf("<line") ? line : "").replace(/<polygon\b[^>]*\/>/g, "");
      expect(horizontalInkWidth(isolatedShaft, shaftX, 112)).toBeCloseTo(1.5, 1);
    }
  );

  it.each(["square", "round", "curly", "polymer", "unknown"] as const)(
    "keeps untilted %s bracket serialization byte-identical", bracketKind => {
      for (const rotation of [0, 90, 37]) {
        expect(svg({ ...bracket, bracketKind, rotation })).toMatchSnapshot(`rotation ${rotation}`);
        expect(svg({ ...bracket, bracketKind, rotation, style: { tiltXDegrees: 0, tiltYDegrees: 0 } }))
          .toBe(svg({ ...bracket, bracketKind, rotation }));
      }
    }
  );

  it.each(["forward", "resonance", "equilibrium", "retrosynthesis", "unknown"] as const)(
    "projects every shaft and head of a %s arrow while keeping the old canvas stroke width", arrowKind => {
      const output = svg({ ...arrow, arrowKind, style: { tiltYDegrees: 60 } });
      const lines = [...output.matchAll(/<line\b[^>]*>/g)].map(match => match[0]);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines.slice(0, arrowKind === "retrosynthesis" ? 2 : lines.length)) {
        expect(line).toContain('x1="130"');
        expect(line).toContain(arrowKind === "retrosynthesis" ? 'x2="188.5"' : 'x2="190"');
        expect(line).toContain('stroke-width="1.5"');
      }
      for (const line of lines) {
        for (const attr of ["x1", "x2"]) {
          const x = Number(line.match(new RegExp(`${attr}="([^"]+)"`))![1]);
          expect(x).toBeGreaterThanOrEqual(130);
          expect(x).toBeLessThanOrEqual(190);
        }
      }
      // All head vertices are projected too, rather than moving just the endpoints.
      const points = [...output.matchAll(/<polygon\b[^>]*points="([^"]+)"/g)]
        .flatMap(match => match[1]!.split(" ").map(point => Number(point.split(",")[0])));
      expect(points.every(x => x >= 130 && x <= 190)).toBe(true);
    }
  );

  it.each(["square", "round", "curly", "polymer", "unknown"] as const)(
    "projects a %s bracket around its center", bracketKind => {
      const output = svg({ ...bracket, bracketKind, style: { tiltYDegrees: 60 } });
      expect(output).not.toContain('transform="matrix(');
      expect(output).toContain('d="M 189.5 100');
      const raster = new Resvg(output, { background: "white" }).render();
      const darkNear = (x: number, y: number) => {
        for (let row = y - 2; row <= y + 2; row++) {
          for (let column = x - 2; column <= x + 2; column++) {
            if (raster.pixels[(row * raster.width + column) * 4]! < 160) return true;
          }
        }
        return false;
      };
      expect(darkNear(189, 100)).toBe(true);
      expect(darkNear(219, 100)).toBe(false);
    }
  );

  it("applies in-plane rotation before screen-space Y and X tilt", () => {
    // Rz(90), Ry(60), Rx(30) maps (-60, 0) to (0, -30*sqrt(3)) about (160,112).
    const output = svg({ ...arrow, rotation: 90, style: { tiltXDegrees: 30, tiltYDegrees: 60 } });
    const line = output.match(/<line\b[^>]*>/)![0];
    expect(line).toContain('x1="160"');
    expect(line).toContain('y1="60.038"');
    expect(line).toContain('x2="160"');
    expect(line).toContain('y2="163.962"');
  });

  it.each([arrow, bracket])("keeps untilted $type SVG unchanged, including rotation", object => {
    for (const rotation of [0, 90, 37]) {
      expect(svg({ ...object, rotation, style: { tiltXDegrees: 0, tiltYDegrees: 0 } }))
        .toBe(svg({ ...object, rotation }));
      if (rotation) expect(svg({ ...object, rotation })).toContain(`transform="rotate(${rotation} 160 112)`);
      else expect(svg(object)).not.toContain('transform="matrix(');
    }
  });
});
