// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { availableParallelism, cpus, machine, platform, release, tmpdir, version } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const pin = "416651ddaef33a4e20392392e7c0b505d446491b";
const scriptVersion = 1;
const toolDir = fileURLToPath(new URL(".", import.meta.url));
const inputDir = join(toolDir, "inputs");
const cmake = process.env.CMAKE ?? "cmake";
const tieKjMol = 0.02;
const perturbations = [
  { id: "jitter-a", seed: 416651, maxAxisOffsetAngstrom: 0.16 },
  { id: "jitter-b", seed: 416654, maxAxisOffsetAngstrom: 0.30 },
];
const excludedElements = new Set(["iodomethane", "antimony-trihydride", "element-scan-probe"]);
const threadEnv = { ...process.env, OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1" };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.signal ?? result.status}\n${result.stderr ?? ""}`);
  }
  return result.stdout;
}

function sourceDirectory(value, name, landmark) {
  if (!value) throw new Error(`Specify ${name} and its source directory.`);
  const source = resolve(value);
  if (!existsSync(join(source, ...landmark))) throw new Error(`Missing source files for ${name} at ${source}`);
  return realpathSync(source);
}

function outsideSources(buildDir, sources) {
  let ancestor = buildDir;
  while (!existsSync(ancestor)) ancestor = resolve(ancestor, "..");
  const physicalPath = resolve(realpathSync(ancestor), relative(ancestor, buildDir));
  for (const source of sources) {
    const path = relative(source, physicalPath);
    if (!path || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep)))
      throw new Error("The build directory must be outside both dependency source trees.");
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jitter(coordinates, { seed, maxAxisOffsetAngstrom }) {
  // xorshift32. Traverse input atom order, then x/y/z order.
  let state = seed;
  return coordinates.map((atom) => atom.map((coordinate) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const unit = (state >>> 0) / 2 ** 32;
    return coordinate + maxAxisOffsetAngstrom * (2 * unit - 1);
  }));
}

function stereoWitness(id, graph) {
  const bonded = (a, b, order) => graph.bonds.some((bond) => bond.order === order &&
    ((bond.a === a && bond.b === b) || (bond.a === b && bond.b === a)));
  if (id.startsWith("2-butanol-")) {
    // O, ethyl, methyl, H in descending CIP priority around atom 1.
    const atoms = [2, 3, 0, 8];
    if (!atoms.every((atom) => bonded(1, atom, 1))) throw new Error(`Missing tetrahedral witness in ${id}`);
    return { kind: "tetrahedral", center: 1, atoms };
  }
  if (id.startsWith("2-butene-")) {
    if (!bonded(0, 1, 1) || !bonded(1, 2, 2) || !bonded(2, 3, 1)) {
      throw new Error(`Missing alkene witness in ${id}`);
    }
    // The two methyl groups are the priority substituents across the alkene.
    return { kind: "alkene", atoms: [0, 1, 2, 3] };
  }
  return null;
}

function freezeInputs(inventory) {
  const ids = Object.keys(inventory).sort();
  const files = readdirSync(inputDir).filter((name) => name.endsWith(".json")).sort();
  const expected = ids.map((id) => `${id}.json`);
  if (!ids.length || !isDeepStrictEqual(files, expected)) {
    const missing = expected.filter((name) => !files.includes(name));
    const extra = files.filter((name) => !expected.includes(name));
    throw new Error(`Inputs differ from inventory. Missing [${missing.join(", ")}]. Extra [${extra.join(", ")}].`);
  }
  const cases = [];
  const exclusions = {};
  for (const id of ids) {
    const bytes = readFileSync(join(inputDir, `${id}.json`));
    const input = JSON.parse(bytes);
    const graphCoverage = input.graphs.map((graph) => ({
      hydrogenModel: graph.hydrogenModel,
      kekule: graph.kekule,
      snapshots: graph.snapshots.map(({ id }) => id),
    }));
    const expectedCoverage = inventory[id].map(({ hydrogenModel, kekule, snapshots }) =>
      ({ hydrogenModel, kekule, snapshots }));
    if (id !== input.id || !isDeepStrictEqual(graphCoverage, expectedCoverage)) {
      throw new Error(`Graph or snapshot coverage differs from inventory for ${id}`);
    }
    if (excludedElements.has(id)) {
      exclusions[id] = "element parameter work";
      continue;
    }
    const graphs = input.graphs.filter((graph) => graph.hydrogenModel === "explicit-hydrogen");
    if (!graphs.length) exclusions[id] = "no explicit-hydrogen variant";
    for (const graph of graphs) {
      const base = graph.snapshots.find(({ id }) => id === "seed" || id === "linear");
      if (!base) throw new Error(`Missing committed seed or linear snapshot for ${id}`);
      const coordinates = base.coordinatesAngstrom;
      if (!Array.isArray(coordinates) || coordinates.length !== graph.atoms.length ||
          coordinates.some((atom) => !Array.isArray(atom) || atom.length !== 3 || !atom.every(Number.isFinite))) {
        throw new Error(`Missing or invalid coordinates for ${id}/${base.id}`);
      }
      cases.push({
        molecule: id,
        kekule: graph.kekule ?? null,
        hydrogenModel: graph.hydrogenModel,
        inputSha256: sha256(bytes),
        stereoIntent: input.stereoIntent ?? null,
        stereoWitness: stereoWitness(id, graph),
        atoms: graph.atoms,
        bonds: graph.bonds,
        frozenCoordinates: [],
        restSnapshot: base.id,
        restCoordinatesAngstrom: coordinates,
        starts: [
          { id: base.id, seed: null, coordinatesAngstrom: coordinates },
          ...perturbations.map((p) => ({
            id: p.id, seed: p.seed, coordinatesAngstrom: jitter(coordinates, p),
          })),
        ],
      });
    }
  }
  if (!cases.length) throw new Error("No explicit-hydrogen benchmark inputs.");
  return { cases, exclusions };
}

