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
      expect(output).toContain('transform="matrix(0.5 0 0 1 80 0) translate(100 100)"');
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
