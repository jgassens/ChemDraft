import { readFile, stat } from "node:fs/promises";
import { sourceSurvival } from "./survival";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { open, interchange, loadCdxSupport, noCdxSupport } from "./codec";
import { writeOutput as writeFile, checkOutputTree } from "./safety";
import { describeDocument, describeTruthSru, SummaryContext } from "./chemistry";
import { HarnessFailure, redactPaths, stageError } from "./errors";
import { compare, compareSurvival, chemistryVerdict, type ErrorStage, type Format, type Result, type RoundTrip, type StageError, type Summary, type Warning, type WorkerProgress } from "./model";

export async function processCopy(copy: string, formats: Format[] = ["cdx", "cdxml"], exportDirectory?: string, progress: (value: WorkerProgress) => void = () => {}): Promise<Omit<Result, "id" | "group" | "era">> {
  const start = performance.now();
  const result: Omit<Result, "id" | "group" | "era"> = {
    format: "unknown", size: 0, parseOk: false, status: "ok", warnings: [], roundTrips: [], timings: { totalMs: 0 }
  };
  const secrets = [copy, dirname(copy)];
  let phase: ErrorStage = "copy";
  let phaseStart = start;
  const stageMs: WorkerProgress["stageMs"] = {};
  const context = new SummaryContext();
  const enter = (stage: ErrorStage) => {
    const now = performance.now();
    stageMs[phase] = (stageMs[phase] ?? 0) + now - phaseStart;
    phase = stage;
    phaseStart = now;
    progress({ type: "progress", stage, format: result.format, size: result.size, parseOk: result.parseOk, elapsedMs: now - start, stageMs: { ...stageMs } });
  };
  progress({ type: "progress", stage: phase, format: result.format, size: 0, parseOk: false, elapsedMs: 0, stageMs: {} });
  const record = (error: StageError) => {
    result.status = result.parseOk ? "processing-error" : "import-error";
    result.error ??= error;
    (result.errors ??= []).push(error);
  };
  try {
    result.size = (await stat(copy)).size;
    enter("detect");
    if (result.size > 64 * 1024 * 1024) throw new HarnessFailure("InputLimitError", "input.too_large", "Input exceeds the 64 MB file-size limit.");
    enter("copy");
    const bytes = await readFile(copy);
    const importStart = performance.now();
    enter("detect");
    result.format = Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "VjCD" ? "cdx"
      : /<(?:\w+:)?CDXML\b/i.test(Buffer.from(bytes).toString("utf8")) ? "cdxml" : "unknown";
    const hasCdx = !!await loadCdxSupport();
    enter("import");
    const imported = await open(bytes);
    result.timings.importMs = performance.now() - importStart;
    result.format = imported.format;
    result.warnings = [...imported.warnings];
    result.parseOk = !!imported.document;
    if (!imported.document) {
      const unknown = imported.format === "unknown";
      record(stageError(unknown ? "detect" : "import", new HarnessFailure(
        unknown ? "UnsupportedFormatError" : "ImportRejectedError", unknown ? "input.unsupported_format" : "import.rejected",
        imported.warnings.map(w => `${w.category}: ${w.message}`).join("; ") || "The shared importer returned no document."
      ), secrets));
    } else {
      enter("summary");
      const summaryStart = performance.now();
      try {
        result.sourceSurvival = sourceSurvival(bytes);
        result.summary = await describeDocument(imported.document, result.warnings, context);
        result.importComparison = compareSurvival(result.sourceSurvival, result.summary.survival!, imported.warnings);
        result.truthSru = await describeTruthSru(imported.document, result.summary, context);
        for (const item of result.summary.summaryErrors ?? []) record(item.summaryError);
      } catch (error) { record(stageError("summary", error, secrets)); }
      result.timings.summaryMs = performance.now() - summaryStart;

      // File exports and conversion routes are independent, including when the baseline summary
      // is incomplete. A failed export never replaces a successfully computed original summary.
      if (exportDirectory) for (const format of formats.filter(format => format !== "cdx" || hasCdx)) {
        try {
          enter(`export-${format}`);
          await checkOutputTree(exportDirectory);
          const exported = await interchange(imported.document, format);
          await writeFile(join(exportDirectory, `export.${format}`), exported.bytes, { flag: "wx" });
        } catch (error) { record(stageError(`export-${format}`, error, secrets)); }
      }
      for (const format of formats) result.roundTrips.push(await roundTrip(format, [format]));
      if (formats.includes("cdx") && formats.includes("cdxml")) result.roundTrips.push(await roundTrip("cdx-cdxml-cdx", ["cdx", "cdxml", "cdx"]));
    }
    if (!hasCdx) for (const route of ["cdx", "cdx-cdxml-cdx"]) {
      if (!result.roundTrips.some(trip => trip.route === route)) result.roundTrips.push(skipped(route));
    }

    function skipped(route: string): RoundTrip {
      return { route, verdict: "SKIPPED", reason: noCdxSupport, warnings: [], differences: [], drawingLoss: [], ms: 0 };
    }

    async function roundTrip(route: string, stages: Format[]): Promise<RoundTrip> {
      if (!hasCdx && stages.includes("cdx")) return skipped(route);
      const started = performance.now();
      let document = imported.document!;
      let previous: Summary | undefined = result.summary;
      let latest: Summary | undefined;
      const trip: RoundTrip = { route, verdict: "PASS", warnings: [], differences: [], drawingLoss: [], ms: 0 };
      const fail = (error: StageError) => {
        trip.error ??= error;
        (trip.errors ??= []).push(error);
        record(error);
      };
      for (const format of stages) {
        let exported: Awaited<ReturnType<typeof interchange>>;
        try {
          enter(`export-${format}`);
          exported = await interchange(document, format);
          trip.bytes = exported.bytes.length;
          trip.warnings.push(...exported.warnings);
        } catch (error) { fail(stageError(`export-${format}`, error, secrets)); break; }
        let reopened: Awaited<ReturnType<typeof open>>;
        try {
          enter(`reimport-${format}`);
          reopened = await open(exported.bytes);
          trip.warnings.push(...reopened.warnings);
          if (!reopened.document) throw new HarnessFailure("ImportRejectedError", "import.rejected", reopened.warnings.map(w => `${w.category}: ${w.message}`).join("; ") || "The shared reimporter returned no document.");
          document = reopened.document;
        } catch (error) { fail(stageError(`reimport-${format}`, error, secrets)); break; }
        const summaryWarnings: Warning[] = [];
        try {
          enter("summary");
          const current = await describeDocument(document, summaryWarnings, context);
          latest = current;
          for (const item of current.summaryErrors ?? []) fail(item.summaryError);
          if (previous && !previous.summaryErrors?.length && !current.summaryErrors?.length) {
            try {
              enter("cross");
              const comparison = compare(previous, current, [...exported.warnings, ...reopened.warnings]);
              trip.identityPasses = (trip.identityPasses ?? 0) + (comparison.identityPasses ?? 0);
              if (comparison.chemistryPassReason) trip.chemistryPassReason = comparison.chemistryPassReason;
              (trip.legs ??= []).push({ before: previous, after: current, warnings: [...exported.warnings, ...reopened.warnings] });
              trip.comparisonInternalErrors = (trip.comparisonInternalErrors ?? 0) + (comparison.comparisonInternalErrors ?? 0);
              trip.differences.push(...comparison.differences);
              if (comparison.undetermined?.length) (trip.undetermined ??= []).push(...comparison.undetermined);
              trip.drawingLoss = [...new Set([...trip.drawingLoss, ...comparison.drawingLoss])];
            } catch (error) { fail(stageError("cross", error, secrets)); }
          } else if (!trip.error) {
            fail(stageError("summary", new HarnessFailure("IncompleteSummaryError", "summary.incomplete", "A complete baseline and reimport summary are required for comparison.")));
          }
          previous = current;
        } catch (error) {
          fail(stageError("summary", error, secrets));
          previous = undefined;
        } finally { trip.warnings.push(...summaryWarnings); }
      }
      trip.summary = latest;
      trip.verdict = trip.error ? "ERROR" : chemistryVerdict(trip.differences, !!trip.undetermined?.length);
      trip.ms = performance.now() - started;
      return trip;
    }
  } catch (error) { record(stageError(phase, error, secrets)); }
  // Flush the final stage's duration even when no conversion routes ran.
  enter(phase);
  result.timings.stageMs = { ...stageMs };
  result.timings.totalMs = performance.now() - start;
  // All private diagnostics (including warnings and per-molecule errors) pass one redaction gate.
  return JSON.parse(JSON.stringify(result, (key, item) => typeof item === "string" && ["message", "reason"].includes(key) ? redactPaths(item, secrets) : item)) as typeof result;
}

if (process.send && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once("message", async (job: { copy: string; formats: Format[]; exportDirectory?: string }) => {
    const result = await processCopy(job.copy, job.formats, job.exportDirectory, value => process.send!(value));
    process.send!(result, () => process.exit(0));
  });
}
