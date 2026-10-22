import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { hashTree, inspectStream, listFiles, parseStream, saveToolAssets } from './stream.mjs';

const defaultCheckout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DEFAULTS = { split: 'all', model: 'claude-sonnet-5-5', timeoutMin: 15, maxTurns: 60, concurrency: 2 };
const PERMITTED_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Skill,mcp__chemdraft__*';

// Verified with `claude --help` on 2026-10-22. --bare skips user hooks/plugins;
// project settings are the isolated work folder, where the copied skill resides.
export function claudeArgs(options, prompt, mcpPath) {
  return ['-p', prompt, '--model', options.model, '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpPath, '--strict-mcp-config', '--setting-sources', 'project', '--bare',
    '--max-turns', String(options.maxTurns), '--dangerously-skip-permissions',
    '--permission-mode', 'bypassPermissions', '--permission-prompts', 'none',
    '--allowedTools', PERMITTED_TOOLS];
}

export function parseArgs(argv) {
  const result = { ...DEFAULTS, ids: null, force: false, dryRun: false, checkout: defaultCheckout };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') result.force = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--agent') {
      const value = argv[++i];
      if (value === 'codex') throw new Error('--agent codex is not implemented: its settings and tool isolation contract differs from Claude.');
      throw new Error(`Unsupported agent: ${value}`);
    } else if (['--cases', '--out', '--ids', '--split', '--model', '--timeout-min', '--max-turns', '--concurrency', '--checkout'].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      const key = { '--timeout-min': 'timeoutMin', '--max-turns': 'maxTurns', '--checkout': 'checkout' }[arg] ?? arg.slice(2);
      result[key] = ['timeoutMin', 'maxTurns', 'concurrency'].includes(key) ? Number(value) : value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!result.cases || !result.out) throw new Error('Usage: run.mjs --cases <cases.json> --out <dir> [options]');
  if (!['dev', 'heldout', 'all'].includes(result.split)) throw new Error('--split must be dev, heldout, or all');
  if (![result.timeoutMin, result.maxTurns, result.concurrency].every((value) => Number.isFinite(value) && value > 0)) throw new Error('Timeout, turns, and concurrency must be positive numbers');
  result.ids = result.ids ? result.ids.split(',').map((id) => id.trim()).filter(Boolean) : null;
  return result;
}

function isInside(repo, out) {
  const relative = path.relative(repo, out);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function command(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let child;
    try {
      child = spawn(command, args, { cwd: options.cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { resolve({ exitCode: null, stdout, stderr: error.message, error }); return; }
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    let timedOut = false;
    let settled = false;
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
      setTimeout(() => { if (!settled && process.platform !== 'win32') try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1_000).unref();
    }, options.timeoutMs) : null;
    child.on('error', (error) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, error, timedOut }); });
    child.on('close', (exitCode) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve({ exitCode, stdout, stderr, timedOut }); });
  });
}

async function usageAllowsStart(agentctl, stderr) {
  const checked = await command(agentctl, ['usage', '--json']);
  if (checked.exitCode !== 0) { stderr(`warning: could not read usage guard: ${checked.stderr || 'agentctl failed'}`); return true; }
  try {
    const data = JSON.parse(checked.stdout);
    const pool = data.pools?.find((item) => item.pool === 'claude');
    return !(typeof pool?.remaining_percent === 'number' && pool.remaining_percent < 15);
  } catch { stderr('warning: could not parse usage guard JSON'); return true; }
}

async function gitValue(checkout, args) {
  const value = await command('git', args, { cwd: checkout });
  return value.exitCode === 0 ? value.stdout.trim() : null;
}

