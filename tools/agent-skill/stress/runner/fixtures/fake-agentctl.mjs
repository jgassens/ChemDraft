#!/usr/bin/env node
if (process.argv[2] === 'usage') {
  process.stdout.write(JSON.stringify({ pools: [{ pool: 'claude', remaining_percent: Number(process.env.FAKE_USAGE_REMAINING ?? 100) }] }));
  process.exit(0);
}
process.exit(1);
