/**
 * The ionizable-site figure: the molecule, the proton each value is about, and how much to trust it.
 *
 * **Why a picture rather than the table alone.** A pKa is a statement about one specific hydrogen
 * leaving one specific atom. A table row saying "atom 7, Phenol, 7.17" asks the reader to hold the
 * structure's atom numbering in their head, and nobody does — so the number arrives detached from the
 * thing it describes. Drawn on the structure, at the proton, it is checkable at a glance.
 *
 * **Drawing the acidic hydrogen is the disclosure, not a decoration.** The method reports the acidity
 * of the site *as drawn*, which for a basic nitrogen is not the number most people want: histidine's
 * neutral -NH2 is scored as that N-H losing a proton, and the contract has to shout about it in
 * capitals. Drawn, the same fact is silent and obvious — the reader sees a neutral NH2 with its H
 * marked, and can tell at once that this is not the ammonium they were thinking of.
 *
 * **Colour thresholds are measured, not chosen.** Green / amber / red are the quartile boundaries of
 * the model's own interval, and the quartiles were measured out of fold: the green band is the quarter
 * of sites where the method's MAE is 0.49, red is the quarter where it is 2.20. They arrive through
 * `IonizationFigureThresholds` rather than being written here, so the drawing cannot drift from the
 * calibration it claims.
 */

/** One site's annotation, already formatted — this module draws, it does not decide. */
export interface IonizationFigureAnnotation {
  atomIndex: number;
  /** e.g. "7.17 ± 0.45". Absent for a site recognised but not titratable. */
  text: string;
  /** Measured confidence band. `unknown` draws neutral rather than guessing at a colour. */
  band: "good" | "fair" | "poor" | "unknown";
  /**
   * Which equilibrium the number describes. Carries the figure's most important distinction, so it is
   * encoded in the colour every pKa tool uses for it: red for an acid losing a proton, blue for a base
   * gaining one.
   */
  transition: "acidic" | "basic";
}

export interface IonizationFigureStructure {
  atoms: { index: number; x: number; y: number; element: string; charge: number; hydrogens: number }[];
  bonds: { from: number; to: number; order: number }[];
}

/** Quartile boundaries of the interval, in log units. Supplied by the method that measured them. */
export interface IonizationFigureThresholds {
  good: number;
  poor: number;
}

/**
 * Two encodings that must not collide.
 *
 * The value's colour says WHICH EQUILIBRIUM — red acidic, blue basic — because that is the convention
 * every pKa tool uses and the distinction a reader must not have to infer from the number's size. The
 * ring around the atom says how far the method can be trusted there, on the measured green/amber/red
 * quartiles. Putting confidence on the text instead would have left the acid/base distinction with
 * nowhere to live.
 */
const COLOURS = {
  acidic: "#cf222e",
  basic: "#1f4fd8",
  good: "#1a7f37",
  fair: "#bf8700",
  poor: "#cf222e",
  unknown: "#57606a",
  bond: "#24292f",
  atom: "#24292f",
  paper: "#ffffff"
} as const;

const BOND_LENGTH = 46;
const DOUBLE_BOND_GAP = 3.4;
const PADDING = 46;
/** Distance from an atom's centre to its value. Must clear the site halo (r 15) and the glyph. */
const LABEL_OFFSET = 20;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Subscript digits, so "NH2" reads as NH₂ without a font dependency. */
const SUBSCRIPTS = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
function subscript(count: number): string {
  return count <= 1 ? "" : String(count).split("").map((d) => SUBSCRIPTS[Number(d)] ?? d).join("");
}

const SUPERSCRIPTS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];
function chargeMark(charge: number): string {
  if (charge === 0) return "";
  // Superscript, because "N+" reads as a formula token and "N⁺" reads as a charge — which is what it
  // is. The nitro group's nitrogen is the common case and it appears on almost every drawn structure.
  const sign = charge > 0 ? "⁺" : "⁻";
  const magnitude = Math.abs(charge);
  return magnitude === 1
    ? sign
    : `${String(magnitude).split("").map((d) => SUPERSCRIPTS[Number(d)] ?? d).join("")}${sign}`;
}

/**
 * Lay the molecule out to a fixed bond length, then fit it to the viewBox.
 *
 * Scaling to the median bond length rather than to the bounding box keeps a two-atom fragment and a
 * steroid at comparable stroke weights; fitting a bounding box would draw ethanol enormous.
 */
const LABEL_FONT_SIZE = 12.5;
/** Rough advance width per character at `LABEL_FONT_SIZE`. Digits and "±" sit near this in system-ui. */
const LABEL_CHAR_WIDTH = 6.9;

