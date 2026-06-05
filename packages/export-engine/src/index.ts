import {
  nativeDrawingStyleFromObjectStyle,
  nativeTextStyleFromObjectStyle,
  pageLayoutSvgSize,
  type ChemDraftDocument,
  type DocumentObject,
  type ElectronMarkObject,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject,
  type NativeDrawingStyle,
  type TextObject,
  type TextSpan
} from "@chemdraft/chem-core";

type DoubleBondSide = NonNullable<MoleculeBond["display"]>["doubleBondSide"];

export type ExportFormat = "svg" | "png" | "pdf" | "mol" | "sdf" | "smiles" | "rxn" | "cdxml";

export interface ExportWarning {
  code: string;
  message: string;
  objectId?: string;
}

export interface SvgExportOptions {
  pageIndex?: number;
  includeWarnings?: boolean;
}

export interface SvgExportResult {
  format: "svg";
  contents: string;
  warnings: ExportWarning[];
}

export function exportDocumentToSvg(document: ChemDraftDocument, options: SvgExportOptions = {}): SvgExportResult {
  const pageIndex = options.pageIndex ?? 0;
  const page = document.pages[pageIndex];
  const warnings: ExportWarning[] = [];

  if (!page) {
    throw new Error(`Cannot export SVG: page index ${pageIndex} does not exist.`);
  }

  const svgSize = pageLayoutSvgSize(page.layout);
  const body = page.objects.map((object, layerIndex) => renderObject(object, warnings, layerIndex)).join("\n  ");
  const warningMarkup =
    options.includeWarnings === true && warnings.length > 0
      ? `\n  <metadata data-chemdraft-warnings="${escapeXml(JSON.stringify(warnings))}" />`
      : "";

  return {
    format: "svg",
    contents: [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${svgSize.width}" height="${svgSize.height}" viewBox="0 0 ${page.width} ${page.height}" role="img" aria-label="${escapeXml(document.title)}">`,
      `  <rect width="${page.width}" height="${page.height}" fill="#ffffff" />`,
      `  <rect x="${page.margin.left}" y="${page.margin.top}" width="${page.width - page.margin.left - page.margin.right}" height="${page.height - page.margin.top - page.margin.bottom}" fill="none" stroke="#9fc9bd" stroke-width="1" opacity="0.5" />`,
      body ? `  ${body}` : "",
      warningMarkup,
      "</svg>"
    ]
      .filter(Boolean)
      .join("\n"),
    warnings
  };
}

function renderObject(object: DocumentObject, warnings: ExportWarning[], layerIndex: number): string {
  switch (object.type) {
    case "molecule":
      return renderMoleculeObject(object, layerIndex);
    case "text":
      return renderTextObject(object, layerIndex);
    case "plus":
      return renderCenteredText(object, "+", "24", "700", layerIndex);
    case "electron-mark":
      return object.markKind === "charge"
        ? renderChargeMarkObject(object, layerIndex)
        : renderFallbackObjectWithWarning(object, warnings, layerIndex);
    case "reaction-arrow":
      return renderLineObject(object, object.arrowKind, layerIndex);
    case "graphic":
      return renderGraphicObject(object, warnings, layerIndex);
    default:
      return renderFallbackObjectWithWarning(object, warnings, layerIndex);
  }
}

function renderFallbackObjectWithWarning(object: DocumentObject, warnings: ExportWarning[], layerIndex: number): string {
  warnings.push({
    code: "export.svg.object_fallback",
    message: `SVG export used a labeled fallback for object type "${object.type}".`,
    objectId: object.id
  });
  return renderFallbackObject(object, layerIndex);
}

function renderMoleculeObject(object: MoleculeObject, layerIndex: number): string {
  if (isNativeMoleculeGraph(object)) {
    return renderNativeMoleculeGraph(object, layerIndex);
  }

  const label = object.structureFormat === "smiles" ? object.structure : `${object.structureFormat} object`;
  const formula = object.chemistry?.warnings.length ? "warnings" : (object.chemistry ? "validated" : "adapter-backed");
  return [
    `<g data-object-id="${escapeXml(object.id)}" data-layer-index="${layerIndex}" data-object-type="molecule" transform="${rotationTransform(object)}">`,
    `  <rect x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx="4" fill="#ffffff" stroke="#2f3b42" stroke-width="1.5" />`,
    `  <text x="${object.x + 12}" y="${object.y + 34}" font-family="Arial, sans-serif" font-size="22" fill="#172026">${escapeXml(label)}</text>`,
    `  <text x="${object.x + 12}" y="${object.y + object.height - 16}" font-family="Arial, sans-serif" font-size="11" fill="#52616b">${escapeXml(formula)}</text>`,
    "</g>"
  ].join("\n  ");
}

