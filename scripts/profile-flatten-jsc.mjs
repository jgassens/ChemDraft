#!/usr/bin/env node
// Bundle production flatten once, then run that same script in V8 and JavaScriptCore.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { cpus, loadavg, release } from "node:os";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(`Usage: node scripts/profile-flatten-jsc.mjs [options]
  --engine both|node|jsc    Engines to run (default both)
  --out <directory>        Bundle, saved model, raw timings and full output (default tmp/flatten-jsc)
  --model <json>           Reuse a saved minimize3d result instead of preparing PEG2 in Node
  --samples <count>        Warm flatten samples (default 7; one discarded warmup)
  --warm-embed-minimize    First embed/minimize in each measured process too
  --stereo-ref <git-ref>   Replay stereo.ts from an older commit, keeping current timing hooks
  --compare <directory>   Assert byte-identical output against that directory for each engine
  --jsc <executable>       Override the macOS system jsc path
  --no-minify             Disable production-style minification`);
  process.exit(0);
}
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const directory = resolve(option("--out", join(root, "tmp/flatten-jsc")));
mkdirSync(directory, { recursive: true });
const modelPath = resolve(option("--model", join(directory, "peg2.json")));
const samples = Number(option("--samples", "7"));
const engine = option("--engine", "both");
if (!Number.isInteger(samples) || samples < 1 || samples > 100) throw new Error("--samples must be an integer from 1 to 100.");
if (!["both", "node", "jsc"].includes(engine)) throw new Error(`Unknown engine: ${engine}`);
const bundle = join(directory, "flatten.cjs");
const glue = readFileSync(join(root, "packages/rdkit-adapter/vendor/RDKit_minimal.js"), "utf8");
const config = { modelPath, samples, wasm: join(root, "packages/rdkit-adapter/vendor/RDKit_minimal.wasm") };
console.log(JSON.stringify({ host: { node: process.version, platform: process.platform, arch: process.arch,
  os: release(), cpu: cpus()[0]?.model, loadavg: loadavg() }, stereoRef: option("--stereo-ref", "working tree"),
  minified: !args.includes("--no-minify") }));
const result = await build({
  stdin: { contents: `
    import { setRdkitModuleLoader, ensureRdkit } from "@chemdraft/rdkit-adapter";
    import { embed3dInWorker, minimize3dInWorker, flatten3dInWorker } from "./apps/desktop/src/chemistry3d/engine";
    import { profileChemistry3d } from "./apps/desktop/src/chemistry3d/timing";
    import { CBPQT, pegTtf, centerGuest } from "./apps/desktop/src/chemistry3d/perfFixtures";
    import { chemistry3dResultError } from "./packages/plugin-host/src/chemistry3dResult";
    import { chemistry3dMethod } from "./apps/desktop/src/chemistry3d/method";
    const config = ${JSON.stringify(config)};
    const nativeClone = globalThis.structuredClone;
    // The shell lacks the web structured-clone API; setup fixtures contain only JSON data.
    if (!nativeClone) globalThis.structuredClone = value => JSON.parse(JSON.stringify(value));
    let uuid = 0;
    Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => String(++uuid).padStart(36, "0") }, configurable: true });
    setRdkitModuleLoader(async () => {
      const factory = new Function("require", "__dirname", ${JSON.stringify(glue + "\nreturn initRDKitModule;")})(globalThis.__profileRequire, ".");
      return factory({ wasmBinary: new Uint8Array(__profileRead(config.wasm, true)), print: () => {}, printErr: () => {} });
    });
    async function main() {
      await ensureRdkit();
      if (globalThis.__profilePrepare || ${args.includes("--warm-embed-minimize")}) {
        const embedded = await embed3dInWorker({ components: [{ smiles: CBPQT }, { smiles: pegTtf(2) }], seed: 42 });
        const minimized = await minimize3dInWorker({ model: centerGuest(embedded.model), interfragment: true, maxIters: 20000 }, embedded.method);
        if (minimized.clash) throw new Error("PEG2 fixture clashes");
        if (globalThis.__profilePrepare) {
          __profileWrite(config.modelPath, JSON.stringify(minimized));
          return;
        }
      }
      const fixture = JSON.parse(__profileRead(config.modelPath, false));
      const request = { model: fixture.model, view: "auto" };
      // Match the provider boundary: flatten runs no field, independently of model history.
      const method = chemistry3dMethod(fixture.method.seed);
      const run = timing => flatten3dInWorker(request, method, timing);
      const warm = performance.now();
      await run();
      __profilePrint(JSON.stringify({ warmupMs: performance.now() - warm }));
      for (let sample = 0; sample < config.samples; sample++) {
        uuid = 0;
        const events = [];
        const start = performance.now();
        const flat = await profileChemistry3d(sink => run(sink), event => events.push(event));
        const ms = performance.now() - start;
        const cloneStart = performance.now();
        if (nativeClone) nativeClone(flat);
        const cloneMs = performance.now() - cloneStart;
        const validateStart = performance.now();
        const error = chemistry3dResultError("flatten3d", flat);
        if (error) throw new Error(error);
        const validateMs = performance.now() - validateStart;
        __profilePrint(JSON.stringify({ sample, ms, events, validateMs, cloneMs: nativeClone ? cloneMs : null }));
        if (sample === 0) __profilePrint(JSON.stringify({ output: flat }));
      }
    }
    main().catch(error => { __profilePrint("PROFILE FAILED: " + String(error) + "\\n" + (error.stack || "")); if (globalThis.process) process.exitCode = 1; });
  `, resolveDir: root, sourcefile: "flatten-profile-entry.ts", loader: "ts" },
  bundle: true, platform: "browser", format: "iife", write: false, logLevel: "silent", minify: !args.includes("--no-minify"),
  nodePaths: [join(root, "node_modules/.pnpm/node_modules")],
  alias: { "@chemdraft/export-engine/pdf": join(root, "packages/export-engine/src/pdf.ts") },
  define: { "import.meta.env": "{}" },
  plugins: [{ name: "prior-stereo-guard", setup(builder) {
    const ref = option("--stereo-ref");
    if (!ref) return;
    builder.onLoad({ filter: /[/\\]chemistry3d[/\\]stereo\.ts$/ }, () => ({
      contents: execFileSync("git", ["show", `${ref}:apps/desktop/src/chemistry3d/stereo.ts`], { cwd: root, encoding: "utf8" }),
      loader: "ts", resolveDir: join(root, "apps/desktop/src/chemistry3d")
    }));
  } }, { name: "unused-browser-assets", setup(builder) {
    // Reachable through the shared document workflow, but not used by flatten. The real
    // MinimalLib factory above receives the vendored WASM bytes read from disk in both hosts.
    builder.onResolve({ filter: /\?(raw|url)$/ }, a => ({ path: a.path, namespace: "unused-asset" }));
    builder.onLoad({ filter: /.*/, namespace: "unused-asset" }, () => ({ contents: 'export default ""', loader: "js" }));
  } }]
});
writeFileSync(bundle, result.outputFiles[0].text);
const runner = join(directory, "node-runner.cjs");
writeFileSync(runner, `
  const fs = require("node:fs");
  globalThis.__profileRequire = require;
  globalThis.__profileRead = (p, binary) => fs.readFileSync(p, binary ? undefined : "utf8");
  globalThis.__profileWrite = (p, text) => fs.writeFileSync(p, text);
  globalThis.__profilePrint = console.log;
  globalThis.__profilePrepare = process.argv.includes("--prepare");
  require(${JSON.stringify(bundle)});
