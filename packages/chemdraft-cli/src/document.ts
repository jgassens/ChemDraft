import { Resvg } from "@resvg/resvg-js";

import {
  createEmptyDocument,
  type ChemDraftDocument,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import type { Depiction2D } from "@chemdraft/ocl-adapter";
import {
  atomLabelHaloWidthPx,
  planMoleculeAtomLabels,
  planPageSvgRender,
  type PageSvgAttributeValue,
  type PageSvgFragment
} from "@chemdraft/layout-engine";
import {
  generateSmiles2DMolfile,
  RdkitNotConfiguredError
} from "@chemdraft/rdkit-adapter";

import {
  applyMoleculeTargetBondLength,
  insertSmilesMolecule,
  pastedStructureDepictionFromMolfile,
  smilesPasteBondLengthPx,
  type PastedStructureDepiction
} from "../../../apps/desktop/src/documentWorkflow";

import { installNodeEngines } from "./engine";

export type RenderBackground = "white" | "transparent";
export type DepictionEngine = "rdkit" | "ocl";

export interface RenderSmilesOptions {
  name?: string;
  width?: number;
  background?: RenderBackground;
  bondLength?: number;
  padding?: number;
}

export interface RenderedSmiles {
  name: string;
  smiles: string;
  svg: string;
  png: Uint8Array;
  engine: DepictionEngine;
  stereoCenters: number;
  unspecifiedStereoCenters: number;
  warnings: string[];
  document: ChemDraftDocument;
  molecule: MoleculeObject;
  viewBox: { x: number; y: number; width: number; height: number };
}

export interface SmilesDepictionResult {
  depiction: PastedStructureDepiction;
  molfile: string;
  engine: DepictionEngine;
  stereoCenters: number;
  unspecifiedStereoCenters: number;
  warnings: string[];
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const DEFAULT_WIDTH = 600;
const DEFAULT_PADDING = 24;
const HIT_TARGET_CLASSES = new Set([
  "native-bond-hit-target",
  "native-bond-hover-decorator",
  "native-atom-hit-target",
  "native-crossing-hit-target",
  "native-molecule-ring-hit-target"
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function structuredOclDepiction(depiction: Depiction2D): PastedStructureDepiction {
  return {
    atoms: depiction.atoms.map((atom) => ({
      element: atom.element,
      x: atom.x,
      y: atom.y,
      charge: atom.charge
    })),
    bonds: depiction.bonds.map((bond) => ({
      from: bond.from,
      to: bond.to,
      // Aromatic/unknown orders and wedge direction cross this boundary unchanged.
      order: bond.order,
      wedge: bond.wedge
    }))
  };
}

class UnsupportedMolfileLabelError extends Error {}

function rejectUnsupportedMolfileLabels(molfile: string, smiles: string): void {
  if (/^M  (?:RAD|ISO)\b/m.test(molfile)) {
    throw new UnsupportedMolfileLabelError(
      `SMILES contains a radical/isotope label that ChemDraft cannot yet draw: ${smiles}`
    );
  }
}

function stereoCenterCounts(
  centers: ReadonlyArray<{ isStereoCenter: boolean; descriptor: "R" | "S" | "unspecified" }>
): { stereoCenters: number; unspecifiedStereoCenters: number } {
  return {
    stereoCenters: centers.filter((center) =>
      center.isStereoCenter && center.descriptor !== "unspecified"
    ).length,
    unspecifiedStereoCenters: centers.filter((center) =>
      center.isStereoCenter && center.descriptor === "unspecified"
    ).length
  };
}

/**
 * Convert a SMILES string to a ChemDraft-ready 2D depiction. RDKit is preferred; OpenChemLib is
 * used only after an explicit RDKit failure, which is preserved in the returned warnings.
 */
export async function depictSmiles(smiles: string): Promise<SmilesDepictionResult> {
  const ocl = await import("@chemdraft/ocl-adapter");
  let rdkitFailure: unknown;

  try {
    installNodeEngines();
    const molfile = await generateSmiles2DMolfile(smiles);
    rejectUnsupportedMolfileLabels(molfile, smiles);
    const depiction = pastedStructureDepictionFromMolfile(molfile);
    const counts = stereoCenterCounts(ocl.perceiveStereoCentersFromMolfile(molfile));
    return { depiction, molfile, engine: "rdkit", ...counts, warnings: [] };
  } catch (error) {
    if (error instanceof UnsupportedMolfileLabelError) throw error;
    // A missing platform loader is an application configuration error, not a chemistry failure.
    // Falling back here would make a broken CLI report a successful OCL render.
    if (
      (typeof RdkitNotConfiguredError === "function" && error instanceof RdkitNotConfiguredError) ||
      (error instanceof Error && error.message === "RDKit module loader has not been configured.")
    ) {
      throw error;
    }
    rdkitFailure = error;
  }

  try {
    const fallback = ocl.depictSmiles2D(smiles);
    rejectUnsupportedMolfileLabels(fallback.molfile, smiles);
    let depiction: PastedStructureDepiction;
    try {
      depiction = pastedStructureDepictionFromMolfile(fallback.molfile);
    } catch {
      // V2000 has fixed-width coordinates. Very large OCL layouts can still be carried through
      // losslessly via its structured result, exactly as desktop SMILES paste does.
      depiction = structuredOclDepiction(fallback);
    }
    const counts = stereoCenterCounts(ocl.perceiveStereoCentersFromMolfile(fallback.molfile));
    return {
      depiction,
      molfile: fallback.molfile,
      engine: "ocl",
      ...counts,
      warnings: [`RDKit depiction failed; used OpenChemLib fallback: ${errorMessage(rdkitFailure)}`]
    };
  } catch (oclError) {
    if (oclError instanceof UnsupportedMolfileLabelError) throw oclError;
    throw new Error(
      `Unable to render SMILES "${smiles}": RDKit: ${errorMessage(rdkitFailure)}; OpenChemLib: ${errorMessage(oclError)}`
    );
  }
}

export function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite number greater than zero.`);
  }
  return value;
}

export function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite, non-negative number.`);
  }
  return value;
}

function moleculeFromDocument(document: ChemDraftDocument): MoleculeObject {
  const molecule = document.pages[0]?.objects.find((object): object is MoleculeObject => object.type === "molecule");
  if (!molecule) {
    throw new Error("The SMILES depiction did not produce a molecule object.");
  }
  return molecule;
}

function includePoint(bounds: Bounds, x: number, y: number, expansion = 0): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(expansion)) return;
  bounds.minX = Math.min(bounds.minX, x - expansion);
  bounds.minY = Math.min(bounds.minY, y - expansion);
  bounds.maxX = Math.max(bounds.maxX, x + expansion);
  bounds.maxY = Math.max(bounds.maxY, y + expansion);
}

