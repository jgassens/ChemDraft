import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseOptions, stringOption } from "../args";
import { renderSmilesToAssets } from "../document";
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

const OPSIN_VERSION = "opsin-2.9.0";
const MAX_NAME_LENGTH = 2000;
const OPSIN_TIMEOUT_MS = 30_000;
const OPSIN_KILL_GRACE_MS = 1_000;
const REBUILD_RUNTIME_SCRIPT = "scripts/build-opsin-runtime.sh";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");

export interface OpsinPaths {
  javaPath: string;
  jarPath: string;
  timeoutMs?: number;
  killGraceMs?: number;
}

export interface NameJob {
  name: string;
  query: string;
}

interface ParsedArguments {
  mode: "single" | "batch";
  name?: string;
  batchFile?: string;
  renderPath?: string;
}

export interface NameCommandDependencies {
  opsinPaths?: OpsinPaths;
  renderSmiles?: typeof renderSmilesToAssets;
}

interface OpsinOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export class OpsinEngineError extends Error {}

export const nameHelp = `ChemDraft chemical name converter

Usage:
  pnpm -s chemdraft name --name <IUPAC-or-trivial-name> [--render out.png]
  pnpm -s chemdraft name --batch <jobs.json>

Batch input is a JSON array of {"name":"aspirin","query":"2-acetoxybenzoic acid"}.
Names are trimmed; blank/duplicate names, path separators, and names beginning with a dot are rejected.

Options:
  --name <name>       Chemical name to convert
  --batch <jobs.json> Convert named queries from a JSON batch
  --render <out.png>  Render a single successful result to PNG
  --help              Print this help

Output:
  One JSON line per query is written to stdout. Progress is written to stderr.
  Exit 0 when every query succeeds, 1 when any conversion or render fails, and 2 for bad arguments.`;

const nameOptions = {
  "--name": { kind: "value" },
  "--batch": { kind: "value" },
  "--render": { kind: "value" },
  "--help": { kind: "boolean" }
} as const;

/** Return the vendored runtime and jar paths without depending on the process working directory. */
export function defaultOpsinPaths(): OpsinPaths {
  const resources = join(workspaceRoot, "apps", "desktop", "src-tauri", "resources", "opsin");
  return {
    javaPath: join(resources, "jre", "bin", "java"),
    jarPath: join(resources, "opsin-cli-2.9.0.jar")
  };
}

/** Reject inputs that would change the line-and-tab protocol rather than silently rewriting them. */
export function validateChemicalName(value: string): string {
  if (value.includes("\t") || value.includes("\n") || value.includes("\r")) {
    throw new CliUsageError("Chemical names cannot contain tabs or newlines.");
  }
  if ([...value].some((character) => /\p{Cc}/u.test(character))) {
    throw new CliUsageError("Chemical names cannot contain control characters.");
  }
  const query = value.trim();
  if (!query) throw new CliUsageError("Enter a chemical name.");
  if ([...query].length > MAX_NAME_LENGTH) {
    throw new CliUsageError(`Chemical names cannot be longer than ${MAX_NAME_LENGTH} characters.`);
  }
  return query;
}

function parseArguments(argv: readonly string[]): ParsedArguments | { help: true } {
  if (argv.includes("--help")) return { help: true };
  const parsed = parseOptions(argv, nameOptions);
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(`Unknown argument "${parsed.positionals[0]}".`);
  }
  const name = stringOption(parsed, "--name");
  const batchFile = stringOption(parsed, "--batch");
  const renderPath = stringOption(parsed, "--render");
  if ((name === undefined ? 0 : 1) + (batchFile === undefined ? 0 : 1) !== 1) {
    throw new CliUsageError("Provide exactly one of --name or --batch.");
  }
  if (name !== undefined) {
    if (renderPath !== undefined && !renderPath.toLowerCase().endsWith(".png")) {
      throw new CliUsageError("--render must name a .png file.");
    }
    return { mode: "single", name: validateChemicalName(name), renderPath };
  }
  if (renderPath !== undefined) {
    throw new CliUsageError("--render is only valid with --name; batch jobs have no shared PNG path.");
  }
  return { mode: "batch", batchFile };
}

async function readJobs(path: string): Promise<NameJob[]> {
  return readBatchFile(path, (candidate, index) => {
    if (
      !candidate || typeof candidate !== "object" ||
      typeof (candidate as { name?: unknown }).name !== "string" ||
      typeof (candidate as { query?: unknown }).query !== "string"
    ) {
      throw new CliUsageError(`Batch job ${index + 1} must contain string "name" and "query" fields.`);
    }
    const job = candidate as NameJob;
    return { ...job, query: validateChemicalName(job.query) };
  });
}

async function requireReadable(path: string, label: string, mode: number): Promise<void> {
  try {
    await access(path, mode);
  } catch {
    throw new OpsinEngineError(
      `OPSIN engine is unavailable: missing ${label} at "${path}". Build it with ${REBUILD_RUNTIME_SCRIPT}.`
    );
  }
}

function parseSmiles(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const smiles = line.split("\t", 1)[0]?.trim();
    if (smiles) return smiles;
  }
  return undefined;
}

function parseFailureReason(stderr: string): string | undefined {
  return stderr.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("Run the jar using"));
}

