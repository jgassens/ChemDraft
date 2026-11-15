// Pure reaction-scheme placement shared by the CLI and document tools.

import {
  createEmptyDocument,
  DocumentTextStyle,
  type ArrowObject,
  type ChemDraftDocument,
  type MoleculeObject,
  type NativeTextStyle,
  type ReactionObject,
  type TextObject,
  textStyleToObjectStyle
} from "@chemdraft/chem-core";
import { moleculeInkBounds, reactionArrowInkBounds, reactionSchemeDrawingMetrics, representativeMoleculeBondLength,
  type FigureStyle } from "@chemdraft/layout-engine";
import type { ReactionAlignmentBudget, ReactionProductAligner } from "@chemdraft/rdkit-adapter/depiction";
import { createNativeReactionArrow } from "./reactionArrows";
import { defaultDoubleBondSide, normalizeNativeMoleculeGeometry, pastedStructureDepictionFromMolfile,
  stereoPerceptionMolfile } from "./molecule";
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
  /** Legacy hint; measured renderer ink bounds are authoritative. */
  bounds?: LayoutBounds;
}

export interface ReactionAlignmentWarning {
  code: "reaction.alignment_skipped" | "reaction.alignment_timeout";
  component: { role: "product"; index: number };
  message: string;
}

export interface ReactionSchemeLayout {
  document: ChemDraftDocument;
  molecules: MoleculeObject[];
  pluses: TextObject[];
  arrow: ArrowObject;
  above?: TextObject;
  below?: TextObject;
  caption?: TextObject;
  warnings: string[];
  alignmentWarnings: ReactionAlignmentWarning[];
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
  /** Legacy input retained for callers; ink gaps now follow the actual bond length. */
  gutter: number;
  bondLength: number;
  pagePadding: number;
  /** Host supplies the adapter after loading its engine. Core never loads an engine. */
  alignProduct?: ReactionProductAligner;
  /** Injectable clock/yield for deterministic budget tests. */
  alignmentScheduler?: Pick<ReactionAlignmentBudget, "now" | "yieldControl">;
}

/** One budget for every product and reactant pair. Yield before synchronous WASM work so
 * interactive hosts can paint/cancel between searches; no engine is loaded by this planner. */
export async function layoutReactionSchemeAsync(options: ReactionSchemeLayoutOptions): Promise<ReactionSchemeLayout> {
  const scheduler = options.alignmentScheduler ?? { now: () => performance.now(),
    yieldControl: () => new Promise<void>(resolve => setTimeout(resolve, 0)) };
  const budget = { ...scheduler, deadline: scheduler.now() + 1_500 };
  const alignmentWarnings: ReactionAlignmentWarning[] = [];
  const warn = (index: number, moleculeId: string, reason: "skipped" | "timeout", detail?: string) => {
    const message = reason === "timeout" ? "Shared-core orientation search reached its time limit." :
      "Shared-core orientation skipped: no qualifying shared core or aligned depiction.";
    alignmentWarnings.push({ code: `reaction.alignment_${reason}`, component: { role: "product", index },
      message: detail ?? `Product ${index + 1} (${moleculeId}): ${message}` });
  };
  const products: ReactionSchemeComponent[] = [];
  for (const [index, component] of options.products.entries()) {
    let molecule = component.molecule;
    if (options.alignProduct && options.reactants.length) {
      await budget.yieldControl();
      if (budget.now() < budget.deadline) try {
        const writerWarnings: string[] = [];
        const references = options.reactants.map(reference => stereoPerceptionMolfile(reference.molecule, writerWarnings));
        const product = stereoPerceptionMolfile(molecule, writerWarnings);
        if (writerWarnings.length) throw new Error(writerWarnings.join(" "));
        const alignment = await options.alignProduct(references, product, budget);
        for (const reason of alignment?.warnings ?? (alignment?.molfile ? [] : ["skipped" as const])) warn(index, molecule.id, reason);
        if (alignment?.molfile) molecule = alignedMolecule(molecule, alignment.molfile);
      } catch (error) {
        warn(index, molecule.id, "skipped",
          `Shared-core orientation unavailable for ${molecule.id}: ${error instanceof Error ? error.message : String(error)}`);
      } else warn(index, molecule.id, "timeout");
    }
    products.push({ ...component, molecule });
  }
  const result = layoutReactionScheme({ ...options, products });
  return { ...result, alignmentWarnings, warnings: [...alignmentWarnings.map(warning => warning.message), ...result.warnings] };
}

/** Persist real label atoms, just like authored abbreviations: nothing invisible remains
 * selectable behind them. Chemistry consumers expand these through the shared label grammar. */
