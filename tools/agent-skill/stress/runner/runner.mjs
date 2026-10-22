import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { hashTree, inspectStream, listFiles, parseStream, saveToolAssets } from './stream.mjs';
import { inspectCodexStream, reportedCodexModel } from './codex-stream.mjs';

const defaultCheckout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DEFAULTS = { agent: 'claude', split: 'all', model: null, timeoutMin: 15, maxTurns: 60, concurrency: 2 };
const PERMITTED_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Skill,mcp__chemdraft__*';

// Project settings are the isolated work folder, where the copied skill resides.
// Do not use --bare: normal OAuth sign-in and skill discovery must remain available.
export function claudeArgs(options, prompt, mcpPath) {
  return ['-p', prompt, '--model', options.model, '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpPath, '--strict-mcp-config', '--setting-sources', 'project',
    '--max-turns', String(options.maxTurns), '--dangerously-skip-permissions',
    '--permission-mode', 'bypassPermissions', '--permission-prompts', 'none',
    '--allowedTools', PERMITTED_TOOLS];
}

export function codexArgs(prompt) {
  return ['exec', '--json', '--skip-git-repo-check', '--', prompt];
}

function codexConfig(options, work) {
  // JSON string quoting is also valid TOML basic-string quoting for these paths.
  return `${options.model ? `model = ${JSON.stringify(options.model)}\n` : ''}approval_policy = "never"\nsandbox_mode = "workspace-write"\n\n[features]\nplugins = false\n\n[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = [${JSON.stringify(work)}]\n\n[mcp_servers.chemdraft]\ncommand = "pnpm"\nargs = ${JSON.stringify(['-s', '--dir', options.checkout, 'chemdraft-mcp'])}\ndefault_tools_approval_mode = "approve"\n`;
}