function buildBenchmark(source, eigen, buildDir) {
  const config = "Release";
  const configure = ["-S", toolDir, "-B", buildDir,
    `-DAVOGADROLIBS_SOURCE=${source}`, `-DEIGEN_SOURCE=${eigen}`,
    `-DCMAKE_BUILD_TYPE=${config}`, "-DCMAKE_POLICY_VERSION_MINIMUM=3.5"];
  if (process.platform === "darwin") configure.push("-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0");
  run(cmake, configure, { stdio: "inherit" });
  run(cmake, ["--build", buildDir, "--config", config, "--target", "optimizer-benchmark",
    "--parallel", String(Math.min(availableParallelism(), 6))], { stdio: "inherit" });
  const [executable, ...benchmarkFlags] =
    readFileSync(join(buildDir, `optimizer-benchmark-${config}.txt`), "utf8").trimEnd().split(/\r?\n/);
  const [, , ...flags] = readFileSync(join(buildDir, `metadata-${config}.txt`), "utf8").trimEnd().split(/\r?\n/);
  const build = Object.fromEntries([...flags, ...benchmarkFlags].map((line) => {
    const split = line.indexOf("=");
    return [line.slice(0, split), line.slice(split + 1).trim()];
  }));
  if (build.configuration !== config) throw new Error(`Expected ${config} CMake configuration`);
  return { executable, build };
}

function summarize(results, regime) {
  const rows = results.flatMap((mol) => mol.starts.map((start) => ({
    label: [mol.molecule, mol.kekule, start.id].filter(Boolean).join(" / "),
    witnessKind: mol.stereoWitness?.kind,
    initialEnergyKjMol: start.initialEnergyKjMol,
    ...start[regime],
  })));
  const tally = { lowerFire: 0, lowerHybrid: 0, ties: 0, uncomparable: 0 };
  for (const { fireMinusHybridEnergyKjMol: energy } of rows) {
    if (energy === null) ++tally.uncomparable;
    else if (Math.abs(energy) <= tieKjMol) ++tally.ties;
    else if (energy < 0) ++tally.lowerFire;
    else ++tally.lowerHybrid;
  }
  const stats = {};
  const exceptions = {};
  for (const method of ["fire", "hybrid"]) {
    const runs = rows.map((row) => row[method]);
    stats[method] = {
      converged: runs.filter((r) => r.status === "converged").length,
      capped: runs.filter((r) => r.status === "capped").length,
      failed: runs.filter((r) => r.status === "failed").length,
      nonfinite: runs.filter((r) => r.status === "NaN").length,
      reachedRms: runs.filter((r) => r.firstConvergedAfterIterations !== null).length,
      medianIterations: median(runs.map((r) => r.iterations)),
      worstIterations: Math.max(...runs.map((r) => r.iterations)),
      medianWallMs: median(runs.map((r) => r.medianWallMs)),
      worstWallMs: Math.max(...runs.map((r) => r.medianWallMs)),
      everAboveStart: runs.filter((r) => r.everEvaluatedAboveStart).length,
      optimizerStepAboveStart: runs.filter((r) => r.stepTrace.optimizerStepEverAboveStart).length,
      acceptedChunkAboveRunStart: runs.filter((r) => r.acceptedChunkEverAboveRunStart).length,
      endedAboveStart: rows.filter((r) =>
        r[method].energyKjMol !== null && r[method].energyKjMol > r.initialEnergyKjMol).length,
      handoffs: runs.filter((r) => r.handoff !== null).length,
    };
    exceptions[method] = {
      capExits: rows.filter((r) => r[method].status === "capped").map((r) => r.label),
      failures: rows.filter((r) => ["failed", "NaN"].includes(r[method].status)).map((r) => r.label),
      transientNonfinite: rows.filter((r) => r[method].nonfiniteEnergyEvaluations).map((r) => r.label),
      stereoChanges: rows.filter((r) => r[method].stereo?.events.length).map((r) => r.label),
      stepStereoChanges: rows.filter((r) => r[method].stepTrace.stereoEvents.length).map((r) => r.label),
      graphChanges: rows.filter((r) => r[method].graphChanged).map((r) => r.label),
      guardRejections: rows.filter((r) => r[method].guardRejections.length).map((r) => r.label),
    };
  }
  const hybridOnly = rows.filter((r) => r.hybrid.status === "converged" &&
    r.fire.status !== "converged").map((r) => r.label);
  const handoffIterations = rows.flatMap((r) => r.hybrid.handoff ? [r.hybrid.handoff.afterIterations] : []);
  const handoffRange = handoffIterations.length
    ? [Math.min(...handoffIterations), Math.max(...handoffIterations)] : null;
  return { rows, tally, stats, exceptions, hybridOnly, handoffRange };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor(sorted.length / 2)] + sorted[Math.ceil(sorted.length / 2) - 1]) / 2;
}