function condenseSchemeLabels(molecule: MoleculeObject): MoleculeObject {
  const eligible = (atom: MoleculeObject["atoms"][number]) => atom.isotope === undefined &&
    !atom.labelLiteral && !atom.markRadicals && !atom.markCharge && atom.labelVisible !== false;
  if (molecule.atoms.length === 2 && !molecule.bonds.length && molecule.atoms.every(eligible)) {
    const sodium = molecule.atoms.find(a => a.element === "Na" && a.formalCharge === 1 && !a.hydrogenCount);
    const hydroxide = molecule.atoms.find(a => a.element === "O" && a.formalCharge === -1 &&
      (a.hydrogenCount === undefined || a.hydrogenCount === 1));
    if (sodium && hydroxide) return { ...molecule, atoms: [{ ...sodium, element: "NaOH", schemeAbbreviation: "NaOH", formalCharge: 0, labelVisible: true }] };
  }
  let atoms = [...molecule.atoms], bonds = [...molecule.bonds];
  for (const metal of molecule.atoms.filter(a => a.element === "Mg" && a.formalCharge === 0 && !a.hydrogenCount && eligible(a))) {
    const incident = bonds.filter(b => b.fromAtomId === metal.id || b.toAtomId === metal.id);
    if (incident.length !== 2) continue;
    // Only R–Mg–Br: a second halide or other non-carbon ligand is a salt, not a Grignard.
    const carbonBonds = incident.filter(b => b.order === "single" && b.stereo === undefined && !b.display?.bondStyle &&
      atoms.some(a => a.id === (b.fromAtomId === metal.id ? b.toAtomId : b.fromAtomId) && a.element === "C"));
    if (carbonBonds.length !== 1) continue;
    for (const bond of incident) {
      if (bond.order !== "single" || bond.stereo !== undefined || bond.display?.bondStyle) continue;
      const halide = atoms.find(a => a.id === (bond.fromAtomId === metal.id ? bond.toAtomId : bond.fromAtomId));
      if (!halide || halide.element !== "Br" || halide.formalCharge !== 0 || halide.hydrogenCount || !eligible(halide) ||
          bonds.filter(b => b.fromAtomId === halide.id || b.toAtomId === halide.id).length !== 1) continue;
      atoms = atoms.filter(a => a.id !== halide.id).map(a => a.id === metal.id ? { ...a, element: "MgBr", labelVisible: true } : a);
      bonds = bonds.filter(b => b.id !== bond.id);
      break;
    }
  }
  // A spelled single-element label already has exact, editable hydrogen semantics.
  if (atoms.length === 1 && !bonds.length && atoms[0]!.element === "O" && atoms[0]!.formalCharge === 0 &&
      (atoms[0]!.hydrogenCount === undefined || atoms[0]!.hydrogenCount === 2) && eligible(atoms[0]!)) {
    atoms = [{ ...atoms[0]!, element: "H2O", labelVisible: true }];
  }
  return { ...molecule, atoms, bonds };
}

/** Read the native roles of every step in page order, including shared intermediates. */
export function documentReactionSummary(document: ChemDraftDocument) {
  return document.pages.flatMap(page => {
    const objects = new Map(page.objects.map(object => [object.id, object]));
    return page.objects.filter((object): object is ReactionObject => object.type === "reaction").map(reaction => ({
      pageId: page.id,
      reactionId: reaction.id,
      components: reaction.components.map(component => ({ ...component })),
      arrowObjectIds: [...(reaction.arrowObjectIds ?? [])],
      plusObjectIds: [...(reaction.plusObjectIds ?? [])],
      conditions: reaction.conditionsTextObjectIds.map(objectId => {
        const object = objects.get(objectId);
        return { objectId, text: object?.type === "text" ? object.text : undefined };
      }),
      mappingState: reaction.mappingState
    }));
  });
}

/**
 * Positions already-depicted reaction components without loading a chemistry engine. The anchor
 * is the left edge of the left-most component at the scheme's vertical centre.
 */
