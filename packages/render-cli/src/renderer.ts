import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  setRdkitModuleLoader,
  type RdkitMinimalModule
} from "@chemdraft/rdkit-adapter";

import {
  applyMoleculeTargetBondLength,
  insertSmilesMolecule,
  pastedStructureDepictionFromMolfile,
  smilesPasteBondLengthPx,
  type PastedStructureDepiction
} from "../../../apps/desktop/src/documentWorkflow";

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

interface DepictionResult {
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

let rdkitLoaderInstalled = false;

/** Register the vendored MinimalLib build using the same Node bootstrap as rdkit-adapter/testing. */
function installNodeRdkitModuleLoader(): void {
  if (rdkitLoaderInstalled) return;

  const glueUrl = new URL("../../rdkit-adapter/vendor/RDKit_minimal.js", import.meta.url);
  const wasmUrl = new URL("../../rdkit-adapter/vendor/RDKit_minimal.wasm", import.meta.url);
  const glueSource = readFileSync(glueUrl, "utf8");
  const wasmBinary = new Uint8Array(readFileSync(wasmUrl));
  const factory = new Function("require", "__dirname", `${glueSource}\n;return initRDKitModule;`)(
    createRequire(import.meta.url),
    dirname(fileURLToPath(glueUrl))
  ) as (options: {
    locateFile: (file: string) => string;
    wasmBinary: Uint8Array;
  }) => Promise<RdkitMinimalModule>;

  setRdkitModuleLoader(() => factory({
    locateFile: () => fileURLToPath(wasmUrl),
    wasmBinary
  }));
  rdkitLoaderInstalled = true;
}

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

async function depictSmiles(smiles: string): Promise<DepictionResult> {
  const ocl = await import("@chemdraft/ocl-adapter");
  let rdkitFailure: unknown;

  try {
    installNodeRdkitModuleLoader();
    const molfile = await generateSmiles2DMolfile(smiles);
    rejectUnsupportedMolfileLabels(molfile, smiles);
    const depiction = pastedStructureDepictionFromMolfile(molfile);
    const counts = stereoCenterCounts(ocl.perceiveStereoCentersFromMolfile(molfile));
    return { depiction, molfile, engine: "rdkit", ...counts, warnings: [] };
  } catch (error) {
    if (error instanceof UnsupportedMolfileLabelError) throw error;
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

function moleculeVisualBounds(document: ChemDraftDocument, molecule: MoleculeObject): Bounds {
  const bounds: Bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  };

  molecule.atoms.forEach((atom) => includePoint(bounds, atom.x, atom.y));
  planMoleculeAtomLabels(molecule).forEach((plan) => {
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

  const page = document.pages[0];
  if (!page) throw new Error("The render document has no page.");
  planPageSvgRender(page).fragments.forEach((fragment) => includePlannedGeometry(bounds, fragment));

  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) {
    throw new Error("The molecule has no finite visual bounds.");
  }
  return bounds;
}

function svgNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function cropSvg(
  svg: string,
  bounds: Bounds,
  padding: number,
  background: RenderBackground
): { svg: string; viewBox: RenderedSmiles["viewBox"] } {
  const viewBox = {
    x: bounds.minX - padding,
    y: bounds.minY - padding,
    width: Math.max(1, bounds.maxX - bounds.minX + padding * 2),
    height: Math.max(1, bounds.maxY - bounds.minY + padding * 2)
  };
  const rootPattern = /<svg\s+([^>]*?)width="[^"]+"\s+height="[^"]+"\s+viewBox="[^"]+"([^>]*)>/;
  let cropped = svg.replace(
    rootPattern,
    `<svg $1width="${svgNumber(viewBox.width)}" height="${svgNumber(viewBox.height)}" viewBox="${svgNumber(viewBox.x)} ${svgNumber(viewBox.y)} ${svgNumber(viewBox.width)} ${svgNumber(viewBox.height)}"$2>`
  );
  if (cropped === svg) {
    throw new Error("Could not crop SVG: the exported root dimensions were not found.");
  }

  if (background === "white") {
    cropped = cropped.replace(
      /(<svg[^>]*>\n)\s*<rect\s+width="[^"]+"\s+height="[^"]+"\s+fill="#ffffff"\s*\/>/,
      `$1  <rect x="${svgNumber(viewBox.x)}" y="${svgNumber(viewBox.y)}" width="${svgNumber(viewBox.width)}" height="${svgNumber(viewBox.height)}" fill="#ffffff" />`
    );
  }

  return { svg: cropped, viewBox };
}

export async function renderSmilesToAssets(
  smiles: string,
  options: RenderSmilesOptions = {}
): Promise<RenderedSmiles> {
  const trimmedSmiles = smiles.trim();
  if (!trimmedSmiles) throw new Error("Unable to render SMILES: the input is empty.");

  const name = options.name ?? "structure";
  const width = finitePositive(options.width ?? DEFAULT_WIDTH, "PNG width");
  const bondLength = finitePositive(options.bondLength ?? smilesPasteBondLengthPx, "Bond length");
  const padding = finiteNonNegative(options.padding ?? DEFAULT_PADDING, "Padding");
  const background = options.background ?? "white";
  if (background !== "white" && background !== "transparent") {
    throw new Error(`Background must be "white" or "transparent", received "${String(background)}".`);
  }

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

  const exported = exportDocumentToSvg(document, {
    background: background === "white" ? "#ffffff" : "transparent"
  });
  const cropped = cropSvg(exported.contents, moleculeVisualBounds(document, molecule), padding, background);
  const png = new Resvg(cropped.svg, {
    fitTo: { mode: "width", value: Math.round(width) }
  }).render().asPng();

  return {
    name,
    smiles: trimmedSmiles,
    svg: cropped.svg,
    png,
    engine: depicted.engine,
    stereoCenters: depicted.stereoCenters,
    unspecifiedStereoCenters: depicted.unspecifiedStereoCenters,
    warnings: [...depicted.warnings, ...exported.warnings.map((warning) => warning.message)],
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
