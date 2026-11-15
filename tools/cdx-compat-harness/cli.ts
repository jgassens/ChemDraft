import { loadCdxSupport, noCdxSupport } from "./codec";
import { parseArgs } from "node:util";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, child, validateDestination, type RunOptions } from "./runner";
import { lines, withCopy, safeError } from "./io";
import { report } from "./report";
import type { Format } from "./model";
import { destinationRealpath, inside, noSymlink, prepareOutput, writeOutput } from "./safety";

const usage = `Usage:
  pnpm -s cdx-compat run --list <paths.txt> --out <dir> [--group-map <groups.tsv>]
    [--formats cdx,cdxml] [--import-timeout-ms 60000] [--timeout-ms 600000] [--max-old-space-mb 2048]
    [--concurrency 2] [--batch-size 50] [--after-batch <executable>] [--resume]
  pnpm -s cdx-compat report --out <dir> [--baseline <old-dir>]
  pnpm -s cdx-compat rescore --out <dir>
  pnpm -s cdx-compat ground-truth --out <dir> --truth-dir <dir>
  pnpm -s cdx-compat export-set --list <ids.txt> --out <dir> --to <dir>`;

export async function main(args: string[]): Promise<number> {
  if (args.includes("--help") || !args.length) { process.stdout.write(`${usage}\n`); return 0; }
  const command = args[0];
  const { values } = parseArgs({ args: args.slice(1), strict: true, options: {
    list: { type: "string" }, out: { type: "string" }, "group-map": { type: "string" },
    formats: { type: "string", default: "cdx,cdxml" }, "timeout-ms": { type: "string", default: "600000" }, "import-timeout-ms": { type: "string", default: "60000" },
    "max-old-space-mb": { type: "string", default: "2048" }, concurrency: { type: "string", default: "2" },
    "batch-size": { type: "string", default: "50" }, "after-batch": { type: "string" }, resume: { type: "boolean" },
    baseline: { type: "string" }, "truth-dir": { type: "string" }, to: { type: "string" }
  } });
  const required = (key: "out" | "list" | "truth-dir" | "to") => {
    if (!values[key]) throw new Error(`Missing required --${key}.`);
    return resolve(values[key]!);
  };
  const number = (key: "timeout-ms" | "import-timeout-ms" | "max-old-space-mb" | "concurrency" | "batch-size", max: number) => {
    const value = Number(values[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`--${key} must be an integer between 1 and ${max}.`);
    return value;
  };
  const out = required("out");
  if (command === "report") { await report(out, values.baseline && resolve(values.baseline)); return 0; }
  if (command === "rescore") { const { rescore } = await import("./rescore"); await rescore(out); return 0; }
  if (command === "ground-truth") {
    const { groundTruth } = await import("./truth");
    await groundTruth(out, required("truth-dir"));
    return 0;
  }
  if (command === "export-set") {
    const to = required("to");
    // Reject public destinations before creating anything or invoking a child.
    const privatePath = join(out, "private");
    if (!inside(await destinationRealpath(privatePath), await destinationRealpath(to))) throw new Error("Export-set: --to must be inside <out>/private.");
    await prepareOutput(out);
    if (!inside(await realpath(privatePath), await destinationRealpath(to))) throw new Error("Export-set: --to must be inside <out>/private.");
    // Check every indexed original, including IDs not selected for export, before writing.
    for await (const row of lines(join(privatePath, "index.tsv"))) await validateDestination(row.split("\t")[1], to);
    // Preflight all requested names so a later collision cannot cause a partial export.
    for await (const id of lines(required("list"))) {
      if (!/^[0-9a-f]{12}$/.test(id)) throw new Error("Export-set IDs must be 12 lowercase hexadecimal characters.");
      for (const format of ["cdx", "cdxml"]) if (await noSymlink(join(to, `${id}.${format}`))) throw new Error("Export-set: destination already exists.");
    }
    await mkdir(to, { recursive: true, mode: 0o700 });
    for await (const id of lines(required("list"))) {
      if (!/^[0-9a-f]{12}$/.test(id)) throw new Error("Export-set IDs must be 12 lowercase hexadecimal characters.");
      let original: string | undefined;
      for await (const row of lines(join(out, "private", "index.tsv"))) {
        const [key, path] = row.split("\t");
        if (key === id) { original = path; break; }
      }
      if (!original) throw new Error(`Export-set: ID ${id} is absent from the private index.`);
      await validateDestination(original, to);
      await withCopy(original, async (copy, actualId, _size, directory) => {
        if (id !== actualId) throw new Error(`Export-set: content changed for ID ${id}; rerun the harness.`);
        const outcome = await child(copy, { formats: ["cdx", "cdxml"], importTimeoutMs: 60000, timeoutMs: 600000, maxOldSpaceMb: 2048, exportDirectory: directory });
        if (!outcome.result?.parseOk || outcome.status) throw new Error(`Export-set: ID ${id} could not be imported or its child failed.`);
        for (const format of ["cdx", "cdxml"]) await writeOutput(join(to, `${id}.${format}`), await readFile(join(directory, `export.${format}`)), { flag: "wx" });
      }, privatePath);
    }
    return 0;
  }
  if (command !== "run") throw new Error("Unknown command. Expected run, report, rescore, ground-truth or export-set.");
  const formats = values.formats!.split(",");
  if (!formats.length || formats.some(f => f !== "cdx" && f !== "cdxml") || new Set(formats).size !== formats.length) throw new Error("--formats must be cdx, cdxml or cdx,cdxml.");
  if (args.includes("--formats") || args.some(arg => arg.startsWith("--formats="))) {
    if (formats.includes("cdx") && !await loadCdxSupport()) throw new Error(`--formats cdx unavailable: ${noCdxSupport}; use --formats cdxml.`);
  }
  const options: RunOptions = {
    out, list: required("list"), groupMap: values["group-map"] && resolve(values["group-map"]), formats: formats as Format[],
    timeoutMs: number("timeout-ms", 86_400_000), importTimeoutMs: number("import-timeout-ms", 86_400_000), maxOldSpaceMb: number("max-old-space-mb", 65536),
    concurrency: number("concurrency", 32), batchSize: number("batch-size", 10000),
    afterBatch: values["after-batch"], resume: values.resume
  };
  const counts = await run(options);
  process.stdout.write(`${JSON.stringify(counts)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    // Node errors often embed input paths. Emit a specific operation/code, never a raw stack.
    const message = error instanceof Error && /^(Missing required|Unknown command|--|List entries|Output must|Results already|Export-set)/.test(error.message) ? error.message : `Compatibility harness ${process.argv[2] ?? "command"} failed (${safeError(error)}).`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  });
}
