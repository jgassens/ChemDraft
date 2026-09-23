import { readFile } from "node:fs/promises";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export const defaultCliIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`)
};

export const cliExitCode = {
  ok: 0,
  failed: 1,
  badArguments: 2
} as const;

export type CliExitCode = typeof cliExitCode[keyof typeof cliExitCode];

export class CliUsageError extends Error {}

export interface NamedBatchJob {
  name: string;
}

export type SuccessfulJsonLine = {
  name: string;
  ok: true;
  warnings: readonly string[];
} & Record<string, unknown>;

export type FailedJsonLine = {
  name: string;
  ok: false;
  error: string;
} & Record<string, unknown>;

export type JsonLineResult = SuccessfulJsonLine | FailedJsonLine;

/** Write one machine-readable result record to stdout. */
export function writeJsonLine(io: CliIo, result: JsonLineResult): void {
  io.stdout(JSON.stringify(result));
}

/** Write human-readable progress to stderr, keeping stdout safe for JSON-lines consumers. */
export function writeProgress(io: CliIo, message: string): void {
  io.stderr(message);
}

/** Resolve the shared 0 (all succeeded) / 1 (one or more failed) result policy. */
export function resultExitCode(allSucceeded: boolean): CliExitCode {
  return allSucceeded ? cliExitCode.ok : cliExitCode.failed;
}

/** Validate the portable filename portion shared by every named batch format. */
export function validateBatchName(name: string): void {
  if (!name || name.startsWith(".") || name.includes("/") || name.includes("\\")) {
    throw new CliUsageError(
      `Invalid batch name "${name}": names must be non-empty, must not begin with a dot, and must not contain path separators.`
    );
  }
}

/**
 * Read a JSON array of named jobs, trim and validate names, and reject duplicates. The callback
 * validates subcommand-specific input fields while this function owns the common batch contract.
 */
export async function readBatchFile<T extends NamedBatchJob>(
  path: string,
  parseJob: (candidate: unknown, index: number) => T,
  validateJob: (job: T, index: number) => void = () => undefined
): Promise<T[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(`Could not read batch file "${path}": ${message}`);
  }
  if (!Array.isArray(parsed)) throw new CliUsageError("Batch JSON must be an array of jobs.");

  const names = new Set<string>();
  return parsed.map((candidate, index) => {
    const parsedJob = parseJob(candidate, index);
    const job = { ...parsedJob, name: parsedJob.name.trim() };
    validateBatchName(job.name);
    if (names.has(job.name)) throw new CliUsageError(`Duplicate batch name "${job.name}".`);
    names.add(job.name);
    validateJob(job, index);
    return job;
  });
}
