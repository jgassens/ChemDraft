// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const pin = "416651ddaef33a4e20392392e7c0b505d446491b";
const generatorVersion = 2;
const toolDir = fileURLToPath(new URL(".", import.meta.url));
const inputDir = join(toolDir, "inputs");
const inventoryPath = join(toolDir, "inventory.json");
const fixtureDir = resolve(toolDir, "../../apps/desktop/src-tauri/tests/fixtures/uff_reference");
const cmake = process.env.CMAKE ?? "cmake";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.signal ?? result.status}\n${result.stderr ?? ""}`);
  }
  return result.stdout;
}

function requiredSource(value, name, landmark) {
  if (!value) throw new Error(`Missing ${name} path.`);
  const source = resolve(value);
  if (!existsSync(join(source, ...landmark))) throw new Error(`Invalid ${name} source path ${source}`);
  return realpathSync(source);
}

function verifyPin(source) {
  const git = (...args) => run("git", ["--no-optional-locks", "-C", source, ...args]).trim();
  if (realpathSync(git("rev-parse", "--show-toplevel")) !== source ||
      git("rev-parse", "HEAD") !== pin ||
      git("status", "--porcelain", "--untracked-files=no")) {
    throw new Error(`Avogadrolibs must be a checkout of ${pin} with no tracked modifications.`);
  }
}

function checkBuildLocation(buildDir, sources) {
  // Resolve any existing ancestor so a symlink cannot point back into a source tree.
  let ancestor = buildDir;
  while (!existsSync(ancestor)) {
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) throw new Error(`Build directory is inaccessible: ${buildDir}`);
    ancestor = parent;
  }
  const physicalPath = resolve(realpathSync(ancestor), relative(ancestor, buildDir));
  for (const source of sources) {
    const path = relative(source, physicalPath);
    if (path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep))) {
      throw new Error("The build directory must be outside both dependency source trees.");
    }
  }
}

function requireFinite(value, context) {
  if (value === null || (typeof value === "number" && !Number.isFinite(value))) {
    throw new Error(`Nonfinite or missing harness value in ${context}`);
  }
  if (typeof value === "object") {
    for (const [key, member] of Object.entries(value)) requireFinite(member, `${context}.${key}`);
  }
}

function withoutTopology(fixture) {
  return {
    ...fixture,
    graphs: fixture.graphs.map((graph) => ({
      ...graph,
      snapshots: graph.snapshots.map(({ topology, ...snapshot }) => snapshot),
    })),
  };
}

function validateCoverage(record, id, expected, kind) {
  if (record.id !== id) throw new Error(`${kind}: expected case ID ${id}, got ${record.id}`);
  const actual = record.graphs.map((graph) => {
    const variant = {
      hydrogenModel: graph.hydrogenModel,
      snapshots: graph.snapshots.map(({ id }) => id),
    };
    if (graph.kekule !== undefined) variant.kekule = graph.kekule;
    const runs = graph.snapshots.flatMap((snapshot) =>
      (snapshot.optimizationRuns ?? []).map(({ algorithm, frozenCoordinates }) => ({
        snapshotId: snapshot.id, algorithm, frozenCoordinates,
      })));
    if (runs.length) variant.runs = runs;
    if (graph.cutoffCrossing) {
      variant.cutoffCrossingSteps = (kind === "Input"
        ? graph.cutoffCrossing.snapshotIds : graph.cutoffCrossing.steps).length;
    }
    return variant;
  });
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${kind} ${id} does not match the inventory.\nExpected ${JSON.stringify(expected)}\nGot ${JSON.stringify(actual)}`);
  }
}

function loadInputs(inventory) {
  const expected = Object.keys(inventory).sort().map((id) => `${id}.json`);
  const actual = readdirSync(inputDir).filter((name) => name.endsWith(".json")).sort();
  if (!expected.length || !isDeepStrictEqual(actual, expected)) {
    const missing = expected.filter((name) => !actual.includes(name));
    const extra = actual.filter((name) => !expected.includes(name));
    throw new Error(`Input files do not match the inventory. Missing: ${missing.join(", ")}. Extra: ${extra.join(", ")}.`);
  }
  return new Map(expected.map((file) => {
    const id = file.slice(0, -5);
    const input = readFileSync(join(inputDir, file));
    validateCoverage(JSON.parse(input), id, inventory[id], "Input");
    return [id, input];
  }));
}

