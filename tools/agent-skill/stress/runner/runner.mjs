import { commandWords } from '../shell-words.mjs';
import { spawnCommandSpec } from '../spawn-command.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { copyFile, cp, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { hashTree, inspectStream, listFiles, parseStream, saveToolAssets } from './stream.mjs';
import { inspectCodexStream, reportedCodexModel } from './codex-stream.mjs';

const defaultCheckout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DEFAULTS = { agent: 'claude', split: 'all', model: null, timeoutMin: 15, maxTurns: 60, concurrency: 2 };
const PERMITTED_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Skill,mcp__chemdraft__*';

/** Resolve an existing path to the filesystem's canonical spelling. */
export function canonicalPath(value, { platform = process.platform, realpathNative = realpathSync.native } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const resolved = paths.resolve(value);
  // A glob or a newly written file may not exist, but its parent can be a link.
  let current = resolved;
  for (;;) {
    try { return paths.join(realpathNative(current), paths.relative(current, resolved)); } catch { /* Try its parent. */ }
    const parent = paths.dirname(current);
    if (parent === current) return resolved;
    current = parent;
  }
}

function comparisonPath(value, options = {}) {
  const canonical = canonicalPath(value, options);
  return (options.platform ?? process.platform) === 'win32' ? canonical.toLowerCase() : canonical;
}

export function pathsEqual(left, right, options = {}) {
  return comparisonPath(left, options) === comparisonPath(right, options);
}

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

export function codexEnvironment(caseDir, codexHome, { platform = process.platform, environment = process.env } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const home = paths.join(caseDir, 'home');
  return { ...environment, HOME: home, ...(platform === 'win32' ? { USERPROFILE: home } : {}), CODEX_HOME: codexHome };
}

export async function createCaseHome(caseDir, checkout, { platform = process.platform, link = symlink } = {}) {
  const home = path.join(caseDir, 'home');
  const skills = path.join(home, '.codex', 'skills');
  await mkdir(skills, { recursive: true });
  await link(path.resolve(checkout, 'skills', 'chemdraft'), path.join(skills, 'chemdraft'), platform === 'win32' ? 'junction' : 'dir');
  return home;
}

/** Link Codex's user skill root to the checkout, matching the documented install. */
export async function linkCodexSkill(codexHome, checkout, { platform = process.platform, link = symlink } = {}) {
  const skills = path.join(codexHome, 'skills');
  const skill = path.join(skills, 'chemdraft');
  await mkdir(skills, { recursive: true });
  await link(path.resolve(checkout, 'skills', 'chemdraft'), skill, platform === 'win32' ? 'junction' : 'dir');
  return skill;
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

function isInside(repo, out, options = {}) {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const relative = paths.relative(comparisonPath(repo, options), comparisonPath(out, options));
  return relative === '' || (!relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative));
}

function isInsideOrParent(checkout, output, options = {}) {
  const paths = (options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
  return isInside(checkout, output, options) || isInside(paths.dirname(checkout), output, options);
}

const outputExtension = /\.(?:png|svg|pdf|cdxml|sdf|mol|chemdraft|json)$/i;

export function commandOutputTargets(commandText, options = {}) {
  const words = commandWords(commandText, options);
  const targets = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === '--out' || word === '--out-dir') {
      if (words[index + 1]) targets.push(words[++index]);
    } else if (word.startsWith('--out=') || word.startsWith('--out-dir=')) {
      targets.push(word.slice(word.indexOf('=') + 1));
    } else if (/^\d*(?:>|>>)$/.test(word) && words[index + 1]) {
      targets.push(words[++index]);
    }
  }
  return targets;
}

/** Retain file inputs even when the agent created them outside its work folder. */
export function commandInputTargets(commandText, options = {}) {
  const words = commandWords(commandText, options), targets = [];
  const fileOption = /^--(?:document|batch|reaction|input|jobs)(?:-file|-path)?$/;
  for (let index = 0; index < words.length; index++) {
    const [option, ...suffix] = words[index].split('=');
    if (!fileOption.test(option)) continue;
    const value = suffix.length ? suffix.join('=') : words[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) continue;
    targets.push(value);
    if (!suffix.length) index++;
  }
  return targets;
}

