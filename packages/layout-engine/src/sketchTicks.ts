import type { NativeArtSketchEffectPlan, NativeArtSketchPathPlan } from "@chemdraft/art-engine";

export interface MoleculeSketchTick {
  source: { x1: number; y1: number; x2: number; y2: number };
  axis: { x1: number; y1: number; x2: number; y2: number };
  cellStart: number;
  cellEnd: number;
  lengthVariation: number;
  identity: string;
  hashed: boolean;
  widening?: { lengths: readonly number[]; index: number; identity: string };
}

/** One filled, tapered pen mark. All control points stay inside a disjoint axial ink cell. */
export function moleculeSketchTickPath(
  tick: MoleculeSketchTick,
  parameters: Pick<NativeArtSketchEffectPlan, "seed" | "roughness" | "bowing" | "color" | "strokeWidth">
): NativeArtSketchPathPlan {
  const random = tickRandom(`${parameters.seed}:${tick.identity}`);
  // Safety bounds saturate at twice the approved strength; zero is handled by the caller.
  const strength = Math.min(2, parameters.roughness / 1.25);
  const signed = () => random() * 2 - 1;
  const axisLength = Math.hypot(tick.axis.x2 - tick.axis.x1, tick.axis.y2 - tick.axis.y1);
  const ux = (tick.axis.x2 - tick.axis.x1) / axisLength;
  const uy = (tick.axis.y2 - tick.axis.y1) / axisLength;
  const nx = -uy;
  const ny = ux;
  const sourceLength = Math.hypot(tick.source.x2 - tick.source.x1, tick.source.y2 - tick.source.y1);
  let angle = signed() * (14 * Math.PI / 180) * strength;
  const lengthChange = signed() * Math.min(sourceLength * 0.25 * strength, tick.lengthVariation);
  // Ordered targets retain the full length range instead of limiting every tick to half its
  // neighbour's increment. Sorting stays within each original length's +/-25% interval because
  // the original lengths (and therefore both interval boundaries) are already ordered.
  const length = tick.widening && tick.lengthVariation > 0
    ? tick.widening.lengths.map((source, index) => {
        const sample = tickRandom(`${parameters.seed}:${tick.widening!.identity}:length:${index}`)() * 2 - 1;
        return source * (1 + sample * 0.25 * Math.min(1, strength));
      }).sort((a, b) => a - b)[tick.widening.index]!
    : sourceLength + lengthChange;
  const cellWidth = tick.cellEnd - tick.cellStart;
  const shift = signed() * Math.min(1.3 * strength, cellWidth * 0.2 * strength);
  const center = ((tick.source.x1 + tick.source.x2) / 2 - tick.axis.x1) * ux +
    ((tick.source.y1 + tick.source.y2) / 2 - tick.axis.y1) * uy;
  const sx = sourceLength > 0 ? (tick.source.x2 - tick.source.x1) / sourceLength : ux;
  const sy = sourceLength > 0 ? (tick.source.y2 - tick.source.y1) / sourceLength : uy;
  const acrossCenter = ((tick.source.x1 + tick.source.x2) / 2 - tick.axis.x1) * nx +
    ((tick.source.y1 + tick.source.y2) / 2 - tick.axis.y1) * ny;
  const bow = signed() * 0.8 * strength * Math.min(2, parameters.bowing);
  const weights = Array.from({ length: 4 }, () =>
    parameters.strokeWidth / 2 * (1 + signed() * 0.4 * Math.min(1, strength))
  );
  const hull = (tilt: number, lengthScale = 1) => {
    const tx = sx * Math.cos(tilt) - sy * Math.sin(tilt);
    const ty = sx * Math.sin(tilt) + sy * Math.cos(tilt);
    const axialDirection = tx * ux + ty * uy;
    const acrossDirection = tx * nx + ty * ny;
    return [1, -1].flatMap((side) => [0, 1, 2, 3].map((station) => {
      const along = (2 * station / 3 - 1) * length / 2 * lengthScale;
      const bend = station === 1 || station === 2 ? bow : 0;
      if (tick.hashed) {
        // Axial end caps preserve the exact widening envelope without clipping the tilt.
        // Divide weight by cos(tilt) so its thickness perpendicular to the pen stays unchanged.
        return {
          axial: along * axialDirection / Math.abs(acrossDirection) - Math.sign(acrossDirection) *
            (side * weights[station]! / Math.abs(acrossDirection) + bend),
          across: acrossCenter + along * Math.sign(acrossDirection)
        };
      }
      const offset = side * weights[station]! + bend;
      return {
        axial: along * axialDirection - acrossDirection * offset,
        across: acrossCenter + along * acrossDirection + axialDirection * offset
      };
    }));
  };
  const bounds = (points: ReturnType<typeof hull>) => {
    const min = Math.min(...points.map((p) => p.axial));
    const max = Math.max(...points.map((p) => p.axial));
    return { min, max, width: max - min };
  };
  let ink = hull(angle);
  if (bounds(ink).width > cellWidth) {
    // Fit the whole mark, never flatten individual points against cell walls. For a wide hash
    // in a narrow cell, reduce only that tick's tilt. Dashes instead shorten to retain their angle.
    let low = 0, high = 1;
    for (let iteration = 0; iteration < 24; iteration++) {
      const scale = (low + high) / 2;
      const candidate = tick.hashed ? hull(angle * scale) : hull(angle, scale);
      if (bounds(candidate).width <= cellWidth) low = scale;
      else high = scale;
    }
    if (tick.hashed) angle *= low;
    ink = tick.hashed ? hull(angle) : hull(angle, low);
  }
  let extent = bounds(ink);
  if (extent.width > cellWidth) {
    // Only exceptionally tiny cells cannot fit even an untilted pen's weight/bow.
    ink = ink.map((p) => ({ ...p, axial: p.axial * cellWidth / extent.width }));
    extent = bounds(ink);
  }
  const fittedCenter = Math.max(tick.cellStart - extent.min,
    Math.min(tick.cellEnd - extent.max, center + shift));
  const coordinates = ink.map(({ axial, across }) =>
    `${number(tick.axis.x1 + ux * (fittedCenter + axial) + nx * across)} ${number(tick.axis.y1 + uy * (fittedCenter + axial) + ny * across)}`
  );
  const left = coordinates.slice(0, 4);
  const right = coordinates.slice(4);
  return {
    d: `M ${left[0]} C ${left[1]} ${left[2]} ${left[3]} L ${right[3]} C ${right[2]} ${right[1]} ${right[0]} Z`,
    stroke: "none", strokeWidth: 0, fill: parameters.color
  };
}

function number(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/** FNV-1a identity hash followed by Mulberry32; independent of document/bond traversal order. */
function tickRandom(identity: string): () => number {
  let state = 2166136261;
  for (let i = 0; i < identity.length; i++) state = Math.imul(state ^ identity.charCodeAt(i), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
