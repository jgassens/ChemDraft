#!/usr/bin/env node
import { parseArgs, run } from './runner.mjs';

try {
  const result = await run(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ cases: result.cases.length, totals: result.totals, exitCode: result.exitCode ?? 0 })}\n`);
  process.exitCode = result.exitCode ?? 0;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