export function parseArgs(argv) {
  const result = { ...DEFAULTS, ids: null, force: false, dryRun: false, skipPreflight: false, checkout: defaultCheckout };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') result.force = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--skip-preflight') result.skipPreflight = true;
    else if (arg === '--agent') {
      const value = argv[++i];
      if (!['claude', 'codex'].includes(value)) throw new Error(`Unsupported agent: ${value}`);
      result.agent = value;
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
  if (result.agent === 'claude') result.model ??= 'claude-sonnet-5-5';
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
      // Node fixtures work on Windows too, without relying on executable shebangs.
      child = spawn(command.endsWith('.mjs') ? process.execPath : command, command.endsWith('.mjs') ? [command, ...args] : args,
        { cwd: options.cwd, env: options.env ?? process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
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

async function usageAllowsStart(agentctl, agent, stderr) {
  const checked = await command(agentctl, ['usage', '--json']);
  if (checked.exitCode !== 0) { stderr(`warning: could not read usage guard: ${checked.stderr || 'agentctl failed'}`); return agent !== 'codex'; }
  try {
    const data = JSON.parse(checked.stdout);
    const pool = data.pools?.find((item) => item.pool === (agent === 'codex' ? 'openai' : 'claude'));
    if (agent === 'codex' && !Number.isFinite(pool?.remaining_percent)) { stderr('warning: OpenAI usage pool is missing or invalid; refusing to start Codex'); return false; }
    return !(typeof pool?.remaining_percent === 'number' && pool.remaining_percent < 15);
  } catch { stderr('warning: could not parse usage guard JSON'); return agent !== 'codex'; }
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

function versionMeta(options, shared) {
  return { agent: options.agent, [options.agent === 'codex' ? 'codexVersion' : 'claudeVersion']: shared.agentVersion };
}

async function sessionModel(home) {
  const sessions = path.join(home, 'sessions');
  if (!existsSync(sessions)) return null;
  let model = null;
  for (const file of await listFiles(sessions)) {
    if (file.path.endsWith('.jsonl')) model = reportedCodexModel(parseStream(await readFile(path.join(sessions, file.path), 'utf8'))) ?? model;
  }
  return model;
}

async function assertNoAgentInstructions(directory) {
  for (const file of await listFiles(directory)) if (path.basename(file.path).toLowerCase() === 'agents.md') {
    throw new Error(`Isolated Codex folder must not contain AGENTS.md: ${file.path}`);
  }
}

function assertCaseId(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Unsafe case id: ${id}`);
}

function opsinJava(checkout) {
  return path.join(checkout, 'apps', 'desktop', 'src-tauri', 'resources', 'opsin', 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

function codexStderrHasMcpLeak(stderr) {
  // Codex/RMCP diagnostics include names such as `mcp.box.com`. Do not treat a
  // generic "MCP tool call" diagnostic as a server observation.
  const names = [
    ...stderr.matchAll(/\b(?:r?mcp)\.([A-Za-z0-9_-]+)/gi),
    ...stderr.matchAll(/\bMCP\s+server\s+(?:named\s+)?["'`]?([A-Za-z0-9_-]+)/gi),
  ].map((match) => match[1].toLowerCase());
  return names.some((name) => name !== 'chemdraft');
}

async function markHalted(caseItem, options, shared) {
  assertCaseId(caseItem.id);
  const caseDir = path.join(options.out, caseItem.id);
  await mkdir(caseDir, { recursive: true });
  const now = new Date().toISOString();
  const meta = { id: caseItem.id, status: 'halted-usage', exitCode: null, startedAt: now, endedAt: now, durationMs: 0,
    model: options.model, ...versionMeta(options, shared), skillSha256: null, checkoutHead: shared.checkoutHead,
    numTurns: 0, usage: null, total_cost_usd: null, mcpServers: [], tools: [], reason: 'usage' };
  await writeMeta(caseDir, meta);
  return meta;
}

async function runOne(caseItem, options, shared, stderr) {
  assertCaseId(caseItem.id);
  const caseDir = path.join(options.out, caseItem.id);
  const metaPath = path.join(caseDir, 'meta.json');
  if (!options.force && existsSync(metaPath)) {
    try {
      const old = JSON.parse(await readFile(metaPath, 'utf8'));
      if (old.status === 'complete' && (old.agent ?? 'claude') === options.agent) {
        const meta = { ...old, agent: options.agent };
        if (!old.agent) await writeMeta(caseDir, meta);
        return { meta, skipped: true };
      }
    } catch { /* rerun corrupt metadata */ }
  }
  if (!(await usageAllowsStart(shared.agentctl, options.agent, stderr))) return { halted: true, meta: await markHalted(caseItem, options, shared) };
  // A rerun must not retain visual artifacts or reports from a prior attempt.
  await rm(caseDir, { recursive: true, force: true });
  await mkdir(caseDir, { recursive: true });
  const work = path.join(caseDir, 'work');
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const codexHome = path.join(caseDir, 'codex-home');
  const copied = options.agent === 'codex' ? path.join(codexHome, 'skills', 'chemdraft') : path.join(work, '.claude', 'skills', 'chemdraft');
  await copiedSkill(path.join(options.checkout, 'skills', 'chemdraft'), copied);
  const mcp = { mcpServers: { chemdraft: { command: 'pnpm', args: ['-s', '--dir', options.checkout, 'chemdraft-mcp'] } } };
  const mcpPath = path.join(caseDir, 'mcp.json');
  const configPath = path.join(codexHome, 'config.toml');
  const config = codexConfig(options, work);
  if (options.agent === 'codex') {
    await cp(shared.codexAuth, path.join(codexHome, 'auth.json'), { dereference: true });
    await writeFile(configPath, config);
    await assertNoAgentInstructions(codexHome);
    await assertNoAgentInstructions(work);
  } else await writeFile(mcpPath, `${JSON.stringify(mcp)}\n`);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const executed = await command(shared.binary, options.agent === 'codex' ? codexArgs(caseItem.prompt) : claudeArgs(options, caseItem.prompt, mcpPath),
    { cwd: work, timeoutMs: options.timeoutMin * 60_000, env: options.agent === 'codex' ? { ...process.env, CODEX_HOME: codexHome } : process.env });
  const endedAt = new Date().toISOString();
  await writeFile(path.join(caseDir, 'transcript.jsonl'), executed.stdout);
  if (options.agent === 'codex') await writeFile(path.join(caseDir, 'stderr.log'), executed.stderr);
  const events = parseStream(executed.stdout);
  const parsed = options.agent === 'codex' ? inspectCodexStream(events) : inspectStream(events);
  let isolationLeak = false;
  if (options.agent === 'codex') {
    parsed.model ??= await sessionModel(codexHome);
    // The generated config is the evidence that only ChemDraft is configured and
    // bundled plugins are disabled. Runtime evidence must not name another server.
    const configUnchanged = await readFile(configPath, 'utf8') === config;
    const pluginFolderCreated = existsSync(path.join(codexHome, 'plugins'));
    const eventMcpLeak = (parsed.mcpServers ?? []).some(({ name }) => name !== 'chemdraft');
    isolationLeak = pluginFolderCreated || eventMcpLeak || codexStderrHasMcpLeak(executed.stderr);
    parsed.isolated &&= configUnchanged && !isolationLeak;
  }
  await writeFile(path.join(caseDir, 'final.md'), parsed.final);
  await writeFile(path.join(caseDir, 'tool-calls.json'), `${JSON.stringify(parsed.toolCalls, null, 2)}\n`);
  await saveToolAssets(parsed.assetEvents ?? events, path.join(caseDir, 'images'));
  await writeFile(path.join(caseDir, 'files.json'), `${JSON.stringify(await listFiles(work), null, 2)}\n`);
  let status = executed.timedOut ? 'timeout' : executed.exitCode === 0 && !parsed.failed ? 'complete' : 'error';
  let reason = executed.timedOut ? 'timeout' : status === 'complete' ? undefined : executed.stderr || `${options.agent} exited unsuccessfully`;
  if (isolationLeak) { status = 'error'; reason = 'isolation-leak'; }
  else if (status !== 'timeout' && !parsed.isolated) { status = 'error'; reason = 'isolation'; }
  const meta = { id: caseItem.id, status, exitCode: executed.exitCode, startedAt, endedAt, durationMs: Date.now() - started,
    model: options.agent === 'codex' ? parsed.model : options.model, ...versionMeta(options, shared), skillSha256: await hashTree(copied), checkoutHead: shared.checkoutHead,
    numTurns: parsed.numTurns, usage: parsed.usage ?? parsed.result?.usage ?? null, total_cost_usd: parsed.result?.total_cost_usd ?? null,
    mcpServers: parsed.mcpServers ?? parsed.init?.mcp_servers ?? parsed.init?.mcpServers ?? [], tools: parsed.tools ?? parsed.init?.tools ?? [],
    isolation: { verified: parsed.isolated, ...(options.agent === 'codex' ? { configuredMcpServers: ['chemdraft'], skillPath: copied } : {}) }, ...(reason ? { reason } : {}) };
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
  const binary = options.agent === 'codex' ? process.env.CHEMDRAFT_STRESS_CODEX_BIN || 'codex' : process.env.CHEMDRAFT_STRESS_CLAUDE_BIN || 'claude';
  const commandPreview = (item) => ({ id: item.id, command: binary, args: options.agent === 'codex' ? codexArgs(item.prompt) : claudeArgs(options, item.prompt, path.join(options.out, item.id, 'mcp.json')) });
  if (options.dryRun) {
    for (const item of cases) stderr(`dry-run ${JSON.stringify(commandPreview(item))}`);
    return { agent: options.agent, arguments: options, cases: cases.map((item) => ({ id: item.id, status: 'dry-run' })), totals: { durationMs: 0, total_cost_usd: 0 } };
  }
  if (!options.skipPreflight) {
    const java = opsinJava(options.checkout);
    if (!existsSync(java)) throw new Error(`OPSIN runtime is missing: ${java}. Build it with node scripts/build-opsin-runtime.mjs, or use --skip-preflight only for runner tests.`);
  }
  await mkdir(options.out, { recursive: true });
  const shared = { binary, agentctl: process.env.CHEMDRAFT_STRESS_AGENTCTL_BIN || 'agentctl',
    agentVersion: null, checkoutHead: await gitValue(options.checkout, ['rev-parse', 'HEAD']) };
  if (options.agent === 'codex') {
    shared.codexAuth = path.join(process.env.CHEMDRAFT_STRESS_CODEX_AUTH_HOME || path.join(homedir(), '.codex-openai'), 'auth.json');
    if (!existsSync(shared.codexAuth)) throw new Error(`Codex auth.json is missing: ${shared.codexAuth}. Set CHEMDRAFT_STRESS_CODEX_AUTH_HOME to the signed-in source home.`);
  }
  const version = await command(shared.binary, ['--version']);
  shared.agentVersion = version.exitCode === 0 ? version.stdout.trim() : null;
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
  const summary = { agent: options.agent, arguments: { ...options, cases: path.resolve(options.cases) }, cases: results.map((meta) => ({ id: meta.id, status: meta.status })),
    totals: { durationMs: results.reduce((sum, meta) => sum + (meta.durationMs || 0), 0), total_cost_usd: results.reduce((sum, meta) => sum + (Number(meta.total_cost_usd) || 0), 0) } };
  await writeFile(path.join(options.out, 'run.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { ...summary, exitCode: halted ? 3 : 0 };
}