async function runOpsin(
  javaPath: string,
  jarPath: string,
  query: string,
  timeoutMs: number,
  killGraceMs: number
): Promise<OpsinOutput> {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(javaPath, ["-jar", jarPath, "-o", "smi", "-n"], {
      env: {
        ...process.env,
        JAVA_TOOL_OPTIONS: undefined,
        _JAVA_OPTIONS: undefined,
        JDK_JAVA_OPTIONS: undefined
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, killGraceMs);
    }, timeoutMs);

    const clearTimers = (): void => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimers();
      rejectOutput(new OpsinEngineError(
        `Could not start the OPSIN engine at "${javaPath}" with "${jarPath}": ${error.message}. Rebuild it with ${REBUILD_RUNTIME_SCRIPT}.`
      ));
    });
    child.on("close", (exitCode) => {
      closed = true;
      clearTimers();
      if (timedOut) {
        rejectOutput(new OpsinEngineError(
          `OPSIN timed out after ${timeoutMs} ms for "${query}"; the process was terminated.`
        ));
        return;
      }
      resolveOutput({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode
      });
    });
    child.stdin.end(`${query}\n`);
  });
}

/** Convert one validated name through the bundled OPSIN CLI, preserving its stdout-based protocol. */
export async function convertNameWithOpsin(
  rawQuery: string,
  paths: OpsinPaths = defaultOpsinPaths()
): Promise<{ smiles?: string; failureReason?: string }> {
  const query = validateChemicalName(rawQuery);
  await requireReadable(paths.javaPath, "bundled Java executable", constants.X_OK);
  await requireReadable(paths.jarPath, "OPSIN jar", constants.R_OK);
  const output = await runOpsin(
    paths.javaPath,
    paths.jarPath,
    query,
    paths.timeoutMs ?? OPSIN_TIMEOUT_MS,
    paths.killGraceMs ?? OPSIN_KILL_GRACE_MS
  );
  if (output.exitCode !== 0) {
    throw new OpsinEngineError(
      `OPSIN engine at "${paths.javaPath}" failed for "${query}" (exit ${String(output.exitCode)}): ${parseFailureReason(output.stderr) ?? "no diagnostic was produced"}. Rebuild it with ${REBUILD_RUNTIME_SCRIPT}.`
    );
  }
  const smiles = parseSmiles(output.stdout);
  if (smiles) return { smiles };
  return {
    failureReason: parseFailureReason(output.stderr) ?? `"${query}" could not be interpreted as a chemical name.`
  };
}

async function runJob(
  job: NameJob,
  renderPath: string | undefined,
  io: CliIo,
  dependencies: NameCommandDependencies
): Promise<boolean> {
  writeProgress(io, `Converting ${job.name}…`);
  try {
    const converted = await convertNameWithOpsin(job.query, dependencies.opsinPaths);
    if (!converted.smiles) {
      const error = `Could not interpret chemical name "${job.query}": ${converted.failureReason}`;
      writeJsonLine(io, { name: job.name, query: job.query, ok: false, smiles: null, engine: OPSIN_VERSION, error });
      writeProgress(io, `Failed ${job.name}: ${error}`);
      return false;
    }

    if (renderPath !== undefined) {
      const rendered = await (dependencies.renderSmiles ?? renderSmilesToAssets)(
        converted.smiles,
        { name: job.name }
      );
      await mkdir(dirname(renderPath), { recursive: true });
      await writeFile(renderPath, rendered.png);
      writeJsonLine(io, {
        name: job.name,
        query: job.query,
        ok: true,
        smiles: converted.smiles,
        engine: OPSIN_VERSION,
        png: renderPath,
        warnings: rendered.warnings
      });
      writeProgress(io, `Wrote ${renderPath}`);
      return true;
    }

    writeJsonLine(io, {
      name: job.name,
      query: job.query,
      ok: true,
      smiles: converted.smiles,
      engine: OPSIN_VERSION,
      warnings: []
    });
    writeProgress(io, `Converted ${job.name}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const namedMessage = error instanceof OpsinEngineError
      ? message
      : `Unable to render OPSIN result for chemical name "${job.query}": ${message}`;
    writeJsonLine(io, { name: job.name, query: job.query, ok: false, smiles: null, engine: OPSIN_VERSION, error: namedMessage });
    writeProgress(io, `Failed ${job.name}: ${namedMessage}`);
    return false;
  }
}

export async function runNameCommand(
  argv: readonly string[],
  io: CliIo = defaultCliIo,
  dependencies: NameCommandDependencies = {}
): Promise<CliExitCode> {
  try {
    const parsed = parseArguments(argv);
    if ("help" in parsed) {
      io.stdout(nameHelp);
      return cliExitCode.ok;
    }
    // Rendering invokes RDKit through document.ts; install the Node bridge before either engine is used.
    installNodeEngines();
    const jobs = parsed.mode === "single"
      ? [{ name: parsed.name!, query: parsed.name! }]
      : await readJobs(parsed.batchFile!);
    let allSucceeded = true;
    for (const job of jobs) {
      if (!await runJob(
        job,
        parsed.mode === "single" ? parsed.renderPath : undefined,
        io,
        dependencies
      )) {
        allSucceeded = false;
      }
    }
    return resultExitCode(allSucceeded);
  } catch (error) {
    return handleCliError(error, io, "name");
  }
}

export const nameCommand = {
  name: "name",
  summary: "Convert chemical names to SMILES with OPSIN.",
  run: runNameCommand
} as const;
