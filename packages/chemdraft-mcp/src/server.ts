import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

export type CliCommand = (argv: readonly string[], io: CliIo) => Promise<CliExitCode>;
type OutputFileKind = "image" | "text" | "resource";
type OutputFile = { path: string; kind: OutputFileKind };

interface CommandSuccess {
  result: Extract<JsonLineResult, { ok: true }>;
  jsonLine: string;
}

interface CommandFailure {
  error: string;
}

export interface ChemDraftMcpDependencies {
  mkdir?: typeof mkdir;
  mkdtemp?: typeof mkdtemp;
  readFile?: typeof readFile;
  readdir?: typeof readdir;
  rm?: typeof rm;
  stat?: typeof stat;
  writeFile?: typeof writeFile;
  now?: () => number;
  tempDirectory?: () => string;
  commands?: Partial<ChemDraftMcpCommands>;
}

export interface ChemDraftMcpCommands {
  analyze: CliCommand;
  export: CliCommand;
  grid: CliCommand;
  name: CliCommand;
  nmr: CliCommand;
  reaction: CliCommand;
  render: CliCommand;
  stereo: CliCommand;
}

interface ServerRuntime {
  dependencies: Omit<Required<ChemDraftMcpDependencies>, "commands"> & {
    commands: ChemDraftMcpCommands;
  };
  temporaryDirectory?: Promise<string>;
  currentServerRoot?: string;
  lastCleanupAt?: number;
}

const MAX_RETURNED_PAYLOAD_BYTES = 5 * 1024 * 1024;
const CALL_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

const defaultDependencies: Omit<Required<ChemDraftMcpDependencies>, "commands"> & {
  commands: ChemDraftMcpCommands;
} = {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  now: Date.now,
  tempDirectory: tmpdir,
  commands: {
    analyze: runAnalyzeCommand,
    export: runExportCommand,
    grid: runGridCommand,
    name: runNameCommand,
    nmr: runNmrCommand,
    reaction: runReactionCommand,
    render: runRenderCommand,
    stereo: runStereoCommand
  }
};

// RDKit calls are synchronous, and PDF export temporarily installs DOM globals. Keep every MCP
// invocation in one process-wide critical section, including invocations from separate server instances.
let toolExecutionTail: Promise<void> = Promise.resolve();

async function withToolExecutionLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = toolExecutionTail;
  let release!: () => void;
  toolExecutionTail = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 72) || "structure";
}

async function cleanupExpiredCallDirectories(runtime: ServerRuntime, parent: string): Promise<void> {
  const now = runtime.dependencies.now();
  if (
    runtime.lastCleanupAt !== undefined &&
    now - runtime.lastCleanupAt < CLEANUP_INTERVAL_MS
  ) return;

  runtime.lastCleanupAt = now;
  try {
    const serverEntries = await runtime.dependencies.readdir(parent, { withFileTypes: true });
    await Promise.all(serverEntries.map(async (serverEntry) => {
      if (!serverEntry.isDirectory() || !serverEntry.name.startsWith("server-")) return;
      const serverRoot = join(parent, serverEntry.name);
      try {
        const callEntries = await runtime.dependencies.readdir(serverRoot, { withFileTypes: true });
        await Promise.all(callEntries.map(async (callEntry) => {
          if (!callEntry.isDirectory() || !callEntry.name.startsWith("call-")) return;
          const path = join(serverRoot, callEntry.name);
          try {
            const metadata = await runtime.dependencies.stat(path);
            if (now - metadata.mtimeMs > CALL_RETENTION_MS) {
              await runtime.dependencies.rm(path, { recursive: true, force: true });
            }
          } catch {
            // Another server may remove an entry between readdir, stat, and rm.
          }
        }));

        if (callEntries.length === 0 && serverRoot !== runtime.currentServerRoot) {
          try {
            const metadata = await runtime.dependencies.stat(serverRoot);
            if (now - metadata.mtimeMs > CALL_RETENTION_MS) {
              await runtime.dependencies.rm(serverRoot, { recursive: true, force: true });
            }
          } catch {
            // Empty server roots are also shared with concurrently running processes.
          }
        }
      } catch {
        // The server directory may disappear after the parent readdir.
      }
    }));
  } catch {
    // Cleanup is maintenance only; a missing or unreadable shared parent must not fail a tool call.
  }
}

