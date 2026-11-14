import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { electronMarkInteractionFrames } from "./electronMarkInteraction";

// Read the real handle dimensions: changing CSS must not silently reintroduce overlap.
const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const buttonSize = Number(css.match(/\.object-resize-handle\s*\{[^}]*width:\s*([\d.]+)px/s)![1]);
const cornerOffset = Number(css.match(/\.object-resize-top-left\s*\{[^}]*left:\s*(-?[\d.]+)px/s)![1]);

describe.each([0.25, 0.5, 1, 2, 4])("electron move targets at zoom %s", scale => {
  it.each([[2.16, 2.16], [18, 18], [72, 36]])("keeps a %s × %s mark movable without covering any resize button", (width, height) => {
    const mark = { x: 100, y: 200, width, height };
    const original = { ...mark };
    const { move, controls } = electronMarkInteractionFrames(mark, scale);
    expect(mark).toEqual(original);
    expect(move.width * scale).toBeGreaterThanOrEqual(24);
    expect(move.height * scale).toBeGreaterThanOrEqual(24);
    expect(move.x + move.width / 2).toBeCloseTo(mark.x + width / 2);
    expect(move.y + move.height / 2).toBeCloseTo(mark.y + height / 2);
    const left = (mark.x + controls.x) * scale, top = (mark.y + controls.y) * scale;
    const right = left + controls.width * scale, bottom = top + controls.height * scale;
    const target = { left: move.x * scale, top: move.y * scale,
      right: (move.x + move.width) * scale, bottom: (move.y + move.height) * scale };
    for (const x of [left + cornerOffset, right - cornerOffset - buttonSize]) {
      for (const y of [top + cornerOffset, bottom - cornerOffset - buttonSize]) {
        expect(x + buttonSize < target.left || x > target.right ||
          y + buttonSize < target.top || y > target.bottom).toBe(true);
      }
    }
  });
});