function renderNativeMoleculeGraph(object: MoleculeObject, layerIndex: number): string {
  const atomById = new Map(object.atoms.map((atom) => [atom.id, atom]));
  const drawingStyle = nativeDrawingStyleFromObjectStyle(object.style);
  const labelByAtomId = new Map(
    object.atoms.flatMap((atom) => {
      const label = atomDisplayLabel(atom, object.bonds);
      return label ? [[atom.id, label] as const] : [];
    })
  );
  const primitive = moleculeDrawingPrimitive(object) === "single-bond" ? "single-bond" : "connected-carbon-chain";
  const bondSegmentGroups = object.bonds.flatMap((bond) => {
    const fromAtom = atomById.get(bond.fromAtomId);
    const toAtom = atomById.get(bond.toAtomId);
    if (!fromAtom || !toAtom) {
      return [];
    }

    const segments = bondLineSegments(
      fromAtom,
      toAtom,
      object,
      bond,
      drawingStyle,
      labelByAtomId.get(fromAtom.id),
      labelByAtomId.get(toAtom.id)
    ).map((segment) => ({ ...segment, bond }));
    return [{ bond, segments }];
  });
  const bondLayers = bondSegmentGroups.map(({ bond, segments }) => [
    `  <g data-bond-layer-id="${escapeXml(bond.id)}">`,
    ...segments.flatMap((segment) => {
      const knockout = bondKnockoutLineSegment(segment, drawingStyle);
      return knockout
        ? [
            `    <line data-bond-id="${escapeXml(segment.bond.id)}" data-bond-order="${segment.bond.order}" data-bond-segment="${segment.segment}"${segment.doubleBondSide ? ` data-double-bond-side="${segment.doubleBondSide}"` : ""} x1="${formatNumber(knockout.x1)}" y1="${formatNumber(knockout.y1)}" x2="${formatNumber(knockout.x2)}" y2="${formatNumber(knockout.y2)}" stroke="${escapeXml(drawingStyle.atomLabelBackgroundColor)}" stroke-width="${drawingStyle.bondStrokeWidthPx + drawingStyle.bondOverlapClearancePx}" stroke-linecap="${drawingStyle.bondLineCap}" />`
          ]
        : [];
    }),
    ...segments.flatMap((segment) => renderNativeBondSegment(segment, object, drawingStyle)),
    "  </g>"
  ].join("\n  "));
  const labelBackgrounds = object.atoms.flatMap((atom) => {
    const label = labelByAtomId.get(atom.id);
    if (!label) {
      return [];
    }
    const box = atomLabelBox(atom, label, drawingStyle);
    return [
      `  <rect x="${formatNumber(box.x)}" y="${formatNumber(box.y)}" width="${formatNumber(box.width)}" height="${formatNumber(box.height)}" fill="${escapeXml(drawingStyle.atomLabelBackgroundColor)}" />`
    ];
  });
  const labels = object.atoms.flatMap((atom) => {
    const label = labelByAtomId.get(atom.id);
    if (!label) {
      return [];
    }

    return [
      `  <g data-atom-label="${escapeXml(label)}" transform="translate(${formatNumber(atom.x)} ${formatNumber(atom.y)})" font-family="${escapeXml(drawingStyle.atomLabelFontFamily)}" font-size="${drawingStyle.atomLabelFontSizePx}" font-weight="${drawingStyle.atomLabelFontWeight}" fill="${escapeXml(nativeMoleculeAtomLabelColor(object, atom.id, drawingStyle))}">${renderAtomLabelRuns(label, drawingStyle)}</g>`
    ];
  });

  return [
    `<g data-object-id="${escapeXml(object.id)}" data-layer-index="${layerIndex}" data-object-type="molecule" data-chem-primitive="${primitive}" data-structure="${escapeXml(object.structure)}" data-atom-count="${object.atoms.length}" data-bond-count="${object.bonds.length}" data-style-preset-id="${escapeXml(drawingStyle.stylePresetId)}" transform="${rotationTransform(object)}">`,
    ...bondLayers,
    ...labelBackgrounds,
    ...labels,
    "</g>"
  ].join("\n  ");
}

interface BondLineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  segment: "primary" | "secondary" | "outer";
  doubleBondSide?: DoubleBondSide;
}

