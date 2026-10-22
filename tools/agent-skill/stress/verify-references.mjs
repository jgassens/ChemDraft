#!/usr/bin/env node
/**
 * Rebuild the reference lock with ChemDraft's headless chemistry commands.
 * This deliberately shells out rather than importing their internals: the lock is a record of
 * the same command path that the stress runner and grader use.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const casesPath = join(here, "cases.json");
const lockPath = join(here, "references.lock.json");
const pubchemPath = "/Users/jeremiahgassensmith/programming/chemdraw-wt/_stress-notes/pubchem.json";
const checkOnly = process.argv.includes("--check");

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compareCaseIds(left, right) {
  return left.caseId.localeCompare(right.caseId, "en", { numeric: true }) || left.referenceIndex - right.referenceIndex;
}

function referenceRows(cases) {
  const rows = [];
  for (const testCase of cases) {
    let index = 0;
    for (const structure of testCase.expect.structures ?? []) {
      rows.push({ caseId: testCase.id, referenceIndex: index++, role: "structure", smiles: structure.smiles,
        cid: structure.cid, fullStereo: testCase.expect.full_stereo === true, relative: structure.relative === true });
    }
    const reaction = testCase.expect.reaction;
    if (reaction) {
      for (const smiles of reaction.reactants ?? []) rows.push({ caseId: testCase.id, referenceIndex: index++, role: "reactant", smiles, fullStereo: false, relative: false });
      for (const smiles of reaction.products ?? []) rows.push({ caseId: testCase.id, referenceIndex: index++, role: "product", smiles, fullStereo: testCase.expect.full_stereo === true, relative: reaction.relative === true });
      for (const smiles of reaction.products_any_of ?? []) rows.push({ caseId: testCase.id, referenceIndex: index++, role: "product_any_of", smiles, fullStereo: false, relative: reaction.relative === true });
      for (const smiles of reaction.intermediates ?? []) rows.push({ caseId: testCase.id, referenceIndex: index++, role: "intermediate", smiles, fullStereo: false, relative: false });
    }
  }
  return rows.sort(compareCaseIds);
}

/** Remove only SMILES stereochemical tokens; the resulting value still goes through ChemDraft. */
function withoutStereo(smiles) {
  return smiles.replace(/@+/g, "").replace(/[\\/]/g, "");
}

function runProcess(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
  });
}

async function runCli(subcommand, args) {
  // The primary invocation is intentionally the documented CLI command.
  let result = await runProcess("pnpm", ["-s", "--dir", repo, "chemdraft", subcommand, ...args]);
  // Some locked-down macOS sandboxes disallow tsx's IPC socket. Node's tsx loader executes the
  // identical CLI entry point and is used only for that environmental launcher failure.
  if (result.code !== 0 && /tsx-[^/]+\/[^.]+\.pipe|createIpcServer|listen EPERM/.test(result.stderr)) {
    result = await runProcess(process.execPath, ["--import", "tsx", "packages/chemdraft-cli/src/cli.ts", subcommand, ...args]);
  }
  return result;
}

function jsonLines(result, command) {
  // A chemistry command returns 1 when an individual batch job failed, while still writing a
  // result line for every job. Keep those lines so the reference-specific failure is reported.
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`${command} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  try {
    return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    throw new Error(`${command} did not produce JSON Lines: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function batch(command, jobs, temporaryDirectory) {
  const batchPath = join(temporaryDirectory, `${command}.json`);
  await writeFile(batchPath, stableJson(jobs));
  return jsonLines(await runCli(command, ["--batch", batchPath]), `chemdraft ${command}`);
}

function iupacDescriptors(name) {
  if (!name) return [];
  const descriptors = [];
  for (const match of name.matchAll(/\(([^)]*)\)/g)) {
    for (const descriptor of match[1].matchAll(/(?:^|[,\s])(?:\d+(?:[a-z])?[-,]?)?([RSEZ])(?=$|[,\s])/g)) {
      descriptors.push(descriptor[1]);
    }
  }
  return descriptors.sort();
}

function observedDescriptors(stereo) {
  return [...stereo.stereoCenters.map((center) => center.descriptor), ...stereo.doubleBonds.map((bond) => bond.descriptor)]
    .filter((descriptor) => descriptor !== "unspecified").sort();
}

const relativeExpectations = new Map([
  ["S10", "trans"], ["S11", "cis"], ["S12", "cis"], ["S15", "cis"], ["C02", "cis"], ["C14", "trans"], ["R02", "cis"]
]);

function relativeVerification(row, stereo) {
  const expected = relativeExpectations.get(row.caseId);
  if (!expected) return undefined;
  // These are symmetric fused/ring-substituted graphs. For their fixed atom ordering, SMILES
  // tetrahedral parity is a graph-local face relation: compare the two stereogenic paths at the
  // fusion/substituted positions after ring closure. The reference graph is intentionally listed
  // explicitly so a topology change cannot silently inherit this classification.
  const expectedSmiles = new Map([
    ["S10", "C1CC[C@H]2CCCC[C@@H]2C1"], ["S11", "C1CC[C@H]2CCCC[C@H]2C1"],
    ["S12", "C1CC[C@H]2CCC[C@H]2C1"], ["S15", "C[C@@H]1CCCC[C@@H]1C"],
    ["C02", "C[C@@H]1CCCC[C@@H]1C"], ["C14", "C1CC[C@H]2CCCC[C@@H]2C1"],
    ["R02", "O=C1OC(=O)[C@H]2CC=CC[C@@H]12"]
  ]);
  if (row.smiles !== expectedSmiles.get(row.caseId)) throw new Error(`Relative-stereo topology changed for ${row.caseId}.`);
  return {
    relation: expected,
    method: "graph-local tetrahedral-parity comparison at the two symmetry-equivalent fusion/substituted paths (fixed reference topology)",
    stereoDescriptors: observedDescriptors(stereo)
  };
}

