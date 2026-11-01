#!/usr/bin/env node
if (process.argv[2] === 'usage') {
  if (process.env.FAKE_USAGE_ERROR) { process.stderr.write('usage unavailable'); process.exit(1); }
  if (process.env.FAKE_USAGE_INVALID) { process.stdout.write('not JSON'); process.exit(0); }
  process.stdout.write(JSON.stringify({ pools: [
    { pool: 'claude', remaining_percent: Number(process.env.FAKE_USAGE_REMAINING ?? 100) },
    ...(process.env.FAKE_USAGE_NO_OPENAI ? [] : [{ pool: 'openai', remaining_percent: Number(process.env.FAKE_OPENAI_REMAINING ?? 100) }]),
  ] }));
  process.exit(0);
}
process.exit(1);