function bondLineSegments(
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  object: MoleculeObject,
  bond: MoleculeBond,
  drawingStyle: NativeDrawingStyle,
  fromLabel?: string,
  toLabel?: string
): BondLineSegment[] {
  const dx = toAtom.x - fromAtom.x;
  const dy = toAtom.y - fromAtom.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return [{ x1: fromAtom.x, y1: fromAtom.y, x2: toAtom.x, y2: toAtom.y, segment: "primary" }];
  }

  const unit = { x: dx / length, y: dy / length };
  const clearance = labelEndpointClearance(fromLabel, toLabel, drawingStyle, length, unit);
  const x1 = fromAtom.x + unit.x * clearance.from;
  const y1 = fromAtom.y + unit.y * clearance.from;
  const x2 = toAtom.x - unit.x * clearance.to;
  const y2 = toAtom.y - unit.y * clearance.to;
  const trimmedLength = Math.hypot(x2 - x1, y2 - y1);
  const normal = { x: -unit.y, y: unit.x };
  const gap = drawingStyle.multipleBondGapPx;

  if (bond.order === "double") {
    const doubleBondSide = bond.display?.doubleBondSide ?? "left";
    if (isTerminalHeteroatomDoubleBond(fromAtom, toAtom, object, bond)) {
      const offset = gap / 2;
      return [
        {
          x1: x1 + normal.x * offset,
          y1: y1 + normal.y * offset,
          x2: x2 + normal.x * offset,
          y2: y2 + normal.y * offset,
          segment: "primary",
          doubleBondSide
        },
        {
          x1: x1 - normal.x * offset,
          y1: y1 - normal.y * offset,
          x2: x2 - normal.x * offset,
          y2: y2 - normal.y * offset,
          segment: "secondary",
          doubleBondSide
        }
      ];
    }

    const offset = doubleBondSide === "left" ? gap : -gap;
    const inset = Math.min(drawingStyle.doubleBondInsetPx, Math.max(0, trimmedLength / 2 - 1));
    return [
      { x1, y1, x2, y2, segment: "primary", doubleBondSide },
      {
        x1: x1 + unit.x * inset + normal.x * offset,
        y1: y1 + unit.y * inset + normal.y * offset,
        x2: x2 - unit.x * inset + normal.x * offset,
        y2: y2 - unit.y * inset + normal.y * offset,
        segment: "secondary",
        doubleBondSide
      }
    ];
  }

  if (bond.order === "triple") {
    return [-gap, 0, gap].map((offset, index) => ({
      x1: x1 + normal.x * offset,
      y1: y1 + normal.y * offset,
      x2: x2 + normal.x * offset,
      y2: y2 + normal.y * offset,
      segment: index === 1 ? "primary" : "outer"
    }));
  }

  return [{ x1, y1, x2, y2, segment: "primary" }];
}

function renderNativeBondSegment(
  segment: BondLineSegment & { bond: MoleculeBond },
  object: MoleculeObject,
  drawingStyle: NativeDrawingStyle
): string[] {
  const bondStyle = segment.bond.display?.bondStyle;
  const styleAttribute = bondStyle ? ` data-bond-style="${bondStyle}"` : "";
  const commonAttributes = `data-bond-id="${escapeXml(segment.bond.id)}" data-bond-order="${segment.bond.order}" data-bond-segment="${segment.segment}"${styleAttribute}${segment.doubleBondSide ? ` data-double-bond-side="${segment.doubleBondSide}"` : ""}`;
  const stroke = escapeXml(nativeMoleculeBondColor(object, segment.bond.id, drawingStyle));

  if (bondStyle === "wedge" && segment.segment === "primary") {
    return [
      `    <polygon ${commonAttributes} points="${nativeWedgePolygonPoints(segment, drawingStyle)}" fill="${stroke}" />`
    ];
  }

  if (bondStyle === "hashed" && segment.segment === "primary") {
    return nativeHashedWedgeSegments(segment, drawingStyle).map((hash, index) =>
      `    <line ${commonAttributes} data-bond-hash-index="${index}" x1="${formatNumber(hash.x1)}" y1="${formatNumber(hash.y1)}" x2="${formatNumber(hash.x2)}" y2="${formatNumber(hash.y2)}" stroke="${stroke}" stroke-width="${drawingStyle.bondStrokeWidthPx}" stroke-linecap="butt" />`
    );
  }

  const strokeWidth = bondStyle === "bold"
    ? drawingStyle.bondStrokeWidthPx * 2.4
    : drawingStyle.bondStrokeWidthPx;
  const lineCap = bondStyle === "dashed" ? "butt" : drawingStyle.bondLineCap;
  const dashArray = bondStyle === "dashed"
    ? ` stroke-dasharray="${nativeDashedBondDashArray(drawingStyle)}"`
    : "";

  return [
    `    <line ${commonAttributes} x1="${formatNumber(segment.x1)}" y1="${formatNumber(segment.y1)}" x2="${formatNumber(segment.x2)}" y2="${formatNumber(segment.y2)}" stroke="${stroke}" stroke-width="${formatNumber(strokeWidth)}" stroke-linecap="${lineCap}"${dashArray} />`
  ];
}

function nativeDashedBondDashArray(drawingStyle: NativeDrawingStyle): string {
  const dash = Math.max(3, drawingStyle.bondStrokeWidthPx * 2.2);
  const gap = Math.max(3, drawingStyle.bondStrokeWidthPx * 1.8);
  return `${formatNumber(dash)} ${formatNumber(gap)}`;
}

