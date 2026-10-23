import type { Anchor, DocumentObject, DocumentPage, MoleculeObject, Point } from "@chemdraft/chem-core";
import { scaleGraphicPathD } from "@chemdraft/art-engine";

export function medianLength(lengths: readonly number[]): number | undefined {
  if (!lengths.length) return undefined;
  const sorted = [...lengths].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** One representative per molecule, so larger graphs do not outweigh smaller molecules. */
export function representativeMoleculeBondLength(molecule: MoleculeObject): number | undefined {
  const atoms = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  return medianLength(molecule.bonds.flatMap((bond) => {
    const a = atoms.get(bond.fromAtomId), b = atoms.get(bond.toAtomId);
    const length = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    return length > 0 && Number.isFinite(length) ? [length] : [];
  }));
}

const moleculePixelMaps = [
  "bondLengths", "bondStrokeWidths", "bondBoldWidths", "bondMultipleBondGaps",
  "bondDoubleBondInsets", "bondMarginWidths", "bondHashSpacings", "bondOverlapClearances",
  "atomLabelFontSizes", "atomLabelPaddings", "atomLabelBondClearances"
];

/** Scale the page about its origin, preserving contact, spacing, rotation and object identity.
 * Explicit style dimensions follow the page; colours and dimensionless settings stay authored.
 */
export function scalePageGeometry(page: DocumentPage, scale: number): DocumentPage {
  const point = <T extends Point>(value: T): T => ({ ...value, x: value.x * scale, y: value.y * scale });
  const anchor = (value: Anchor): Anchor => value.point ? { ...value, point: point(value.point) } : value;
  const textStyle = (style: Record<string, unknown>) => {
    const scaled = { ...style };
    for (const key of ["fontSizePx", "paragraphSpacingPx", "letterSpacingPx"]) {
      if (typeof style[key] === "number") scaled[key] = style[key] * scale;
    }
    return scaled;
  };
  const moleculeStyle = (style: MoleculeObject["style"]) => {
    const scaled = { ...style };
    for (const [key, value] of Object.entries(style)) {
      if (key.endsWith("Px") && typeof value === "number") scaled[key] = value * scale;
      if (moleculePixelMaps.includes(key) && value && typeof value === "object" && !Array.isArray(value)) {
        scaled[key] = Object.fromEntries(Object.entries(value).map(([id, size]) =>
          [id, typeof size === "number" ? size * scale : size]));
      }
    }
    for (const key of ["visualEffects", "inactiveVisualEffects", "effects", "inactiveEffects"]) {
      const effects = style[key];
      if (!Array.isArray(effects)) continue;
      scaled[key] = effects.map((effect: Record<string, unknown>) => {
        const result = { ...effect };
        for (const dimension of ["offsetX", "offsetY", "blurPx", "spreadPx", "strokeWidth"]) {
          if (typeof effect[dimension] === "number") result[dimension] = effect[dimension] * scale;
        }
        return result;
      });
    }
    return scaled;
  };
  const objects = page.objects.map((object): DocumentObject => {
    const frame = { x: object.x * scale, y: object.y * scale,
      width: object.width * scale, height: object.height * scale };
    switch (object.type) {
      case "molecule": return { ...object, ...frame, style: moleculeStyle(object.style),
        atoms: object.atoms.map((atom) => ({ ...point(atom),
          ...(atom.labelOffset ? { labelOffset: point(atom.labelOffset) } : {}) })),
        superatoms: object.superatoms.map((item) => ({ ...item, attachmentPoints: item.attachmentPoints.map(anchor) })),
        rGroups: object.rGroups.map((item) => ({ ...item, attachmentPoints: item.attachmentPoints.map(anchor) })) };
      case "text": return { ...object, ...frame, style: textStyle(object.style),
        spans: object.spans.map((span) => ({ ...span, style: textStyle(span.style) })) };
      case "reaction-arrow": return { ...object, ...frame, start: anchor(object.start), end: anchor(object.end) };
      case "mechanism-arrow": return { ...object, ...frame, source: anchor(object.source), target: anchor(object.target),
        controlPoints: object.controlPoints.map(point) };
      case "electron-mark": return { ...object, ...frame, anchor: anchor(object.anchor) };
      case "superatom": return { ...object, ...frame,
        metadata: { ...object.metadata, attachmentPoints: object.metadata.attachmentPoints.map(anchor) } };
      case "r-group-label": return { ...object, ...frame,
        display: { ...object.display, attachmentPoints: object.display.attachmentPoints.map(anchor) } };
      case "graphic": {
        const data = { ...object.data };
        for (const key of ["lineStart", "lineEnd", "pathControlPoint", "arcCenter"] as const) {
          if (data[key]) data[key] = point(data[key]);
        }
        if (data.pathNodes) data.pathNodes = data.pathNodes.map((node) => ({ ...node, point: point(node.point),
          ...(node.inControl ? { inControl: point(node.inControl) } : {}),
          ...(node.outControl ? { outControl: point(node.outControl) } : {}) }));
        if (data.freehandPoints) data.freehandPoints = data.freehandPoints.map(point);
        if (data.freehandOptions?.size !== undefined) data.freehandOptions = { ...data.freehandOptions, size: data.freehandOptions.size * scale };
        // Recompute freehand caches from the scaled points, never reuse the old path/revision.
        delete data.cachedFreehandPathD;
        delete data.cachedFreehandPathRevision;
        if (data.pathD) data.pathD = scaleGraphicPathD(data.pathD, scale);
        for (const key of ["arcRadiusX", "arcRadiusY", "shaftMarkSizePx", "dualShaftGapPx", "cornerRadiusPx"] as const) {
          if (data[key] !== undefined) data[key] *= scale;
        }
        for (const key of ["markerStart", "markerEnd"] as const) {
          const marker = data[key];
          if (marker?.sizePx !== undefined) data[key] = { ...marker, sizePx: marker.sizePx * scale };
        }
        return { ...object, ...frame, data, style: object.graphicKind !== "image" && object.style.strokeWidth !== undefined
          ? { ...object.style, strokeWidth: object.style.strokeWidth * scale } : object.style };
      }
      default: return { ...object, ...frame };
    }
  });
  return { ...page, width: page.width * scale, height: page.height * scale,
    margin: { top: page.margin.top * scale, right: page.margin.right * scale,
      bottom: page.margin.bottom * scale, left: page.margin.left * scale },
    layout: { ...page.layout, presetId: "custom", widthPx: page.layout.widthPx * scale, heightPx: page.layout.heightPx * scale,
      marginTopPx: page.layout.marginTopPx * scale, marginRightPx: page.layout.marginRightPx * scale,
      marginBottomPx: page.layout.marginBottomPx * scale, marginLeftPx: page.layout.marginLeftPx * scale,
      ...(page.layout.sourceWidth !== undefined ? { sourceWidth: page.layout.sourceWidth * scale } : {}),
      ...(page.layout.sourceHeight !== undefined ? { sourceHeight: page.layout.sourceHeight * scale } : {}) },
    crossings: page.crossings.map((crossing) => ({ ...crossing,
      ...(crossing.clearancePx !== undefined ? { clearancePx: crossing.clearancePx * scale } : {}) })), objects };
}