`);
function run(command, argv) {
  const child = spawnSync(command, argv, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (child.error) throw child.error;
  process.stderr.write(child.stderr);
  if (child.status !== 0 || child.stdout.includes("PROFILE FAILED:")) {
    process.stdout.write(child.stdout);
    throw new Error(`${command} failed (${child.status})`);
  }
  return child.stdout;
}
if (!args.includes("--model")) run(process.execPath, [runner, "--prepare"]);
for (const selected of engine === "both" ? ["node", "jsc"] : [engine]) {
  console.log(`Engine: ${selected}; model: ${modelPath}; bundle: ${bundle}`);
  let output;
  if (selected === "node") output = run(process.execPath, [runner]);
  else if (selected === "jsc") {
    const prelude = join(directory, "jsc-prelude.js");
    writeFileSync(prelude, `
      globalThis.console = { log: print, error: print, warn: print };
      globalThis.performance = { now: () => preciseTime() * 1000 };
      globalThis.__profileRead = (p, binary) => binary ? readFile(p, "binary") : readFile(p);
      globalThis.__profilePrint = print;
    `);
    output = run(option("--jsc", "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"), [prelude, bundle]);
  } else throw new Error(`Unknown engine: ${selected}`);
  const records = output.trim().split("\n").map(line => JSON.parse(line));
  const rows = records.filter(row => row.events);
  if (rows.length !== samples) throw new Error(`${selected} returned ${rows.length}/${samples} samples.`);
  const serialized = JSON.stringify(records.find(row => row.output)?.output);
  if (!serialized) throw new Error(`${selected} did not return its flatten result.`);
  writeFileSync(join(directory, `${selected}.output.json`), serialized);
  const compare = option("--compare");
  if (compare && serialized !== readFileSync(resolve(compare, `${selected}.output.json`), "utf8")) {
    throw new Error(`${selected} flatten output differs from ${compare}.`);
  }
  writeFileSync(join(directory, `${selected}.jsonl`), records.filter(row => !row.output).map(row => JSON.stringify(row)).join("\n") + "\n");
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const stages = [...new Set(rows.flatMap(row => row.events.map(event => event.stage)))];
  console.table(stages.map(stage => ({ stage,
    medianMs: +median(rows.map(row => row.events.filter(event => event.stage === stage).reduce((sum, event) => sum + event.ms, 0))).toFixed(3),
    calls: median(rows.map(row => row.events.filter(event => event.stage === stage).length))
  })));
  console.log(JSON.stringify({ engine: selected, samples, warmupMs: records[0].warmupMs,
    minMs: Math.min(...rows.map(row => row.ms)), medianMs: median(rows.map(row => row.ms)), maxMs: Math.max(...rows.map(row => row.ms)),
    validationMedianMs: median(rows.map(row => row.validateMs)),
    cloneMedianMs: rows[0].cloneMs === null ? null : median(rows.map(row => row.cloneMs)),
    outputSha256: createHash("sha256").update(serialized).digest("hex"), ...(compare ? { byteIdentical: true } : {}) }));
}