function nativeWedgeWidth(drawingStyle: NativeDrawingStyle): number {
  return Math.max(8, drawingStyle.bondStrokeWidthPx * 5.2);
}

function nativeWedgePolygonPoints(
  segment: Pick<BondLineSegment, "x1" | "y1" | "x2" | "y2">,
  drawingStyle: NativeDrawingStyle
): string {
  const geometry = nativeSegmentVectorGeometry(segment);
  if (!geometry) {
    return `${formatNumber(segment.x1)},${formatNumber(segment.y1)} ${formatNumber(segment.x2)},${formatNumber(segment.y2)}`;
  }

  const halfWidth = nativeWedgeWidth(drawingStyle) / 2;
  const wideLeft = {
    x: segment.x2 + geometry.normal.x * halfWidth,
    y: segment.y2 + geometry.normal.y * halfWidth
  };
  const wideRight = {
    x: segment.x2 - geometry.normal.x * halfWidth,
    y: segment.y2 - geometry.normal.y * halfWidth
  };

  return [
    `${formatNumber(segment.x1)},${formatNumber(segment.y1)}`,
    `${formatNumber(wideLeft.x)},${formatNumber(wideLeft.y)}`,
    `${formatNumber(wideRight.x)},${formatNumber(wideRight.y)}`
  ].join(" ");
}

function nativeHashedWedgeSegments(
  segment: Pick<BondLineSegment, "x1" | "y1" | "x2" | "y2">,
  drawingStyle: NativeDrawingStyle
): Pick<BondLineSegment, "x1" | "y1" | "x2" | "y2">[] {
  const geometry = nativeSegmentVectorGeometry(segment);
  if (!geometry) {
    return [];
  }

  const hashCount = Math.max(5, Math.min(9, Math.round(geometry.length / 9)));
  const maxWidth = nativeWedgeWidth(drawingStyle);
  return Array.from({ length: hashCount }, (_, index) => {
    const t = (index + 1) / (hashCount + 1);
    const center = {
      x: segment.x1 + geometry.unit.x * geometry.length * t,
      y: segment.y1 + geometry.unit.y * geometry.length * t
    };
    const halfWidth = maxWidth * t / 2;
    return {
      x1: center.x + geometry.normal.x * halfWidth,
      y1: center.y + geometry.normal.y * halfWidth,
      x2: center.x - geometry.normal.x * halfWidth,
      y2: center.y - geometry.normal.y * halfWidth
    };
  });
}

function nativeSegmentVectorGeometry(
  segment: Pick<BondLineSegment, "x1" | "y1" | "x2" | "y2">
): { length: number; unit: { x: number; y: number }; normal: { x: number; y: number } } | undefined {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return undefined;
  }

  const unit = { x: dx / length, y: dy / length };
  return {
    length,
    unit,
    normal: { x: -unit.y, y: unit.x }
  };
}

function isTerminalHeteroatomDoubleBond(
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  object: MoleculeObject,
  bond: MoleculeBond
): boolean {
  if (bond.order !== "double") {
    return false;
  }

  return isTerminalHeteroatom(fromAtom, object) || isTerminalHeteroatom(toAtom, object);
}

function isTerminalHeteroatom(atom: MoleculeAtom, object: MoleculeObject): boolean {
  return atom.element !== "C" && atom.element !== "H" && atomBondCount(object, atom.id) === 1;
}

function atomBondCount(object: MoleculeObject, atomId: string): number {
  return object.bonds.filter((bond) => bond.fromAtomId === atomId || bond.toAtomId === atomId).length;
}

function bondKnockoutLineSegment(
  segment: Pick<BondLineSegment, "x1" | "y1" | "x2" | "y2">,
  drawingStyle: NativeDrawingStyle
): Pick<BondLineSegment, "x1" | "y1" | "x2" | "y2"> | undefined {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return undefined;
  }

  const endpointInset = Math.min(
    drawingStyle.bondStrokeWidthPx + drawingStyle.bondOverlapClearancePx,
    Math.max(0, length / 2 - 0.5)
  );
  if (endpointInset <= 0) {
    return undefined;
  }

  const unit = { x: dx / length, y: dy / length };
  return {
    x1: segment.x1 + unit.x * endpointInset,
    y1: segment.y1 + unit.y * endpointInset,
    x2: segment.x2 - unit.x * endpointInset,
    y2: segment.y2 - unit.y * endpointInset
  };
}

function labelEndpointClearance(
  fromLabel: string | undefined,
  toLabel: string | undefined,
  drawingStyle: NativeDrawingStyle,
  bondLength: number,
  unit: { x: number; y: number }
): { from: number; to: number } {
  const from = atomLabelBondClearance(fromLabel, drawingStyle, unit);
  const to = atomLabelBondClearance(toLabel, drawingStyle, { x: -unit.x, y: -unit.y });
  const total = from + to;
  const maximumTotal = bondLength * 0.55;
  if (total <= maximumTotal || total === 0) {
    return { from, to };
  }

  const scale = maximumTotal / total;
  return { from: from * scale, to: to * scale };
}

