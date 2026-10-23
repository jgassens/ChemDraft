// Pure reaction-scheme placement shared by the CLI and document tools.

import {
  createEmptyDocument,
  type ArrowObject,
  type ChemDraftDocument,
  type MoleculeObject,
  type NativeTextStyle,
  type TextObject,
  textStyleToObjectStyle
} from "@chemdraft/chem-core";
import { createNativeReactionArrow } from "./reactionArrows";
import { phase4Timestamp } from "./shared";
import { nativeTextObjectSizeForText } from "./textObjects";

export interface LayoutBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ReactionSchemeComponent {
  molecule: MoleculeObject;
  bounds: LayoutBounds;
}

export interface ReactionSchemeLayout {
  document: ChemDraftDocument;
  molecules: MoleculeObject[];
  pluses: TextObject[];
  arrow: ArrowObject;
  condition?: TextObject;
}

export interface ReactionSchemeLayoutOptions {
  reactants: readonly ReactionSchemeComponent[];
  products: readonly ReactionSchemeComponent[];
  arrowKind: ArrowObject["arrowKind"];
  conditionText?: string;
  /** Left edge of the first molecule and vertical centre of the scheme. */
  anchor: { x: number; y: number };
  gutter: number;
  bondLength: number;
  pagePadding: number;
}

const PLUS_STYLE: Partial<NativeTextStyle> = { fontSizePx: 20, textAlign: "center" };
const CONDITIONS_STYLE: Partial<NativeTextStyle> = { fontSizePx: 14, textAlign: "center" };

/**
 * Positions already-depicted reaction components without loading a chemistry engine. The anchor
 * is the left edge of the left-most component at the scheme's vertical centre.
 */
export function layoutReactionScheme(options: ReactionSchemeLayoutOptions): ReactionSchemeLayout {
  const conditionText = options.conditionText?.trim() ?? "";
  const visible = [...options.reactants, ...options.products];
  if (visible.length === 0) throw new Error("A reaction scheme needs at least one molecule.");

  const conditionSize = conditionText
    ? nativeTextObjectSizeForText(conditionText, CONDITIONS_STYLE)
    : { width: 0, height: 0 };
  const plusSize = nativeTextObjectSizeForText("+", PLUS_STYLE);
  const arrowLength = Math.max(options.bondLength * 2.5, conditionSize.width + options.gutter * 2);

  let cursor = options.anchor.x;
  let moleculeNumber = 0;
  const molecules: MoleculeObject[] = [];
  const plusPoints: Array<{ x: number; y: number }> = [];
  const placeGroup = (components: readonly ReactionSchemeComponent[]): void => {
    components.forEach((component, index) => {
      const width = component.bounds.maxX - component.bounds.minX;
      const height = component.bounds.maxY - component.bounds.minY;
      molecules.push(translateMolecule(
        component.molecule,
        `mol_reaction_${String(moleculeNumber + 1).padStart(3, "0")}`,
        cursor - component.bounds.minX,
        options.anchor.y - height / 2 - component.bounds.minY
      ));
      moleculeNumber += 1;
      cursor += width;
      if (index < components.length - 1) {
        cursor += options.gutter;
        plusPoints.push({ x: cursor, y: options.anchor.y - plusSize.height / 2 });
        cursor += plusSize.width + options.gutter;
      }
    });
  };

  const leftSide = options.arrowKind === "retrosynthesis" ? options.products : options.reactants;
  const rightSide = options.arrowKind === "retrosynthesis" ? options.reactants : options.products;
  placeGroup(leftSide);
  cursor += options.gutter;
  const arrowStart = cursor;
  const arrowEnd = arrowStart + arrowLength;
  cursor = arrowEnd + options.gutter;
  placeGroup(rightSide);

  const maximumMoleculeHeight = Math.max(
    options.bondLength,
    ...visible.map((component) => component.bounds.maxY - component.bounds.minY)
  );
  const pageWidth = cursor + options.pagePadding;
  const pageHeight = options.anchor.y + maximumMoleculeHeight / 2 + options.pagePadding;
  const empty = createEmptyDocument({ title: "Reaction scheme", now: phase4Timestamp });
  const page = empty.pages[0]!;
  const arrow = createNativeReactionArrow(
    { ...empty, pages: [{ ...page, objects: molecules }] },
    { x: arrowStart, y: options.anchor.y },
    { x: arrowEnd, y: options.anchor.y },
    options.arrowKind
  );
  const pluses = plusPoints.map((point, index) => createLayoutText(
    nextLayoutId("text", molecules.length + 2 + index),
    point,
    "+",
    PLUS_STYLE,
    pageWidth,
    pageHeight
  ));
  const condition = conditionText ? createLayoutText(
    nextLayoutId("text", molecules.length + 2 + pluses.length),
    {
      x: (arrowStart + arrowEnd - conditionSize.width) / 2,
      y: options.anchor.y - conditionSize.height - options.gutter / 2
    },
    conditionText,
    CONDITIONS_STYLE,
    pageWidth,
    pageHeight
  ) : undefined;
  const objects = [...molecules, arrow, ...pluses, ...(condition ? [condition] : [])];

  return {
    document: {
      ...empty,
      pages: [{
        ...page,
        width: pageWidth,
        height: pageHeight,
        layout: {
          ...page.layout,
          presetId: "custom",
          orientation: pageWidth >= pageHeight ? "landscape" : "portrait",
          widthPx: pageWidth,
          heightPx: pageHeight
        },
        objects
      }],
      selection: { objectIds: [condition?.id ?? pluses.at(-1)?.id ?? arrow.id] }
    },
    molecules,
    pluses,
    arrow,
    ...(condition ? { condition } : {})
  };
}

function translateMolecule(molecule: MoleculeObject, id: string, dx: number, dy: number): MoleculeObject {
  return {
    ...molecule,
    id,
    x: molecule.x + dx,
    y: molecule.y + dy,
    atoms: molecule.atoms.map((atom) => ({ ...atom, x: atom.x + dx, y: atom.y + dy }))
  };
}

function createLayoutText(
  id: string,
  point: { x: number; y: number },
  text: string,
  style: Partial<NativeTextStyle>,
  pageWidth: number,
  pageHeight: number
): TextObject {
  const size = nativeTextObjectSizeForText(text, style, {
    maxWidth: Math.max(36, pageWidth - point.x)
  });
  return {
    id,
    type: "text",
    x: clampToPage(point.x, pageWidth - size.width),
    y: clampToPage(point.y, pageHeight - size.height),
    width: size.width,
    height: size.height,
    rotation: 0,
    style: { ...textStyleToObjectStyle(style), textBoxSizingMode: "auto" },
    compatibility: { sourceFormat: "chemdraft-native", warnings: [], unknown: {} },
    text,
    spans: [{ text, script: "normal", style: {} }]
  };
}

function clampToPage(value: number, maximum: number): number {
  return Math.min(Math.max(value, 0), Math.max(0, maximum));
}

function nextLayoutId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(3, "0")}`;
}