function numericAttribute(attrs: Record<string, PageSvgAttributeValue>, name: string): number | undefined {
  const value = attrs[name];
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function strokeExpansion(attrs: Record<string, PageSvgAttributeValue>): number {
  return (numericAttribute(attrs, "stroke-width") ?? 0) / 2;
}

function includePointList(bounds: Bounds, points: string, expansion: number): void {
  for (const point of points.trim().split(/\s+/)) {
    const [x, y] = point.split(",").map(Number);
    if (x !== undefined && y !== undefined) includePoint(bounds, x, y, expansion);
  }
}

/**
 * Read actual line/polygon geometry from the layout engine's page plan. This deliberately consumes
 * the shared plan instead of reproducing wedge, hash, multiple-bond, or junction rendering math.
 */
function includePlannedGeometry(bounds: Bounds, fragment: PageSvgFragment): void {
  if (fragment.kind === "text") return;
  const className = typeof fragment.attrs.class === "string" ? fragment.attrs.class : "";
  if (HIT_TARGET_CLASSES.has(className)) return;

  const expansion = strokeExpansion(fragment.attrs);
  if (fragment.tag === "line") {
    const x1 = numericAttribute(fragment.attrs, "x1");
    const y1 = numericAttribute(fragment.attrs, "y1");
    const x2 = numericAttribute(fragment.attrs, "x2");
    const y2 = numericAttribute(fragment.attrs, "y2");
    if (x1 !== undefined && y1 !== undefined) includePoint(bounds, x1, y1, expansion);
    if (x2 !== undefined && y2 !== undefined) includePoint(bounds, x2, y2, expansion);
  } else if (fragment.tag === "polygon" || fragment.tag === "polyline") {
    const points = fragment.attrs.points;
    if (typeof points === "string") includePointList(bounds, points, expansion);
  } else if (fragment.tag === "circle") {
    const cx = numericAttribute(fragment.attrs, "cx");
    const cy = numericAttribute(fragment.attrs, "cy");
    const radius = numericAttribute(fragment.attrs, "r");
    if (cx !== undefined && cy !== undefined && radius !== undefined) {
      includePoint(bounds, cx, cy, radius + expansion);
    }
  } else if (fragment.tag === "ellipse") {
    const cx = numericAttribute(fragment.attrs, "cx");
    const cy = numericAttribute(fragment.attrs, "cy");
    const rx = numericAttribute(fragment.attrs, "rx");
    const ry = numericAttribute(fragment.attrs, "ry");
    if (cx !== undefined && cy !== undefined && rx !== undefined && ry !== undefined) {
      includePoint(bounds, cx - rx, cy - ry, expansion);
      includePoint(bounds, cx + rx, cy + ry, expansion);
    }
  }

  fragment.children.forEach((child) => includePlannedGeometry(bounds, child));
}

/** Visible bounds for the first page, including every molecule label and native text object. */
export function documentVisualBounds(document: ChemDraftDocument): Bounds {
  const bounds: Bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  };

  const page = document.pages[0];
  if (!page) throw new Error("The render document has no page.");

  for (const object of page.objects) {
    if (object.type === "molecule") {
      object.atoms.forEach((atom) => includePoint(bounds, atom.x, atom.y));
      planMoleculeAtomLabels(object).forEach((plan) => {
        const halo = plan.backgroundVisible ? atomLabelHaloWidthPx(plan.drawingStyle) / 2 : 0;
        includePoint(
          bounds,
          plan.anchor.x + plan.layout.bounds.x,
          plan.anchor.y + plan.layout.bounds.y,
          halo
        );
        includePoint(
          bounds,
          plan.anchor.x + plan.layout.bounds.x + plan.layout.bounds.width,
          plan.anchor.y + plan.layout.bounds.y + plan.layout.bounds.height,
          halo
        );
      });
    } else if (object.type === "text") {
      includePoint(bounds, object.x, object.y);
      includePoint(bounds, object.x + object.width, object.y + object.height);
    }
  }

  planPageSvgRender(page).fragments.forEach((fragment) => includePlannedGeometry(bounds, fragment));

  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) {
    throw new Error("The document has no finite visual bounds.");
  }
  return bounds;
}

function svgNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function rewriteSvgRootToViewBox(
  svg: string,
  viewBox: RenderedSmiles["viewBox"],
  background: RenderBackground
): string {
  const rootPattern = /<svg\s+([^>]*?)width="[^"]+"\s+height="[^"]+"\s+viewBox="[^"]+"([^>]*)>/;
  let rewritten = svg.replace(
    rootPattern,
    `<svg $1width="${svgNumber(viewBox.width)}" height="${svgNumber(viewBox.height)}" viewBox="${svgNumber(viewBox.x)} ${svgNumber(viewBox.y)} ${svgNumber(viewBox.width)} ${svgNumber(viewBox.height)}"$2>`
  );
  if (rewritten === svg) {
    throw new Error("Could not crop SVG: the exported root dimensions were not found.");
  }

  if (background === "white") {
    rewritten = rewritten.replace(
      /(<svg[^>]*>\n)\s*<rect\s+[^>]*fill="#ffffff"\s*\/>/,
      `$1  <rect x="${svgNumber(viewBox.x)}" y="${svgNumber(viewBox.y)}" width="${svgNumber(viewBox.width)}" height="${svgNumber(viewBox.height)}" fill="#ffffff" />`
    );
  }
  return rewritten;
}

/** Crop an exported document SVG to all visible first-page content plus requested padding. */
export function cropDocumentSvgToContent(
  svg: string,
  document: ChemDraftDocument,
  padding: number,
  background: RenderBackground
): { svg: string; viewBox: RenderedSmiles["viewBox"] } {
  const bounds = documentVisualBounds(document);
  const contentPadding = finiteNonNegative(padding, "Padding");
  const viewBox = {
    x: bounds.minX - contentPadding,
    y: bounds.minY - contentPadding,
    width: Math.max(1, bounds.maxX - bounds.minX + contentPadding * 2),
    height: Math.max(1, bounds.maxY - bounds.minY + contentPadding * 2)
  };
  return { svg: rewriteSvgRootToViewBox(svg, viewBox, background), viewBox };
}

