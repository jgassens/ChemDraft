import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { child, run } from "./runner";
import { report } from "./report";
import { results } from "./io";
import { rdkitError, stageError } from "./errors";
import type { Result } from "./model";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

it.each([37, Object.defineProperty({ detail: "synthetic diagnostic" }, "reason", { value: "native failure" })])("decodes thrown RDKit values with and without an Emscripten decoder (%s)", thrown => {
  const category = typeof thrown === "number" ? "rdkit.exception_number" : "rdkit.exception_object";
  expect(stageError("summary", rdkitError(thrown, { getExceptionMessage: () => ["RDKit", "synthetic native exception"] }))).toMatchObject({ category, message: "RDKit: synthetic native exception" });
  const fallback = stageError("summary", rdkitError(thrown));
  expect(fallback.category).toBe(category);
  expect(fallback.message).toBe(typeof thrown === "number" ? "37" : '{"detail":"synthetic diagnostic","reason":"native failure"}');
});

it("classifies native OOB errors and retains cyclic objects' own properties", () => {
  expect(stageError("summary", rdkitError(new WebAssembly.RuntimeError("memory access out of bounds")))).toMatchObject({ category: "rdkit.wasm_oob", message: "memory access out of bounds" });
  const thrown: { reason: string; self?: unknown } = { reason: "synthetic" };
  thrown.self = thrown;
  expect(stageError("summary", thrown).message).toBe('{"reason":"synthetic","self":"[circular]"}');
});

it.each([{ message: "synthetic object message" }, { what: () => "synthetic native what" }])("reads thrown objects' native diagnostics", thrown => {
  expect(rdkitError(thrown).message).toBe("message" in thrown ? thrown.message : thrown.what());
  expect(rdkitError(thrown, { getExceptionMessage: () => { throw 17; } }).message).not.toContain("[object Object]");
});

it("separates injected import hangs from slow summaries, retaining IPC stage/format/timings", async () => {
  const root = await mkdtemp(join(fileURLToPath(new URL(".", import.meta.url)), ".supervision-test-"));
  directories.push(root);
  const sources = join(root, "sources"), out = join(root, "out");
  await mkdir(sources);
  const worker = join(root, "slow-worker.mjs");
  await writeFile(worker, `import { readFileSync } from 'node:fs';
process.once('message', job => {
 const stage = readFileSync(job.copy, 'utf8');
 process.send({ type: 'progress', stage, format: 'cdxml', parseOk: stage !== 'import', size: 42, elapsedMs: 12, stageMs: { detect: 2, ...(stage === 'summary' ? { import: 10 } : {}) } }, () => {
   while (true) {}
 });
});`);
  const originals: string[] = [];
  for (const stage of ["import", "summary"]) {
    const file = join(sources, `${stage}.cdxml`);
    await writeFile(file, stage);
    originals.push(file);
  }
  const list = join(root, "list.txt");
  await writeFile(list, originals.join("\n"));
  await run({ list, out, formats: [], concurrency: 2, batchSize: 2, maxOldSpaceMb: 256, importTimeoutMs: 100, timeoutMs: 1500 }, (copy, options) => child(copy, options, worker));
  const rows: Result[] = [];
  for await (const row of results(out)) rows.push(row);
  const hang = rows.find(row => row.timeoutKind === "import-hang")!;
  const slow = rows.find(row => row.timeoutKind === "harness-slow")!;
  expect(hang).toMatchObject({ status: "timeout", format: "cdxml", parseOk: false, error: { stage: "import", category: "import.hang", message: expect.stringContaining("IMPORT HANG") } });
  expect(slow).toMatchObject({ status: "timeout", format: "cdxml", parseOk: true, error: { stage: "summary", category: "harness.slow", message: expect.stringContaining("not a product finding") } });
  expect(hang.timings.stageMs?.import).toBeGreaterThanOrEqual(90);
  expect(slow.timings.stageMs?.summary).toBeGreaterThanOrEqual(1400);
  expect(slow.timings.stageMs?.import).toBe(10);
  await report(out);
  const json = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  expect(json.timeouts).toEqual({ importHang: 1, harnessSlow: 1, unclassified: 0 });
  expect(json.errorCounts).toEqual({ import: { "import.hang": 1 }, summary: { "harness.slow": 1 } });
  expect(await readFile(join(out, "report.md"), "utf8")).toContain("IMPORT HANG (product findings): 1. Harness-slow (not product findings): 1");
  expect(await readdir(join(out, "private", "tmp"))).toEqual([]);
}, 10000);