export function layoutReactionScheme(options: Omit<ReactionSchemeLayoutOptions, "alignProduct" | "alignmentScheduler">): ReactionSchemeLayout {
  const textStyle = { ...(options.style === "document" ? DocumentTextStyle : {}), ...options.textStyle };
  const warnings: string[] = [];
  // Bounds supplied by older callers may include storage padding. Always measure the same bond
  // and atom-label plans that paint the canvas, after orientation matching has finished.
  const measure = (component: ReactionSchemeComponent) => {
    const molecule = condenseSchemeLabels(component.molecule);
    const b = moleculeInkBounds(molecule);
    return { molecule, bounds: { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height } };
  };
  const reactants = options.reactants.map(measure);
  const measuredProducts = options.products.map(measure);
  const visible = [...reactants, ...measuredProducts];
  if (visible.length === 0) throw new Error("A reaction scheme needs at least one molecule.");
  const bondLength = representativeMoleculeBondLength(visible[0]!.molecule) ?? options.bondLength;
  const gap = 1.25 * bondLength;
  const drawing = reactionSchemeDrawingMetrics(visible[0]!.molecule);
  const plusStyle = { ...textStyle, fontSizePx: drawing.fontSizePx, textAlign: "center" as const };

  const labelPlan = planReactionLabels({
    above: [...(options.conditionText === undefined ? [] : [options.conditionText]), ...(options.above ?? [])],
    below: options.below ?? [],
    caption: options.caption,
    textStyle,
    bondLength,
    arrowKind: options.arrowKind,
    arrowStrokeWidth: drawing.strokeWidth
  });
  const plusSize = { width: drawing.plusSize, height: drawing.plusSize };
  const arrowLength = labelPlan.arrowLength;
  const arrowInk = reactionArrowInkBounds(options.arrowKind, arrowLength, drawing.strokeWidth);

  let cursor = options.anchor.x;
  let moleculeNumber = 0;
  let molecules: MoleculeObject[] = [];
  const moleculeFrames: Array<{ x: number; y: number; width: number; height: number }> = [];
  const plusPoints: Array<{ x: number; y: number }> = [];
  const placeGroup = (components: readonly ReturnType<typeof measure>[]): void => {
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
        cursor += gap;
        plusPoints.push({ x: cursor, y: options.anchor.y - plusSize.height / 2 });
        cursor += plusSize.width + gap;
      }
    });
  };

  const leftSide = options.arrowKind === "retrosynthesis" ? measuredProducts : reactants;
  const rightSide = options.arrowKind === "retrosynthesis" ? reactants : measuredProducts;
  placeGroup(leftSide);
  cursor += gap;
  const arrowStart = cursor - arrowInk.x;
  const arrowEnd = arrowStart + arrowLength;
  cursor = arrowStart + arrowInk.x + arrowInk.width + gap;
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
  arrow = { ...arrow, style: { ...arrow.style, strokeWidth: drawing.strokeWidth } };
  let pluses = plusPoints.map((point, index): TextObject => ({ ...createLayoutText(
    nextLayoutId("text", molecules.length + 2 + index),
    point,
    "+",
    plusStyle
  ), ...plusSize, style: { ...textStyleToObjectStyle(plusStyle), reactionPlus: true,
    strokeWidth: drawing.strokeWidth, textBoxSizingMode: "fixed" } }));
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
    warnings, alignmentWarnings: [],
    ...(above ? { above } : {}),
    ...(below ? { below } : {}),
    ...(caption ? { caption } : {})
  };
}

/** Copy only the engine's coordinates and directed stereo spelling onto the original graph.
 * Atom/bond ids, chemistry, annotations and styles remain native. RDKit checked canonical identity. */
function alignedMolecule(molecule: MoleculeObject, molfile: string): MoleculeObject {
  const depiction = pastedStructureDepictionFromMolfile(molfile);
  if (depiction.atoms.length !== molecule.atoms.length || depiction.bonds.length !== molecule.bonds.length) {
    throw new Error("Aligned depiction changed the native atom or bond count.");
  }
  const pair = (a: string, b: string) => [a, b].sort().join(":");
  const originalBonds = new Map(molecule.bonds.map(bond => [pair(bond.fromAtomId, bond.toAtomId), bond]));
  const atoms = molecule.atoms.map((atom, index) => ({ ...atom,
    x: depiction.atoms[index]!.x, y: -depiction.atoms[index]!.y }));
  const bonds = depiction.bonds.map(bond => {
    const fromAtomId = atoms[bond.from]!.id, toAtomId = atoms[bond.to]!.id;
    const original = originalBonds.get(pair(fromAtomId, toAtomId));
    if (!original) throw new Error("Aligned depiction changed the native atom connectivity.");
    const display = { ...original.display };
    if (display.bondStyle === "wedge" || display.bondStyle === "hashed") delete display.bondStyle;
    if (bond.wedge) display.bondStyle = bond.wedge;
    return { ...original, fromAtomId, toAtomId, display };
  });
  let result = normalizeNativeMoleculeGeometry({ ...molecule, atoms, bonds, structureFormat: "molfile-v2000", structure: molfile });
  result = { ...result, bonds: result.bonds.map(bond => bond.order === "double"
    ? { ...bond, display: { ...bond.display, doubleBondSide: defaultDoubleBondSide(result, bond) } } : bond) };
  return result;
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