function atomLabelBondClearance(
  label: string | undefined,
  drawingStyle: NativeDrawingStyle,
  direction: { x: number; y: number }
): number {
  if (!label) {
    return 0;
  }

  const { bounds } = atomLabelLayout(label, drawingStyle);
  const horizontalDistance = direction.x > 0.0001
    ? (bounds.x + bounds.width) / direction.x
    : direction.x < -0.0001
      ? bounds.x / direction.x
      : Number.POSITIVE_INFINITY;
  const verticalDistance = direction.y > 0.0001
    ? (bounds.y + bounds.height) / direction.y
    : direction.y < -0.0001
      ? bounds.y / direction.y
      : Number.POSITIVE_INFINITY;
  const labelBoundaryDistance = Math.min(horizontalDistance, verticalDistance);

  return Math.max(drawingStyle.atomLabelBondClearancePx, Math.max(0, labelBoundaryDistance));
}

function atomLabelBox(
  atom: MoleculeAtom,
  label: string,
  drawingStyle: NativeDrawingStyle
): { x: number; y: number; width: number; height: number } {
  const { bounds } = atomLabelLayout(label, drawingStyle);
  return {
    x: atom.x + bounds.x,
    y: atom.y + bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

type AtomLabelScript = "normal" | "subscript" | "superscript";

interface AtomLabelRun {
  text: string;
  script: AtomLabelScript;
}

interface AtomLabelLayoutRun extends AtomLabelRun {
  x: number;
  y: number;
  textAnchor: "middle" | "start";
}

interface AtomLabelLayout {
  bounds: { x: number; y: number; width: number; height: number };
  runs: AtomLabelLayoutRun[];
}

function renderAtomLabelRuns(label: string, drawingStyle: NativeDrawingStyle): string {
  return atomLabelLayout(label, drawingStyle).runs
    .map((run) =>
      `<text data-atom-label-run="${run.script === "superscript" ? "charge" : run.script}" x="${formatNumber(run.x)}" y="${formatNumber(run.y)}" dominant-baseline="central" text-anchor="${run.textAnchor}"${run.script === "normal" ? "" : ` font-size="${formatNumber(atomLabelRunFontSize(run.script, drawingStyle) ?? drawingStyle.atomLabelFontSizePx)}"`}>${escapeXml(run.text)}</text>`
    )
    .join("");
}

function atomLabelLayout(label: string, drawingStyle: NativeDrawingStyle): AtomLabelLayout {
  const { bodyRuns, chargeRun } = atomLabelParts(label);
  const baseText = bodyRuns.filter((run) => run.script === "normal").map((run) => run.text).join("") || label;
  const suffixRuns = bodyRuns.filter((run) => run.script !== "normal");
  const baseWidth = atomLabelRunWidth({ text: baseText, script: "normal" }, drawingStyle);
  const baseHalfWidth = baseWidth / 2;
  const baseHalfHeight = drawingStyle.atomLabelFontSizePx * 0.54;
  const runs: AtomLabelLayoutRun[] = [
    {
      text: baseText,
      script: "normal",
      x: 0,
      y: 0,
      textAnchor: "middle"
    }
  ];
  let right = baseHalfWidth;
  let top = -baseHalfHeight;
  let bottom = baseHalfHeight;
  let cursor = baseHalfWidth + drawingStyle.atomLabelFontSizePx * 0.04;

  for (const run of suffixRuns) {
    const fontSize = atomLabelRunFontSize(run.script, drawingStyle) ?? drawingStyle.atomLabelFontSizePx;
    const width = atomLabelRunWidth(run, drawingStyle);
    const y = run.script === "subscript"
      ? drawingStyle.atomLabelFontSizePx * 0.34
      : -drawingStyle.atomLabelFontSizePx * 0.42;
    runs.push({
      ...run,
      x: cursor,
      y,
      textAnchor: "start"
    });
    right = Math.max(right, cursor + width);
    top = Math.min(top, y - fontSize * 0.52);
    bottom = Math.max(bottom, y + fontSize * 0.52);
    cursor += width + drawingStyle.atomLabelFontSizePx * 0.03;
  }

  if (chargeRun) {
    const fontSize = atomLabelRunFontSize(chargeRun.script, drawingStyle) ?? drawingStyle.atomLabelFontSizePx;
    const width = atomLabelRunWidth(chargeRun, drawingStyle);
    const x = Math.max(cursor, baseHalfWidth + drawingStyle.atomLabelFontSizePx * 0.08);
    const y = -drawingStyle.atomLabelFontSizePx * 0.48;
    runs.push({
      ...chargeRun,
      x,
      y,
      textAnchor: "start"
    });
    right = Math.max(right, x + width);
    top = Math.min(top, y - fontSize * 0.52);
    bottom = Math.max(bottom, y + fontSize * 0.52);
  }

  const padding = drawingStyle.atomLabelPaddingPx;
  return {
    bounds: {
      x: -baseHalfWidth - padding,
      y: top - padding,
      width: right + baseHalfWidth + padding * 2,
      height: bottom - top + padding * 2
    },
    runs
  };
}

function atomLabelParts(label: string): { bodyRuns: AtomLabelRun[]; chargeRun?: AtomLabelRun } {
  const { body, charge } = splitAtomLabelCharge(label);
  const runs = Array.from(body).reduce<AtomLabelRun[]>((currentRuns, character) => {
    const script = atomLabelScript(character);
    const previous = currentRuns[currentRuns.length - 1];
    if (previous?.script === script) {
      previous.text += character;
      return currentRuns;
    }

    currentRuns.push({ text: character, script });
    return currentRuns;
  }, []);

  return {
    bodyRuns: runs.length > 0 ? runs : [{ text: label, script: "normal" }],
    chargeRun: charge ? { text: charge, script: "superscript" } : undefined
  };
}

function splitAtomLabelCharge(label: string): { body: string; charge?: string } {
  const twoCharacterCharge = label.match(/^(.*?)(\d[+-])$/);
  if (twoCharacterCharge && twoCharacterCharge[1] && !twoCharacterCharge[1].endsWith("H")) {
    return { body: twoCharacterCharge[1], charge: twoCharacterCharge[2] };
  }

  const oneCharacterCharge = label.match(/^(.*)([+-])$/);
  if (oneCharacterCharge && oneCharacterCharge[1]) {
    return { body: oneCharacterCharge[1], charge: oneCharacterCharge[2] };
  }

  return { body: label };
}

function atomLabelRunWidth(run: AtomLabelRun, drawingStyle: NativeDrawingStyle): number {
  const fontSize = atomLabelRunFontSize(run.script, drawingStyle) ?? drawingStyle.atomLabelFontSizePx;
  const widthFactor = run.script === "normal" ? 0.62 : 0.5;
  return run.text.length * fontSize * widthFactor;
}

function atomLabelScript(character: string): AtomLabelScript {
  if (/\d/.test(character)) {
    return "subscript";
  }
  if (character === "+" || character === "-") {
    return "superscript";
  }
  return "normal";
}

function atomLabelRunFontSize(script: AtomLabelScript, drawingStyle: NativeDrawingStyle): number | undefined {
  if (script === "normal") {
    return undefined;
  }

  return drawingStyle.atomLabelFontSizePx * (script === "superscript" ? 0.88 : 0.72);
}

function atomDisplayLabel(atom: MoleculeAtom, bonds: readonly MoleculeBond[]): string | undefined {
  const valence = bonds.reduce((sum, bond) => {
    if (bond.fromAtomId !== atom.id && bond.toAtomId !== atom.id) {
      return sum;
    }
    return sum + (bond.order === "triple" ? 3 : bond.order === "double" ? 2 : 1);
  }, 0);
  if (atom.element === "C" && valence > 0 && atom.formalCharge === 0 && atom.labelVisible !== true) {
    return undefined;
  }

  const implicitHydrogens = commonValence(atom.element) === undefined
    ? ""
    : implicitHydrogenLabel(Math.max(0, (commonValence(atom.element) ?? 0) - valence));

  return `${atom.element}${implicitHydrogens}${chargeLabelSuffix(atom.formalCharge)}`;
}

function commonValence(element: string): number | undefined {
  return {
    H: 1,
    B: 3,
    C: 4,
    N: 3,
    O: 2,
    F: 1,
    P: 3,
    S: 2,
    I: 1
  }[element];
}

function implicitHydrogenLabel(count: number): string {
  if (count <= 0) {
    return "";
  }

  return count === 1 ? "H" : `H${count}`;
}

function atomFormalChargeForValence(element: string, valence: number): number | undefined {
  const neutralValence = commonValence(element);
  const maxValence = commonMaxValence(element);
  if (neutralValence === undefined || maxValence === undefined || valence < 0 || valence > maxValence) {
    return undefined;
  }

  if (valence <= neutralValence) {
    return 0;
  }

  if (element === "B" && valence === 4) {
    return -1;
  }

  if ((element === "N" || element === "O") && valence === neutralValence + 1) {
    return 1;
  }

  if (element === "P" && valence === 4) {
    return 1;
  }

  if (element === "P" && valence === 5) {
    return 0;
  }

  if (element === "S" && (valence === 4 || valence === 6)) {
    return 0;
  }

  return undefined;
}

function commonMaxValence(element: string): number | undefined {
  return {
    H: 1,
    B: 4,
    C: 4,
    N: 4,
    O: 3,
    F: 1,
    P: 5,
    S: 6,
    I: 1
  }[element];
}

function chargeLabelSuffix(charge: number): string {
  if (charge === 0) {
    return "";
  }

  const magnitude = Math.abs(charge);
  const sign = charge > 0 ? "+" : "-";
  return magnitude === 1 ? sign : `${magnitude}${sign}`;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function renderTextObject(object: TextObject, layerIndex: number): string {
  const textStyle = nativeTextStyleFromObjectStyle(object.style);
  const lines = textObjectSpanLines(object);
  const textAnchor = textStyle.textAlign === "center"
    ? "middle"
    : textStyle.textAlign === "right"
      ? "end"
      : "start";
  const x = textStyle.textAlign === "center"
    ? object.x + object.width / 2
    : textStyle.textAlign === "right"
      ? object.x + object.width
      : object.x;
  const y = object.y + textStyle.fontSizePx;
  const tspans = lines.length > 0
    ? lines.map((line, index) => renderTextSpanLine(line, index, x, textStyle.fontSizePx * textStyle.lineHeight + textStyle.paragraphSpacingPx)).join("")
    : `<tspan x="${formatNumber(x)}"></tspan>`;

  return [
    `<text data-object-id="${escapeXml(object.id)}" data-layer-index="${layerIndex}" data-object-type="text" x="${formatNumber(x)}" y="${formatNumber(y)}" font-family="${escapeXml(textStyle.fontFamily)}" font-size="${formatNumber(textStyle.fontSizePx)}" font-weight="${formatNumber(textStyle.fontWeight)}" font-style="${textStyle.fontStyle}" text-decoration="${textStyle.textDecoration}" letter-spacing="${formatNumber(textStyle.letterSpacingPx)}" text-anchor="${textAnchor}" fill="${escapeXml(textStyle.color)}" transform="${rotationTransform(object)}">`,
    tspans,
    "</text>"
  ].join("");
}

function renderTextSpanLine(
  line: TextSpan[],
  lineIndex: number,
  x: number,
  lineAdvancePx: number
): string {
  if (line.length === 0) {
    return `<tspan x="${formatNumber(x)}"${lineIndex === 0 ? "" : ` dy="${formatNumber(lineAdvancePx)}"`}></tspan>`;
  }

  return line.map((span, spanIndex) => {
    const positionAttributes = spanIndex === 0
      ? ` x="${formatNumber(x)}"${lineIndex === 0 ? "" : ` dy="${formatNumber(lineAdvancePx)}"`}`
      : "";
    const scriptAttributes = span.script === "normal"
      ? ""
      : ` baseline-shift="${span.script === "superscript" ? "super" : "sub"}" font-size="72%"`;
    const styleAttributes = textSpanSvgAttributes(span);

    return `<tspan${positionAttributes}${scriptAttributes}${styleAttributes}>${escapeXml(span.text)}</tspan>`;
  }).join("");
}

function textObjectSpanLines(object: TextObject): TextSpan[][] {
  const spans = textObjectSpansForExport(object);
  return spans.reduce<TextSpan[][]>((lines, span) => {
    const parts = span.text.split(/\r?\n/);
    parts.forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
      }
      if (part.length > 0) {
        lines[lines.length - 1].push({ ...span, text: part });
      }
    });
    return lines;
  }, [[]]);
}