async function defaultOutDir(runtime: ServerRuntime): Promise<string> {
  if (!runtime.temporaryDirectory) {
    const creating = (async () => {
      const parent = join(runtime.dependencies.tempDirectory(), "chemdraft-mcp");
      await runtime.dependencies.mkdir(parent, { recursive: true });
      const root = await runtime.dependencies.mkdtemp(join(parent, "server-"));
      runtime.currentServerRoot = root;
      await cleanupExpiredCallDirectories(runtime, parent);
      return root;
    })();
    runtime.temporaryDirectory = creating;
    creating.catch(() => {
      if (runtime.temporaryDirectory === creating) {
        runtime.temporaryDirectory = undefined;
        runtime.currentServerRoot = undefined;
      }
    });
  }
  return runtime.temporaryDirectory;
}

async function outputDirectory(runtime: ServerRuntime, outDir: string | undefined): Promise<string> {
  const root = outDir ?? await defaultOutDir(runtime);
  await runtime.dependencies.mkdir(root, { recursive: true });
  if (outDir === undefined) {
    await cleanupExpiredCallDirectories(
      runtime,
      join(runtime.dependencies.tempDirectory(), "chemdraft-mcp")
    );
  }
  return runtime.dependencies.mkdtemp(join(root, "call-"));
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

function payloadTooLarge(path: string): ReturnType<typeof errorResult> {
  return errorResult(
    `Output payload "${path}" exceeds the 5 MB MCP limit. Retry with a smaller width or a smaller structure.`
  );
}

async function response(
  runtime: ServerRuntime,
  outcome: CommandSuccess | CommandFailure,
  files: readonly OutputFile[] = [],
  additionalText: string | undefined = undefined
) {
  if ("error" in outcome) return errorResult(outcome.error);
  if (Buffer.byteLength(outcome.jsonLine) > MAX_RETURNED_PAYLOAD_BYTES) {
    return payloadTooLarge("command result");
  }
  if (additionalText !== undefined && Buffer.byteLength(additionalText) > MAX_RETURNED_PAYLOAD_BYTES) {
    return payloadTooLarge("command report");
  }

  const loaded = await Promise.all(files.map(async (file) => ({
    ...file,
    contents: await runtime.dependencies.readFile(file.path)
  })));
  const oversized = loaded.find((file) => file.contents.byteLength > MAX_RETURNED_PAYLOAD_BYTES);
  if (oversized) return payloadTooLarge(oversized.path);

  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/png" }
    | { type: "resource"; resource: { uri: string; blob: string; mimeType: "application/pdf" } }
  > = [{ type: "text", text: outcome.jsonLine }];
  if (additionalText) content.push({ type: "text", text: additionalText });
  for (const file of loaded) {
    if (file.kind === "image") {
      content.push({ type: "image", data: file.contents.toString("base64"), mimeType: "image/png" });
    } else if (file.kind === "text") {
      content.push({ type: "text", text: file.contents.toString("utf8") });
    } else {
      content.push({
        type: "resource",
        resource: {
          uri: pathToFileURL(file.path).href,
          blob: file.contents.toString("base64"),
          mimeType: "application/pdf"
        }
      });
    }
  }
  return { content };
}

function resultPaths(result: Record<string, unknown>): string[] {
  const paths = [
    ...(Array.isArray(result.files) ? result.files : []),
    ...(Array.isArray(result.spectrum) ? result.spectrum : []),
    result.png,
    result.out
  ].filter((value): value is string => typeof value === "string");
  return [...new Set(paths)];
}

function visualFiles(result: Record<string, unknown>): OutputFile[] {
  const files: OutputFile[] = [];
  for (const path of resultPaths(result)) {
    if (path.toLowerCase().endsWith(".png")) files.push({ path, kind: "image" });
    if (path.toLowerCase().endsWith(".svg")) files.push({ path, kind: "text" });
  }
  return files;
}

function exportFiles(result: Record<string, unknown>, format: string): OutputFile[] {
  const path = resultPaths(result).find((candidate) => candidate.toLowerCase().endsWith(`.${format}`));
  if (!path) return [];
  return [{ path, kind: format === "pdf" ? "resource" : "text" }];
}

const chemistryHonesty = "Radicals and isotope labels are refused rather than silently changed.";

/** Create the reusable server instance used by stdio and in-memory MCP clients. */
export function createChemDraftMcpServer(
  dependencyOverrides: ChemDraftMcpDependencies = {}
): McpServer {
  const runtime: ServerRuntime = {
    dependencies: {
      ...defaultDependencies,
      ...dependencyOverrides,
      commands: { ...defaultDependencies.commands, ...dependencyOverrides.commands }
    }
  };
  const server = new McpServer({ name: "chemdraft", version: "0.0.0" });
  const runTool = <T>(work: () => Promise<T>) => withToolExecutionLock(async () => {
    try {
      return await work();
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  server.registerTool("render_structure", {
    description: `Render a SMILES structure as PNG, SVG, or both. ${chemistryHonesty}`,
    inputSchema: {
      smiles: z.string().min(1),
      width: z.number().positive().optional(),
      background: z.enum(["white", "transparent"]).optional(),
      bondLength: z.number().positive().optional(),
      padding: z.number().nonnegative().optional(),
      format: z.enum(["png", "svg", "both"]).optional(),
      outDir: z.string().min(1).optional()
    }
  }, async ({ smiles, width, background, bondLength, padding, format = "png", outDir }) => runTool(async () => {
    const directory = await outputDirectory(runtime, outDir);
    const output = join(directory, `${slug(smiles)}.${format === "svg" ? "svg" : "png"}`);
    const argv = ["--smiles", smiles, "--out", output, "--format", format];
    if (width !== undefined) argv.push("--width", String(width));
    if (background !== undefined) argv.push("--background", background);
    if (bondLength !== undefined) argv.push("--bond-length", String(bondLength));
    if (padding !== undefined) argv.push("--padding", String(padding));
    const outcome = await runCommand(runtime.dependencies.commands.render, argv);
    return response(runtime, outcome, succeeded(outcome) ? visualFiles(outcome.result) : []);
  }));

  server.registerTool("render_grid", {
    description: `Render named SMILES entries as a PNG or SVG grid. ${chemistryHonesty}`,
    inputSchema: {
      items: z.array(z.object({ name: z.string().min(1), smiles: z.string().min(1) })).min(1),
      labels: z.enum(["none", "letters", "names"]).optional(),
      columns: z.number().int().positive().optional(),
      width: z.number().positive().optional(),
      gutter: z.number().nonnegative().optional(),
      padding: z.number().nonnegative().optional(),
      background: z.enum(["white", "transparent"]).optional(),
      format: z.enum(["png", "svg"]).optional(),
      outDir: z.string().min(1).optional()
    }
  }, async ({
    items,
    labels,
    columns,
    width,
    gutter,
    padding,
    background,
    format = "png",
    outDir
  }) => runTool(async () => {
    const directory = await outputDirectory(runtime, outDir);
    const name = slug(items.map((item) => item.smiles).join("-"));
    const batch = join(directory, `${name}-grid-items.json`);
    const output = join(directory, `${name}-grid.${format}`);
    await runtime.dependencies.writeFile(batch, JSON.stringify(items));
    const argv = ["--batch", batch, "--out", output];
    if (labels !== undefined) argv.push("--labels", labels);
    if (columns !== undefined) argv.push("--columns", String(columns));
    if (width !== undefined) argv.push("--width", String(width));
    if (gutter !== undefined) argv.push("--gutter", String(gutter));
    if (padding !== undefined) argv.push("--padding", String(padding));
    if (background !== undefined) argv.push("--background", background);
    const outcome = await runCommand(runtime.dependencies.commands.grid, argv);
    return response(runtime, outcome, succeeded(outcome) ? visualFiles(outcome.result) : []);
  }));

  server.registerTool("render_reaction", {
    description: `Render a reaction as a PNG or SVG scheme. reactionSmiles splits roles on '.', while component arrays preserve each entry—including a salt containing '.'—as one molecule object. Agent labels report the formula or the recorded SMILES fallback. ${chemistryHonesty}`,
    inputSchema: {
      reactionSmiles: z.string().min(1).optional(),
      reactants: z.array(z.string().min(1)).min(1).optional(),
      agents: z.array(z.string().min(1)).optional(),
      products: z.array(z.string().min(1)).min(1).optional(),
      conditions: z.string().optional(),
      arrow: z.enum(["forward", "equilibrium", "resonance", "retrosynthesis"]).optional(),
      width: z.number().positive().optional(),
      background: z.enum(["white", "transparent"]).optional(),
      format: z.enum(["png", "svg"]).optional(),
      outDir: z.string().min(1).optional()
    }
  }, async ({
    reactionSmiles,
    reactants,
    agents,
    products,
    conditions,
    arrow,
    width,
    background,
    format = "png",
    outDir
  }) => runTool(async () => {
    const hasArrays = reactants !== undefined || agents !== undefined || products !== undefined;
    if ((reactionSmiles === undefined) === !hasArrays) {
      return errorResult("Provide exactly one of reactionSmiles or reactants/agents/products arrays.");
    }
    if (hasArrays && (!reactants || !products)) {
      return errorResult("Component-array reactions require at least one reactant and one product.");
    }
    const directory = await outputDirectory(runtime, outDir);
    const reactionSlug = reactionSmiles ?? [...reactants!, ...(agents ?? []), ...products!].join("-");
    const output = join(directory, `${slug(reactionSlug)}-reaction.${format}`);
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
    if (background !== undefined) argv.push("--background", background);
    const outcome = await runCommand(runtime.dependencies.commands.reaction, argv);
    return response(runtime, outcome, succeeded(outcome) ? visualFiles(outcome.result) : []);
  }));

  server.registerTool("analyze_structure", {
    description: "Analyze a SMILES structure. Every summary field carries a value plus an analysis status, so declined and not-requested methods remain distinct. Quote reported pKa intervals rather than presenting predictions as exact.",
    inputSchema: {
      smiles: z.string().min(1),
      methods: z.array(z.string().min(1)).min(1).optional(),
      format: z.enum(["json", "md"]).optional()
    }
  }, async ({ smiles, methods, format = "json" }) => runTool(async () => {
    await outputDirectory(runtime, undefined);
    const argv = ["--smiles", smiles, "--format", format];
    if (methods) argv.push("--methods", methods.join(","));
    const outcome = await runCommand(runtime.dependencies.commands.analyze, argv);
    const report = succeeded(outcome) && format === "md" && typeof outcome.result.report === "string"
      ? outcome.result.report
      : undefined;
    return response(runtime, outcome, [], report);
  }));

  server.registerTool("name_to_structure", {
    description: `Convert a chemical name with OPSIN, optionally rendering its structure. ${chemistryHonesty}`,
    inputSchema: {
      name: z.string().min(1),
      render: z.boolean().optional(),
      allowAmbiguous: z.boolean().optional()
    }
  }, async ({ name, render = false, allowAmbiguous = false }) => runTool(async () => {
    const directory = await outputDirectory(runtime, undefined);
    const output = join(directory, `${slug(name)}.png`);
    const argv = ["--name", name];
    if (render) argv.push("--render", output);
    if (allowAmbiguous) argv.push("--allow-ambiguous");
    const outcome = await runCommand(runtime.dependencies.commands.name, argv);
    return response(runtime, outcome, succeeded(outcome) ? visualFiles(outcome.result) : []);
  }));

  server.registerTool("check_stereo", {
    description: `Inspect specified and unspecified tetrahedral stereocentres and E/Z double bonds. Atom and bond indices are 0-based. ${chemistryHonesty}`,
    inputSchema: { smiles: z.string().min(1) }
  }, async ({ smiles }) => runTool(async () => {
    await outputDirectory(runtime, undefined);
    return response(runtime, await runCommand(runtime.dependencies.commands.stereo, ["--smiles", smiles]));
  }));

  server.registerTool("predict_nmr", {
    description: "Predict 1H/13C NMR shifts. J values and multiplicities are estimates, not measured values; unmatched environments remain warnings rather than invented values.",
    inputSchema: {
      smiles: z.string().min(1),
      nuclei: z.array(z.enum(["1H", "13C"])).min(1).optional(),
      spectrum: z.boolean().optional(),
      statistic: z.enum(["median", "mean"]).optional(),
      ignoreLabileHydrogens: z.boolean().optional()
    }
  }, async ({
    smiles,
    nuclei,
    spectrum = false,
    statistic,
    ignoreLabileHydrogens = false
  }) => runTool(async () => {
    const directory = await outputDirectory(runtime, undefined);
    const output = join(directory, `${slug(smiles)}-nmr.png`);
    const argv = ["--smiles", smiles];
    if (nuclei) argv.push("--nuclei", nuclei.join(","));
    if (spectrum) argv.push("--spectrum", output);
    if (statistic !== undefined) argv.push("--statistic", statistic);
    if (ignoreLabileHydrogens) argv.push("--ignore-labile");
    const outcome = await runCommand(runtime.dependencies.commands.nmr, argv);
    return response(runtime, outcome, succeeded(outcome) ? visualFiles(outcome.result) : []);
  }));

  server.registerTool("export_structure", {
    description: `Export a SMILES structure without changing its chemistry. ${chemistryHonesty}`,
    inputSchema: {
      smiles: z.string().min(1),
      format: z.enum(["cdxml", "pdf", "sdf", "mol", "smi"]),
      outDir: z.string().min(1).optional()
    }
  }, async ({ smiles, format, outDir }) => runTool(async () => {
    const directory = await outputDirectory(runtime, outDir);
    const output = join(directory, `${slug(smiles)}.${format}`);
    const outcome = await runCommand(
      runtime.dependencies.commands.export,
      ["--smiles", smiles, "--format", format, "--out", output]
    );
    return response(runtime, outcome, succeeded(outcome) ? exportFiles(outcome.result, format) : []);
  }));

  return server;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const server = createChemDraftMcpServer();
  await server.connect(new StdioServerTransport());
}
