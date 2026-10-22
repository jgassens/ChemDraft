#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { args, readCases, saveJson, json, defaultCheckout, isMain, SCORING_VERSION } from './common.mjs';
import { createChemistry } from './chemistry.mjs';
import { readRun, extract } from './extract.mjs';
import { gradeCase, harnessResult } from './checks.mjs';
import { VISUAL_INSTRUCTIONS, writeVisualPack } from './visual-pack.mjs';

export async function grade(options) {
  const allCases = await readCases(options.cases);
  if (options.ids) for (const id of options.ids) if (!allCases.some((item) => item.id === id)) throw new Error(`Unknown case id ${id}`);
  const cases = options.ids ? allCases.filter((item) => options.ids.includes(item.id)) : allCases;
  const output = join(options.runs, 'grade'), visual = join(options.runs, 'visual-pack');
  await mkdir(output, { recursive: true });
  await mkdir(visual, { recursive: true });
  await writeFile(join(visual, 'INSTRUCTIONS.md'), VISUAL_INSTRUCTIONS);
  const chemistry = await createChemistry(options.checkout ?? defaultCheckout);
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
        } else result = await gradeCase(testCase, run, extracted, chemistry);
      }
    } catch (error) { result = harnessResult(testCase, error.stack ?? error.message); }
    try {
      if (run) result.visual_pack = await writeVisualPack(visual, testCase, run, chemistry);
    } catch (error) { result = harnessResult(testCase, `Visual pack failed: ${error.message}`); }
    await rm(scratch, { recursive: true, force: true });
    results.push(result);
    await saveJson(join(output, `${testCase.id}.auto.json`), result);
    process.stderr.write(`${testCase.id}: ${result.status === 'harness' ? 'harness' : result.auto}\n`);
  }
  const aggregate = { scoring_version: SCORING_VERSION, cases_version: (await json(options.cases)).version ?? null,
    engine_loads: chemistry.engineLoads, cases: results };
  await saveJson(join(output, 'auto.json'), aggregate);
  await rm(join(output, '.scratch'), { recursive: true, force: true });
  return aggregate;
}

if (isMain(import.meta.url)) {
  grade(args(process.argv.slice(2), ['cases', 'runs', 'checkout', 'ids'])).catch((error) => {
    process.stderr.write(`Grader failed: ${error.message}\n`); process.exitCode = 1;
  });
}