function finalOutputTargets(final, work) {
  const targets = new Map();
  for (const match of final.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    const link = match[1].replace(/^<|>$/g, '');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(link) || /^[a-z]:[\\/]/i.test(link)) targets.set(path.resolve(work, link), link);
  }
  for (const match of final.matchAll(/(?:^|[\s("'])((?:\/[\w. -]+)+\.(?:png|svg|pdf|cdxml|sdf|mol|chemdraft|json))(?=$|[\s)'".,])/gi)) {
    targets.set(match[1], match[1]);
  }
  return [...targets].map(([target, requestedPath]) => ({ target, requestedPath }));
}

async function filesAtOutputTarget(target, input = false) {
  let info;
  try { info = await lstat(target); } catch { return []; }
  if (info.isFile()) return input || outputExtension.test(target) ? [target] : [];
  if (!info.isDirectory() || info.isSymbolicLink()) return [];
  const files = [];
  let oversized = false;
  async function visit(directory) {
    if (oversized) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const current = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(current);
      else if (entry.isFile()) {
        files.push(current);
        if (files.length > 50) { oversized = true; return; }
      }
      if (oversized) return;
    }
  }
  await visit(target);
  return oversized ? [] : files.filter((file) => input || outputExtension.test(file));
}

async function collectOutputs(caseDir, work, codexHome, final, toolCalls) {
  const targets = new Map(finalOutputTargets(final, work).map(({ target, requestedPath }) => [target, { requestedPath, toolCallIndex: null }]));
  for (const [toolCallIndex, call] of toolCalls.entries()) if (call.name === 'Bash' && typeof call.input?.command === 'string') {
    for (const target of commandOutputTargets(call.input.command)) {
      targets.set(path.isAbsolute(target) ? target : path.resolve(work, target), { requestedPath: target, toolCallIndex });
    }
    for (const target of commandInputTargets(call.input.command)) {
      targets.set(path.resolve(work, target), { requestedPath: target, toolCallIndex, input: true });
    }
  } else if (call.name?.startsWith('mcp__chemdraft__')) {
    // MCP inputs are structured; only explicit file fields are paths, not inline document JSON.
    for (const key of ['documentPath', 'batchPath', 'reactionPath', 'inputPath']) {
      const value = call.input?.[key];
      if (typeof value === 'string' && value && !/[\r\n]/.test(value)) {
        targets.set(path.resolve(work, value), { requestedPath: value, toolCallIndex, input: true });
      }
    }
    const visit = (value) => {
      if (typeof value === 'string') {
        try { visit(JSON.parse(value)); } catch {
          if (outputExtension.test(value) && !/[\r\n]/.test(value)) targets.set(path.resolve(work, value), { requestedPath: value, toolCallIndex });
        }
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) if (!['data', 'blob'].includes(key)) visit(child);
    };
    visit(call.result);
  }
  const outputDir = path.join(caseDir, 'outputs');
  await mkdir(outputDir, { recursive: true });
  const manifest = [];
  const copied = new Set();
  for (const [target, { requestedPath, toolCallIndex, input }] of targets) {
    for (const source of await filesAtOutputTarget(target, input)) {
      const resolved = canonicalPath(source);
      if (!resolved || isInside(codexHome, resolved) || copied.has(resolved)) continue;
      copied.add(resolved);
      const copiedName = `${String(manifest.length + 1).padStart(3, '0')}-${path.basename(resolved)}`;
      const destination = path.join(outputDir, copiedName);
      await copyFile(resolved, destination);
      const data = await readFile(resolved);
      manifest.push({ originalPath: resolved, requestedPath, copiedName, toolCallIndex, size: (await stat(resolved)).size,
        sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
  await writeFile(path.join(caseDir, 'outputs.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function isCliCommand(commandText, checkout, { platform = process.platform } = {}) {
  const words = commandWords(commandText, { platform });
  const pnpm = words.some((word) => /(?:^|[\\/])pnpm(?:\.cmd|\.exe)?$/i.test(word));
  const directory = words.findIndex((word) => word === '--dir');
  return pnpm && directory >= 0 && pathsEqual(words[directory + 1] ?? '', checkout, { platform }) && words.slice(directory + 2).includes('chemdraft');
}

function inputStrings(value, strings = []) {
  if (typeof value === 'string') strings.push(value);
  else if (Array.isArray(value)) for (const child of value) inputStrings(child, strings);
  else if (value && typeof value === 'object') for (const child of Object.values(value)) inputStrings(child, strings);
  return strings;
}

/** Find the nearest checkout, caching both positive and negative ancestor checks. */
export function checkoutAt(value, { platform = process.platform, exists = existsSync, realpathNative = realpathSync.native, cache = new Map() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let current = canonicalPath(value, { platform, realpathNative });
  const visited = [];
  let found = null;
  for (;;) {
    const key = platform === 'win32' ? current.toLowerCase() : current;
    if (cache.has(key)) { found = cache.get(key); break; }
    visited.push(key);
    if (exists(paths.join(current, 'packages', 'chemdraft-cli', 'package.json')) && exists(paths.join(current, 'skills', 'chemdraft', 'SKILL.md'))) {
      found = current;
      break;
    }
    const parent = paths.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const key of visited) cache.set(key, found);
  return found;
}

function referencedPaths(text, { platform, environment }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const expanded = text.replace(/\$\{(HOME|CODEX_HOME|USERPROFILE)\}|\$(HOME|CODEX_HOME|USERPROFILE)\b|%(HOME|CODEX_HOME|USERPROFILE)%/g,
    (match, braced, plain, windows) => environment[braced ?? plain ?? windows] ?? match);
  const candidates = [];
  if (paths.isAbsolute(expanded)) candidates.push(expanded);
  const assignment = expanded.indexOf('=');
  if (assignment >= 0 && paths.isAbsolute(expanded.slice(assignment + 1))) candidates.push(expanded.slice(assignment + 1));
  // Include assignments and paths embedded in quoted scripts; never execute text.
  for (const match of expanded.matchAll(/(["'`])((?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*?)\1/g)) candidates.push(match[2]);
  for (const match of expanded.matchAll(/(?:^|[\s"'`=(:,;])((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'`<>|;,)]*)/g)) candidates.push(match[1]);
  return candidates;
}

export function repoAccess(toolCalls, checkout, { platform = process.platform, work = checkout, fileChanges = [],
  environment = process.env, exists = existsSync, realpathNative = realpathSync.native, cache = new Map() } = {}) {
  const accesses = [];
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const pathOptions = { platform, realpathNative };
  const inCheckout = (value) => {
    const relative = paths.relative(comparisonPath(checkout, pathOptions), comparisonPath(paths.resolve(work, value), pathOptions));
    return relative === '' || relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
  };
  const auditForeign = (call, values) => {
    const seen = new Set();
    for (const value of values) for (const referenced of referencedPaths(value, { platform, environment })) {
      const foreign = checkoutAt(referenced, { ...pathOptions, exists, cache });
      if (!foreign || pathsEqual(foreign, checkout, pathOptions) || seen.has(foreign)) continue;
      seen.add(foreign);
      accesses.push({ tool: call.name, path: referenced, checkout: foreign, classification: 'foreign-checkout',
        ...(call.name === 'Bash' ? { command: call.input.command } : {}) });
    }
  };
  for (const call of toolCalls) {
    if (call.name === 'Bash' && typeof call.input?.command === 'string') {
      let words;
      try { words = commandWords(call.input.command, { platform }); } catch { words = []; }
      auditForeign(call, [...words, call.input.command]);
      if (call.input.command.includes(checkout)) accesses.push({ tool: 'Bash', command: call.input.command,
        classification: isCliCommand(call.input.command, checkout, { platform }) ? 'cli' : 'source-read' });
    } else if (['Write', 'Edit', 'NotebookEdit'].includes(call.name)) {
      auditForeign(call, inputStrings(call.input));
      for (const value of [call.input?.file_path, call.input?.path, call.input?.notebook_path].filter((value) => typeof value === 'string')) {
        if (inCheckout(value)) accesses.push({ tool: call.name, path: value, classification: 'source-write' });
      }
    } else if (['Read', 'Grep', 'Glob'].includes(call.name)) {
      auditForeign(call, inputStrings(call.input));
      for (const value of inputStrings(call.input)) if (value.includes(checkout)) {
        accesses.push({ tool: call.name, path: value, classification: 'source-read' });
        break;
      }
    }
  }
  for (const change of fileChanges) if (typeof change.path === 'string') auditForeign({ name: 'file_change' }, [change.path]);
  for (const change of fileChanges) if (typeof change.path === 'string' && inCheckout(change.path)) {
    accesses.push({ tool: 'file_change', path: change.path, classification: 'source-write' });
  }
  return accesses;
}

export { quoteWindowsCmdArgument, resolveWindowsCommand, spawnCommandSpec } from '../spawn-command.mjs';
async function command(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let child;
    try {
      const environment = options.env ?? process.env;
      const specification = spawnCommandSpec(command, args, { environment });
      child = spawn(specification.command, specification.args,
        { cwd: options.cwd, env: environment, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
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

export async function usageAllowsStart(agentctl, agent, stderr) {
  const checked = await command(agentctl, ['usage', '--json']);
  if (checked.exitCode !== 0) { stderr(`warning: could not read usage guard: ${checked.stderr || 'agentctl failed'}`); return true; }
  try {
    const data = JSON.parse(checked.stdout);
    const pool = data.pools?.find((item) => item.pool === (agent === 'codex' ? 'openai' : 'claude'));
    if (!Number.isFinite(pool?.remaining_percent)) { stderr(`warning: ${agent} usage pool is missing or invalid; proceeding`); return true; }
    return !(typeof pool?.remaining_percent === 'number' && pool.remaining_percent < 15);
  } catch { stderr('warning: could not parse usage guard JSON'); return true; }
}

/** Reject inherited project instructions, including ancestors reached through symlinks. */
export async function assertOutputIsolation(output, { home = homedir() } = {}) {
  const canonicalHome = canonicalPath(home);
  let current = canonicalPath(output);
  const directories = new Set();
  for (;;) {
    directories.add(canonicalPath(current));
    const parent = path.dirname(current);
    if (parent === current || pathsEqual(current, canonicalHome)) break;
    current = parent;
  }
  for (const directory of directories) {
    let ancestor = directory;
    for (;;) {
      for (const entry of ['CLAUDE.md', 'AGENTS.md', '.claude', '.codex']) {
        if ((entry === '.claude' || entry === '.codex') && pathsEqual(ancestor, canonicalHome)) continue;
        if (existsSync(path.join(ancestor, entry))) throw new Error(`--out inherits agent instructions: ${path.join(ancestor, entry)}`);
      }
      // Include home itself, but never inspect its parents for home descendants.
      if (pathsEqual(ancestor, canonicalHome) || path.dirname(ancestor) === ancestor) break;
      ancestor = canonicalPath(path.dirname(ancestor));
    }
  }
}

export function checkoutChanges(before, after) {
  const prior = new Set((before ?? '').split('\n').filter(Boolean));
  return (after ?? '').split('\n').filter((line) => line && !prior.has(line));
}

async function gitValue(checkout, args) {
  const value = await command('git', args, { cwd: checkout });
  return value.exitCode === 0 ? value.stdout.trimEnd() : null;
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
  const metaPath = path.join(caseDir, 'meta.json');
  try {
    const existing = JSON.parse(await readFile(metaPath, 'utf8'));
    // The post-halt sweep reaches cases that no worker visited. Preserve only
    // this agent's completed attempt, matching the resume rule in runOne.
    if (existing.status === 'complete' && (existing.agent ?? 'claude') === options.agent) return existing;
  } catch (error) { if (error.code !== 'ENOENT') { /* Replace malformed metadata. */ } }
  await mkdir(caseDir, { recursive: true });
  const now = new Date().toISOString();
  const meta = { id: caseItem.id, status: 'halted-usage', exitCode: null, startedAt: now, endedAt: now, durationMs: 0,
    model: options.model, ...versionMeta(options, shared), skillSha256: null, checkoutHead: shared.checkoutHead,
    numTurns: 0, usage: null, total_cost_usd: null, mcpServers: [], tools: [], repoAccess: [], reason: 'usage' };
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
  const skill = options.agent === 'codex' ? path.join(codexHome, 'skills', 'chemdraft') : path.join(work, '.claude', 'skills', 'chemdraft');
  if (options.agent === 'claude') await copiedSkill(path.join(options.checkout, 'skills', 'chemdraft'), skill);
  const mcp = { mcpServers: { chemdraft: { command: 'pnpm', args: ['-s', '--dir', options.checkout, 'chemdraft-mcp'] } } };
  const mcpPath = path.join(caseDir, 'mcp.json');
  const configPath = path.join(codexHome, 'config.toml');
  const config = codexConfig(options, work);
  if (options.agent === 'codex') {
    await createCaseHome(caseDir, options.checkout);
    await linkCodexSkill(codexHome, options.checkout);
    await cp(shared.codexAuth, path.join(codexHome, 'auth.json'), { dereference: true });
    await writeFile(configPath, config);
    await assertNoAgentInstructions(codexHome);
    await assertNoAgentInstructions(work);
  } else await writeFile(mcpPath, `${JSON.stringify(mcp)}\n`);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const environment = options.agent === 'codex' ? codexEnvironment(caseDir, codexHome) : process.env;
  const executed = await command(shared.binary, options.agent === 'codex' ? codexArgs(caseItem.prompt) : claudeArgs(options, caseItem.prompt, mcpPath),
    { cwd: work, timeoutMs: options.timeoutMin * 60_000, env: environment });
  const endedAt = new Date().toISOString();
  await writeFile(path.join(caseDir, 'transcript.jsonl'), executed.stdout);
  if (options.agent === 'codex') await writeFile(path.join(caseDir, 'stderr.log'), executed.stderr);
  const events = parseStream(executed.stdout);
  const parsed = options.agent === 'codex' ? inspectCodexStream(events) : inspectStream(events, { userSkillsPath: options.userSkillsPath });
  let isolationLeak = parsed.isolationLeak ?? false;
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
  const assets = await saveToolAssets(parsed.assetEvents ?? events, path.join(caseDir, 'images'));
  await writeFile(path.join(caseDir, 'files.json'), `${JSON.stringify(await listFiles(work), null, 2)}\n`);
  const outputs = await collectOutputs(caseDir, work, codexHome, parsed.final, parsed.toolCalls);
  assets.push(...outputs.map((output) => ({ ...output, path: `outputs/${output.copiedName}` })));
  await writeFile(path.join(caseDir, 'assets.json'), `${JSON.stringify(assets, null, 2)}\n`);
  const checkoutStatusAfter = await gitValue(options.checkout, ['status', '--porcelain', '--untracked-files=all']);
  const newCheckoutChanges = checkoutChanges(shared.checkoutStatusBefore, checkoutStatusAfter);
  const checkoutModified = newCheckoutChanges.length > 0;
  const accesses = repoAccess(parsed.toolCalls, options.checkout, { work, environment, fileChanges: parsed.fileChanges, cache: shared.checkoutCache });
  const foreignCheckout = accesses.find((access) => access.classification === 'foreign-checkout');
  isolationLeak ||= checkoutModified || !!foreignCheckout || accesses.some((access) => access.classification === 'source-write');
  parsed.isolated &&= !isolationLeak;
  let status = executed.timedOut ? 'timeout' : executed.exitCode === 0 && !parsed.failed ? 'complete' : 'error';
  let reason = executed.timedOut ? 'timeout' : status === 'complete' ? undefined : parsed.failureReason || executed.stderr || `${options.agent} exited unsuccessfully`;
  if (isolationLeak) { status = 'error'; reason = foreignCheckout ? `isolation-leak: foreign checkout ${foreignCheckout.checkout}` : 'isolation-leak'; }
  else if (status !== 'timeout' && !parsed.isolated) { status = 'error'; reason = 'isolation'; }
  const meta = { id: caseItem.id, status, exitCode: executed.exitCode, startedAt, endedAt, durationMs: Date.now() - started,
    model: options.agent === 'codex' ? parsed.model : options.model, ...versionMeta(options, shared), skillSha256: await hashTree(skill), checkoutHead: shared.checkoutHead,
    numTurns: parsed.numTurns, usage: parsed.usage ?? parsed.result?.usage ?? null, total_cost_usd: parsed.result?.total_cost_usd ?? null,
    mcpServers: parsed.mcpServers ?? parsed.init?.mcp_servers ?? parsed.init?.mcpServers ?? [], tools: parsed.tools ?? parsed.init?.tools ?? [],
    isolation: { verified: parsed.isolated, ...(options.agent === 'codex' ? { configuredMcpServers: ['chemdraft'], skillPath: skill } : {}) },
    checkoutModified, checkoutStatusBefore: shared.checkoutStatusBefore, checkoutStatusAfter, newCheckoutChanges,
    repoAccess: accesses, ...(reason ? { reason } : {}) };
  await writeMeta(caseDir, meta);
  return { meta, stderr: executed.stderr };
}

export async function run(options, io = {}) {
  const stderr = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  options.checkout = canonicalPath(options.checkout);
  options.out = canonicalPath(options.out);
  if (isInsideOrParent(options.checkout, options.out)) throw new Error('--out must be outside the repository and its parent directory');
  await assertOutputIsolation(options.out, { home: options.home });
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
  const shared = { binary, agentctl: process.env.CHEMDRAFT_STRESS_AGENTCTL_BIN || 'agentctl', checkoutCache: new Map(),
    agentVersion: null, checkoutHead: await gitValue(options.checkout, ['rev-parse', 'HEAD']),
    checkoutStatusBefore: await gitValue(options.checkout, ['status', '--porcelain', '--untracked-files=all']) };
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
