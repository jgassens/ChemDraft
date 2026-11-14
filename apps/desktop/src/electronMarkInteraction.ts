import type { ElectronMarkObject } from "@chemdraft/chem-core";

/** Canvas-only targets in document units; never used for saved or exported geometry. */
export function electronMarkInteractionFrames(mark: Pick<ElectronMarkObject, "x" | "y" | "width" | "height">, pageScale: number) {
  const scale = Number.isFinite(pageScale) && pageScale > 0 ? pageScale : 1;
  const width = Math.max(mark.width, 24 / scale);
  const height = Math.max(mark.height, 24 / scale);
  const x = mark.x + (mark.width - width) / 2;
  const y = mark.y + (mark.height - height) / 2;
  // The 18px corner buttons extend 10px into their frame (App.css offset -8px).
  // Twelve pixels leave a gap between those buttons and the entire move target.
  const margin = 12 / scale;
  return {
    move: { x, y, width, height },
    controls: { x: x - mark.x - margin, y: y - mark.y - margin,
      width: width + 2 * margin, height: height + 2 * margin }
  };
}
