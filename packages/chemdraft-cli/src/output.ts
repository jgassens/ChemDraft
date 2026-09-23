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

export interface NamedSmilesJob extends NamedBatchJob {
  smiles: string;
}

const MAX_BATCH_JOBS = 500;
const batchNamePattern = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,99}$/;

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

/** Parse the common named-SMILES batch job shape used by structure commands. */
export function parseNamedSmilesJob(candidate: unknown, index: number): NamedSmilesJob {
  if (
    !candidate || typeof candidate !== "object" ||
    typeof (candidate as { name?: unknown }).name !== "string" ||
    typeof (candidate as { smiles?: unknown }).smiles !== "string"
  ) {
    throw new CliUsageError(`Batch job ${index + 1} must contain string "name" and "smiles" fields.`);
  }
  return candidate as NamedSmilesJob;
}

/** Emit the shared outer command error and choose usage-error versus runtime-failure exit status. */
export function handleCliError(error: unknown, io: CliIo, usageCommand: string): CliExitCode {
  const message = error instanceof Error ? error.message : String(error);
  io.stderr(`Error: ${message}`);
  io.stderr(`Run pnpm -s chemdraft ${usageCommand} --help for usage.`);
  return error instanceof CliUsageError ? cliExitCode.badArguments : cliExitCode.failed;
}

/** Validate the portable filename portion shared by every named batch format. */
export function validateBatchName(name: string): void {
  if (!batchNamePattern.test(name)) {
    throw new CliUsageError(
      `Invalid batch name ${JSON.stringify(name)}: names must match ${batchNamePattern}.`
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
  if (parsed.length > MAX_BATCH_JOBS) {
    const firstExcess = parsed[MAX_BATCH_JOBS];
    const name = firstExcess && typeof firstExcess === "object" &&
      typeof (firstExcess as { name?: unknown }).name === "string"
      ? ` named ${JSON.stringify((firstExcess as NamedBatchJob).name)}`
      : "";
    throw new CliUsageError(
      `Batch job ${MAX_BATCH_JOBS + 1}${name} exceeds the maximum of ${MAX_BATCH_JOBS} jobs.`
    );
  }

  const names = new Map<string, string>();
  return parsed.map((candidate, index) => {
    const parsedJob = parseJob(candidate, index);
    const job = { ...parsedJob, name: parsedJob.name.trim() };
    validateBatchName(job.name);
    const normalizedName = job.name.toLowerCase();
    const duplicate = names.get(normalizedName);
    if (duplicate !== undefined) {
      throw new CliUsageError(
        `Duplicate batch name ${JSON.stringify(job.name)}: conflicts with ${JSON.stringify(duplicate)} on case-insensitive filesystems.`
      );
    }
    names.set(normalizedName, job.name);
    validateJob(job, index);
    return job;
  });
}