function format(value, digits = 4) {
  return value === null ? "—" : value.toFixed(digits);
}

function tableBody(rows) {
  return rows.map(({ label, fireMinusHybridEnergyKjMol, fire, hybrid }) => {
    const cells = [label, format(fireMinusHybridEnergyKjMol, 6)];
    for (const r of [fire, hybrid]) {
      cells.push(r.iterations, `${r.forceEvaluations}/${r.energyEvaluations}`,
        format(r.medianWallMs), r.status);
    }
    return `| ${cells.join(" | ")} |`;
  }).join("\n");
}

function report(data, regimes) {
  const { provenance, settings, cases, exclusions } = data;
  const { requestedChunkIterations: chunk, releaseChunks, actualTailIterationCap: cap,
    mobileGradientRmsLimitKjMolAngstrom: rms, timedRepeats, warmups } = settings;
  const moleculeCount = new Set(cases.map((c) => c.molecule)).size;
  const titles = { release: "Default release", tail: "Extended tail" };
  const labels = { fire: "ABC-FIRE", hybrid: "Hybrid" };
  const text = [
    "# ABC-FIRE and Hybrid on the Spin 3D UFF reference set",
    "",
    `Measured on ${provenance.machine.cpu} (${provenance.machine.platform} ${provenance.machine.arch}, kernel ${provenance.machine.kernel}) using ${provenance.build.compiler}, CMake ${provenance.build.configuration}, and Eigen ${provenance.eigenVersion}. Ran on ${provenance.measuredAtUtc} with pinned Avogadrolibs \`${provenance.upstreamCommit}\`. Build flags and individual timings are in the [JSON](fire-vs-hybrid.json).`,
    "",
    `The comparison covers ${moleculeCount} molecules, ${cases.length} explicit-hydrogen graphs including both committed Kekulé forms, and ${regimes.release.rows.length} paired starts per regime. Each graph starts from its committed seed or linear snapshot and two jitters of that same snapshot. The fixed xorshift32 seeds are ${perturbations.map((p) => p.seed).join(" and ")} with per-axis ranges ${perturbations.map((p) => `±${p.maxAxisOffsetAngstrom} Å`).join(" and ")}, respectively. The runs omitted ${Object.entries(exclusions).map(([id, reason]) => `\`${id}\` (${reason})`).join(", ")}.`,
    "",
    `Both methods use the same all-mobile mask, coordinates, UFF input graph, and ${rms} kJ/(mol·Å) threshold on the RMS of mobile Cartesian gradient components. The benchmark applies the sidecar's radius and bond-length checks at chunk boundaries, using the committed baseline geometry for rest lengths. It measures the optimizer and those chunk checks from a frozen input. Drag targets, post-release clamping and drift removal are outside this measurement.`,
    "",
    `Release uses the sidecar's ${releaseChunks} requests of ${chunk} iterations, stopping early on optimizer failure or a nonfinite endpoint. The release table classifies the final chunk. Tail stops on the first qualifying chunk boundary or when no further request fits within the cap of ${cap.toLocaleString("en-US")} actual iterations. The pinned L-BFGS solver performs one more iteration than requested at its iteration limit. The tables count actual iterations and the JSON also records requested iterations and the last completed ABC-FIRE iteration before Hybrid hands off to L-BFGS.`,
    "",
    `Wall times are single-threaded medians of ${timedRepeats} repeats per run after ${warmups} warm-up. The timer includes the chunk loop and benchmark accounting. UFF setup, initial probe, alignment and output are outside the timer. A fused UFF evaluation counts once as an energy evaluation and once as a force evaluation. Energy-increase counts include rejected line-search trials as well as any accepted chunk above the run's starting energy.`,
    "",
    `Energy differences are ABC-FIRE minus Hybrid in kJ/mol. Absolute differences of ${tieKjMol} kJ/mol or less count as ties. F/E gives force and energy evaluations. Stereo checks compare oriented geometry witnesses for the 2-butanol and 2-butene inputs at the start, at each accepted chunk, and after each optimizer step in the warm-up replay. The graph audit checks ordered atoms, elements, charges and bond endpoints and orders. Coordinates do not infer new bonds.`,
  ];
  for (const [regime, { rows, tally, stats, exceptions, hybridOnly, handoffRange }] of Object.entries(regimes)) {
    text.push("", `## ${titles[regime]}`, "",
      "| Molecule / Kekulé / start | ΔE (kJ/mol) | FIRE iterations | FIRE F/E | FIRE ms | FIRE status | Hybrid iterations | Hybrid F/E | Hybrid ms | Hybrid status |",
      "| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |",
      tableBody(rows), "",
      `ABC-FIRE reached the lower final energy in ${tally.lowerFire} pairs, Hybrid in ${tally.lowerHybrid}, with ${tally.ties} ties and ${tally.uncomparable} pairs without comparable energies.`,
      "",
      "| Method | Converged at exit | Capped | Failed | NaN | Reached RMS threshold at any boundary | Median / worst iterations | Median / worst ms | Evaluated / optimizer step / accepted chunk / final above run start | Handoffs |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const [method, s] of Object.entries(stats)) {
      text.push(`| ${labels[method]} | ${s.converged} | ${s.capped} | ${s.failed} | ${s.nonfinite} | ${s.reachedRms} | ${s.medianIterations} / ${s.worstIterations} | ${format(s.medianWallMs)} / ${format(s.worstWallMs)} | ${s.everAboveStart} / ${s.optimizerStepAboveStart} / ${s.acceptedChunkAboveRunStart} / ${s.endedAboveStart} | ${s.handoffs} |`);
    }
    text.push("", "The status columns identify all cap exits and failures by start.");
    if (handoffRange) text.push(`Hybrid handed off after ${handoffRange.join("–")} ABC-FIRE iterations.`);
    if (hybridOnly.length) {
      text.push(`Hybrid alone met the RMS threshold at exit on ${hybridOnly.join(", ")}.`);
    }
    if (regime === "tail") {
      for (const row of rows) {
        for (const method of Object.keys(labels)) {
          const run = row[method];
          if (run.status === "capped") {
            text.push(`${labels[method]} capped on ${row.label} at ${run.iterations.toLocaleString("en-US")} iterations and ${format(run.mobileGradientRmsKjMolAngstrom, 5)} kJ/(mol·Å) RMS.`);
          }
        }
      }
    }
    text.push("");
    const describe = (key) => Object.entries(exceptions).flatMap(([method, values]) =>
      values[key].map((label) => `${labels[method]} on ${label}`)).join(", ") || "None";
    const alkene = rows.filter((r) => r.witnessKind === "alkene");
    const changedInBoth = alkene.filter((r) => r.fire.stereo.endpointChanged && r.hybrid.stereo.endpointChanged);
    const tetrahedral = rows.filter((r) => r.witnessKind === "tetrahedral");
    const tetrahedralChanges = tetrahedral.flatMap((r) =>
      Object.keys(labels).filter((method) => r[method].stepTrace.stereoEvents.length)
        .map((method) => `${labels[method]} on ${r.label}`));
    if (changedInBoth.length) {
      const witnesses = changedInBoth.flatMap((r) => [r.fire.stereo.endpointWitness, r.hybrid.stereo.endpointWitness]);
      text.push(`Both methods crossed the perpendicular alkene witness and stayed on its opposite side at exit on ${changedInBoth.map((r) => r.label).join(", ")}. Endpoint projected cosines ranged from ${format(Math.min(...witnesses), 3)} to ${format(Math.max(...witnesses), 3)}.`, "");
    }
    text.push(
      `- Failed or NaN exits. ${describe("failures")}.`,
      `- Runs with nonfinite energy evaluations. ${describe("transientNonfinite")}.`,
      `- Tetrahedral witness changes at internal optimizer steps. ${tetrahedralChanges.join(", ") || "None"}.`,
      `- Stereo changes or degeneracies at accepted chunk boundaries. ${describe("stereoChanges")}.`,
      `- Stereo changes or degeneracies at internal optimizer steps. ${describe("stepStereoChanges")}.`,
      `- Connectivity or graph changes. ${describe("graphChanges")}.`,
      `- Geometry guard rejections. ${describe("guardRejections")}.`);
  }
  return text.join("\n") + "\n";
}