/** Rasterize an SVG to a PNG whose output width is measured in pixels. */
export function svgToPng(svg: string, width: number): Uint8Array {
  const pngWidth = finitePositive(width, "PNG width");
  return new Resvg(svg, {
    fitTo: { mode: "width", value: Math.round(pngWidth) }
  }).render().asPng();
}

export interface BuildSmilesDocumentOptions {
  name?: string;
  bondLength?: number;
}

export interface BuiltSmilesDocument {
  name: string;
  smiles: string;
  document: ChemDraftDocument;
  molecule: MoleculeObject;
  engine: DepictionEngine;
  stereoCenters: number;
  unspecifiedStereoCenters: number;
  warnings: string[];
}

/** Build a one-molecule ChemDraft document from SMILES using the desktop insertion workflow. */
export async function buildSmilesDocument(
  smiles: string,
  options: BuildSmilesDocumentOptions = {}
): Promise<BuiltSmilesDocument> {
  const trimmedSmiles = smiles.trim();
  if (!trimmedSmiles) throw new Error("Unable to render SMILES: the input is empty.");

  const name = options.name ?? "structure";
  const bondLength = finitePositive(options.bondLength ?? smilesPasteBondLengthPx, "Bond length");
  const depicted = await depictSmiles(trimmedSmiles);
  let document = createEmptyDocument({ title: name });
  const page = document.pages[0];
  if (!page) throw new Error("The render document has no page.");
  document = insertSmilesMolecule(
    document,
    { x: page.width / 2, y: page.height / 2 },
    depicted.depiction,
    trimmedSmiles
  );
  let molecule = moleculeFromDocument(document);
  if (Math.abs(bondLength - smilesPasteBondLengthPx) > 0.0001) {
    document = applyMoleculeTargetBondLength(document, [molecule.id], bondLength);
    molecule = moleculeFromDocument(document);
  }

  return {
    name,
    smiles: trimmedSmiles,
    document,
    molecule,
    engine: depicted.engine,
    stereoCenters: depicted.stereoCenters,
    unspecifiedStereoCenters: depicted.unspecifiedStereoCenters,
    warnings: depicted.warnings
  };
}

/** Render a SMILES string to a cropped SVG, PNG, and the reusable ChemDraft document model. */
export async function renderSmilesToAssets(
  smiles: string,
  options: RenderSmilesOptions = {}
): Promise<RenderedSmiles> {
  const name = options.name ?? "structure";
  const width = finitePositive(options.width ?? DEFAULT_WIDTH, "PNG width");
  const bondLength = finitePositive(options.bondLength ?? smilesPasteBondLengthPx, "Bond length");
  const padding = finiteNonNegative(options.padding ?? DEFAULT_PADDING, "Padding");
  const background = options.background ?? "white";
  if (background !== "white" && background !== "transparent") {
    throw new Error(`Background must be "white" or "transparent", received "${String(background)}".`);
  }

  const built = await buildSmilesDocument(smiles, { name, bondLength });
  const { document, molecule } = built;

  const exported = exportDocumentToSvg(document, {
    background: background === "white" ? "#ffffff" : "transparent"
  });
  const cropped = cropDocumentSvgToContent(exported.contents, document, padding, background);
  const png = svgToPng(cropped.svg, width);

  return {
    name,
    smiles: built.smiles,
    svg: cropped.svg,
    png,
    engine: built.engine,
    stereoCenters: built.stereoCenters,
    unspecifiedStereoCenters: built.unspecifiedStereoCenters,
    warnings: [...built.warnings, ...exported.warnings.map((warning) => warning.message)],
    document,
    molecule,
    viewBox: cropped.viewBox
  };
}

export const renderDefaults = {
  width: DEFAULT_WIDTH,
  padding: DEFAULT_PADDING,
  bondLength: smilesPasteBondLengthPx,
  background: "white" as const
};