function layout(structure: IonizationFigureStructure, annotations: readonly IonizationFigureAnnotation[]) {
  const lengths = structure.bonds
    .map((bond) => {
      const a = structure.atoms[bond.from];
      const b = structure.atoms[bond.to];
      if (!a || !b) return 0;
      return Math.hypot(a.x - b.x, a.y - b.y);
    })
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const median = lengths.length > 0 ? lengths[Math.floor(lengths.length / 2)]! : 1;
  const scale = median > 0 ? BOND_LENGTH / median : BOND_LENGTH;

  const points = structure.atoms.map((atom) => ({ ...atom, sx: atom.x * scale, sy: atom.y * scale }));
  const centreX = points.reduce((sum, p) => sum + p.sx, 0) / (points.length || 1);
  const centreY = points.reduce((sum, p) => sum + p.sy, 0) / (points.length || 1);

  const anchorFor = (sx: number, sy: number): { x: number; y: number } => {
    const dx = sx - centreX;
    const dy = sy - centreY;
    const length = Math.hypot(dx, dy);
    // A site at the centroid has no outward direction; below is the conventional fallback.
    if (length < 1) return { x: sx, y: sy + LABEL_OFFSET + 9 };
    return { x: sx + (dx / length) * (LABEL_OFFSET + 9), y: sy + (dy / length) * (LABEL_OFFSET + 9) };
  };

  // The extent has to include the LABELS, not just the atoms. Padding alone cannot do it: a value is
  // offset outward from an edge atom and then extends half its own width further, which on histidine
  // put "7.59 ± 5.15" past the left edge and clipped it to ".59 ± 5.15" — a wrong number, rendered
  // confidently. So every drawn box is measured and the frame is sized to fit them all.
  const boxes = points.map((p) => ({ minX: p.sx - 13, maxX: p.sx + 13, minY: p.sy - 13, maxY: p.sy + 13 }));
  const byIndex = new Map(points.map((p) => [p.index, p]));
  for (const annotation of annotations) {
    const atom = byIndex.get(annotation.atomIndex);
    if (!atom) continue;
    const anchor = anchorFor(atom.sx, atom.sy);
    const halfWidth = (annotation.text.length * LABEL_CHAR_WIDTH) / 2 + 3;
    boxes.push({
      minX: anchor.x - halfWidth,
      maxX: anchor.x + halfWidth,
      minY: anchor.y - LABEL_FONT_SIZE,
      maxY: anchor.y + LABEL_FONT_SIZE
    });
  }
  const minX = Math.min(...boxes.map((b) => b.minX));
  const minY = Math.min(...boxes.map((b) => b.minY));
  const maxX = Math.max(...boxes.map((b) => b.maxX));
  const maxY = Math.max(...boxes.map((b) => b.maxY));

  const shiftX = PADDING - minX;
  const shiftY = PADDING - minY;
  return {
    atoms: points.map((p) => ({ ...p, sx: p.sx + shiftX, sy: p.sy + shiftY })),
    width: maxX - minX + PADDING * 2,
    height: maxY - minY + PADDING * 2,
    /** Where a site's value goes: outward from the molecule's centre, away from its own structure. */
    labelAnchor(sx: number, sy: number): { x: number; y: number } {
      const anchor = anchorFor(sx - shiftX, sy - shiftY);
      return { x: anchor.x + shiftX, y: anchor.y + shiftY };
    }
  };
}

/**
 * Draw the ionizable sites on their structure.
 *
 * Returns undefined when there is nothing to draw — no coordinates, or no annotated site. An absent
 * figure is better than an empty frame, which reads as a failure of the analysis rather than of the
 * drawing.
 */
