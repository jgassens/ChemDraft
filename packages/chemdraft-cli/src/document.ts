import { Resvg } from "@resvg/resvg-js";

import {
  createEmptyDocument,
  moleculeToMolfileV2000,
  moleculeToMolfileV3000,
  type ChemDraftDocument,
  type MoleculeBond,
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
  ensureRdkit,
  generateSmiles2DMolfile,
  RdkitNotConfiguredError
} from "@chemdraft/rdkit-adapter";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";

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
  unspecifiedDoubleBonds: number;
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
  sourceCanonicalSmiles?: string;
  identityVerifiedByRdkit: boolean;
  unspecifiedDoubleBondIndices: number[];
  dativeBondIndices: number[];
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
export const MIN_RASTER_WIDTH = 16;
export const MAX_RASTER_WIDTH = 4000;
const MAX_SMILES_LENGTH = 5000;
const MAX_HEAVY_ATOMS = 500;
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

/** A caller-controlled input exceeded a documented work or output limit. */
export class InputLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputLimitError";
  }
}

export function isRdkitNotConfiguredError(error: unknown): boolean {
  return error instanceof RdkitNotConfiguredError ||
    (error instanceof Error && error.name === "RdkitNotConfiguredError");
}

function normalizedSmilesInput(smiles: string): string {
  if (smiles.length > MAX_SMILES_LENGTH) {
    throw new InputLimitError(
      `Unable to render SMILES: input exceeds the ${MAX_SMILES_LENGTH}-character limit.`
    );
  }
  const trimmed = smiles.trim();
  if (!trimmed) {
    throw new Error("Unable to render SMILES: the input is empty.");
  }
  return trimmed;
}

function rejectOversizedDepiction(depiction: PastedStructureDepiction): void {
  const heavyAtoms = depiction.atoms.filter((atom) => atom.element !== "H").length;
  if (heavyAtoms > MAX_HEAVY_ATOMS) {
    throw new InputLimitError(
      `Unable to render SMILES: structure has ${heavyAtoms} heavy atoms; the limit is ${MAX_HEAVY_ATOMS}.`
    );
  }
}

interface RdkitCountMolecule {
  delete(): void;
  get_json?: () => string;
  get_num_atoms?: () => number;
}

interface RdkitCountJson {
  defaults?: { atom?: { z?: number } };
  molecules?: Array<{ atoms?: Array<{ z?: number }> }>;
}

/** Refuse oversized structures after a graph parse but before either engine performs 2D layout. */
async function rejectOversizedSmiles(smiles: string): Promise<void> {
  installNodeEngines();
  const rdkit = await ensureRdkit();
  const molecule = rdkit.get_mol(smiles) as (RdkitCountMolecule & object) | null;
  // Preserve the existing OCL fallback for inputs RDKit cannot parse. A successful RDKit parse is
  // the common path and gives us a cheap, layout-free count from the engine's own atom graph.
  if (!molecule) return;

  try {
    let heavyAtoms: number | undefined;
    if (molecule.get_json) {
      const parsed = JSON.parse(molecule.get_json()) as RdkitCountJson;
      const defaultAtomicNumber = parsed.defaults?.atom?.z ?? 6;
      const atoms = parsed.molecules?.[0]?.atoms;
      if (atoms) {
        heavyAtoms = atoms.filter((atom) => (atom.z ?? defaultAtomicNumber) !== 1).length;
      }
    } else if (molecule.get_num_atoms) {
      // Older MinimalLib builds expose only this count. Its default SMILES parse removes hydrogens.
      heavyAtoms = molecule.get_num_atoms();
    }
    if (heavyAtoms !== undefined && heavyAtoms > MAX_HEAVY_ATOMS) {
      throw new InputLimitError(
        `Unable to render SMILES: structure has ${heavyAtoms} heavy atoms; the limit is ${MAX_HEAVY_ATOMS}.`
      );
    }
  } finally {
    molecule.delete();
  }
}

interface SourceBondSemantics {
  unspecifiedDoubleBondIndices: number[];
  dativeBondIndices: number[];
}