function textObjectSpansForExport(object: TextObject): TextSpan[] {
  const spans = object.spans.filter((span) => span.text.length > 0);
  if (spans.length > 0 && spans.map((span) => span.text).join("") === object.text) {
    return spans;
  }

  return [{ text: object.text, script: "normal", style: {} }];
}

function textSpanSvgAttributes(span: TextSpan): string {
  const attributes: string[] = [];
  const color = metadataString(span.style.color);
  const fontFamily = metadataString(span.style.fontFamily);
  const fontSizePx = metadataNumber(span.style.fontSizePx);
  const fontWeight = metadataNumber(span.style.fontWeight);
  const fontStyle = metadataString(span.style.fontStyle);
  const textDecoration = metadataString(span.style.textDecoration);
  const letterSpacingPx = metadataNumber(span.style.letterSpacingPx);

  if (color) {
    attributes.push(`fill="${escapeXml(color)}"`);
  }
  if (fontFamily) {
    attributes.push(`font-family="${escapeXml(fontFamily)}"`);
  }
  if (fontSizePx !== undefined && span.script === "normal") {
    attributes.push(`font-size="${formatNumber(fontSizePx)}"`);
  }
  if (fontWeight !== undefined) {
    attributes.push(`font-weight="${formatNumber(fontWeight)}"`);
  }
  if (fontStyle === "italic" || fontStyle === "normal") {
    attributes.push(`font-style="${fontStyle}"`);
  }
  if (textDecoration) {
    attributes.push(`text-decoration="${escapeXml(textDecoration)}"`);
  }
  if (letterSpacingPx !== undefined) {
    attributes.push(`letter-spacing="${formatNumber(letterSpacingPx)}"`);
  }

  return attributes.length > 0 ? ` ${attributes.join(" ")}` : "";
}

