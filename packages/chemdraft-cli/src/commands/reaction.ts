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
import { analyzeStructureDetailed } from "@chemdraft/rdkit-adapter";

import { numericOption, parseOptions, repeatedOption, stringOption } from "../args";
import {
  buildSmilesDocument,
  cropDocumentSvgToContent,
  documentVisualBounds,
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
  handleCliError,
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

export type ReactionArrowKind = ArrowObject["arrowKind"];
type ReactionOutputFormat = "png" | "svg";

export interface ParsedReactionSmiles {
  reactants: string[];
  agents: string[];
  products: string[];
}

interface ReactionJob {
  name: string;
  input: ParsedReactionSmiles;
  rxn?: string;
  out: string;
  conditions: string;
  arrow: ReactionArrowKind;
  width: number;
  background: RenderBackground;
}

interface BatchReactionJob {
  name: string;
  rxn?: string;
  reactants?: string[];
  agents?: string[];
  products?: string[];
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
  agentTexts: ReactionAgentText[];
  warnings: string[];
}

export interface ReactionAgentText {
  smiles: string;
  text: string;
  source: "formula" | "smiles";
  hillFormula?: string;
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
const DEFAULT_REACTION_WIDTH = 1000;

export const reactionHelp = `ChemDraft headless reaction-scheme renderer

Usage:
  pnpm -s chemdraft reaction --rxn <reactants>\u003e<agents>\u003e<products> --out <file.png|file.svg>
  pnpm -s chemdraft reaction --reactant <SMILES> [--agent <SMILES>] --product <SMILES> --out <file>
  pnpm -s chemdraft reaction --batch <jobs.json> [--out-dir <dir>] [--format png|svg]

Reaction SMILES must contain exactly two \u003e separators. Each side is split on '.', so a
'.'-joined salt is drawn as two species. Repeated --reactant/--agent/--product flags preserve each
value as one molecule object, including any '.'-joined salt. Agents are validated and shown above
the arrow as composition formulas (falling back to SMILES only when composition fails);
--conditions appends additional text there. Species, plus signs, and the arrow use 24 px gutters.

Batch input is a JSON array of named jobs containing either "rxn" or the arrays "reactants",
"agents", and "products". Array entries preserve '.' as one molecule object. Each job may supply
"out"; otherwise --out-dir is required and files are named from the job name (PNG by default).

Options:
  --conditions <text>             Additional conditions shown above the arrow
  --arrow <kind>                  forward|equilibrium|resonance|retrosynthesis (default: forward)
  --width <px>                    PNG width (default: ${DEFAULT_REACTION_WIDTH})
  --background <kind>             white|transparent (default: white)
  --out-dir <dir>                 Batch output directory
  --format <kind>                 Batch output format when jobs omit "out" (default: png)
  --help                          Print this help

Output:
  One JSON line per reaction is written to stdout. Progress is written to stderr.
  Exit 0 when every reaction succeeds, 1 when any render fails, and 2 for bad arguments.`;

const reactionOptions = {
  "--rxn": { kind: "value" },
  "--reactant": { kind: "value", repeated: true },
  "--agent": { kind: "value", repeated: true },
  "--product": { kind: "value", repeated: true },
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
  if (typeof value === "number") return numericOption(String(value), label);
  return numericOption(typeof value === "string" ? value : undefined, label);
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

function repeatedReactionComponents(
  reactants: readonly string[],
  agents: readonly string[],
  products: readonly string[],
  label = "Repeated reaction flags"
): ParsedReactionSmiles {
  if (reactants.length === 0 || products.length === 0) {
    throw new CliUsageError(`${label} require at least one reactant and one product.`);
  }
  const trim = (values: readonly string[], role: string): string[] => values.map((value) => {
    const component = value.trim();
    if (!component) throw new CliUsageError(`${label} contain an empty ${role}.`);
    return component;
  });
  return {
    reactants: trim(reactants, "reactant"),
    agents: trim(agents, "agent"),
    products: trim(products, "product")
  };
}

function parseArguments(argv: readonly string[]): ParsedArguments | { help: true } {
  if (argv.includes("--help")) return { help: true };
  const parsed = parseOptions(argv, reactionOptions);
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(`Unknown argument "${parsed.positionals[0]}".`);
  }

  const rxn = stringOption(parsed, "--rxn");
  const reactants = repeatedOption(parsed, "--reactant");
  const agents = repeatedOption(parsed, "--agent");
  const products = repeatedOption(parsed, "--product");
  const hasComponentFlags = reactants.length + agents.length + products.length > 0;
  const out = stringOption(parsed, "--out");
  const jobsFile = stringOption(parsed, "--batch");
  const outDir = stringOption(parsed, "--out-dir");
  const requestedFormat = stringOption(parsed, "--format");
  const conditions = stringOption(parsed, "--conditions")?.trim() ?? "";
  const requestedArrow = stringOption(parsed, "--arrow");
  const arrow = requestedArrow === undefined ? "forward" : reactionArrow(requestedArrow);
  const requestedWidth = stringOption(parsed, "--width");
  const width = requestedWidth === undefined ? DEFAULT_REACTION_WIDTH : positiveWidth(requestedWidth);
  const requestedBackground = stringOption(parsed, "--background");
  const background = requestedBackground === undefined
    ? renderDefaults.background
    : reactionBackground(requestedBackground);

  if (jobsFile !== undefined) {
    if (rxn !== undefined || hasComponentFlags || out !== undefined) {
      throw new CliUsageError(
        "--rxn, repeated reaction component flags, and --out are only valid in single-reaction mode."
      );
    }
    const format = requestedFormat === undefined ? undefined : reactionFormat(requestedFormat);
    return { mode: "batch", jobsFile, outDir, format, conditions, arrow, width, background };
  }

  if (!out) throw new CliUsageError("Single-reaction mode requires --out.");
  if ((rxn === undefined) === !hasComponentFlags) {
    throw new CliUsageError(
      "Provide exactly one reaction input: --rxn or repeated --reactant/--agent/--product flags."
    );
  }
  if (outDir !== undefined || requestedFormat !== undefined) {
    throw new CliUsageError("--out-dir and --format are only valid with --batch.");
  }
  const input = rxn !== undefined
    ? parseReactionSmiles(rxn)
    : repeatedReactionComponents(reactants, agents, products);
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
      input,
      ...(rxn !== undefined ? { rxn } : {}),
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
    typeof (candidate as { name?: unknown }).name !== "string"
  ) {
    throw new CliUsageError(`Batch job ${index + 1} must contain a string "name" field.`);
  }
  const raw = candidate as Record<string, unknown>;
  if (raw.rxn !== undefined && typeof raw.rxn !== "string") {
    throw new CliUsageError(`Batch job ${index + 1} "rxn" must be a string.`);
  }
  for (const field of ["reactants", "agents", "products"] as const) {
    if (raw[field] !== undefined && (
      !Array.isArray(raw[field]) || !(raw[field] as unknown[]).every((entry) => typeof entry === "string")
    )) {
      throw new CliUsageError(`Batch job ${index + 1} "${field}" must be an array of strings.`);
    }
  }
  if (raw.out !== undefined && typeof raw.out !== "string") {
    throw new CliUsageError(`Batch job ${index + 1} "out" must be a string.`);
  }
  if (raw.conditions !== undefined && typeof raw.conditions !== "string") {
    throw new CliUsageError(`Batch job ${index + 1} "conditions" must be a string.`);
  }
  return {
    name: raw.name as string,
    rxn: raw.rxn as string | undefined,
    reactants: raw.reactants as string[] | undefined,
    agents: raw.agents as string[] | undefined,
    products: raw.products as string[] | undefined,
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
    const hasArrays = job.reactants !== undefined || job.agents !== undefined || job.products !== undefined;
    if ((job.rxn === undefined) === !hasArrays) {
      throw new CliUsageError(
        `Batch job "${job.name}" must contain exactly one of "rxn" or reaction component arrays.`
      );
    }
    if (job.rxn !== undefined) parseReactionSmiles(job.rxn);
    else repeatedReactionComponents(job.reactants ?? [], job.agents ?? [], job.products ?? [], `Batch job "${job.name}"`);
    if (job.out !== undefined) outputFormat(job.out);
    if (job.out === undefined && args.outDir === undefined) {
      throw new CliUsageError(`Batch job "${job.name}" needs "out" when --out-dir is not provided.`);
    }
  });
  return jobs.map((job) => {
    const format = job.format ?? args.format ?? "png";
    const input = job.rxn !== undefined
      ? parseReactionSmiles(job.rxn)
      : repeatedReactionComponents(
          job.reactants ?? [],
          job.agents ?? [],
          job.products ?? [],
          `Batch job "${job.name}"`
        );
    return {
      name: job.name,
      input,
      ...(job.rxn !== undefined ? { rxn: job.rxn } : {}),
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

function formulaCount(symbol: string, count: number): string {
  return count === 1 ? symbol : `${symbol}${count}`;
}

function reactionFormula(result: Extract<Awaited<ReturnType<typeof analyzeStructureDetailed>>["run"]["results"][number], { kind: "composition" }>): string | undefined {
  if (!result.formula || result.status !== "ok") return undefined;
  if (result.elements.some((entry) => entry.isotope !== undefined)) return result.formula;
  const counts = new Map(result.elements.map((entry) => [entry.symbol, entry.count]));
  // Readers expect inorganic oxyacids in H-central-atom-O order (H2SO4), while the analysis
  // contract correctly retains strict no-carbon Hill order (H2O4S). This is display-only and the
  // exact Hill formula is retained in the JSON record below.
  if (!counts.has("C") && counts.has("H") && counts.has("O") && counts.size > 2) {
    const middle = [...counts.entries()]
      .filter(([symbol]) => symbol !== "H" && symbol !== "O")
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return [
      formulaCount("H", counts.get("H")!),
      ...middle.map(([symbol, count]) => formulaCount(symbol, count)),
      formulaCount("O", counts.get("O")!)
    ].join("");
  }
  return result.formula;
}

async function agentText(smiles: string, index: number): Promise<{
  agent: ReactionAgentText;
  warning?: string;
}> {
  try {
    const detailed = await analyzeStructureDetailed({
      format: "smiles",
      value: smiles,
      runId: `chemdraft-cli-reaction-agent-${index + 1}`,
      startedAt: new Date().toISOString(),
      methodIds: ["rdkit.composition"]
    });
    const composition = detailed.run.results.find((result) =>
      result.methodId === "rdkit.composition" &&
      result.interpretationId === "source" &&
      result.kind === "composition"
    );
    if (composition?.kind === "composition") {
      const text = reactionFormula(composition);
      if (text) {
        return {
          agent: {
            smiles,
            text,
            source: "formula",
            ...(composition.formula ? { hillFormula: composition.formula } : {})
          }
        };
      }
      const reason = composition.applicability.reasons[0] ?? composition.warnings[0]?.message;
      return {
        agent: { smiles, text: smiles, source: "smiles" },
        warning: `Could not compute an agent formula for "${smiles}"; shown as SMILES${reason ? `: ${reason}` : "."}`
      };
    }
  } catch (error) {
    return {
      agent: { smiles, text: smiles, source: "smiles" },
      warning: `Could not compute an agent formula for "${smiles}"; shown as SMILES: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  return {
    agent: { smiles, text: smiles, source: "smiles" },
    warning: `Could not compute an agent formula for "${smiles}"; shown as SMILES.`
  };
}

/** Build and crop one reaction scheme. Agents are depicted for validation, then shown as formulas. */
export async function renderReactionScheme(
  input: string | ParsedReactionSmiles,
  options: {
    arrow?: ReactionArrowKind;
    conditions?: string;
    background?: RenderBackground;
  } = {}
): Promise<RenderedReactionScheme> {
  const parsed = typeof input === "string" ? parseReactionSmiles(input) : input;
  const arrow = options.arrow ?? "forward";
  if (!ARROW_KINDS.has(arrow)) reactionArrow(arrow);
  const background = options.background ?? renderDefaults.background;
  reactionBackground(background);
  installNodeEngines();

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
  const agentResults = await Promise.all(parsed.agents.map(agentText));
  const agentTexts = agentResults.map((result) => result.agent);
  const visible = [...reactants, ...products];
  const conditionText = [...agentTexts.map((agent) => agent.text), ...(options.conditions?.trim() ? [options.conditions.trim()] : [])]
    .join(", ");
  const conditionSize = conditionText
    ? nativeTextObjectSizeForText(conditionText, CONDITIONS_STYLE)
    : { width: 0, height: 0 };
  const plusSize = nativeTextObjectSizeForText("+", PLUS_STYLE);
  const boundsByComponent = new Map(visible.map((component) => {
    const bounds = documentVisualBounds(component.document);
    return [component, {
      ...bounds,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY
    }] as const;
  }));
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
  const cropped = cropDocumentSvgToContent(
    exported.contents,
    document,
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
    agentTexts,
    warnings: [
      ...reactants,
      ...agents,
      ...products
    ].flatMap((component) => component.warnings)
      .concat(agentResults.flatMap((result) => result.warning ? [result.warning] : []))
      .concat(exported.warnings.map((warning) => warning.message))
  };
}

async function renderReactionJob(job: ReactionJob, io: CliIo): Promise<boolean> {
  writeProgress(io, `Rendering reaction ${job.name}\u2026`);
  try {
    const rendered = await renderReactionScheme(job.input, {
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
      agentTexts: rendered.agentTexts,
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
      ...(job.rxn !== undefined ? { rxn: job.rxn } : {
        reactants: job.input.reactants,
        agents: job.input.agents,
        products: job.input.products
      }),
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
    return handleCliError(error, io, "reaction");
  }
}

export const reactionCommand = {
  name: "reaction",
  summary: "Render reaction SMILES as a cropped reaction scheme.",
  run: runReactionCommand
} as const;