async function copiedSkill(source, destination) {
  await cp(source, destination, { recursive: true, dereference: true, force: true });
  async function assertNoLinks(directory) {
    for (const entry of await (await import('node:fs/promises')).readdir(directory)) {
      const current = path.join(directory, entry);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Copied skill unexpectedly contains symlink: ${current}`);
      if (info.isDirectory()) await assertNoLinks(current);
    }
  }
  await assertNoLinks(destination);
}

async function writeMeta(caseDir, meta) { await writeFile(path.join(caseDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`); }

function assertCaseId(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Unsafe case id: ${id}`);
}

async function markHalted(caseItem, options, shared) {
  assertCaseId(caseItem.id);
  const caseDir = path.join(options.out, caseItem.id);
  await mkdir(caseDir, { recursive: true });
  const now = new Date().toISOString();
  const meta = { id: caseItem.id, status: 'halted-usage', exitCode: null, startedAt: now, endedAt: now, durationMs: 0,
    model: options.model, claudeVersion: shared.claudeVersion, skillSha256: null, checkoutHead: shared.checkoutHead,
    numTurns: 0, usage: null, total_cost_usd: null, mcpServers: [], tools: [], reason: 'usage' };
  await writeMeta(caseDir, meta);
  return meta;
}

async function runOne(caseItem, options, shared, stderr) {
  assertCaseId(caseItem.id);
  const caseDir = path.join(options.out, caseItem.id);
  const metaPath = path.join(caseDir, 'meta.json');
  if (!options.force && existsSync(metaPath)) {
    try { const old = JSON.parse(await readFile(metaPath, 'utf8')); if (old.status === 'complete') return { meta: old, skipped: true }; } catch { /* rerun corrupt metadata */ }
  }
  if (!(await usageAllowsStart(shared.agentctl, stderr))) return { halted: true, meta: await markHalted(caseItem, options, shared) };
  // A rerun must not retain visual artifacts or reports from a prior attempt.
  await rm(caseDir, { recursive: true, force: true });
  await mkdir(caseDir, { recursive: true });
  const work = path.join(caseDir, 'work');
  await rm(work, { recursive: true, force: true });
  await mkdir(path.join(work, '.claude', 'skills'), { recursive: true });
  const copied = path.join(work, '.claude', 'skills', 'chemdraft');
  await copiedSkill(path.join(options.checkout, 'skills', 'chemdraft'), copied);
  const mcp = { mcpServers: { chemdraft: { command: 'pnpm', args: ['-s', '--dir', options.checkout, 'chemdraft-mcp'] } } };
  const mcpPath = path.join(caseDir, 'mcp.json');
  await writeFile(mcpPath, `${JSON.stringify(mcp)}\n`);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const executed = await command(shared.claude, claudeArgs(options, caseItem.prompt, mcpPath), { cwd: work, timeoutMs: options.timeoutMin * 60_000 });
  const endedAt = new Date().toISOString();
  await writeFile(path.join(caseDir, 'transcript.jsonl'), executed.stdout);
  const parsed = inspectStream(parseStream(executed.stdout));
  await writeFile(path.join(caseDir, 'final.md'), parsed.final);
  await writeFile(path.join(caseDir, 'tool-calls.json'), `${JSON.stringify(parsed.toolCalls, null, 2)}\n`);
  await saveToolAssets(parseStream(executed.stdout), path.join(caseDir, 'images'));
  await writeFile(path.join(caseDir, 'files.json'), `${JSON.stringify(await listFiles(work), null, 2)}\n`);
  let status = executed.timedOut ? 'timeout' : executed.exitCode === 0 ? 'complete' : 'error';
  let reason = executed.timedOut ? 'timeout' : executed.exitCode === 0 ? undefined : executed.stderr || 'claude exited unsuccessfully';
  if (status !== 'timeout' && !parsed.isolated) { status = 'error'; reason = 'isolation'; }
  const meta = { id: caseItem.id, status, exitCode: executed.exitCode, startedAt, endedAt, durationMs: Date.now() - started,
    model: options.model, claudeVersion: shared.claudeVersion, skillSha256: await hashTree(copied), checkoutHead: shared.checkoutHead,
    numTurns: parsed.numTurns, usage: parsed.result?.usage ?? null, total_cost_usd: parsed.result?.total_cost_usd ?? null,
    mcpServers: parsed.init?.mcp_servers ?? parsed.init?.mcpServers ?? [], tools: parsed.init?.tools ?? [], ...(reason ? { reason } : {}) };
  await writeMeta(caseDir, meta);
  return { meta, stderr: executed.stderr };
}

export async function run(options, io = {}) {
  const stderr = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  options.checkout = await realpath(path.resolve(options.checkout));
  options.out = path.resolve(options.out);
  if (isInside(options.checkout, options.out)) throw new Error('--out must be outside the repository');
  const casesData = JSON.parse(await readFile(options.cases, 'utf8'));
  let cases = casesData.cases.filter((item) => options.split === 'all' || item.split === options.split);
  if (options.ids) {
    const found = new Set(cases.map((item) => item.id));
    for (const id of options.ids) if (!found.has(id)) throw new Error(`Unknown or excluded case id: ${id}`);
    cases = cases.filter((item) => options.ids.includes(item.id));
  }
  const commandPreview = (item) => ({ id: item.id, command: process.env.CHEMDRAFT_STRESS_CLAUDE_BIN || 'claude', args: claudeArgs(options, item.prompt, path.join(options.out, item.id, 'mcp.json')) });
  if (options.dryRun) {
    for (const item of cases) stderr(`dry-run ${JSON.stringify(commandPreview(item))}`);
    return { arguments: options, cases: cases.map((item) => ({ id: item.id, status: 'dry-run' })), totals: { durationMs: 0, total_cost_usd: 0 } };
  }
  await mkdir(options.out, { recursive: true });
  const shared = { claude: process.env.CHEMDRAFT_STRESS_CLAUDE_BIN || 'claude', agentctl: process.env.CHEMDRAFT_STRESS_AGENTCTL_BIN || 'agentctl',
    claudeVersion: null, checkoutHead: await gitValue(options.checkout, ['rev-parse', 'HEAD']) };
  const version = await command(shared.claude, ['--version']);
  shared.claudeVersion = version.exitCode === 0 ? version.stdout.trim() : null;
  const results = new Array(cases.length); let next = 0; let halted = false;
  async function worker() {
    while (!halted) {
      const index = next++;
      if (index >= cases.length) return;
      stderr(`running ${cases[index].id}`);
      const outcome = await runOne(cases[index], options, shared, stderr);
      results[index] = outcome.meta;
      if (outcome.stderr) stderr(`${cases[index].id}: ${outcome.stderr.trim()}`);
      if (outcome.halted) { halted = true; return; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, cases.length) }, worker));
  for (let index = 0; index < cases.length; index++) if (!results[index]) results[index] = await markHalted(cases[index], options, shared);
  const summary = { arguments: { ...options, cases: path.resolve(options.cases) }, cases: results.map((meta) => ({ id: meta.id, status: meta.status })),
    totals: { durationMs: results.reduce((sum, meta) => sum + (meta.durationMs || 0), 0), total_cost_usd: results.reduce((sum, meta) => sum + (Number(meta.total_cost_usd) || 0), 0) } };
  await writeFile(path.join(options.out, 'run.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { ...summary, exitCode: halted ? 3 : 0 };
}