/** Read the bond semantics the desktop's structural depiction type cannot currently carry. */
function sourceBondSemantics(molfile: string): SourceBondSemantics {
  const unspecifiedDoubleBondIndices: number[] = [];
  const dativeBondIndices: number[] = [];
  const lines = molfile.split(/\r?\n/);
  const v2000CountsIndex = lines.findIndex((line) => /\bV2000\b/.test(line));
  if (v2000CountsIndex >= 0) {
    const counts = lines[v2000CountsIndex] ?? "";
    const atomCount = Number.parseInt(counts.slice(0, 3).trim(), 10);
    const bondCount = Number.parseInt(counts.slice(3, 6).trim(), 10);
    if (Number.isInteger(atomCount) && Number.isInteger(bondCount)) {
      const bondStart = v2000CountsIndex + 1 + atomCount;
      for (let index = 0; index < bondCount; index += 1) {
        const line = lines[bondStart + index] ?? "";
        const order = Number.parseInt(line.slice(6, 9).trim(), 10);
        const stereo = Number.parseInt(line.slice(9, 12).trim(), 10);
        if (order === 2 && stereo === 3) unspecifiedDoubleBondIndices.push(index);
      }
    }
    return { unspecifiedDoubleBondIndices, dativeBondIndices };
  }

  let inBondSection = false;
  let bondIndex = 0;
  for (const line of lines) {
    if (/^M\s+V30\s+BEGIN BOND\s*$/.test(line)) {
      inBondSection = true;
      continue;
    }
    if (/^M\s+V30\s+END BOND\s*$/.test(line)) {
      inBondSection = false;
      continue;
    }
    if (!inBondSection) continue;
    const match = /^M\s+V30\s+\d+\s+(\d+)\s+\d+\s+\d+\b(.*)$/.exec(line);
    if (!match) continue;
    const type = Number(match[1]);
    if (type === 9) dativeBondIndices.push(bondIndex);
    if (type === 2 && /\bCFG=2\b/.test(match[2] ?? "")) {
      unspecifiedDoubleBondIndices.push(bondIndex);
    }
    bondIndex += 1;
  }
  return { unspecifiedDoubleBondIndices, dativeBondIndices };
}

async function canonicalSmiles(structure: string, label: "input" | "output"): Promise<string> {
  const identifiers = await computeStructureIdentifiers(structure);
  if (!identifiers?.smiles) {
    throw new Error(`Unable to verify chemical identity: RDKit could not canonicalize the ${label}.`);
  }
  return identifiers.smiles;
}

async function optionalCanonicalSmiles(structure: string): Promise<string | undefined> {
  try {
    return (await computeStructureIdentifiers(structure))?.smiles;
  } catch {
    return undefined;
  }
}

/** Fail closed if RDKit's canonical isomeric SMILES says a conversion changed identity. */
export async function assertCanonicalIdentity(
  inputCanonicalSmiles: string,
  outputStructure: string
): Promise<void> {
  const outputCanonicalSmiles = await canonicalSmiles(outputStructure, "output");
  if (outputCanonicalSmiles !== inputCanonicalSmiles) {
    throw new Error(`identity changed: ${inputCanonicalSmiles} -> ${outputCanonicalSmiles}`);
  }
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

function withDativeBondStyles(
  molecule: MoleculeObject,
  dativeBondIndices: readonly number[]
): MoleculeObject {
  if (dativeBondIndices.length === 0) return molecule;
  const dative = new Set(dativeBondIndices);
  return {
    ...molecule,
    // The metadata was calculated before the structural insert knew these bonds were dative.
    // Omit that stale derived cache; the native graph and RDKit identity remain authoritative.
    chemistry: undefined,
    bonds: molecule.bonds.map((bond, index): MoleculeBond => dative.has(index)
      ? { ...bond, display: { ...(bond.display ?? {}), bondStyle: "dashed" } }
      : bond)
  };
}

function replaceMolecule(
  document: ChemDraftDocument,
  molecule: MoleculeObject
): ChemDraftDocument {
  return {
    ...document,
    pages: document.pages.map((page) => ({
      ...page,
      objects: page.objects.map((object) => object.id === molecule.id ? molecule : object)
    }))
  };
}

function markV2000UnspecifiedDoubleBonds(
  molfile: string,
  indices: ReadonlySet<number>
): string {
  if (indices.size === 0) return molfile;
  const lines = molfile.split(/\r?\n/);
  const countsIndex = lines.findIndex((line) => /\bV2000\b/.test(line));
  if (countsIndex < 0) return molfile;
  const atomCount = Number.parseInt((lines[countsIndex] ?? "").slice(0, 3).trim(), 10);
  const bondCount = Number.parseInt((lines[countsIndex] ?? "").slice(3, 6).trim(), 10);
  if (!Number.isInteger(atomCount) || !Number.isInteger(bondCount)) return molfile;
  const bondStart = countsIndex + 1 + atomCount;
  for (const index of indices) {
    if (index < 0 || index >= bondCount) continue;
    const lineIndex = bondStart + index;
    const line = lines[lineIndex];
    if (!line || Number.parseInt(line.slice(6, 9).trim(), 10) !== 2) continue;
    lines[lineIndex] = `${line.slice(0, 9)}  3${line.slice(12)}`;
  }
  return lines.join(molfile.includes("\r\n") ? "\r\n" : "\n");
}

function markV3000UnspecifiedDoubleBonds(
  molfile: string,
  indices: ReadonlySet<number>
): string {
  if (indices.size === 0) return molfile;
  const lines = molfile.split(/\r?\n/);
  let inBondSection = false;
  let bondIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^M\s+V30\s+BEGIN BOND\s*$/.test(line)) {
      inBondSection = true;
      continue;
    }
    if (/^M\s+V30\s+END BOND\s*$/.test(line)) {
      inBondSection = false;
      continue;
    }
    if (!inBondSection || !/^M\s+V30\s+\d+\s+\d+\s+\d+\s+\d+\b/.test(line)) continue;
    if (indices.has(bondIndex) && !/\bCFG=/.test(line)) lines[index] = `${line} CFG=2`;
    bondIndex += 1;
  }
  return lines.join(molfile.includes("\r\n") ? "\r\n" : "\n");
}

