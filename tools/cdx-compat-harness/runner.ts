import { fork, execFile, type ForkOptions } from "node:child_process";
import { mkdir, mkdtemp, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { lines, results, withCopy, repairTail, safeError } from "./io";
import { errorStages, type Format, type Result, type StageError, type WorkerProgress } from "./model";
import { completionLine, HarnessFailure, stageError } from "./errors";
import { appendOutput as appendFile, writeOutput as writeFile, prepareOutput, validateDestination } from "./safety";
import { trackChild, trackDirectory } from "./lifecycle";
export { validateDestination } from "./safety";

export interface RunOptions {
  list: string; out: string; groupMap?: string; formats: Format[];
  timeoutMs: number; maxOldSpaceMb: number; concurrency: number; batchSize: number;
  importTimeoutMs?: number;
  afterBatch?: string; resume?: boolean;
}
export interface ChildOutcome { result?: Omit<Result, "id" | "group" | "era">; status?: "crash" | "timeout" | "oom"; error?: StageError; exitCode?: number | null; signal?: string | null; }
function supervisionError(status: "crash" | "timeout" | "oom", protocol = false, progress?: WorkerProgress, timeoutKind?: Result["timeoutKind"]): StageError {
  const error = status === "timeout" ? timeoutKind === "import-hang"
    ? new HarnessFailure("ImportHangError", "import.hang", "IMPORT HANG: shared importer exceeded its deadline (product finding).")
    : timeoutKind === "harness-slow" ? new HarnessFailure("HarnessSlowError", "harness.slow", "Harness summary/round-trip budget exceeded (harness-slow; not a product finding).")
      : new HarnessFailure("WorkerTimeoutError", "worker.timeout", "Worker exceeded the per-file deadline before reporting progress.")
    : status === "oom" ? new HarnessFailure("WorkerMemoryError", "worker.oom", "Worker exhausted its available memory.")
    : protocol ? new HarnessFailure("WorkerProtocolError", "worker.protocol", "Worker did not return a valid file result.")
    : new HarnessFailure("WorkerExitError", "worker.crash", "Worker exited abnormally; see exitCode and signal.");
  return stageError(progress?.stage ?? "detect", error);
}
export function child(copy: string, options: Pick<RunOptions, "timeoutMs" | "importTimeoutMs" | "maxOldSpaceMb" | "formats"> & { exportDirectory?: string }, worker = fileURLToPath(new URL("worker.ts", import.meta.url))): Promise<ChildOutcome> {
  return new Promise(resolveOutcome => {
    let response: ChildOutcome["result"];
    let progress: WorkerProgress | undefined, progressAt = performance.now();
    let timeoutKind: Result["timeoutKind"], workStarted = false;
    let timedOut = false, oom = false, protocolError = false;
    let stderr = "";
    const forkOptions: ForkOptions & { windowsHide: boolean } = {
      execArgv: [`--max-old-space-size=${options.maxOldSpaceMb}`, "--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
      // Do not inherit NODE_OPTIONS: the requested heap cap must be authoritative.
      env: { ...process.env, NODE_OPTIONS: "" }
    };
    const processChild = fork(worker, [], forkOptions);
    trackChild(processChild);
    const expire = (kind?: Result["timeoutKind"]) => { if (timedOut) return; timedOut = true; timeoutKind = kind; processChild.kill("SIGKILL"); };
    let timer = setTimeout(() => expire(progress ? "harness-slow" : undefined), options.timeoutMs);
    let importTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = () => { clearTimeout(timer); clearTimeout(importTimer); };
    processChild.stderr?.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-8192);
      if (/heap out of memory|allocation failed|wasm.*out of memory|cannot enlarge memory/i.test(stderr)) oom = true;
    });
    processChild.on("message", value => {
      const update = value as WorkerProgress;
      if (update?.type === "progress") {
        if (!errorStages.includes(update.stage) || !["unknown", "cdx", "cdxml"].includes(update.format)
          || typeof update.parseOk !== "boolean" || !Number.isFinite(update.size) || !Number.isFinite(update.elapsedMs)
          || !update.stageMs || Object.entries(update.stageMs).some(([stage, ms]) => !errorStages.includes(stage as WorkerProgress["stage"]) || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0)) { protocolError = true; return; }
        if (update.stage !== progress?.stage) {
          clearTimeout(importTimer);
          if (update.stage === "import" || update.stage.startsWith("reimport-")) {
            if (!workStarted) clearTimeout(timer);
            importTimer = setTimeout(() => expire("import-hang"), options.importTimeoutMs ?? 60_000);
          }
        }
        if (update.parseOk && !workStarted) {
          workStarted = true;
          clearTimeout(timer);
          timer = setTimeout(() => expire("harness-slow"), options.timeoutMs);
        }
        progress = update;
        progressAt = performance.now();
        return;
      }
      const candidate = value as ChildOutcome["result"];
      if (response || !candidate || typeof candidate.parseOk !== "boolean" || !Array.isArray(candidate.roundTrips)) protocolError = true;
      else response = candidate;
    });
    processChild.once("error", error => { clearTimers(); resolveOutcome({ status: "crash", error: stageError(progress?.stage ?? "detect", error, [copy]) }); });
    processChild.once("close", (exitCode, signal) => {
      clearTimers();
      const status = timedOut ? "timeout" : oom ? "oom" : exitCode !== 0 || signal || !response || protocolError ? "crash" : undefined;
      const error = status && supervisionError(status, protocolError || (!response && exitCode === 0 && !signal), progress, timeoutKind);
      const interrupted: ChildOutcome["result"] = status && progress && error ? {
        format: progress.format, size: progress.size, parseOk: progress.parseOk, status,
        ...(timeoutKind ? { timeoutKind } : {}), error, errors: [error], warnings: [], roundTrips: [],
        timings: { totalMs: progress.elapsedMs + performance.now() - progressAt,
          stageMs: { ...progress.stageMs, [progress.stage]: (progress.stageMs[progress.stage] ?? 0) + performance.now() - progressAt } }
      } : undefined;
      resolveOutcome(status ? { status, error: error || undefined, result: interrupted, exitCode, signal } : { result: response });
    });
    processChild.send({ copy, formats: options.formats, exportDirectory: options.exportDirectory }, error => { if (error) processChild.kill("SIGKILL"); });
  });
}

