import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import {
  createEmptyDocument,
  type ArrowObject,
  type ChemDraftDocument,
  type MoleculeObject,
  type NativeTextStyle
} from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { atomLabelHaloWidthPx, planMoleculeAtomLabels } from "@chemdraft/layout-engine";

import { parseOptions, stringOption } from "../args";
import {
  buildSmilesDocument,
  cropDocumentSvgToContent,
  finitePositive,
  renderDefaults,
  svgToPng,
  type BuiltSmilesDocument,
  type RenderBackground
} from "../document";
import { installNodeEngines } from "../engine";
import {
  CliUsageError,
  cliExitCode,
  defaultCliIo,
  readBatchFile,
  resultExitCode,
  writeJsonLine,
  writeProgress,
  type CliExitCode,
  type CliIo
} from "../output";
import {
  insertNativeReactionArrow,
  insertNativeTextObject,
  nativeTextObjectSizeForText
} from "../../../../apps/desktop/src/documentWorkflow";
import { installNodeRdkitModuleLoader } from "../../../rdkit-adapter/src/node";

export type ReactionArrowKind = ArrowObject["arrowKind"];
type ReactionOutputFormat = "png" | "svg";

export interface ParsedReactionSmiles {
  reactants: string[];
  agents: string[];
  products: string[];
}

interface ReactionJob {
  name: string;
  rxn: string;
  out: string;
  conditions: string;
  arrow: ReactionArrowKind;
  width: number;
  background: RenderBackground;
}

interface BatchReactionJob {
  name: string;
  rxn: string;
  out?: string;
  format?: ReactionOutputFormat;
  conditions?: string;
  arrow?: ReactionArrowKind;
  width?: number;
  background?: RenderBackground;
}

interface ParsedArguments {
  mode: "single" | "batch";
  jobsFile?: string;
  outDir?: string;
  format?: ReactionOutputFormat;
  job?: ReactionJob;
  conditions: string;
  arrow: ReactionArrowKind;
  width: number;
  background: RenderBackground;
}

export interface RenderedReactionScheme extends ParsedReactionSmiles {
  document: ChemDraftDocument;
  svg: string;
  viewBox: { x: number; y: number; width: number; height: number };
  arrow: ReactionArrowKind;
  conditions: string;
  warnings: string[];
}

const REACTION_GUTTER = renderDefaults.padding;
const PLUS_STYLE: Partial<NativeTextStyle> = { fontSizePx: 20, textAlign: "center" };
const CONDITIONS_STYLE: Partial<NativeTextStyle> = { fontSizePx: 14, textAlign: "center" };
const ARROW_KINDS = new Set<ReactionArrowKind>([
  "forward",
  "equilibrium",
  "resonance",
  "retrosynthesis"
]);

export const reactionHelp = `ChemDraft headless reaction-scheme renderer

Usage:
  pnpm chemdraft reaction --rxn <reactants>\u003e<agents>\u003e<products> --out <file.png|file.svg>
  pnpm chemdraft reaction --batch <jobs.json> [--out-dir <dir>] [--format png|svg]

Reaction SMILES must contain exactly two \u003e separators. Each side is split on '.', so a
'.'-joined salt is drawn as two species. Agents are validated as SMILES and shown as condition
text above the arrow; --conditions appends additional text there. Species, plus signs, and the
arrow use 24 px gutters, matching the default crop padding.

Batch input is a JSON array of objects with "name" and "rxn". Each job may supply "out"; otherwise
--out-dir is required and files are named from the job name (PNG by default).

Options:
  --conditions <text>             Additional conditions shown above the arrow
  --arrow <kind>                  forward|equilibrium|resonance|retrosynthesis (default: forward)
  --width <px>                    PNG width (default: ${renderDefaults.width})
  --background <kind>             white|transparent (default: white)
  --out-dir <dir>                 Batch output directory
  --format <kind>                 Batch output format when jobs omit "out" (default: png)
  --help                          Print this help

Output:
  One JSON line per reaction is written to stdout. Progress is written to stderr.
  Exit 0 when every reaction succeeds, 1 when any render fails, and 2 for bad arguments.`;

const reactionOptions = {
  "--rxn": { kind: "value" },
  "--out": { kind: "value" },
  "--batch": { kind: "value" },
  "--out-dir": { kind: "value" },
  "--format": { kind: "value" },
  "--conditions": { kind: "value" },
  "--arrow": { kind: "value" },
  "--width": { kind: "value" },
  "--background": { kind: "value" },
  "--help": { kind: "boolean" }
} as const;