export function ionizationFigureSvg(options: {
  structure: IonizationFigureStructure;
  annotations: readonly IonizationFigureAnnotation[];
  title: string;
}): string | undefined {
  const { structure, annotations, title } = options;
  if (structure.atoms.length === 0 || annotations.length === 0) return undefined;

  const view = layout(structure, annotations);
  const byIndex = new Map(view.atoms.map((atom) => [atom.index, atom]));
  const annotated = new Map(annotations.map((entry) => [entry.atomIndex, entry]));
  const parts: string[] = [];

  // --- bonds ---
  for (const bond of structure.bonds) {
    const a = byIndex.get(bond.from);
    const b = byIndex.get(bond.to);
    if (!a || !b) continue;

    // Stop the line short of any drawn atom label, so the glyph sits in a gap rather than on a stroke.
    const dx = b.sx - a.sx;
    const dy = b.sy - a.sy;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    const trimA = a.element === "C" && !annotated.has(a.index) ? 0 : 11;
    const trimB = b.element === "C" && !annotated.has(b.index) ? 0 : 11;
    const x1 = a.sx + ux * trimA;
    const y1 = a.sy + uy * trimA;
    const x2 = b.sx - ux * trimB;
    const y2 = b.sy - uy * trimB;

    const offsets = bond.order === 2 ? [-DOUBLE_BOND_GAP, DOUBLE_BOND_GAP]
      : bond.order === 3 ? [-DOUBLE_BOND_GAP * 1.6, 0, DOUBLE_BOND_GAP * 1.6]
        : [0];
    for (const offset of offsets) {
      const ox = -uy * offset;
      const oy = ux * offset;
      parts.push(
        `<line x1="${(x1 + ox).toFixed(2)}" y1="${(y1 + oy).toFixed(2)}" ` +
          `x2="${(x2 + ox).toFixed(2)}" y2="${(y2 + oy).toFixed(2)}" ` +
          `stroke="${COLOURS.bond}" stroke-width="1.6" stroke-linecap="round"/>`
      );
    }
  }

  // --- atoms ---
  for (const atom of view.atoms) {
    const annotation = annotated.get(atom.index);
    const isSite = annotation !== undefined;
    // Carbons stay implicit vertices unless they carry a value, which is how a structure is read.
    if (atom.element === "C" && atom.charge === 0 && !isSite) continue;

    const colour = isSite ? COLOURS[annotation.transition] : COLOURS.atom;
    if (isSite) {
      const confidence = COLOURS[annotation.band];
      parts.push(
        `<circle cx="${atom.sx.toFixed(2)}" cy="${atom.sy.toFixed(2)}" r="15" ` +
          `fill="${confidence}" fill-opacity="0.12" stroke="${confidence}" stroke-width="1.8"/>`
      );
    }
    parts.push(
      `<circle cx="${atom.sx.toFixed(2)}" cy="${atom.sy.toFixed(2)}" r="10.5" fill="${COLOURS.paper}"/>`
    );

    // The acidic proton is drawn, not implied. This is the figure's whole reason for existing: the
    // value belongs to THIS hydrogen leaving THIS atom, and a reader who can see it can tell at once
    // whether the transition being scored is the one they had in mind.
    const label = `${atom.element}${atom.hydrogens > 0 ? `H${subscript(atom.hydrogens)}` : ""}${chargeMark(atom.charge)}`;
    parts.push(
      `<text x="${atom.sx.toFixed(2)}" y="${atom.sy.toFixed(2)}" text-anchor="middle" ` +
        `dominant-baseline="central" font-family="system-ui, -apple-system, sans-serif" ` +
        `font-size="13" font-weight="${isSite ? 700 : 500}" fill="${colour}">${escapeXml(label)}</text>`
    );

    if (annotation) {
      // Pushed away from the middle of the molecule rather than always straight down. A value dropped
      // below its atom lands on whatever bond happens to be there — on histidine's imidazole it sat
      // across two ring bonds and its neighbour's label. Radially outward, there is by construction
      // less structure in the way.
      const { x, y } = view.labelAnchor(atom.sx, atom.sy);
      parts.push(
        `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" ` +
          `text-anchor="middle" dominant-baseline="central" ` +
          `font-family="system-ui, -apple-system, sans-serif" font-size="${LABEL_FONT_SIZE}" font-weight="600" ` +
          // Outline first, glyph over it: crowded structures will still put a label near a bond, and a
          // number that has to be deciphered is not much better than one that is not there.
          `paint-order="stroke" stroke="${COLOURS.paper}" stroke-width="3.5" stroke-linejoin="round" ` +
          `fill="${colour}">${escapeXml(annotation.text)}</text>`
      );
    }
  }

  // width/height AND viewBox: the attributes give an <img> its intrinsic size and aspect ratio so CSS
  // can scale it down, while the viewBox — sized above to contain the labels, not just the atoms — is
  // what stops an outermost value being clipped.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${view.width.toFixed(0)} ${view.height.toFixed(0)}" ` +
    `width="${view.width.toFixed(0)}" height="${view.height.toFixed(0)}" role="img">` +
    `<title>${escapeXml(title)}</title>` +
    `<rect width="100%" height="100%" fill="${COLOURS.paper}"/>` +
    parts.join("") +
    `</svg>`
  );
}

/** Which measured band an interval falls in. `null` spread means the method offered no value. */
export function ionizationBand(
  spread: number | undefined,
  thresholds: IonizationFigureThresholds
): IonizationFigureAnnotation["band"] {
  if (spread === undefined || !Number.isFinite(spread)) return "unknown";
  if (spread <= thresholds.good) return "good";
  if (spread <= thresholds.poor) return "fair";
  return "poor";
}
