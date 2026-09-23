import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { runAnalyzeCommand } from "../../chemdraft-cli/src/commands/analyze";
import { runExportCommand } from "../../chemdraft-cli/src/commands/export";
import { runGridCommand } from "../../chemdraft-cli/src/commands/grid";
import { runNameCommand } from "../../chemdraft-cli/src/commands/name";
import { runNmrCommand } from "../../chemdraft-cli/src/commands/nmr";
import { runReactionCommand } from "../../chemdraft-cli/src/commands/reaction";
import { runRenderCommand } from "../../chemdraft-cli/src/commands/render";
import { runStereoCommand } from "../../chemdraft-cli/src/commands/stereo";
import type { CliExitCode, CliIo, JsonLineResult } from "../../chemdraft-cli/src/output";

type CliCommand = (argv: readonly string[], io: CliIo) => Promise<CliExitCode>;
type ImageFile = { path: string; mimeType: "image/png" | "image/svg+xml" };

interface CommandSuccess {
  result: Extract<JsonLineResult, { ok: true }>;
  jsonLine: string;
}

interface CommandFailure {
  error: string;
}

let temporaryDirectory: Promise<string> | undefined;

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 72) || "structure";
}

async function defaultOutDir(): Promise<string> {
  temporaryDirectory ??= (async () => {
    const parent = join(tmpdir(), "chemdraft-mcp");
    await mkdir(parent, { recursive: true });
    return mkdtemp(join(parent, "server-"));
  })();
  return temporaryDirectory;
}

async function outputDirectory(outDir: string | undefined): Promise<string> {
  const directory = outDir ?? await defaultOutDir();
  await mkdir(directory, { recursive: true });
  return directory;
}

function commandFailure(stderr: readonly string[], exitCode: CliExitCode): CommandFailure {
  const message = stderr.find((line) => line.startsWith("Error: "))?.slice("Error: ".length) ??
    stderr.at(-1) ??
    `ChemDraft CLI command exited with code ${exitCode}.`;
  return { error: message };
}

/** Call CLI command modules directly so RDKit stays warm for this MCP server's lifetime. */
async function runCommand(command: CliCommand, argv: readonly string[]): Promise<CommandSuccess | CommandFailure> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    const exitCode = await command(argv, {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    });
    const jsonLine = [...stdout].reverse().find((line) => {
      try {
        const candidate: unknown = JSON.parse(line);
        return candidate !== null && typeof candidate === "object" && "ok" in candidate;
      } catch {
        return false;
      }
    });
    if (!jsonLine) return commandFailure(stderr, exitCode);
    const result = JSON.parse(jsonLine) as JsonLineResult;
    if (!result.ok) return { error: result.error };
    return { result, jsonLine };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function errorResult(error: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: error }] };
}

function succeeded(outcome: CommandSuccess | CommandFailure): outcome is CommandSuccess {
  return "result" in outcome;
}

async function imageContent(files: readonly ImageFile[]) {
  return Promise.all(files.map(async ({ path, mimeType }) => ({
    type: "image" as const,
    data: (await readFile(path)).toString("base64"),
    mimeType
  })));
}

async function response(
  command: Promise<CommandSuccess | CommandFailure>,
  images: readonly ImageFile[] = [],
  additionalText: string | undefined = undefined
) {
  const outcome = await command;
  if ("error" in outcome) return errorResult(outcome.error);
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/png" | "image/svg+xml" }
  > = [{ type: "text", text: outcome.jsonLine }];
  if (additionalText) content.push({ type: "text" as const, text: additionalText });
  content.push(...await imageContent(images));
  return { content };
}

function pngFiles(result: Record<string, unknown>): ImageFile[] {
  const paths = [
    ...(Array.isArray(result.files) ? result.files : []),
    ...(Array.isArray(result.spectrum) ? result.spectrum : []),
    result.png,
    result.out
  ].filter((value): value is string => typeof value === "string" && value.endsWith(".png"));
  return [...new Set(paths)].map((path) => ({ path, mimeType: "image/png" }));
}

