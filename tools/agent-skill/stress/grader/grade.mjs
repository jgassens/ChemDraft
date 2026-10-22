#!/usr/bin/env node
import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { args, readCases, saveJson, json, defaultCheckout, isMain, SCORING_VERSION } from './common.mjs';
import { createChemistry } from './chemistry.mjs';
import { readRun, extract } from './extract.mjs';
import { gradeCase, harnessResult } from './checks.mjs';
import { VISUAL_INSTRUCTIONS, writeVisualPack } from './visual-pack.mjs';

async function hasRunFolder(root, id) {
  try { await access(join(root, id)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function grade(options) {
  const allCases = await readCases(options.cases);
  if (options.ids) for (const id of options.ids) if (!allCases.some((item) => item.id === id)) throw new Error(`Unknown case id ${id}`);
  // A smoke/partial run is a normal grading input.  Do not manufacture harness
  // failures for cases the runner was never asked to execute.
  const cases = options.ids ? allCases.filter((item) => options.ids.includes(item.id)) :
    (await Promise.all(allCases.map(async (item) => (await hasRunFolder(options.runs, item.id)) ? item : null))).filter(Boolean);
  const output = join(options.runs, 'grade'), visual = join(options.runs, 'visual-pack');
  await mkdir(output, { recursive: true });
  await mkdir(visual, { recursive: true });
  await writeFile(join(visual, 'INSTRUCTIONS.md'), VISUAL_INSTRUCTIONS);
  const checkout = options.checkout ?? defaultCheckout;
  const chemistry = await createChemistry(checkout);
  let referenceLock;
  try { referenceLock = await json(join(checkout, 'tools', 'agent-skill', 'stress', 'references.lock.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const results = [];
  for (const testCase of cases) {
    const scratch = join(output, '.scratch', testCase.id);
    let result, run;
    try {
      run = await readRun(join(options.runs, testCase.id));
      if (run.meta.status !== 'complete') result = harnessResult(testCase, `Runner status: ${run.meta.status ?? 'missing'}`);
      else {
        const extracted = await extract(run, chemistry, scratch);
        // Missing artifacts are a harness problem, not evidence of wrong chemistry.
        if (extracted.errors.some((message) => /Retained run file is missing or ambiguous/.test(message))) {
          result = harnessResult(testCase, extracted.errors.join('; '));
        } else result = await gradeCase(testCase, run, extracted, chemistry, referenceLock);
      }
    } catch (error) { result = harnessResult(testCase, error.stack ?? error.message); }
    try {
      if (run) result.visual_pack = await writeVisualPack(visual, testCase, run, chemistry);
    } catch (error) { result = harnessResult(testCase, `Visual pack failed: ${error.message}`); }
    await rm(scratch, { recursive: true, force: true });
    result.agent = run?.meta.agent ?? null;
    results.push(result);
    await saveJson(join(output, `${testCase.id}.auto.json`), result);
    process.stderr.write(`${testCase.id}: ${result.status === 'harness' ? 'harness' : result.auto}\n`);
  }
  const agents = [...new Set(results.map((result) => result.agent))];
  const aggregate = { scoring_version: SCORING_VERSION, cases_version: (await json(options.cases)).version ?? null,
    agent: agents.length === 1 ? agents[0] : null, agents, engine_loads: chemistry.engineLoads, cases: results };
  await saveJson(join(output, 'auto.json'), aggregate);
  await saveJson(join(visual, 'manifest.json'), { agent: aggregate.agent, agents, cases: results.map((result) => ({ id: result.id, agent: result.agent })) });
  await rm(join(output, '.scratch'), { recursive: true, force: true });
  return aggregate;
}

if (isMain(import.meta.url)) {
  grade(args(process.argv.slice(2), ['cases', 'runs', 'checkout', 'ids'])).catch((error) => {
    process.stderr.write(`Grader failed: ${error.message}\n`); process.exitCode = 1;
  });
}
