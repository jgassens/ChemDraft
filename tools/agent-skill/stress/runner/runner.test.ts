import { cp, mkdtemp, readFile, rm, writeFile, lstat, readdir, mkdir, symlink } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error runner.mjs is intentionally plain JavaScript.
import { assertOutputIsolation, checkoutChanges, commandOutputTargets, repoAccess, run, quoteWindowsCmdArgument, resolveWindowsCommand, spawnCommandSpec } from './runner.mjs';
// @ts-expect-error stream.mjs is intentionally plain JavaScript.
import { inspectStream } from './stream.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');
const runner = path.join(root, 'tools/agent-skill/stress/runner/run.mjs');
const fakeClaude = path.join(root, 'tools/agent-skill/stress/runner/fixtures/fake-claude.mjs');
const fakeCodex = path.join(root, 'tools/agent-skill/stress/runner/fixtures/fake-codex.mjs');
const fakeAgentctl = path.join(root, 'tools/agent-skill/stress/runner/fixtures/fake-agentctl.mjs');
const temporary: string[] = [];

async function fixtureCases() {
  const directory = realpathSync(await mkdtemp(path.join(tmpdir(), 'chemdraft-stress-cases-')));
  temporary.push(directory);
  const file = path.join(directory, 'cases.json');
  await writeFile(file, JSON.stringify({ cases: [
    { id: 'S01', split: 'dev', prompt: 'Verbatim prompt: use $ and "quotes".' },
    { id: 'S02', split: 'heldout', prompt: 'Second prompt.' }
  ] }));
  return file;
}

async function outDirectory() { const value = realpathSync(await mkdtemp(path.join(tmpdir(), 'chemdraft-stress-out-'))); temporary.push(value); return value; }

async function fakeCheckout(withOpsin: boolean) {
  const container = realpathSync(await mkdtemp(path.join(tmpdir(), 'chemdraft-stress-checkout-')));
  temporary.push(container);
  const directory = path.join(container, 'repo');
  await mkdir(directory);
  await cp(path.join(root, 'skills'), path.join(directory, 'skills'), { recursive: true });
  if (withOpsin) {
    const java = path.join(directory, 'apps/desktop/src-tauri/resources/opsin/jre/bin', process.platform === 'win32' ? 'java.exe' : 'java');
    await mkdir(path.dirname(java), { recursive: true });
    await writeFile(java, 'fake java runtime');
  }
  return directory;
}

