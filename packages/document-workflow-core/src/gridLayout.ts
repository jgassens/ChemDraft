// Pure grid placement shared by the CLI and document tools.

import {
  createEmptyDocument,
  DocumentTextStyle,
  type ChemDraftDocument,
  type MoleculeObject,
  type NativeTextStyle,
  type TextObject,
  textStyleToObjectStyle
} from "@chemdraft/chem-core";
import type { FigureStyle } from "@chemdraft/layout-engine";
import { nativeTextObjectSizeForText } from "./textObjects";
import type { LayoutBounds } from "./reactionScheme";
import { nextObjectId, phase4Timestamp } from "./shared";

export interface GridLayoutEntry {
  molecule: MoleculeObject;
  bounds: LayoutBounds;
  label: string | null;
}

export interface GridLayoutOptions {
  /** Fit preserves the legacy layout; document sizes the page and cells to include labels. */
  style?: FigureStyle;
  textStyle?: Partial<NativeTextStyle>;
  entries: readonly GridLayoutEntry[];
  columns?: number;
  gutter: number;
  anchor: { x: number; y: number };
  pageWidth: number;
  labelGap?: number;
}

export interface GridLayout {
  document: ChemDraftDocument;
  molecules: MoleculeObject[];
  labels: TextObject[];
  columns: number;
  rows: number;
}

/** Position already-depicted molecules in a deterministic, non-overlapping grid. */
export function layoutGrid(options: GridLayoutOptions): GridLayout {
  if (options.entries.length === 0) throw new Error("A grid needs at least one molecule.");
  const textStyle = { ...(options.style === "document" ? DocumentTextStyle : {}), ...options.textStyle };
  const widths = options.entries.map((entry) => entry.bounds.maxX - entry.bounds.minX);
  const heights = options.entries.map((entry) => entry.bounds.maxY - entry.bounds.minY);
  const moleculeWidth = Math.max(...widths);
  const moleculeHeight = Math.max(...heights);
  const columns = Math.min(
    options.entries.length,
    options.columns ?? automaticGridColumns(options.entries, options.gutter, options.pageWidth)
  );
  const labelGap = options.labelGap ?? 8;
  const labelsPresent = options.entries.some((entry) => entry.label !== null);
  const labelHeight = labelsPresent ? Math.max(
    ...options.entries.filter((entry) => entry.label !== null)
      .map((entry) => nativeTextObjectSizeForText(entry.label!, textStyle).height)
  ) : 0;
  const labelWidth = Math.max(0, ...options.entries.map((entry) => entry.label === null
    ? 0 : nativeTextObjectSizeForText(entry.label, textStyle).width));
  const cellWidth = (options.style === "document" ? Math.max(moleculeWidth, labelWidth) : moleculeWidth) + options.gutter;
  const cellHeight = moleculeHeight + (labelsPresent ? labelGap + labelHeight : 0) + options.gutter;
  const rows = Math.ceil(options.entries.length / columns);
  const empty = createEmptyDocument({ title: "ChemDraft grid", now: phase4Timestamp });
  const initialPage = empty.pages[0]!;
  const pageWidth = options.anchor.x * 2 + columns * cellWidth;
  const pageHeight = options.anchor.y * 2 + rows * cellHeight;
  const page = options.style === "document" ? {
    ...initialPage,
    width: pageWidth,
    height: pageHeight,
    layout: { ...initialPage.layout, presetId: "custom" as const, widthPx: pageWidth, heightPx: pageHeight }
  } : initialPage;
  const molecules: MoleculeObject[] = [];
  const labels: TextObject[] = [];
  const objects: Array<MoleculeObject | TextObject> = [];

  options.entries.forEach((entry, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellX = options.anchor.x + column * cellWidth;
    const cellY = options.anchor.y + row * cellHeight;
    const width = widths[index]!;
    const height = heights[index]!;
    const visualX = cellX + (cellWidth - width) / 2;
    const visualY = cellY + (moleculeHeight - height) / 2;
    const molecule = translateMolecule(
      entry.molecule,
      `mol_grid_${String(index + 1).padStart(3, "0")}`,
      visualX - entry.bounds.minX,
      visualY - entry.bounds.minY
    );
    molecules.push(molecule);
    objects.push(molecule);
    if (entry.label !== null) {
      const size = nativeTextObjectSizeForText(entry.label, textStyle);
      const label = createGridLabel(
        nextObjectId({ ...empty, pages: [{ ...page, objects }] }, "text"),
        { x: cellX + (cellWidth - size.width) / 2, y: cellY + moleculeHeight + labelGap },
        entry.label,
        textStyle,
        page.width,
        page.height
      );
      labels.push(label);
      objects.push(label);
    }
  });

  return {
    document: {
      ...empty,
      pages: [{ ...page, objects }],
      selection: { objectIds: labels.length > 0 ? [labels[labels.length - 1]!.id] : [] }
    },
    molecules,
    labels,
    columns,
    rows
  };
}

export function automaticGridColumns(
  entries: readonly Pick<GridLayoutEntry, "bounds">[],
  gutter: number,
  pageWidth: number
): number {
  const cellWidth = Math.max(...entries.map((entry) => entry.bounds.maxX - entry.bounds.minX)) + gutter;
  return Math.min(entries.length, Math.max(1, Math.floor((pageWidth - 48) / cellWidth)));
}

function translateMolecule(molecule: MoleculeObject, id: string, dx: number, dy: number): MoleculeObject {
  return { ...molecule, id, x: molecule.x + dx, y: molecule.y + dy, atoms: molecule.atoms.map((atom) => ({ ...atom, x: atom.x + dx, y: atom.y + dy })) };
}

function createGridLabel(
  id: string,
  point: { x: number; y: number },
  text: string,
  style: Partial<NativeTextStyle>,
  pageWidth: number,
  pageHeight: number
): TextObject {
  const size = nativeTextObjectSizeForText(text, style, { maxWidth: Math.max(36, pageWidth - point.x) });
  return {
    id, type: "text", x: clampToPage(point.x, pageWidth - size.width),
    y: clampToPage(point.y, pageHeight - size.height), width: size.width, height: size.height, rotation: 0,
    style: { ...textStyleToObjectStyle(style), textBoxSizingMode: "auto" },
    compatibility: { sourceFormat: "chemdraft-native", warnings: [], unknown: {} },
    text, spans: [{ text, script: "normal", style: {} }]
  };
}

function clampToPage(value: number, maximum: number): number {
  return Math.min(Math.max(value, 0), Math.max(0, maximum));
}
