// Pure reaction-scheme placement shared by the CLI and document tools.

import {
  createEmptyDocument,
  DocumentTextStyle,
  type ArrowObject,
  type ChemDraftDocument,
  type MoleculeObject,
  type NativeTextStyle,
  type TextObject,
  textStyleToObjectStyle
} from "@chemdraft/chem-core";
import type { FigureStyle } from "@chemdraft/layout-engine";
import { createNativeReactionArrow } from "./reactionArrows";
import { layoutReactionLabels, planReactionLabels } from "./reactionLabels";
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
  above?: TextObject;
  below?: TextObject;
  caption?: TextObject;
}

export interface ReactionSchemeLayoutOptions {
  /** Document uses the fixed physical text preset for conditions and plus signs. */
  style?: FigureStyle;
  textStyle?: Partial<NativeTextStyle>;
  reactants: readonly ReactionSchemeComponent[];
  products: readonly ReactionSchemeComponent[];
  arrowKind: ArrowObject["arrowKind"];
  above?: readonly string[];
  below?: readonly string[];
  caption?: string;
  /** Compatibility adapter: newline-separated above lines, prepended to above. No delimiter guessing. */
  conditionText?: string;
  /** Left edge of the first molecule and vertical centre of the scheme. */
  anchor: { x: number; y: number };
  gutter: number;
  bondLength: number;
  pagePadding: number;
}

const PLUS_STYLE: Partial<NativeTextStyle> = { fontSizePx: 20, textAlign: "center" };

/**
 * Positions already-depicted reaction components without loading a chemistry engine. The anchor
 * is the left edge of the left-most component at the scheme's vertical centre.
 */
export function layoutReactionScheme(options: ReactionSchemeLayoutOptions): ReactionSchemeLayout {
  const textStyle = { ...(options.style === "document" ? DocumentTextStyle : {}), ...options.textStyle };
  const plusStyle = { ...PLUS_STYLE, ...textStyle };
  const visible = [...options.reactants, ...options.products];
  if (visible.length === 0) throw new Error("A reaction scheme needs at least one molecule.");

  const labelPlan = planReactionLabels({
    above: [...(options.conditionText === undefined ? [] : [options.conditionText]), ...(options.above ?? [])],
    below: options.below ?? [],
    caption: options.caption,
    textStyle,
    bondLength: options.bondLength,
    arrowKind: options.arrowKind
  });
  const plusSize = nativeTextObjectSizeForText("+", plusStyle);
  const arrowLength = labelPlan.arrowLength;

  let cursor = options.anchor.x;
  let moleculeNumber = 0;
  let molecules: MoleculeObject[] = [];
  const moleculeFrames: Array<{ x: number; y: number; width: number; height: number }> = [];
  const plusPoints: Array<{ x: number; y: number }> = [];
  const placeGroup = (components: readonly ReactionSchemeComponent[]): void => {
    components.forEach((component, index) => {
      const width = component.bounds.maxX - component.bounds.minX;
      const height = component.bounds.maxY - component.bounds.minY;
      moleculeFrames.push({ x: cursor, y: options.anchor.y - height / 2, width, height });
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
  const empty = createEmptyDocument({ title: "Reaction scheme", now: phase4Timestamp });
  const page = empty.pages[0]!;
  let arrow = createNativeReactionArrow(
    { ...empty, pages: [{ ...page, objects: molecules }] },
    { x: arrowStart, y: options.anchor.y },
    { x: arrowEnd, y: options.anchor.y },
    options.arrowKind
  );
  let pluses = plusPoints.map((point, index) => createLayoutText(
    nextLayoutId("text", molecules.length + 2 + index),
    point,
    "+",
    plusStyle
  ));
  let { above, below, caption } = layoutReactionLabels(labelPlan, {
    arrowMidpoint: { x: (arrowStart + arrowEnd) / 2, y: options.anchor.y },
    // Callers may include visible atom-label overhangs in bounds, outside the molecule frame.
    schemeBounds: objectBounds([...moleculeFrames, arrow, ...pluses]),
    idPrefix: nextLayoutId("text", molecules.length + 2 + pluses.length)
  });
  // Preserve the anchor whenever it leaves enough room. If labels extend beyond the page's
  // top/left margin, translate the complete scheme together, never individual text blocks.
  const bounds = objectBounds([...molecules, ...moleculeFrames, arrow, ...pluses,
    ...[above, below, caption].filter((text) => text !== undefined)]);
  const dx = Math.max(0, options.pagePadding - bounds.minX);
  const dy = Math.max(0, options.pagePadding - bounds.minY);
  if (dx || dy) {
    molecules = molecules.map((molecule) => translateMolecule(molecule, molecule.id, dx, dy));
    arrow = {
      ...arrow, x: arrow.x + dx, y: arrow.y + dy,
      start: { kind: "point", point: { x: arrowStart + dx, y: options.anchor.y + dy } },
      end: { kind: "point", point: { x: arrowEnd + dx, y: options.anchor.y + dy } }
    };
    const translateText = (text: TextObject): TextObject => ({ ...text, x: text.x + dx, y: text.y + dy });
    pluses = pluses.map(translateText);
    above = above ? translateText(above) : undefined;
    below = below ? translateText(below) : undefined;
    caption = caption ? translateText(caption) : undefined;
  }
  const pageWidth = Math.max(cursor, bounds.maxX) + dx + options.pagePadding;
  const pageHeight = Math.max(options.anchor.y + maximumMoleculeHeight / 2, bounds.maxY) + dy + options.pagePadding;
  const objects = [...molecules, arrow, ...pluses, ...[above, below, caption].filter((text) => text !== undefined)];

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
      selection: { objectIds: [caption?.id ?? below?.id ?? above?.id ?? pluses.at(-1)?.id ?? arrow.id] }
    },
    molecules,
    pluses,
    arrow,
    ...(above ? { above } : {}),
    ...(below ? { below } : {}),
    ...(caption ? { caption } : {})
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
  style: Partial<NativeTextStyle>
): TextObject {
  const size = nativeTextObjectSizeForText(text, style);
  return {
    id,
    type: "text",
    x: point.x,
    y: point.y,
    width: size.width,
    height: size.height,
    rotation: 0,
    style: { ...textStyleToObjectStyle(style), textBoxSizingMode: "auto" },
    compatibility: { sourceFormat: "chemdraft-native", warnings: [], unknown: {} },
    text,
    spans: [{ text, script: "normal", style: {} }]
  };
}

function objectBounds(objects: readonly { x: number; y: number; width: number; height: number }[]): LayoutBounds {
  return {
    minX: Math.min(...objects.map((object) => object.x)),
    minY: Math.min(...objects.map((object) => object.y)),
    maxX: Math.max(...objects.map((object) => object.x + object.width)),
    maxY: Math.max(...objects.map((object) => object.y + object.height))
  };
}

function nextLayoutId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(3, "0")}`;
}