async function invoke(args: string[], env: Record<string, string | undefined> = {}, skipPreflight = true) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [runner, ...(skipPreflight ? ['--skip-preflight'] : []), ...args], { cwd: root, env: { ...process.env, CHEMDRAFT_STRESS_CLAUDE_BIN: fakeClaude, CHEMDRAFT_STRESS_CODEX_BIN: fakeCodex, CHEMDRAFT_STRESS_AGENTCTL_BIN: fakeAgentctl, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('stress runner', { timeout: 30_000 }, () => {
  it('resolves Windows npm shims and preserves a quoted prompt without starting cmd.exe', () => {
    const prompt = `Draw (S)-ibuprofen & say "R" or 'S' 100% $HOME`;
    const shim = 'C:\\Users\\chemist\\AppData\\Roaming\\npm\\codex.CMD';
    const environment = {
      PATH: 'C:\\Tools;C:\\Users\\chemist\\AppData\\Roaming\\npm',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    };
    const exists = (candidate: string) => candidate.toLowerCase() === shim.toLowerCase();

    expect(resolveWindowsCommand('codex', { platform: 'win32', environment, exists })).toBe(shim);
    expect(quoteWindowsCmdArgument(prompt)).toBe(`"Draw ^(S^)-ibuprofen ^& say \\"R\\" or 'S' 100%% $HOME"`);
    expect(spawnCommandSpec('codex', ['exec', '--', prompt], { platform: 'win32', environment, exists })).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${shim}" "exec" "--" "Draw ^(S^)-ibuprofen ^& say \\"R\\" or 'S' 100%% $HOME"`],
    });
  });

  it('runs an isolated case and saves transcript-derived artifacts', async () => {
    const cases = await fixtureCases(); const out = await outDirectory(); const trace = path.join(out, 'trace.json');
    const result = await invoke(['--cases', cases, '--out', out, '--ids', 'S01', '--checkout', root], { FAKE_CLAUDE_TRACE: trace });
    expect(result.code).toBe(0);
    const invocation = JSON.parse(await readFile(trace, 'utf8'));
    expect(invocation.cwd).toBe(path.join(out, 'S01', 'work'));
    expect(invocation.argv).toContain('Verbatim prompt: use $ and "quotes".');
    expect(invocation.argv).toEqual(expect.arrayContaining(['--strict-mcp-config', '--setting-sources', 'project', '--allowedTools']));
    expect(invocation.argv).not.toContain('--bare');
    const copied = path.join(out, 'S01/work/.claude/skills/chemdraft');
    expect((await lstat(copied)).isSymbolicLink()).toBe(false);
    expect((await readdir(path.join(out, 'S01/images'))).sort()).toEqual(['001-mcp__chemdraft__render_structure.png', '002-mcp__chemdraft__render_structure.svg']);
    expect(await readFile(path.join(out, 'S01/final.md'), 'utf8')).toBe('Finished drawing.');
    const meta = JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'));
    expect(meta).toMatchObject({ id: 'S01', agent: 'claude', status: 'complete', model: 'claude-sonnet-5-5', numTurns: 1, total_cost_usd: 0.01 });
    expect(JSON.parse(await readFile(path.join(out, 'run.json'), 'utf8')).agent).toBe('claude');
    expect(JSON.parse(await readFile(path.join(out, 'S01/tool-calls.json'), 'utf8'))[0].result[0].source.data).toBeUndefined();
  });

  it('resumes completed cases without calling Claude again', async () => {
    const cases = await fixtureCases(); const out = await outDirectory(); const trace = path.join(out, 'trace.json');
    await invoke(['--cases', cases, '--out', out, '--ids', 'S01', '--checkout', root], { FAKE_CLAUDE_TRACE: trace });
    await rm(trace);
    const resumed = await invoke(['--cases', cases, '--out', out, '--ids', 'S01', '--checkout', root], { FAKE_CLAUDE_TRACE: trace });
    expect(resumed.code).toBe(0); expect(existsSync(trace)).toBe(false);
  });

  it('times out a stuck process', async () => {
    const cases = await fixtureCases(); const out = await outDirectory();
    const result = await invoke(['--cases', cases, '--out', out, '--ids', 'S01', '--checkout', root, '--timeout-min', '0.001'], { FAKE_CLAUDE_SLEEP: '1' });
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8')).status).toBe('timeout');
  });

  it('halts remaining work below the Claude usage floor', async () => {
    const cases = await fixtureCases(); const out = await outDirectory();
    const result = await invoke(['--cases', cases, '--out', out, '--checkout', root, '--concurrency', '1'], { FAKE_USAGE_REMAINING: '14' });
    expect(result.code).toBe(3);
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8')).status).toBe('halted-usage');
    expect(JSON.parse(await readFile(path.join(out, 'S02/meta.json'), 'utf8')).status).toBe('halted-usage');
  });

  it('preserves a completed resumed case when usage halts before it is visited', async () => {
    const cases = await fixtureCases(); const out = await outDirectory();
    await invoke(['--cases', cases, '--out', out, '--ids', 'S02', '--checkout', root, '--concurrency', '1']);
    const before = await readFile(path.join(out, 'S02/meta.json'), 'utf8');
    const result = await invoke(['--cases', cases, '--out', out, '--checkout', root, '--concurrency', '1'], { FAKE_USAGE_REMAINING: '14' });
    expect(result.code).toBe(3);
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8')).status).toBe('halted-usage');
    expect(await readFile(path.join(out, 'S02/meta.json'), 'utf8')).toBe(before);
    expect(JSON.parse(await readFile(path.join(out, 'S02/meta.json'), 'utf8')).status).toBe('complete');
  });

  it('rejects an init event that contains another MCP server', async () => {
    const cases = await fixtureCases(); const out = await outDirectory();
    await invoke(['--cases', cases, '--out', out, '--ids', 'S01', '--checkout', root], { FAKE_CLAUDE_EXTRA_MCP: '1' });
    const meta = JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'));
    expect(meta).toMatchObject({ status: 'error', reason: 'isolation' });
  });

  it('refuses an output directory inside the checkout', async () => {
    const cases = await fixtureCases();
    const result = await invoke(['--cases', cases, '--out', path.join(root, 'tools/agent-skill/stress/runner/nope'), '--checkout', root]);
    expect(result.code).toBe(2); expect(result.stderr).toContain('--out must be outside the repository');
  });

  it('refuses an output directory in the checkout parent, including a sibling worktree', async () => {
    const cases = await fixtureCases();
    const result = await invoke(['--cases', cases, '--out', path.join(path.dirname(root), 'sibling-results'), '--checkout', root]);
    expect(result.code).toBe(2); expect(result.stderr).toContain('--out must be outside the repository and its parent directory');
  });

  it('requires the OPSIN runtime before starting either agent', async () => {
    const cases = await fixtureCases(); const out = await outDirectory();
    const checkout = await fakeCheckout(false);
    const result = await invoke(['--cases', cases, '--out', out, '--ids', 'S01', '--checkout', checkout], {}, false);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('OPSIN runtime is missing:');
    expect(existsSync(path.join(out, 'S01/meta.json'))).toBe(false);
  });

  it('accepts a fake checkout with the OPSIN runtime without consulting the real checkout', async () => {
    const cases = await fixtureCases(); const out = await outDirectory(); const checkout = await fakeCheckout(true);
    const result = await invoke(['--cases', cases, '--out', out, '--ids', 'S01', '--checkout', checkout], {}, false);
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8')).status).toBe('complete');
  });

  async function codexFixture() {
    const cases = await fixtureCases(); const out = await outDirectory();
    const sourceHome = path.join(out, 'source-home');
    await mkdir(sourceHome);
    await writeFile(path.join(sourceHome, 'auth.json'), '{"fake":"oauth-auth"}');
    await writeFile(path.join(sourceHome, 'AGENTS.md'), 'Must not be copied.');
    await writeFile(path.join(sourceHome, 'config.toml'), '[mcp_servers.unwanted]\ncommand = "unwanted"\n');
    return { cases, out, sourceHome,
      args: ['--cases', cases, '--out', out, '--ids', 'S01', '--checkout', root, '--agent', 'codex'],
      env: { CHEMDRAFT_STRESS_CODEX_AUTH_HOME: sourceHome, FAKE_CODEX_TRACE: path.join(out, 'trace.json') } };
  }

  async function tree(directory: string): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await readdir(directory)) {
      const file = path.join(directory, entry);
      const info = await lstat(file);
      expect(info.isSymbolicLink()).toBe(false);
      expect(entry.toLowerCase()).not.toBe('agents.md');
      result.push(file);
      if (info.isDirectory()) result.push(...await tree(file));
    }
    return result;
  }

  it('isolates Codex home and normalizes events to the shared grader artifacts', async () => {
    const { out, args, env, sourceHome } = await codexFixture();
    const result = await invoke(args, env);
    expect(result.code).toBe(0);
    const caseDir = path.join(out, 'S01'); const home = path.join(caseDir, 'codex-home');
    const invocation = JSON.parse(await readFile(env.FAKE_CODEX_TRACE, 'utf8'));
    expect(invocation).toEqual({ argv: ['exec', '--json', '--skip-git-repo-check', '--', 'Verbatim prompt: use $ and "quotes".'], cwd: path.join(caseDir, 'work'), codexHome: home });
    expect((await readdir(home)).sort()).toEqual(['auth.json', 'config.toml', 'skills']);
    expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe(await readFile(path.join(sourceHome, 'auth.json'), 'utf8'));
    const config = await readFile(path.join(home, 'config.toml'), 'utf8');
    expect(config.match(/\[mcp_servers\.[^\]]+\]/g)).toEqual(['[mcp_servers.chemdraft]']);
    expect(config).toContain(`args = ${JSON.stringify(['-s', '--dir', root, 'chemdraft-mcp'])}`);
    expect(config).toContain('command = "pnpm"');
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain('default_tools_approval_mode = "approve"');
    expect(config).toContain('[features]\nplugins = false');
    expect(config).toContain('sandbox_mode = "workspace-write"');
    expect(config).toContain('network_access = true');
    expect(config).toContain(`writable_roots = [${JSON.stringify(path.join(caseDir, 'work'))}]`);
    expect(config).not.toMatch(/^model\s*=/m);
    await tree(home); await tree(path.join(caseDir, 'work'));
    const skill = path.join(home, 'skills', 'chemdraft');
    expect(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe(await readFile(path.join(root, 'skills/chemdraft/SKILL.md'), 'utf8'));
    await writeFile(path.join(skill, 'SKILL.md'), 'Changed copy');
    expect(await readFile(path.join(root, 'skills/chemdraft/SKILL.md'), 'utf8')).not.toBe('Changed copy');
    expect(JSON.parse(await readFile(path.join(caseDir, 'tool-calls.json'), 'utf8'))).toEqual([
      { name: 'mcp__chemdraft__render_structure', input: { smiles: 'C' }, result: { content: [
        { type: 'image', mimeType: 'image/png' }, { type: 'text', text: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
      ] } },
      { name: 'Bash', input: { command: 'echo drawn' }, result: { content: [{ type: 'text', text: 'drawn\n' }] } },
    ]);
    expect((await readdir(path.join(caseDir, 'images'))).sort()).toEqual(['001-mcp__chemdraft__render_structure.png', '002-mcp__chemdraft__render_structure.svg']);
    expect((await readFile(path.join(caseDir, 'images/001-mcp__chemdraft__render_structure.png'))).subarray(1, 4).toString()).toBe('PNG');
    expect(await readFile(path.join(caseDir, 'final.md'), 'utf8')).toBe('Finished drawing.');
    expect(await readFile(path.join(caseDir, 'transcript.jsonl'), 'utf8')).toContain('iVBORw0KGgo');
    expect(await readFile(path.join(caseDir, 'stderr.log'), 'utf8')).toBe('');
    expect(JSON.parse(await readFile(path.join(caseDir, 'files.json'), 'utf8'))).toEqual([expect.objectContaining({ path: 'drawing.txt', size: 16 })]);
    expect(JSON.parse(await readFile(path.join(caseDir, 'meta.json'), 'utf8'))).toMatchObject({ agent: 'codex', codexVersion: 'fake-codex 0.162.1', status: 'complete', model: 'fake-default-model', numTurns: 1,
      usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 5 }, mcpServers: [{ name: 'chemdraft', status: 'connected' }], isolation: { verified: true, configuredMcpServers: ['chemdraft'] } });
    expect(JSON.parse(await readFile(path.join(out, 'run.json'), 'utf8')).agent).toBe('codex');
  });

  it('collects externally written outputs and records CLI checkout access', async () => {
    const { out, args, env } = await codexFixture();
    const external = realpathSync(await mkdtemp(path.join(tmpdir(), 'chemdraft-stress-external-')));
    temporary.push(external);
    const artifact = path.join(external, 'artifact.svg');
    await writeFile(artifact, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await invoke(args, { ...env, FAKE_CODEX_OUTPUT_FILE: artifact, FAKE_CODEX_CHECKOUT: root });
    const caseDir = path.join(out, 'S01');
    const outputs = JSON.parse(await readFile(path.join(caseDir, 'outputs.json'), 'utf8'));
    expect(outputs).toEqual([expect.objectContaining({ originalPath: artifact, copiedName: '001-artifact.svg', size: 41 })]);
    expect(await readFile(path.join(caseDir, 'outputs/001-artifact.svg'), 'utf8')).toContain('<svg');
    expect(JSON.parse(await readFile(path.join(caseDir, 'meta.json'), 'utf8')).repoAccess).toEqual([
      expect.objectContaining({ tool: 'Bash', classification: 'cli' }),
    ]);
  });

  it('records checkout source reads separately from CLI calls', async () => {
    const { out, args, env } = await codexFixture();
    await invoke(args, { ...env, FAKE_CODEX_SOURCE_READ: '1', FAKE_CODEX_CHECKOUT: root });
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8')).repoAccess).toEqual([
      expect.objectContaining({ tool: 'Bash', classification: 'source-read' }),
    ]);
  });

  it('writes an explicit Codex model and records the model from session events when stdout omits it', async () => {
    const { out, args, env } = await codexFixture();
    await invoke([...args, '--model', 'requested-model'], { ...env, FAKE_CODEX_SESSION_MODEL: '1', FAKE_CODEX_MODEL: 'reported-model' });
    expect(await readFile(path.join(out, 'S01/codex-home/config.toml'), 'utf8')).toContain('model = "requested-model"');
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8')).model).toBe('reported-model');
  });

  it('halts Codex below the OpenAI floor even when the Claude pool is full', async () => {
    const { out, args, env } = await codexFixture();
    const result = await invoke(args, { ...env, FAKE_OPENAI_REMAINING: '14' });
    expect(result.code).toBe(3);
    expect(existsSync(env.FAKE_CODEX_TRACE)).toBe(false);
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'))).toMatchObject({ agent: 'codex', status: 'halted-usage' });
  });

  it('allows Codex at exactly 15% OpenAI remaining even when Claude is exhausted', async () => {
    const { out, args, env } = await codexFixture();
    expect((await invoke(args, { ...env, FAKE_OPENAI_REMAINING: '15', FAKE_USAGE_REMAINING: '0' })).code).toBe(0);
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8')).status).toBe('complete');
  });

  it('warns and continues Codex when the OpenAI usage pool is unavailable', async () => {
    const { args, env } = await codexFixture();
    const result = await invoke(args, { ...env, FAKE_USAGE_NO_OPENAI: '1' });
    expect(result.code).toBe(0); expect(result.stderr).toContain('warning:');
    expect(existsSync(env.FAKE_CODEX_TRACE)).toBe(true);
  });

  it('warns and proceeds for unreadable and malformed usage for both agents', async () => {
    for (const agent of ['claude', 'codex']) for (const flag of ['FAKE_USAGE_ERROR', 'FAKE_USAGE_INVALID']) {
      const { out, args, env } = await codexFixture();
      args[args.indexOf('codex')] = agent;
      const result = await invoke(args, { ...env, [flag]: '1' });
      expect(result.code).toBe(0); expect(result.stderr).toContain('warning:');
      expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8')).status).toBe('complete');
    }
  });

  it('records tool provenance for runner PNG/SVG assets and copied outputs', async () => {
    const { out, args, env } = await codexFixture();
    const artifact = path.join(out, 'figure.svg'); await writeFile(artifact, '<svg/>');
    await invoke(args, { ...env, FAKE_CODEX_OUTPUT_FILE: artifact, FAKE_CODEX_CHECKOUT: root });
    const assets = JSON.parse(await readFile(path.join(out, 'S01/assets.json'), 'utf8'));
    expect(assets).toEqual([
      expect.objectContaining({ path: 'images/001-mcp__chemdraft__render_structure.png', toolCallIndex: 0 }),
      expect.objectContaining({ path: 'images/002-mcp__chemdraft__render_structure.svg', toolCallIndex: 0 }),
      expect.objectContaining({ path: 'outputs/001-figure.svg', toolCallIndex: 1, originalPath: artifact }),
    ]);
  });

  it('fails Claude result errors and turn-limit subtypes even with exit zero', async () => {
    for (const failure of ['is_error', 'error_max_turns', 'error_during_execution']) {
      const cases = await fixtureCases(), out = await outDirectory();
      await invoke(['--cases', cases, '--out', out, '--ids', 'S01', '--checkout', root], { FAKE_CLAUDE_RESULT_ERROR: failure });
      expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'))).toMatchObject({ status: 'error', reason: expect.stringContaining(failure) });
    }
  });

  it('rejects init skills present in the parameterised user skills folder, except chemdraft', async () => {
    const skills = await outDirectory();
    await mkdir(path.join(skills, 'private-user-skill')); await mkdir(path.join(skills, 'chemdraft'));
    const init = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'chemdraft', status: 'connected' }], skills: ['chemdraft', 'private-user-skill'] };
    expect(inspectStream([init], { userSkillsPath: skills })).toMatchObject({ isolated: false, isolationLeak: true });
    expect(inspectStream([{ ...init, skills: ['chemdraft', 'builtin'] }], { userSkillsPath: skills }).isolated).toBe(true);
    const cases = await fixtureCases(), out = await outDirectory();
    const previous = { ...process.env };
    try {
      process.env.CHEMDRAFT_STRESS_CLAUDE_BIN = fakeClaude; process.env.CHEMDRAFT_STRESS_AGENTCTL_BIN = fakeAgentctl;
      process.env.FAKE_CLAUDE_SKILL = 'private-user-skill';
      await run({ cases, out, checkout: root, agent: 'claude', split: 'all', ids: ['S01'], skipPreflight: true,
        timeoutMin: 1, maxTurns: 3, concurrency: 1, userSkillsPath: skills }, { stderr: () => {} });
    } finally { process.env = previous; }
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'))).toMatchObject({ status: 'error', reason: 'isolation-leak' });
  });

  it('rejects instruction files/folders on every output ancestor, including home and symlinks', async () => {
    const home = await outDirectory();
    const parent = path.join(home, 'runs'); await mkdir(parent);
    for (const entry of ['CLAUDE.md', 'AGENTS.md', '.claude', '.codex']) {
      const location = path.join(parent, entry);
      if (entry.startsWith('.')) await mkdir(location); else await writeFile(location, 'instructions');
      await expect(assertOutputIsolation(path.join(parent, 'new', 'out'), { home })).rejects.toThrow('inherits agent instructions');
      await rm(location, { recursive: true });
    }
    await mkdir(path.join(home, '.claude')); await mkdir(path.join(home, '.codex'));
    await expect(assertOutputIsolation(path.join(parent, 'new'), { home })).resolves.toBeUndefined();
    await writeFile(path.join(home, 'CLAUDE.md'), 'instructions');
    await expect(assertOutputIsolation(path.join(parent, 'new'), { home })).rejects.toThrow('CLAUDE.md');
    // Actual --out validation is exercised before any agent launch.
    const cases = await fixtureCases();
    const result = await invoke(['--cases', cases, '--out', path.join(parent, 'new'), '--checkout', root]);
    expect(result.code).toBe(2); expect(result.stderr).toContain('inherits agent instructions');
    await rm(path.join(home, 'CLAUDE.md'));
    const elsewhere = path.join(home, 'elsewhere'), target = path.join(home, 'secret', 'inner');
    await mkdir(elsewhere); await mkdir(target, { recursive: true });
    await writeFile(path.join(home, 'secret', 'AGENTS.md'), 'inherited through symlink');
    await symlink(target, path.join(elsewhere, 'linked'), 'junction');
    await expect(assertOutputIsolation(path.join(elsewhere, 'linked', 'new'), { home })).rejects.toThrow('AGENTS.md');
  });

  it('records new git status changes and fails isolation after a checkout write', async () => {
    expect(checkoutChanges(' M prior\n', ' M prior\n?? new\n')).toEqual(['?? new']);
    const checkout = await fakeCheckout(false), cases = await fixtureCases(), out = await outDirectory();
    execFileSync('git', ['init', checkout], { stdio: 'pipe' });
    await invoke(['--cases', cases, '--out', out, '--ids', 'S01', '--checkout', checkout], { FAKE_CLAUDE_WRITE: path.join(checkout, 'unexpected.txt') });
    const meta = JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'));
    expect(meta).toMatchObject({ status: 'error', reason: 'isolation-leak', checkoutModified: true });
    expect(meta.checkoutStatusAfter).toContain('unexpected.txt');
    expect(meta.checkoutStatusBefore).not.toContain('unexpected.txt');
  });

  it('audits Claude writes and Codex file changes inside the checkout on both platforms', async () => {
    for (const platform of ['darwin', 'win32']) {
      const checkout = platform === 'win32' ? 'C:\\repo' : '/repo';
      const source = platform === 'win32' ? 'C:\\repo\\source.ts' : '/repo/source.ts';
      for (const name of ['Write', 'Edit', 'NotebookEdit']) {
        expect(repoAccess([{ name, input: { file_path: source } }], checkout, { platform })).toEqual([
          expect.objectContaining({ tool: name, classification: 'source-write' })]);
      }
      expect(repoAccess([], checkout, { platform, fileChanges: [{ path: source }] })).toEqual([
        expect.objectContaining({ tool: 'file_change', classification: 'source-write' })]);
      expect(repoAccess([{ name: 'Write', input: { file_path: `${checkout}-other/file` } }], checkout, { platform })).toEqual([]);
    }
    const windowsCommand = String.raw`cmd.exe /d /s /c "pnpm.cmd -s --dir C:\repo chemdraft render --smiles CCO --out C:\Users\x\figure.svg"`;
    expect(commandOutputTargets(windowsCommand, { platform: 'win32' })).toEqual(['C:\\Users\\x\\figure.svg']);
    expect(repoAccess([{ name: 'Bash', input: { command: windowsCommand } }], 'C:\\repo', { platform: 'win32' }))
      .toEqual([expect.objectContaining({ classification: 'cli' })]);
    const { out, args, env } = await codexFixture();
    await invoke(args, { ...env, FAKE_CODEX_WRITE_EVENT: path.join(root, 'source.ts') });
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'))).toMatchObject({ status: 'error', reason: 'isolation-leak',
      repoAccess: [expect.objectContaining({ classification: 'source-write', tool: 'file_change' })] });
    const cases = await fixtureCases(), claudeOut = await outDirectory();
    await invoke(['--cases', cases, '--out', claudeOut, '--ids', 'S01', '--checkout', root], { FAKE_CLAUDE_WRITE_EVENT: path.join(root, 'source.ts') });
    expect(JSON.parse(await readFile(path.join(claudeOut, 'S01/meta.json'), 'utf8'))).toMatchObject({ status: 'error', reason: 'isolation-leak',
      repoAccess: [expect.objectContaining({ classification: 'source-write', tool: 'Edit' })] });
  });

  it('clearly rejects missing Codex auth without running an agent', async () => {
    const { args, env, sourceHome } = await codexFixture();
    await rm(path.join(sourceHome, 'auth.json'));
    const result = await invoke(args, env);
    expect(result.code).toBe(2); expect(result.stderr).toContain('Codex auth.json is missing:');
    expect(existsSync(env.FAKE_CODEX_TRACE)).toBe(false);
  });

  it('fails Codex isolation when events name another MCP server', async () => {
    const { out, args, env } = await codexFixture();
    await invoke(args, { ...env, FAKE_CODEX_EXTRA_MCP: '1' });
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'))).toMatchObject({ status: 'error', reason: 'isolation-leak', isolation: { verified: false } });
  });

  it('fails Codex isolation when a plugins folder appears or stderr names another MCP server', async () => {
    for (const envFlag of [{ FAKE_CODEX_PLUGIN_LEAK: '1' }, { FAKE_CODEX_STDERR_MCP_LEAK: '1' }]) {
      const { out, args, env } = await codexFixture();
      await invoke(args, { ...env, ...envFlag });
      expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'))).toMatchObject({ status: 'error', reason: 'isolation-leak', isolation: { verified: false } });
      expect(await readFile(path.join(out, 'S01/stderr.log'), 'utf8')).toBe(envFlag.FAKE_CODEX_STDERR_MCP_LEAK ? 'rmcp auth error for mcp.box.com\n' : '');
    }
  });

  it('accepts a Codex run with zero ChemDraft calls when config and leak checks pass', async () => {
    const { out, args, env } = await codexFixture();
    await invoke(args, { ...env, FAKE_CODEX_STARTUP_ONLY: '1' });
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'))).toMatchObject({ status: 'complete', isolation: { verified: true } });
  });

  it('keeps a failed ChemDraft MCP call isolated because it still names our server', async () => {
    const { out, args, env } = await codexFixture();
    await invoke(args, { ...env, FAKE_CODEX_FAILED_MCP: '1' });
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'))).toMatchObject({ status: 'complete', isolation: { verified: true } });
  });

  it('normalizes alternate event fields and JSON-encoded arguments/results', async () => {
    const { out, args, env } = await codexFixture();
    await invoke(args, { ...env, FAKE_CODEX_VARIANTS: '1' });
    const calls = JSON.parse(await readFile(path.join(out, 'S01/tool-calls.json'), 'utf8'));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ name: 'mcp__chemdraft__render_structure', input: { smiles: 'C' } });
    expect(calls[0].result.content[0].data).toBeUndefined();
    expect(calls[1]).toMatchObject({ name: 'Bash', result: { content: [{ type: 'text', text: 'drawn\n' }] } });
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8')).status).toBe('complete');
  });

  it('records a failed Codex turn even when the process exits zero', async () => {
    const { out, args, env } = await codexFixture();
    await invoke(args, { ...env, FAKE_CODEX_TURN_FAILURE: '1' });
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8')).status).toBe('error');
  });

  it('resumes Codex cases but reruns a case completed by the other agent', async () => {
    const { out, args, env, cases } = await codexFixture();
    await invoke(['--cases', cases, '--out', out, '--ids', 'S01', '--checkout', root]);
    await invoke(args, env);
    expect(existsSync(env.FAKE_CODEX_TRACE)).toBe(true);
    await rm(env.FAKE_CODEX_TRACE);
    await invoke(args, env);
    expect(existsSync(env.FAKE_CODEX_TRACE)).toBe(false);
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8')).agent).toBe('codex');
  });
});