async function groupFor(map: string | undefined, original: string): Promise<{ group: string; era: string }> {
  if (!map) return { group: "ungrouped", era: "unknown" };
  for await (const line of lines(map)) {
    const [path, group = "ungrouped", era] = line.split("\t");
    if (path === original) {
      // Groups are untrusted labels; reports use opaque hashes so a name/path/formula
      // accidentally used as a group cannot escape. The private index retains the label.
      const band = era ?? group.match(/(?:19|20)\d{2}(?:[-–](?:19|20)\d{2})?/)?.[0];
      return { group, era: band && /^(?:19|20)\d{2}(?:[-–](?:19|20)\d{2})?$/.test(band) ? band : "unknown" };
    }
  }
  return { group: "ungrouped", era: "unknown" };
}
export const publicGroup = (group: string) => group === "ungrouped" ? group : `group-${createHash("sha256").update(group).digest("hex").slice(0, 12)}`;

export async function run(options: RunOptions, execute = child): Promise<{ processed: number; skipped: number; copyErrors?: number }> {
  // Validate the complete list before creating output. Stream twice rather than retain paths.
  for await (const original of lines(options.list)) await validateDestination(original, options.out);
  await prepareOutput(options.out);
  const tempRoot = join(options.out, "private", "tmp");
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const resultPath = join(options.out, "private", "results.jsonl");
  if (!options.resume) {
    try { if ((await stat(resultPath)).size) throw new Error("Results already exist; use --resume or a fresh output directory."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await appendFile(resultPath, "", { mode: 0o600 });
  if (options.resume) await repairTail(options.out);
  // A disk index keeps resume bounded in memory and avoids rescanning a large corpus per file.
  // Rebuild from the authoritative stream so interruption between append and marker is safe.
  const doneDirectory = join(options.out, "private", "done");
  await rm(doneDirectory, { recursive: true, force: true });
  await mkdir(doneDirectory, { mode: 0o700 });
  for await (const row of results(options.out)) {
    if (row.status === "copy-error" && row.id === "unavailable") continue;
    if (!/^[0-9a-f]{12}$/.test(row.id)) throw new Error("Results contain an invalid content ID.");
    await writeFile(join(doneDirectory, row.id), "", { mode: 0o600 });
  }
  // Serialize appends: concurrent writes must never interleave large JSON lines.
  let resultQueue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = resultQueue.then(action);
    resultQueue = pending.then(() => {}, () => {});
    return pending;
  };
  let processed = 0, skipped = 0, copyErrors = 0;
  let batch: string[] = [];
  for await (const original of lines(options.list)) {
    batch.push(original);
    if (batch.length >= options.batchSize) { await processBatch(batch); batch = []; }
  }
  if (batch.length) await processBatch(batch);
  return { processed, skipped, ...(copyErrors ? { copyErrors } : {}) };

  async function processBatch(paths: string[]) {
    let cursor = 0;
    // Same-content files within a concurrent batch share one ID. Serialize reservations.
    const inFlight = new Map<string, Promise<void>>();
    const consume = async () => {
      while (cursor < paths.length) {
        const original = paths[cursor++];
        const started = performance.now();
        const { group, era } = await groupFor(options.groupMap, original);
        let copied = false;
        try {
          await withCopy(original, async (copy, id, size) => {
            copied = true;
            await appendFile(join(options.out, "private", "index.tsv"), `${id}\t${original}\t${group.replace(/[\t\r\n]/g, " ")}\n`, { mode: 0o600 });
            const pending = inFlight.get(id);
            if (pending) { await pending; skipped++; return; }
            let release!: () => void;
            inFlight.set(id, new Promise<void>(done => { release = done; }));
            try {
              try { await stat(join(doneDirectory, id)); skipped++; return; }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
              let outcome: ChildOutcome;
              try { outcome = await execute(copy, options); }
              catch (error) { outcome = { status: "crash", error: stageError("detect", error, [copy, original]) }; }
              const result: Result = {
                id, group: publicGroup(group), era, format: "unknown", size, parseOk: false,
                status: outcome.status ?? "crash", warnings: [], roundTrips: [],
                timings: { totalMs: performance.now() - started },
                ...outcome.result,
                ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
                ...(outcome.signal !== undefined ? { signal: outcome.signal } : {})
              };
              if (result.status !== "ok" && !result.error) {
                result.error = outcome.error ?? (result.status === "crash" || result.status === "timeout" || result.status === "oom"
                  ? supervisionError(result.status)
                  : stageError(result.parseOk ? "summary" : "import", new Error(result.errorMessage ?? "Worker returned a failure without diagnostics.")));
                (result.errors ??= []).unshift(result.error);
              }
              // Diagnostics may quote a file path. Redact original and temporary path spellings.
              let encoded = JSON.stringify(result);
              for (const secret of [original, copy, resolve(copy, "..")]) encoded = encoded.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
              await serialized(async () => {
                await appendFile(resultPath, `${encoded}\n`);
                await writeFile(join(doneDirectory, id), "", { mode: 0o600 });
                process.stderr.write(completionLine(result));
              });
              processed++;
            } finally { release(); }
          }, tempRoot);
        } catch (error) {
          // A source that cannot be copied has no content hash and therefore no file ID.
          // Its path remains in the private index so the conductor can locate the failure.
          await appendFile(join(options.out, "private", "events.jsonl"), `${JSON.stringify({ category: "copy_or_result_write_failed", code: safeError(error) })}\n`, { mode: 0o600 });
          if (copied) throw error;
          copyErrors++;
          const result: Result = {
            id: "unavailable", group: publicGroup(group), era, format: "unknown", size: 0,
            parseOk: false, status: "copy-error", error: stageError("copy", error, [original]),
            warnings: [], roundTrips: [], timings: { totalMs: performance.now() - started }
          };
          await serialized(async () => {
            await appendFile(resultPath, `${JSON.stringify(result)}\n`);
            process.stderr.write(completionLine(result));
          });
          await appendFile(join(options.out, "private", "index.tsv"), `unavailable\t${original}\t${group.replace(/[\t\r\n]/g, " ")}\n`, { mode: 0o600 });
        }
      }
    };
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(options.concurrency, paths.length) }, consume));
    const failure = outcomes.find(o => o.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    if (options.afterBatch) {
      const directory = await mkdtemp(join(tempRoot, "batch-"));
      const untrack = trackDirectory(directory);
      try {
        const list = join(directory, "batch.txt");
        await writeFile(list, `${paths.join("\n")}\n`, { mode: 0o600 });
        const outcome = await new Promise<{ category: string; code?: string | number; signal?: string | null }>(done => {
          trackChild(execFile(options.afterBatch!, [list], { shell: false, windowsHide: true, timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: 8192 }, error => done(error ? { category: "after_batch_failed", code: typeof error.code === "number" ? error.code : safeError(error), signal: error.signal } : { category: "after_batch_ok" })));
        });
        await appendFile(join(options.out, "private", "events.jsonl"), `${JSON.stringify({ ...outcome, count: paths.length })}\n`, { mode: 0o600 });
      } finally { await rm(directory, { recursive: true, force: true }); untrack(); }
    }
  }
}