function reactionArrow(value: unknown, label = "--arrow"): ReactionArrowKind {
  if (typeof value === "string" && ARROW_KINDS.has(value as ReactionArrowKind)) {
    return value as ReactionArrowKind;
  }
  throw new CliUsageError(
    `${label} must be forward, equilibrium, resonance, or retrosynthesis; received "${String(value)}".`
  );
}

function reactionBackground(value: unknown, label = "--background"): RenderBackground {
  if (value === "white" || value === "transparent") return value;
  throw new CliUsageError(`${label} must be white or transparent; received "${String(value)}".`);
}

function reactionFormat(value: unknown, label = "--format"): ReactionOutputFormat {
  if (value === "png" || value === "svg") return value;
  throw new CliUsageError(`${label} must be png or svg; received "${String(value)}".`);
}

function positiveWidth(value: unknown, label = "--width"): number {
  const parsed = typeof value === "number" ? value : Number(value);
  try {
    return finitePositive(parsed, label);
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

function outputFormat(path: string): ReactionOutputFormat {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "png";
  if (extension === ".svg") return "svg";
  throw new CliUsageError(`Reaction output must end in .png or .svg; received "${path}".`);
}

function reactionPart(part: string, role: "reactant" | "agent" | "product", allowEmpty: boolean): string[] {
  if (part.trim().length === 0) {
    if (allowEmpty) return [];
    throw new CliUsageError(`Reaction SMILES must contain at least one ${role}.`);
  }
  const components = part.split(".").map((component) => component.trim());
  if (components.some((component) => component.length === 0)) {
    throw new CliUsageError(`Reaction SMILES contains an empty ${role} component around '.'.`);
  }
  return components;
}

/** Parse the three reaction roles without changing any component SMILES. */
export function parseReactionSmiles(rxn: string): ParsedReactionSmiles {
  const parts = rxn.split(">");
  if (parts.length !== 3) {
    throw new CliUsageError(
      `Reaction SMILES must contain exactly two ">" separators (reactants>agents>products); received "${rxn}".`
    );
  }
  return {
    reactants: reactionPart(parts[0]!, "reactant", false),
    agents: reactionPart(parts[1]!, "agent", true),
    products: reactionPart(parts[2]!, "product", false)
  };
}

function parseArguments(argv: readonly string[]): ParsedArguments | { help: true } {
  if (argv.includes("--help")) return { help: true };
  const parsed = parseOptions(argv, reactionOptions);
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(`Unknown argument "${parsed.positionals[0]}".`);
  }

  const rxn = stringOption(parsed, "--rxn");
  const out = stringOption(parsed, "--out");
  const jobsFile = stringOption(parsed, "--batch");
  const outDir = stringOption(parsed, "--out-dir");
  const requestedFormat = stringOption(parsed, "--format");
  const conditions = stringOption(parsed, "--conditions")?.trim() ?? "";
  const requestedArrow = stringOption(parsed, "--arrow");
  const arrow = requestedArrow === undefined ? "forward" : reactionArrow(requestedArrow);
  const requestedWidth = stringOption(parsed, "--width");
  const width = requestedWidth === undefined ? renderDefaults.width : positiveWidth(requestedWidth);
  const requestedBackground = stringOption(parsed, "--background");
  const background = requestedBackground === undefined
    ? renderDefaults.background
    : reactionBackground(requestedBackground);

  if (jobsFile !== undefined) {
    if (rxn !== undefined || out !== undefined) {
      throw new CliUsageError("--rxn and --out are only valid in single-reaction mode.");
    }
    const format = requestedFormat === undefined ? undefined : reactionFormat(requestedFormat);
    return { mode: "batch", jobsFile, outDir, format, conditions, arrow, width, background };
  }

  if (!rxn || !out) throw new CliUsageError("Single-reaction mode requires both --rxn and --out.");
  if (outDir !== undefined || requestedFormat !== undefined) {
    throw new CliUsageError("--out-dir and --format are only valid with --batch.");
  }
  parseReactionSmiles(rxn);
  outputFormat(out);
  const extension = extname(out);
  return {
    mode: "single",
    conditions,
    arrow,
    width,
    background,
    job: {
      name: basename(out, extension) || "reaction",
      rxn,
      out,
      conditions,
      arrow,
      width,
      background
    }
  };
}

function parseBatchJob(candidate: unknown, index: number): BatchReactionJob {
  if (
    !candidate || typeof candidate !== "object" ||
    typeof (candidate as { name?: unknown }).name !== "string" ||
    typeof (candidate as { rxn?: unknown }).rxn !== "string"
  ) {
    throw new CliUsageError(`Batch job ${index + 1} must contain string "name" and "rxn" fields.`);
  }
  const raw = candidate as Record<string, unknown>;
  if (raw.out !== undefined && typeof raw.out !== "string") {
    throw new CliUsageError(`Batch job ${index + 1} "out" must be a string.`);
  }
  if (raw.conditions !== undefined && typeof raw.conditions !== "string") {
    throw new CliUsageError(`Batch job ${index + 1} "conditions" must be a string.`);
  }
  return {
    name: raw.name as string,
    rxn: raw.rxn as string,
    out: raw.out as string | undefined,
    format: raw.format === undefined ? undefined : reactionFormat(raw.format, `Batch job ${index + 1} format`),
    conditions: raw.conditions as string | undefined,
    arrow: raw.arrow === undefined ? undefined : reactionArrow(raw.arrow, `Batch job ${index + 1} arrow`),
    width: raw.width === undefined ? undefined : positiveWidth(raw.width, `Batch job ${index + 1} width`),
    background: raw.background === undefined
      ? undefined
      : reactionBackground(raw.background, `Batch job ${index + 1} background`)
  };
}

async function readReactionJobs(args: ParsedArguments): Promise<ReactionJob[]> {
  const jobs = await readBatchFile(args.jobsFile!, parseBatchJob, (job) => {
    parseReactionSmiles(job.rxn);
    if (job.out !== undefined) outputFormat(job.out);
    if (job.out === undefined && args.outDir === undefined) {
      throw new CliUsageError(`Batch job "${job.name}" needs "out" when --out-dir is not provided.`);
    }
  });
  return jobs.map((job) => {
    const format = job.format ?? args.format ?? "png";
    return {
      name: job.name,
      rxn: job.rxn,
      out: job.out ?? join(args.outDir!, `${job.name}.${format}`),
      conditions: job.conditions?.trim() ?? args.conditions,
      arrow: job.arrow ?? args.arrow,
      width: job.width ?? args.width,
      background: job.background ?? args.background
    };
  });
}

function translateMolecule(
  molecule: MoleculeObject,
  id: string,
  dx: number,
  dy: number
): MoleculeObject {
  return {
    ...molecule,
    id,
    x: molecule.x + dx,
    y: molecule.y + dy,
    atoms: molecule.atoms.map((atom) => ({ ...atom, x: atom.x + dx, y: atom.y + dy }))
  };
}

interface MoleculeVisualBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

function moleculeVisualBounds(molecule: MoleculeObject): MoleculeVisualBounds {
  let minX = molecule.x;
  let minY = molecule.y;
  let maxX = molecule.x + molecule.width;
  let maxY = molecule.y + molecule.height;
  for (const label of planMoleculeAtomLabels(molecule)) {
    const halo = label.backgroundVisible ? atomLabelHaloWidthPx(label.drawingStyle) / 2 : 0;
    minX = Math.min(minX, label.anchor.x + label.layout.bounds.x - halo);
    minY = Math.min(minY, label.anchor.y + label.layout.bounds.y - halo);
    maxX = Math.max(maxX, label.anchor.x + label.layout.bounds.x + label.layout.bounds.width + halo);
    maxY = Math.max(maxY, label.anchor.y + label.layout.bounds.y + label.layout.bounds.height + halo);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

async function depictComponent(smiles: string, index: number): Promise<BuiltSmilesDocument> {
  try {
    return await buildSmilesDocument(smiles, {
      name: `reaction-component-${index + 1}`,
      bondLength: renderDefaults.bondLength
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to render reaction component SMILES "${smiles}": ${message}`);
  }
}

function svgNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function expandCropForTextAndLabels(
  svg: string,
  document: ChemDraftDocument,
  initial: RenderedReactionScheme["viewBox"],
  padding: number,
  background: RenderBackground
): { svg: string; viewBox: RenderedReactionScheme["viewBox"] } {
  let minX = initial.x;
  let minY = initial.y;
  let maxX = initial.x + initial.width;
  let maxY = initial.y + initial.height;
  const include = (x1: number, y1: number, x2: number, y2: number): void => {
    minX = Math.min(minX, x1 - padding);
    minY = Math.min(minY, y1 - padding);
    maxX = Math.max(maxX, x2 + padding);
    maxY = Math.max(maxY, y2 + padding);
  };

  for (const object of document.pages[0]?.objects ?? []) {
    include(object.x, object.y, object.x + object.width, object.y + object.height);
    if (object.type === "molecule") {
      for (const label of planMoleculeAtomLabels(object)) {
        const halo = label.backgroundVisible ? atomLabelHaloWidthPx(label.drawingStyle) / 2 : 0;
        include(
          label.anchor.x + label.layout.bounds.x - halo,
          label.anchor.y + label.layout.bounds.y - halo,
          label.anchor.x + label.layout.bounds.x + label.layout.bounds.width + halo,
          label.anchor.y + label.layout.bounds.y + label.layout.bounds.height + halo
        );
      }
    }
  }

  const viewBox = {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
  const rootPattern = /<svg\s+([^>]*?)width="[^"]+"\s+height="[^"]+"\s+viewBox="[^"]+"([^>]*)>/;
  let expanded = svg.replace(
    rootPattern,
    `<svg $1width="${svgNumber(viewBox.width)}" height="${svgNumber(viewBox.height)}" viewBox="${svgNumber(viewBox.x)} ${svgNumber(viewBox.y)} ${svgNumber(viewBox.width)} ${svgNumber(viewBox.height)}"$2>`
  );
  if (expanded === svg && (
    viewBox.x !== initial.x || viewBox.y !== initial.y ||
    viewBox.width !== initial.width || viewBox.height !== initial.height
  )) {
    throw new Error("Could not expand the reaction SVG crop.");
  }
  if (background === "white") {
    expanded = expanded.replace(
      /(<svg[^>]*>\n)\s*<rect\s+[^>]*fill="#ffffff"\s*\/>/,
      `$1  <rect x="${svgNumber(viewBox.x)}" y="${svgNumber(viewBox.y)}" width="${svgNumber(viewBox.width)}" height="${svgNumber(viewBox.height)}" fill="#ffffff" />`
    );
  }
  return { svg: expanded, viewBox };
}

/** Build and crop one reaction scheme. Agents are depicted for validation, then shown as text. */
export async function renderReactionScheme(
  rxn: string,
  options: {
    arrow?: ReactionArrowKind;
    conditions?: string;
    background?: RenderBackground;
  } = {}
): Promise<RenderedReactionScheme> {
  const parsed = parseReactionSmiles(rxn);
  const arrow = options.arrow ?? "forward";
  if (!ARROW_KINDS.has(arrow)) reactionArrow(arrow);
  const background = options.background ?? renderDefaults.background;
  reactionBackground(background);
  installNodeEngines();
  // Package-level node_modules is linked from the source checkout in isolated worktrees. In that
  // setup the package subpath and this worktree's root import can have different module realpaths;
  // install the same idempotent Node loader on the depiction instance as well.
  installNodeRdkitModuleLoader();

  let componentIndex = 0;
  const depictAll = async (components: readonly string[]): Promise<BuiltSmilesDocument[]> => {
    const depicted: BuiltSmilesDocument[] = [];
    for (const smiles of components) {
      depicted.push(await depictComponent(smiles, componentIndex));
      componentIndex += 1;
    }
    return depicted;
  };
  const reactants = await depictAll(parsed.reactants);
  const agents = await depictAll(parsed.agents);
  const products = await depictAll(parsed.products);
  const visible = [...reactants, ...products];
  const conditionText = [...parsed.agents, ...(options.conditions?.trim() ? [options.conditions.trim()] : [])]
    .join(", ");
  const conditionSize = conditionText
    ? nativeTextObjectSizeForText(conditionText, CONDITIONS_STYLE)
    : { width: 0, height: 0 };
  const plusSize = nativeTextObjectSizeForText("+", PLUS_STYLE);
  const boundsByComponent = new Map(visible.map((component) => [
    component,
    moleculeVisualBounds(component.molecule)
  ]));
  const maximumMoleculeHeight = Math.max(
    renderDefaults.bondLength,
    ...visible.map((component) => boundsByComponent.get(component)!.height)
  );
  const aboveCenter = Math.max(
    maximumMoleculeHeight / 2,
    conditionText ? conditionSize.height + REACTION_GUTTER / 2 : 0
  );
  const centerY = renderDefaults.padding + aboveCenter;
  const pageHeight = centerY + maximumMoleculeHeight / 2 + renderDefaults.padding;
  const arrowLength = Math.max(
    renderDefaults.bondLength * 2.5,
    conditionSize.width + REACTION_GUTTER * 2
  );

  let cursor = renderDefaults.padding;
  let moleculeNumber = 0;
  const molecules: MoleculeObject[] = [];
  const plusPoints: Array<{ x: number; y: number }> = [];
  const placeGroup = (components: readonly BuiltSmilesDocument[]): void => {
    components.forEach((component, index) => {
      const bounds = boundsByComponent.get(component)!;
      molecules.push(translateMolecule(
        component.molecule,
        `mol_reaction_${String(moleculeNumber + 1).padStart(3, "0")}`,
        cursor - bounds.minX,
        centerY - bounds.height / 2 - bounds.minY
      ));
      moleculeNumber += 1;
      cursor += bounds.width;
      if (index < components.length - 1) {
        cursor += REACTION_GUTTER;
        plusPoints.push({ x: cursor, y: centerY - plusSize.height / 2 });
        cursor += plusSize.width + REACTION_GUTTER;
      }
    });
  };

  placeGroup(reactants);
  cursor += REACTION_GUTTER;
  const arrowStart = cursor;
  const arrowEnd = arrowStart + arrowLength;
  cursor = arrowEnd + REACTION_GUTTER;
  placeGroup(products);
  const pageWidth = cursor + renderDefaults.padding;

  const empty = createEmptyDocument({ title: "Reaction scheme" });
  const page = empty.pages[0]!;
  let document: ChemDraftDocument = {
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
      objects: molecules
    }],
    selection: { objectIds: [] }
  };
  document = insertNativeReactionArrow(
    document,
    { x: arrowStart, y: centerY },
    { x: arrowEnd, y: centerY },
    arrow
  );
  for (const point of plusPoints) {
    document = insertNativeTextObject(document, point, "+", PLUS_STYLE);
  }
  if (conditionText) {
    document = insertNativeTextObject(
      document,
      {
        x: (arrowStart + arrowEnd - conditionSize.width) / 2,
        y: centerY - conditionSize.height - REACTION_GUTTER / 2
      },
      conditionText,
      CONDITIONS_STYLE
    );
  }

  const exported = exportDocumentToSvg(document, {
    background: background === "white" ? "#ffffff" : "transparent"
  });
  const firstMolecule = molecules[0]!;
  const initialCrop = cropDocumentSvgToContent(
    exported.contents,
    document,
    firstMolecule,
    renderDefaults.padding,
    background
  );
  const cropped = expandCropForTextAndLabels(
    initialCrop.svg,
    document,
    initialCrop.viewBox,
    renderDefaults.padding,
    background
  );

  return {
    ...parsed,
    document,
    svg: cropped.svg,
    viewBox: cropped.viewBox,
    arrow,
    conditions: conditionText,
    warnings: [
      ...reactants,
      ...agents,
      ...products
    ].flatMap((component) => component.warnings)
      .concat(exported.warnings.map((warning) => warning.message))
  };
}

async function renderReactionJob(job: ReactionJob, io: CliIo): Promise<boolean> {
  writeProgress(io, `Rendering reaction ${job.name}\u2026`);
  try {
    const rendered = await renderReactionScheme(job.rxn, {
      arrow: job.arrow,
      conditions: job.conditions,
      background: job.background
    });
    await mkdir(dirname(job.out), { recursive: true });
    const format = outputFormat(job.out);
    await writeFile(
      job.out,
      format === "svg" ? rendered.svg : svgToPng(rendered.svg, job.width)
    );
    writeJsonLine(io, {
      name: job.name,
      ok: true,
      out: job.out,
      reactants: rendered.reactants,
      agents: rendered.agents,
      products: rendered.products,
      arrow: rendered.arrow,
      conditions: rendered.conditions,
      warnings: rendered.warnings
    });
    writeProgress(io, `Wrote ${job.out}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJsonLine(io, {
      name: job.name,
      ok: false,
      rxn: job.rxn,
      out: job.out,
      error: message
    });
    writeProgress(io, `Failed ${job.name}: ${message}`);
    return false;
  }
}

export async function runReactionCommand(
  argv: readonly string[],
  io: CliIo = defaultCliIo
): Promise<CliExitCode> {
  try {
    const parsed = parseArguments(argv);
    if ("help" in parsed) {
      io.stdout(reactionHelp);
      return cliExitCode.ok;
    }
    const jobs = parsed.mode === "single" ? [parsed.job!] : await readReactionJobs(parsed);
    let allSucceeded = true;
    for (const job of jobs) {
      if (!await renderReactionJob(job, io)) allSucceeded = false;
    }
    return resultExitCode(allSucceeded);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Error: ${message}`);
    io.stderr("Run pnpm chemdraft reaction --help for usage.");
    return error instanceof CliUsageError ? cliExitCode.badArguments : cliExitCode.failed;
  }
}

export const reactionCommand = {
  name: "reaction",
  summary: "Render reaction SMILES as a cropped reaction scheme.",
  run: runReactionCommand
} as const;