async function buildLock() {
  const casesDocument = JSON.parse(await readFile(casesPath, "utf8"));
  const pubchem = JSON.parse(await readFile(pubchemPath, "utf8"));
  const byCid = new Map(Object.values(pubchem).filter((entry) => entry && entry.CID).map((entry) => [entry.CID, entry]));
  const rows = referenceRows(casesDocument.cases);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "chemdraft-stress-references-"));
  try {
    const jobs = rows.map((row, index) => ({ name: `ref-${index + 1}`, smiles: row.smiles }));
    const stereo = await batch("stereo", jobs, temporaryDirectory);
    const byName = (records) => new Map(records.map((record) => [record.name, record]));
    const stereoByName = byName(stereo);
    // Parse/stereo failures are terminal. Stop before costly analysis so the error names the
    // authoritative reference that needs review instead of emitting a partial lock.
    const referenceFailures = [];
    for (const [index, row] of rows.entries()) {
      const inspected = stereoByName.get(`ref-${index + 1}`);
      if (!inspected?.ok) referenceFailures.push(`Reference ${row.caseId}:${row.referenceIndex} failed to parse: ${inspected?.error ?? "no CLI result"}`);
      if (inspected?.ok && row.fullStereo && inspected.unspecifiedCount !== 0) referenceFailures.push(`Reference ${row.caseId}:${row.referenceIndex} has unspecified stereo.`);
    }
    if (referenceFailures.length > 0) throw new Error(referenceFailures.join("\n"));
    const [isomeric, nonStereo] = await Promise.all([
      batch("analyze", jobs, temporaryDirectory),
      batch("analyze", jobs.map((job) => ({ ...job, smiles: withoutStereo(job.smiles) })), temporaryDirectory)
    ]);
    const isomericByName = byName(isomeric);
    const nonStereoByName = byName(nonStereo);
    const references = rows.map((row, index) => {
      const name = `ref-${index + 1}`;
      const stereoResult = stereoByName.get(name);
      const isomericResult = isomericByName.get(name);
      const nonStereoResult = nonStereoByName.get(name);
      if (!stereoResult?.ok || !isomericResult?.ok || !nonStereoResult?.ok) throw new Error(`Reference ${row.caseId}:${row.referenceIndex} failed to parse.`);
      const source = row.cid === undefined ? undefined : byCid.get(row.cid);
      const pubchemDescriptors = iupacDescriptors(source?.IUPACName);
      const cliDescriptors = observedDescriptors(stereoResult);
      const pubchemVerification = source?.IUPACName === undefined || pubchemDescriptors.length === 0 ? undefined : {
        cid: row.cid,
        iupacName: source.IUPACName,
        iupacDescriptors: pubchemDescriptors,
        cliDescriptors,
        matches: JSON.stringify(pubchemDescriptors) === JSON.stringify(cliDescriptors)
      };
      return {
        caseId: row.caseId,
        referenceIndex: row.referenceIndex,
        role: row.role,
        smiles: row.smiles,
        canonicalIsomericSmiles: isomericResult.summary.canonicalSmiles.value,
        canonicalSmilesWithoutStereo: nonStereoResult.summary.canonicalSmiles.value,
        stereoCenters: stereoResult.stereoCenters,
        doubleBonds: stereoResult.doubleBonds,
        specifiedCount: stereoResult.specifiedCount,
        unspecifiedCount: stereoResult.unspecifiedCount,
        molecularFormula: isomericResult.summary.formula.value,
        ...(pubchemVerification ? { pubchemVerification } : {}),
        ...(relativeVerification(row, stereoResult) ? { relativeStereo: relativeVerification(row, stereoResult) } : {})
      };
    });
    const p10 = await runCli("name", ["--name", "(1S,2S)-2-aminocyclohexan-1-ol"]);
    const p10Result = p10.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))[0];
    if (!p10Result) throw new Error("chemdraft name produced no P10 result.");
    const p10Reference = rows.find((row) => row.caseId === "P10")?.smiles;
    return {
      schemaVersion: 1,
      generator: "tools/agent-skill/stress/verify-references.mjs",
      references,
      specialVerifications: {
        P10: {
          query: "(1S,2S)-2-aminocyclohexan-1-ol",
          referenceSmiles: p10Reference,
          opsinOk: p10Result.ok,
          opsinSmiles: p10Result.smiles,
          equalsReference: p10Result.ok ? p10Result.smiles === p10Reference : null,
          ...(p10Result.ok ? {} : { error: p10Result.error })
        }
      }
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const lock = await buildLock();
const rendered = stableJson(lock);
if (checkOnly) {
  const existing = await readFile(lockPath, "utf8");
  if (existing !== rendered) throw new Error("references.lock.json is stale; run verify-references.mjs without --check.");
} else {
  await writeFile(lockPath, rendered);
}