const chemistryHonesty = "Radicals and isotope labels are refused rather than silently changed.";

/** Create the reusable server instance used by stdio and in-memory MCP clients. */
export function createChemDraftMcpServer(): McpServer {
  const server = new McpServer({ name: "chemdraft", version: "0.0.0" });

  server.registerTool("render_structure", {
    description: `Render a SMILES structure as PNG, SVG, or both. ${chemistryHonesty}`,
    inputSchema: {
      smiles: z.string().min(1),
      width: z.number().positive().optional(),
      background: z.enum(["white", "transparent"]).optional(),
      format: z.enum(["png", "svg", "both"]).optional(),
      outDir: z.string().min(1).optional()
    }
  }, async ({ smiles, width, background, format = "png", outDir }) => {
    const directory = await outputDirectory(outDir);
    const output = join(directory, `${slug(smiles)}.${format === "svg" ? "svg" : "png"}`);
    const argv = ["--smiles", smiles, "--out", output, "--format", format];
    if (width !== undefined) argv.push("--width", String(width));
    if (background !== undefined) argv.push("--background", background);
    const outcome = await runCommand(runRenderCommand, argv);
    return response(Promise.resolve(outcome), succeeded(outcome) ? pngFiles(outcome.result) : []);
  });

  server.registerTool("render_grid", {
    description: `Render named SMILES entries as a PNG grid. ${chemistryHonesty}`,
    inputSchema: {
      items: z.array(z.object({ name: z.string().min(1), smiles: z.string().min(1) })).min(1),
      labels: z.enum(["none", "letters", "names"]).optional(),
      columns: z.number().int().positive().optional(),
      width: z.number().positive().optional(),
      outDir: z.string().min(1).optional()
    }
  }, async ({ items, labels, columns, width, outDir }) => {
    const directory = await outputDirectory(outDir);
    const name = slug(items.map((item) => item.smiles).join("-"));
    const batch = join(directory, `${name}-grid-items.json`);
    const output = join(directory, `${name}-grid.png`);
    await writeFile(batch, JSON.stringify(items));
    const argv = ["--batch", batch, "--out", output];
    if (labels !== undefined) argv.push("--labels", labels);
    if (columns !== undefined) argv.push("--columns", String(columns));
    if (width !== undefined) argv.push("--width", String(width));
    const outcome = await runCommand(runGridCommand, argv);
    return response(Promise.resolve(outcome), succeeded(outcome) ? pngFiles(outcome.result) : []);
  });

  server.registerTool("render_reaction", {
    description: `Render a reaction as a PNG scheme. reactionSmiles splits roles on '.', while component arrays preserve each entry—including a salt containing '.'—as one molecule object. Agent labels report the formula or the recorded SMILES fallback. ${chemistryHonesty}`,
    inputSchema: {
      reactionSmiles: z.string().min(1).optional(),
      reactants: z.array(z.string().min(1)).min(1).optional(),
      agents: z.array(z.string().min(1)).optional(),
      products: z.array(z.string().min(1)).min(1).optional(),
      conditions: z.string().optional(),
      arrow: z.enum(["forward", "equilibrium", "resonance", "retrosynthesis"]).optional(),
      width: z.number().positive().optional(),
      outDir: z.string().min(1).optional()
    }
  }, async ({ reactionSmiles, reactants, agents, products, conditions, arrow, width, outDir }) => {
    const hasArrays = reactants !== undefined || agents !== undefined || products !== undefined;
    if ((reactionSmiles === undefined) === !hasArrays) {
      return errorResult("Provide exactly one of reactionSmiles or reactants/agents/products arrays.");
    }
    if (hasArrays && (!reactants || !products)) {
      return errorResult("Component-array reactions require at least one reactant and one product.");
    }
    const directory = await outputDirectory(outDir);
    const reactionSlug = reactionSmiles ?? [...reactants!, ...(agents ?? []), ...products!].join("-");
    const output = join(directory, `${slug(reactionSlug)}-reaction.png`);
    const argv = reactionSmiles !== undefined
      ? ["--rxn", reactionSmiles, "--out", output]
      : [
          ...reactants!.flatMap((smiles) => ["--reactant", smiles]),
          ...(agents ?? []).flatMap((smiles) => ["--agent", smiles]),
          ...products!.flatMap((smiles) => ["--product", smiles]),
          "--out", output
        ];
    if (conditions !== undefined) argv.push("--conditions", conditions);
    if (arrow !== undefined) argv.push("--arrow", arrow);
    if (width !== undefined) argv.push("--width", String(width));
    const outcome = await runCommand(runReactionCommand, argv);
    return response(Promise.resolve(outcome), succeeded(outcome) ? pngFiles(outcome.result) : []);
  });

  server.registerTool("analyze_structure", {
    description: "Analyze a SMILES structure. Every summary field carries a value plus an analysis status, so declined and not-requested methods remain distinct. Quote reported pKa intervals rather than presenting predictions as exact.",
    inputSchema: {
      smiles: z.string().min(1),
      methods: z.array(z.string().min(1)).min(1).optional(),
      format: z.enum(["json", "md"]).optional()
    }
  }, async ({ smiles, methods, format = "json" }) => {
    const argv = ["--smiles", smiles, "--format", format];
    if (methods) argv.push("--methods", methods.join(","));
    const outcome = await runCommand(runAnalyzeCommand, argv);
    const report = succeeded(outcome) && format === "md" && typeof outcome.result.report === "string"
      ? outcome.result.report
      : undefined;
    return response(Promise.resolve(outcome), [], report);
  });

  server.registerTool("name_to_structure", {
    description: `Convert a chemical name with OPSIN, optionally rendering its structure. ${chemistryHonesty}`,
    inputSchema: {
      name: z.string().min(1),
      render: z.boolean().optional()
    }
  }, async ({ name, render = false }) => {
    const directory = await outputDirectory(undefined);
    const output = join(directory, `${slug(name)}.png`);
    const argv = ["--name", name];
    if (render) argv.push("--render", output);
    const outcome = await runCommand(runNameCommand, argv);
    return response(Promise.resolve(outcome), succeeded(outcome) ? pngFiles(outcome.result) : []);
  });

  server.registerTool("check_stereo", {
    description: `Inspect specified and unspecified tetrahedral stereocentres and E/Z double bonds. Atom and bond indices are 0-based. ${chemistryHonesty}`,
    inputSchema: { smiles: z.string().min(1) }
  }, async ({ smiles }) => response(runCommand(runStereoCommand, ["--smiles", smiles])));

  server.registerTool("predict_nmr", {
    description: "Predict 1H/13C NMR shifts. J values and multiplicities are estimates, not measured values; unmatched environments remain warnings rather than invented values.",
    inputSchema: {
      smiles: z.string().min(1),
      nuclei: z.array(z.enum(["1H", "13C"])).min(1).optional(),
      spectrum: z.boolean().optional()
    }
  }, async ({ smiles, nuclei, spectrum = false }) => {
    const directory = await outputDirectory(undefined);
    const output = join(directory, `${slug(smiles)}-nmr.png`);
    const argv = ["--smiles", smiles];
    if (nuclei) argv.push("--nuclei", nuclei.join(","));
    if (spectrum) argv.push("--spectrum", output);
    const outcome = await runCommand(runNmrCommand, argv);
    return response(Promise.resolve(outcome), succeeded(outcome) ? pngFiles(outcome.result) : []);
  });

  server.registerTool("export_structure", {
    description: `Export a SMILES structure without changing its chemistry. ${chemistryHonesty}`,
    inputSchema: {
      smiles: z.string().min(1),
      format: z.enum(["cdxml", "pdf", "sdf", "mol", "smi"]),
      outDir: z.string().min(1).optional()
    }
  }, async ({ smiles, format, outDir }) => {
    const directory = await outputDirectory(outDir);
    const output = join(directory, `${slug(smiles)}.${format}`);
    return response(runCommand(runExportCommand, ["--smiles", smiles, "--format", format, "--out", output]));
  });

  return server;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const server = createChemDraftMcpServer();
  await server.connect(new StdioServerTransport());
}