// Keep numeric vectors and tuples together while giving each snapshot its own block.
function formatJson(value, depth = 0) {
  if (Object.is(value, -0)) return "-0.0";
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const indent = "  ".repeat(depth);
  const childIndent = indent + "  ";
  if (Array.isArray(value)) {
    const items = value.map((member) => formatJson(member, depth + 1));
    if (value.every((member) => typeof member !== "object") && items.join(", ").length <= 120)
      return `[${items.join(", ")}]`;
    // Long gradient vectors take one line per atom.
    if (value.every((member) => typeof member === "number")) {
      const triples = [];
      for (let i = 0; i < items.length; i += 3) triples.push(items.slice(i, i + 3).join(", "));
      return `[\n${childIndent}${triples.join(`,\n${childIndent}`)}\n${indent}]`;
    }
    return `[\n${childIndent}${items.join(`,\n${childIndent}`)}\n${indent}]`;
  }
  const items = Object.entries(value).map(([key, member]) =>
    `${JSON.stringify(key)}: ${formatJson(member, depth + 1)}`);
  return items.length ? `{\n${childIndent}${items.join(`,\n${childIndent}`)}\n${indent}}` : "{}";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function generate(source, eigen, buildDir, inventoryBytes) {
  const inventory = JSON.parse(inventoryBytes);
  const inputs = loadInputs(inventory);
  const config = "Release";
  const configure = ["-S", toolDir, "-B", buildDir,
    `-DAVOGADROLIBS_SOURCE=${source}`, `-DEIGEN_SOURCE=${eigen}`,
    `-DCMAKE_BUILD_TYPE=${config}`, "-DCMAKE_POLICY_VERSION_MINIMUM=3.5"];
  if (process.platform === "darwin") configure.push("-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0");
  run(cmake, configure, { stdio: "inherit" });
  run(cmake, ["--build", buildDir, "--config", config, "--target",
    "uff-reference", "uff-reference-diagnostic", "--parallel",
    String(Math.min(availableParallelism(), 6))], { stdio: "inherit" });

  const [pristineExe, diagnosticExe, ...flags] =
    readFileSync(join(buildDir, `metadata-${config}.txt`), "utf8").trimEnd().split(/\r?\n/);
  const build = Object.fromEntries(flags.map((line) => {
    const split = line.indexOf("=");
    return [line.slice(0, split), line.slice(split + 1).trim()];
  }));
  const { eigenVersion, ...settings } = JSON.parse(run(pristineExe, ["--settings"]));
  const manifest = {
    upstreamCommit: pin,
    eigenVersion,
    generatorVersion,
    build,
    settings,
    diagnosticMatchesUnmodified: true,
    inventorySha256: sha256(inventoryBytes),
    files: {},
  };
  const outputs = new Map();
  for (const [id, input] of inputs) {
    const file = `${id}.json`;
    const pristine = JSON.parse(run(pristineExe, [], { input }));
    const diagnostic = JSON.parse(run(diagnosticExe, [], { input }));
    requireFinite(diagnostic, file);
    if (!isDeepStrictEqual(pristine, withoutTopology(diagnostic))) {
      throw new Error(`Diagnostic results diverged from unmodified Avogadro for ${file}`);
    }
    validateCoverage(diagnostic, id, inventory[id], "Fixture");
    const output = `${formatJson(diagnostic)}\n`;
    manifest.files[file] = { inputSha256: sha256(input), outputSha256: sha256(output) };
    outputs.set(file, output);
  }
  // Validate the entire run before touching the existing fixtures.
  mkdirSync(fixtureDir, { recursive: true });
  for (const [file, output] of outputs) writeFileSync(join(fixtureDir, file), output);
  writeFileSync(join(fixtureDir, "manifest.json"), `${formatJson(manifest)}\n`);
  console.log(`Wrote ${outputs.size} UFF reference fixtures to ${fixtureDir}`);
}

function main() {
  const { values } = parseArgs({ options: {
    avogadrolibs: { type: "string" },
    eigen: { type: "string" },
    "build-dir": { type: "string" },
  } });
  const source = requiredSource(values.avogadrolibs ?? process.env.AVOGADROLIBS_SOURCE,
    "Avogadrolibs (--avogadrolibs or AVOGADROLIBS_SOURCE)", ["avogadro", "calc", "uff.cpp"]);
  const eigen = requiredSource(values.eigen ?? process.env.EIGEN_SOURCE,
    "Eigen (--eigen or EIGEN_SOURCE)", ["Eigen", "Core"]);
  verifyPin(source);
  const buildDir = values["build-dir"] ? resolve(values["build-dir"]) : mkdtempSync(join(tmpdir(), "uff-ref-"));
  try {
    checkBuildLocation(buildDir, [source, eigen]);
    generate(source, eigen, buildDir, readFileSync(inventoryPath));
  } finally {
    if (!values["build-dir"]) rmSync(buildDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`UFF reference regeneration failed. ${error.message}`);
  process.exitCode = 1;
}