function identityMolfile(
  molecule: MoleculeObject,
  semantics: SourceBondSemantics,
  warnings?: string[]
): { contents: string; format: "molfile-v2000" | "molfile-v3000" } {
  const unspecified = new Set(semantics.unspecifiedDoubleBondIndices);
  if (semantics.dativeBondIndices.length > 0) {
    return {
      contents: markV3000UnspecifiedDoubleBonds(
        moleculeToMolfileV3000(molecule, { fromDocFrame: true, warnings }),
        unspecified
      ),
      format: "molfile-v3000"
    };
  }
  return {
    contents: markV2000UnspecifiedDoubleBonds(
      moleculeToMolfileV2000(molecule, { fromDocFrame: true, warnings }),
      unspecified
    ),
    format: "molfile-v2000"
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
  const normalizedSmiles = normalizedSmilesInput(smiles);
  try {
    await rejectOversizedSmiles(normalizedSmiles);
  } catch (error) {
    if (error instanceof InputLimitError || isRdkitNotConfiguredError(error)) throw error;
    // Preserve the normal depiction path: it reports the RDKit failure and may still use OCL.
  }
  const ocl = await import("@chemdraft/ocl-adapter");
  let rdkitFailure: unknown;

  try {
    installNodeEngines();
    const molfile = await generateSmiles2DMolfile(normalizedSmiles);
    rejectUnsupportedMolfileLabels(molfile, normalizedSmiles);
    const depiction = pastedStructureDepictionFromMolfile(molfile);
    rejectOversizedDepiction(depiction);
    const counts = stereoCenterCounts(ocl.perceiveStereoCentersFromMolfile(molfile));
    const semantics = sourceBondSemantics(molfile);
    const sourceCanonicalSmiles = await canonicalSmiles(normalizedSmiles, "input");
    await assertCanonicalIdentity(sourceCanonicalSmiles, molfile);
    return {
      depiction,
      molfile,
      engine: "rdkit",
      ...counts,
      sourceCanonicalSmiles,
      identityVerifiedByRdkit: true,
      ...semantics,
      warnings: []
    };
  } catch (error) {
    if (error instanceof UnsupportedMolfileLabelError || error instanceof InputLimitError) throw error;
    // A missing platform loader is an application configuration error, not a chemistry failure.
    // Falling back here would make a broken CLI report a successful OCL render.
    if (isRdkitNotConfiguredError(error)) {
      throw error;
    }
    rdkitFailure = error;
  }

  try {
    const fallback = ocl.depictSmiles2D(normalizedSmiles);
    rejectUnsupportedMolfileLabels(fallback.molfile, normalizedSmiles);
    let depiction: PastedStructureDepiction;
    try {
      depiction = pastedStructureDepictionFromMolfile(fallback.molfile);
    } catch {
      // V2000 has fixed-width coordinates. Very large OCL layouts can still be carried through
      // losslessly via its structured result, exactly as desktop SMILES paste does.
      depiction = structuredOclDepiction(fallback);
    }
    rejectOversizedDepiction(depiction);
    const counts = stereoCenterCounts(ocl.perceiveStereoCentersFromMolfile(fallback.molfile));
    const semantics = sourceBondSemantics(fallback.molfile);
    const [inputCanonicalSmiles, outputCanonicalSmiles] = await Promise.all([
      optionalCanonicalSmiles(normalizedSmiles),
      optionalCanonicalSmiles(fallback.molfile)
    ]);
    if (
      inputCanonicalSmiles !== undefined &&
      outputCanonicalSmiles !== undefined &&
      inputCanonicalSmiles !== outputCanonicalSmiles
    ) {
      throw new Error(`identity changed: ${inputCanonicalSmiles} -> ${outputCanonicalSmiles}`);
    }
    const sourceCanonicalSmiles = inputCanonicalSmiles ?? outputCanonicalSmiles;
    const identityVerifiedByRdkit = inputCanonicalSmiles !== undefined && outputCanonicalSmiles !== undefined;
    const identityWarnings = !identityVerifiedByRdkit
      ? ["RDKit could not canonicalize the OpenChemLib fallback input/output pair; identity was not RDKit-verified."]
      : [];
    return {
      depiction,
      molfile: fallback.molfile,
      engine: "ocl",
      ...counts,
      sourceCanonicalSmiles,
      identityVerifiedByRdkit,
      ...semantics,
      warnings: [
        `RDKit depiction failed; used OpenChemLib fallback: ${errorMessage(rdkitFailure)}`,
        ...identityWarnings
      ]
    };
  } catch (oclError) {
    if (oclError instanceof UnsupportedMolfileLabelError || oclError instanceof InputLimitError) {
      throw oclError;
    }
    throw new Error(
      `Unable to render SMILES "${normalizedSmiles}": RDKit: ${errorMessage(rdkitFailure)}; OpenChemLib: ${errorMessage(oclError)}`
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

/** Validate a requested raster width and return the finite value unchanged. */
export function validateRasterWidth(width: number, flag: string): number {
  const rasterWidth = finitePositive(width, flag);
  if (rasterWidth < MIN_RASTER_WIDTH || rasterWidth > MAX_RASTER_WIDTH) {
    throw new Error(
      `${flag} must be between ${MIN_RASTER_WIDTH} and ${MAX_RASTER_WIDTH} pixels; received ${rasterWidth}.`
    );
  }
  return rasterWidth;
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
  const pngWidth = validateRasterWidth(width, "PNG width");
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
  unspecifiedDoubleBonds: number;
  dativeBonds: number;
  sourceCanonicalSmiles?: string;
  identityVerifiedByRdkit: boolean;
  identityMolfile: string;
  warnings: string[];
}

/** Build a one-molecule ChemDraft document from SMILES using the desktop insertion workflow. */
export async function buildSmilesDocument(
  smiles: string,
  options: BuildSmilesDocumentOptions = {}
): Promise<BuiltSmilesDocument> {
  const trimmedSmiles = normalizedSmilesInput(smiles);

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
  molecule = withDativeBondStyles(molecule, depicted.dativeBondIndices);
  document = replaceMolecule(document, molecule);
  if (Math.abs(bondLength - smilesPasteBondLengthPx) > 0.0001) {
    document = applyMoleculeTargetBondLength(document, [molecule.id], bondLength);
    molecule = moleculeFromDocument(document);
  }

  const serialized = identityMolfile(molecule, depicted);
  molecule = {
    ...molecule,
    structureFormat: serialized.format,
    structure: serialized.contents
  };
  document = replaceMolecule(document, molecule);
  if (depicted.sourceCanonicalSmiles !== undefined) {
    await assertCanonicalIdentity(depicted.sourceCanonicalSmiles, serialized.contents);
  }

  const warnings = [...depicted.warnings];
  if (depicted.unspecifiedDoubleBondIndices.length > 0) {
    warnings.push(
      `E/Z unspecified for ${depicted.unspecifiedDoubleBondIndices.length} double bond(s); the 2D drawing necessarily shows one geometry`
    );
  }

  return {
    name,
    smiles: trimmedSmiles,
    document,
    molecule,
    engine: depicted.engine,
    stereoCenters: depicted.stereoCenters,
    unspecifiedStereoCenters: depicted.unspecifiedStereoCenters,
    unspecifiedDoubleBonds: depicted.unspecifiedDoubleBondIndices.length,
    dativeBonds: depicted.dativeBondIndices.length,
    sourceCanonicalSmiles: depicted.sourceCanonicalSmiles,
    identityVerifiedByRdkit: depicted.identityVerifiedByRdkit,
    identityMolfile: serialized.contents,
    warnings
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
    unspecifiedDoubleBonds: built.unspecifiedDoubleBonds,
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
