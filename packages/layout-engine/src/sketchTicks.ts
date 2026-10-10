import type { NativeArtSketchEffectPlan, NativeArtSketchPathPlan } from "@chemdraft/art-engine";

export interface MoleculeSketchTick {
  source: { x1: number; y1: number; x2: number; y2: number };
  axis: { x1: number; y1: number; x2: number; y2: number };
  cellStart: number;
  cellEnd: number;
  lengthVariation: number;
  identity: string;
  hashed: boolean;
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
  const angle = signed() * (7 * Math.PI / 180) * strength;
  const lengthChange = signed() * Math.min(sourceLength * 0.15 * strength, tick.lengthVariation);
  const length = sourceLength + lengthChange;
  const shift = signed() * Math.min(0.65 * strength, (tick.cellEnd - tick.cellStart) * 0.1);
  const cx = (tick.source.x1 + tick.source.x2) / 2 + ux * shift;
  const cy = (tick.source.y1 + tick.source.y2) / 2 + uy * shift;
  const sx = sourceLength > 0 ? (tick.source.x2 - tick.source.x1) / sourceLength : ux;
  const sy = sourceLength > 0 ? (tick.source.y2 - tick.source.y1) / sourceLength : uy;
  const tx = sx * Math.cos(angle) - sy * Math.sin(angle);
  const ty = sx * Math.sin(angle) + sy * Math.cos(angle);
  // Maintain the widening envelope despite rotation; jitter cannot invert adjacent hash widths.
  const halfLength = length / 2 / (tick.hashed ? Math.cos(angle) : 1);
  const acrossCenter = ((tick.source.x1 + tick.source.x2) / 2 - tick.axis.x1) * nx +
    ((tick.source.y1 + tick.source.y2) / 2 - tick.axis.y1) * ny;
  const bow = signed() * 0.4 * strength * Math.min(2, parameters.bowing);
  const weights = Array.from({ length: 4 }, () =>
    parameters.strokeWidth / 2 * (1 + signed() * 0.28 * Math.min(1, strength))
  );
  const point = (station: number, side: number) => {
    const t = station / 3;
    const along = (2 * t - 1) * halfLength;
    const offset = side * weights[station]! + (station === 1 || station === 2 ? bow : 0);
    const x = cx + tx * along - ty * offset;
    const y = cy + ty * along + tx * offset;
    const axial = Math.max(tick.cellStart, Math.min(tick.cellEnd,
      (x - tick.axis.x1) * ux + (y - tick.axis.y1) * uy));
    const across = (x - tick.axis.x1) * nx + (y - tick.axis.y1) * ny;
    const boundedAcross = tick.hashed
      ? Math.max(acrossCenter - length / 2, Math.min(acrossCenter + length / 2, across))
      : across;
    return `${number(tick.axis.x1 + ux * axial + nx * boundedAcross)} ${number(tick.axis.y1 + uy * axial + ny * boundedAcross)}`;
  };
  const left = [0, 1, 2, 3].map((station) => point(station, 1));
  const right = [0, 1, 2, 3].map((station) => point(station, -1));
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