function nativeMoleculeBondColor(
  object: MoleculeObject,
  bondId: string,
  drawingStyle: NativeDrawingStyle
): string {
  return styleColorMapValue(object.style.bondColors, bondId) ?? drawingStyle.bondColor;
}

function nativeMoleculeAtomLabelColor(
  object: MoleculeObject,
  atomId: string,
  drawingStyle: NativeDrawingStyle
): string {
  return styleColorMapValue(object.style.atomLabelColors, atomId) ?? drawingStyle.atomLabelColor;
}

function styleColorMapValue(value: unknown, id: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const color = (value as Record<string, unknown>)[id];
  return typeof color === "string" ? color : undefined;
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function metadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function renderChargeMarkObject(object: ElectronMarkObject, layerIndex: number): string {
  const charge = object.charge === -1 ? "-" : "+";
  return [
    `<g data-object-id="${escapeXml(object.id)}" data-layer-index="${layerIndex}" data-object-type="electron-mark" data-mark-kind="charge" data-charge="${object.charge === -1 ? "-1" : "1"}" transform="${rotationTransform(object)}">`,
    `  <text x="${formatNumber(object.x + object.width / 2)}" y="${formatNumber(object.y + object.height / 2)}" dominant-baseline="central" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="700" fill="#111111">${charge}</text>`,
    "</g>"
  ].join("\n  ");
}

function renderGraphicObject(
  object: Extract<DocumentObject, { type: "graphic" }>,
  warnings: ExportWarning[],
  layerIndex: number
): string {
  if (object.graphicKind === "rect") {
    return `<rect data-object-id="${escapeXml(object.id)}" data-layer-index="${layerIndex}" data-object-type="graphic" x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" fill="none" stroke="#2f3b42" stroke-width="1.5" transform="${rotationTransform(object)}" />`;
  }

  warnings.push({
    code: "export.svg.graphic_fallback",
    message: `SVG export used a labeled fallback for graphic kind "${object.graphicKind}".`,
    objectId: object.id
  });
  return renderFallbackObject(object, layerIndex);
}

function renderLineObject(object: DocumentObject, label: string, layerIndex: number): string {
  const startX = object.x;
  const startY = object.y + object.height / 2;
  const endX = object.x + object.width;
  const endY = startY;
  return [
    `<g data-object-id="${escapeXml(object.id)}" data-layer-index="${layerIndex}" data-object-type="${escapeXml(object.type)}" transform="${rotationTransform(object)}">`,
    `  <line x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}" stroke="#172026" stroke-width="1.5" />`,
    `  <text x="${object.x}" y="${object.y - 6}" font-family="Arial, sans-serif" font-size="10" fill="#52616b">${escapeXml(label)}</text>`,
    "</g>"
  ].join("\n  ");
}

function renderFallbackObject(object: DocumentObject, layerIndex: number): string {
  return [
    `<g data-object-id="${escapeXml(object.id)}" data-layer-index="${layerIndex}" data-object-type="${escapeXml(object.type)}" transform="${rotationTransform(object)}">`,
    `  <rect x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx="4" fill="#ffffff" stroke="#69757d" stroke-width="1" />`,
    `  <text x="${object.x + 8}" y="${object.y + 20}" font-family="Arial, sans-serif" font-size="11" fill="#52616b">${escapeXml(object.type)}</text>`,
    "</g>"
  ].join("\n  ");
}

function renderCenteredText(
  object: DocumentObject,
  label: string,
  fontSize: string,
  fontWeight: string,
  layerIndex: number
): string {
  return `<text data-object-id="${escapeXml(object.id)}" data-layer-index="${layerIndex}" data-object-type="${escapeXml(object.type)}" x="${object.x + object.width / 2}" y="${object.y + object.height / 2}" dominant-baseline="middle" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="#172026" transform="${rotationTransform(object)}">${escapeXml(label)}</text>`;
}

function rotationTransform(object: DocumentObject): string {
  if (object.rotation === 0) {
    return "";
  }

  return `rotate(${object.rotation} ${object.x + object.width / 2} ${object.y + object.height / 2})`;
}

function moleculeDrawingPrimitive(object: MoleculeObject): "single-bond" | undefined {
  return object.style.drawingPrimitive === "single-bond" && object.atoms.length === 2 ? "single-bond" : undefined;
}

function isNativeMoleculeGraph(object: MoleculeObject): boolean {
  return object.atoms.length > 0;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