function main() {
  const { values } = parseArgs({ options: {
    avogadrolibs: { type: "string" }, eigen: { type: "string" }, "build-dir": { type: "string" },
  } });
  const source = sourceDirectory(values.avogadrolibs ?? process.env.AVOGADROLIBS_SOURCE,
    "--avogadrolibs", ["avogadro", "calc", "energyoptimizer.cpp"]);
  const eigen = sourceDirectory(values.eigen ?? process.env.EIGEN_SOURCE, "--eigen", ["Eigen", "Core"]);
  const git = (...args) => run("git", ["--no-optional-locks", "-C", source, ...args]).trim();
  const upstreamCommit = git("rev-parse", "HEAD");
  if (realpathSync(git("rev-parse", "--show-toplevel")) !== source || upstreamCommit !== pin ||
      git("status", "--porcelain", "--untracked-files=no")) {
    throw new Error(`Use an Avogadrolibs checkout of ${pin} with no tracked modifications.`);
  }
  const inventory = readFileSync(join(toolDir, "inventory.json"));
  const { cases: frozen, exclusions } = freezeInputs(JSON.parse(inventory));
  const frozenStartsSha256 = sha256(JSON.stringify(frozen));
  const buildDir = values["build-dir"] ? resolve(values["build-dir"]) : mkdtempSync(join(tmpdir(), "uff-optimizer-"));
  try {
    outsideSources(buildDir, [source, eigen]);
    const { executable, build } = buildBenchmark(source, eigen, buildDir);
    const execute = (args, options) => JSON.parse(run(executable, args, { env: threadEnv, ...options }));
    const { eigenVersion, ...settings } = execute(["--settings"]);
    const measuredAtUtc = new Date().toISOString();
    const cases = frozen.map(({ starts, ...graph }) => {
      console.error(`Measuring ${graph.molecule}${graph.kekule ? ` (${graph.kekule})` : ""}`);
      return { ...graph, starts: execute([], { input: JSON.stringify({ ...graph, starts }) }) };
    });
    const regimes = Object.fromEntries(["release", "tail"].map((id) => [id, summarize(cases, id)]));
    const provenance = {
      upstreamCommit, eigenVersion, scriptVersion, measuredAtUtc, build,
      machine: { cpu: cpus()[0].model, arch: machine(), platform: platform(), kernel: release(),
        osVersion: version(), node: process.version },
      eigenMacrosSha256: sha256(readFileSync(join(eigen, "Eigen", "src", "Core", "util", "Macros.h"))),
      inventorySha256: sha256(inventory), frozenStartsSha256,
      sourceFilesSha256: Object.fromEntries(["benchmark-optimizers.mjs", "optimizer-benchmark.cpp",
        "optimizer-observer.h", "reference-geometry.h", "CMakeLists.txt"].map((file) =>
        [file, sha256(readFileSync(join(toolDir, file)))])),
    };
    const data = {
      provenance,
      settings: {
        ...settings, perturbationGenerator: "xorshift32", perturbations, tieKjMol,
        mask: "All Cartesian coordinates mobile in all runs",
      },
      exclusions, cases,
      totals: Object.fromEntries(Object.entries(regimes).map(([id, { rows, ...stats }]) =>
        [id, { pairs: rows.length, ...stats }])),
    };
    const output = join(toolDir, "benchmarks");
    mkdirSync(output, { recursive: true });
    // Keep coordinate triples on one line without rounding any numerical results.
    const json = JSON.stringify(data, null, 2).replace(
      /\[\n +(-?[\d.e+\-]+),\n +(-?[\d.e+\-]+),\n +(-?[\d.e+\-]+)\n +\]/g, "[$1, $2, $3]");
    writeFileSync(join(output, "fire-vs-hybrid.json"), json + "\n");
    writeFileSync(join(output, "fire-vs-hybrid.md"), report(data, regimes));
  } finally {
    if (!values["build-dir"]) rmSync(buildDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`Optimizer benchmark failed. ${error.message}`);
  process.exitCode = 1;
}
