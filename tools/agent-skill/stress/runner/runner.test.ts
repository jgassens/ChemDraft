import { cp, mkdtemp, readFile, rm, writeFile, lstat, readdir, mkdir, symlink } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error runner.mjs is intentionally plain JavaScript.
import { assertOutputIsolation, checkoutAt, checkoutChanges, codexEnvironment, createCaseHome, commandInputTargets, commandOutputTargets, pathsEqual, repoAccess, run, quoteWindowsCmdArgument, resolveWindowsCommand, spawnCommandSpec } from './runner.mjs';
// @ts-expect-error stream.mjs is intentionally plain JavaScript.
import { inspectStream } from './stream.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');
const runner = path.join(root, 'tools/agent-skill/stress/runner/run.mjs');
const fakeClaude = path.join(root, 'tools/agent-skill/stress/runner/fixtures/fake-claude.mjs');
const fakeCodex = path.join(root, 'tools/agent-skill/stress/runner/fixtures/fake-codex.mjs');
const fakeAgentctl = path.join(root, 'tools/agent-skill/stress/runner/fixtures/fake-agentctl.mjs');
const temporary: string[] = [];

async function fixtureCases() {
  const directory = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'chemdraft-stress-cases-')));
  temporary.push(directory);
  const file = path.join(directory, 'cases.json');
  await writeFile(file, JSON.stringify({ cases: [
    { id: 'S01', split: 'dev', prompt: 'Verbatim prompt: use $ and "quotes".' },
    { id: 'S02', split: 'heldout', prompt: 'Second prompt.' }
  ] }));
  return file;
}

async function outDirectory() { const value = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'chemdraft-stress-out-'))); temporary.push(value); return value; }

async function fakeCheckout(withOpsin: boolean) {
  const container = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'chemdraft-stress-checkout-')));
  temporary.push(container);
  const directory = path.join(container, 'repo');
  await mkdir(directory);
  await cp(path.join(root, 'skills'), path.join(directory, 'skills'), { recursive: true });
  await mkdir(path.join(directory, 'packages/chemdraft-cli'), { recursive: true });
  await writeFile(path.join(directory, 'packages/chemdraft-cli/package.json'), '{}');
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

  it('compares canonical Windows paths case-insensitively', () => {
    const short = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\artifact.svg`;
    const long = String.raw`c:\USERS\runneradmin\appdata\local\temp\ARTIFACT.svg`;
    const realpathNative = (value: string) => value.toLowerCase().includes('runner~1')
      ? String.raw`C:\Users\runneradmin\AppData\Local\Temp\artifact.svg`
      : value;
    expect(pathsEqual(short, long, { platform: 'win32', realpathNative })).toBe(true);
  });

  it('runs an isolated case and saves transcript-derived artifacts', async () => {
    const cases = await fixtureCases(); const out = await outDirectory(); const trace = path.join(out, 'trace.json');
    const result = await invoke(['--cases', cases, '--out', out, '--ids', 'S01', '--checkout', root], { FAKE_CLAUDE_TRACE: trace });
    expect(result.code).toBe(0);
    const invocation = JSON.parse(await readFile(trace, 'utf8'));
    expect(invocation.cwd).toBe(path.join(out, 'S01', 'work'));
    expect(invocation.home).toBe(process.env.HOME);
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

  it('replaces a completed attempt from the other agent when usage halts', async () => {
    for (const agent of ['claude', 'codex']) {
      const cases = await fixtureCases(); const out = await outDirectory();
      const other = agent === 'claude' ? 'codex' : 'claude';
      await mkdir(path.join(out, 'S01'), { recursive: true });
      await writeFile(path.join(out, 'S01/meta.json'), JSON.stringify({ id: 'S01', agent: other, status: 'complete' }));
      const args = ['--cases', cases, '--out', out, '--ids', 'S01', '--checkout', root, '--agent', agent];
      const codexHome = path.join(out, 'source-home');
      if (agent === 'codex') { await mkdir(codexHome); await writeFile(path.join(codexHome, 'auth.json'), '{}'); }
      const result = await invoke(args, agent === 'codex'
        ? { FAKE_OPENAI_REMAINING: '14', CHEMDRAFT_STRESS_CODEX_AUTH_HOME: codexHome }
        : { FAKE_USAGE_REMAINING: '14' });
      expect(result.code).toBe(3);
      expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'))).toMatchObject({ agent, status: 'halted-usage' });
    }
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
    expect(invocation).toEqual({ argv: ['exec', '--json', '--skip-git-repo-check', '--', 'Verbatim prompt: use $ and "quotes".'],
      cwd: path.join(caseDir, 'work'), codexHome: home, home: path.join(caseDir, 'home'), path: process.env.PATH,
      ...(process.env.USERPROFILE || process.platform === 'win32' ? { userprofile: process.platform === 'win32' ? path.join(caseDir, 'home') : process.env.USERPROFILE } : {}) });
    const linkedSkill = path.join(caseDir, 'home/.codex/skills/chemdraft');
    expect((await lstat(linkedSkill)).isSymbolicLink()).toBe(true);
    expect(realpathSync.native(linkedSkill)).toBe(realpathSync.native(path.join(root, 'skills/chemdraft')));
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
    const external = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'chemdraft-stress-external-')));
    temporary.push(external);
    const artifact = path.join(external, 'artifact.svg');
    await writeFile(artifact, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await invoke(args, { ...env, FAKE_CODEX_OUTPUT_FILE: artifact, FAKE_CODEX_CHECKOUT: root });
    const caseDir = path.join(out, 'S01');
    const outputs = JSON.parse(await readFile(path.join(caseDir, 'outputs.json'), 'utf8'));
    expect(outputs).toEqual([expect.objectContaining({ originalPath: artifact, requestedPath: artifact, copiedName: '001-artifact.svg', size: 41 })]);
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

  it('retains external CLI and MCP input files with tool provenance after the case', async () => {
    const { out, args, env } = await codexFixture();
    const inputs = await outDirectory();
    const names = ['document', 'batch', 'reaction', 'reaction-file', 'input', 'input-file', 'document-file'];
    const files = names.map((name) => path.join(inputs, `${name} file.${name === 'batch' ? 'data' : 'json'}`));
    const mcpFile = path.join(inputs, 'mcp document.json');
    for (const file of [...files, mcpFile]) await writeFile(file, '{"retained":true}');
    const oversized = path.join(inputs, 'too-many-files');
    await mkdir(oversized);
    await Promise.all(Array.from({ length: 51 }, (_, i) => writeFile(path.join(oversized, `${i}.json`), '{}')));
    const privateFile = path.join(out, 'S01/codex-home/auth.json');
    const options = files.map((file, i) => i % 2 ? `--${names[i]}="${file}"` : `--${names[i]} "${file}"`).join(' ');
    const result = await invoke(args, { ...env, FAKE_CODEX_DOCUMENT_PATH: mcpFile,
      FAKE_CODEX_INPUT_COMMAND: `pnpm -s chemdraft render-document ${options} --jobs "${oversized}" --document-path "${privateFile}"` });
    expect(result.code).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(out, 'S01/outputs.json'), 'utf8'));
    expect(manifest).toHaveLength(8);
    for (const file of [...files, mcpFile]) {
      const entry = manifest.find((item: { requestedPath: string }) => item.requestedPath === file);
      expect(entry).toMatchObject({ requestedPath: file, originalPath: realpathSync.native(file),
        toolCallIndex: file === mcpFile ? 0 : 1, size: 17, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(await readFile(path.join(out, 'S01/outputs', entry.copiedName), 'utf8')).toBe('{"retained":true}');
    }
    const assets = JSON.parse(await readFile(path.join(out, 'S01/assets.json'), 'utf8'));
    expect(assets.filter((item: { originalPath: string }) => [...files, mcpFile].includes(item.originalPath))).toHaveLength(8);
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

  it.each(['darwin', 'win32'])('preserves the parent environment and links the case home on %s', async (platform) => {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const caseDir = platform === 'win32' ? 'C:\\runs\\S01' : '/runs/S01';
    const codexHome = paths.join(caseDir, 'codex-home');
    const parent = { HOME: '/real/home', USERPROFILE: 'C:\\real\\home', PATH: 'node-and-pnpm-path', CODEX_HOME: '/real/codex', EXTRA: 'keep' };
    expect(codexEnvironment(caseDir, codexHome, { platform, environment: parent })).toEqual({
      ...parent, HOME: paths.join(caseDir, 'home'), CODEX_HOME: codexHome,
      USERPROFILE: platform === 'win32' ? paths.join(caseDir, 'home') : parent.USERPROFILE,
    });
    const checkout = await fakeCheckout(false), actualCase = await outDirectory();
    const linkTypes: string[] = [];
    const home = await createCaseHome(actualCase, checkout, { platform,
      link: async (target: string, destination: string, type: 'dir' | 'junction') => {
        linkTypes.push(type); await symlink(target, destination, process.platform === 'win32' ? 'junction' : type);
      } });
    expect(linkTypes).toEqual([platform === 'win32' ? 'junction' : 'dir']);
    expect(realpathSync.native(path.join(home, '.codex/skills/chemdraft'))).toBe(realpathSync.native(path.join(checkout, 'skills/chemdraft')));
    expect(repoAccess([{ name: 'Read', input: { file_path: path.join(home, '.codex/skills/chemdraft/SKILL.md') } }], checkout)
      .some((entry: { classification: string }) => entry.classification === 'foreign-checkout')).toBe(false);
  });

  it.each(['darwin', 'win32'])('detects and caches foreign checkouts from absolute paths on %s', async (platform) => {
    const container = await outDirectory();
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const virtualRoot = platform === 'win32' ? 'C:\\fixtures' : '/fixtures';
    const checkout = paths.join(virtualRoot, 'tested'), foreign = paths.join(virtualRoot, 'other checkout');
    for (const name of ['tested', 'other checkout']) {
      await mkdir(path.join(container, name, 'packages/chemdraft-cli'), { recursive: true });
      await mkdir(path.join(container, name, 'skills/chemdraft'), { recursive: true });
      await writeFile(path.join(container, name, 'packages/chemdraft-cli/package.json'), '{}');
      await writeFile(path.join(container, name, 'skills/chemdraft/SKILL.md'), 'fake skill');
    }
    const translate = (value: string) => {
      const relative = paths.relative(virtualRoot, value);
      if (relative.startsWith('..') || paths.isAbsolute(relative)) throw new Error('Outside fixture');
      return path.join(container, ...relative.split(paths.sep));
    };
    let probes = 0;
    const exists = (value: string) => { probes++; try { return existsSync(translate(value)); } catch { return false; } };
    const realpathNative = (value: string) => paths.join(virtualRoot, ...path.relative(container, realpathSync.native(translate(value))).split(path.sep));
    const options = { platform, exists, realpathNative, cache: new Map() };
    const source = paths.join(foreign, 'packages/chemdraft-cli/source.ts');
    const calls = [
      { name: 'Bash', input: { command: `pnpm -s --dir "${foreign}" chemdraft render` } },
      { name: 'Bash', input: { command: `repo="${foreign}"; cd "$repo"` } },
      { name: 'Bash', input: { command: `node -e "readFileSync('${source.replaceAll('\\', '\\\\')}')"` } },
      ...['Read', 'Grep', 'Glob', 'Write', 'Edit', 'NotebookEdit'].map((name) => ({ name, input: { file_path: source } })),
    ];
    const accesses = repoAccess(calls, checkout, options);
    expect(accesses).toHaveLength(calls.length);
    expect(accesses.every((entry: { classification: string; checkout: string }) => entry.classification === 'foreign-checkout' && entry.checkout === foreign)).toBe(true);
    const before = probes;
    expect(checkoutAt(source, options)).toBe(foreign);
    expect(probes).toBe(before);
    expect(checkoutAt(paths.join(virtualRoot, 'ordinary/missing.txt'), options)).toBeNull();
    const negativeProbes = probes;
    expect(checkoutAt(paths.join(virtualRoot, 'ordinary/another.txt'), options)).toBeNull();
    expect(probes - negativeProbes).toBeLessThanOrEqual(1);
    expect(repoAccess([{ name: 'Read', input: { path: paths.join(checkout, 'skills/chemdraft/SKILL.md') } }], checkout, options))
      .not.toContainEqual(expect.objectContaining({ classification: 'foreign-checkout' }));
  });

  it('fails isolation for foreign checkout commands and accepts the fake home skill path', async () => {
    const foreign = await fakeCheckout(false);
    const { out, args, env } = await codexFixture();
    await invoke(args, { ...env, FAKE_CODEX_INPUT_COMMAND: `pnpm -s --dir "${foreign}" chemdraft render` });
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'))).toMatchObject({ status: 'error',
      reason: `isolation-leak: foreign checkout ${foreign}`, isolation: { verified: false },
      repoAccess: [expect.objectContaining({ classification: 'foreign-checkout', checkout: foreign })] });
    const ownSkill = path.join(out, 'S01/home/.codex/skills/chemdraft/SKILL.md');
    await invoke([...args, '--force'], { ...env, FAKE_CODEX_INPUT_COMMAND: `cat "${ownSkill}"` });
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'))).toMatchObject({ status: 'complete', isolation: { verified: true } });
    // A real user install linking to a foreign checkout is still detected.
    const home = await outDirectory();
    const linked = path.join(home, 'chemdraft');
    await symlink(path.join(foreign, 'skills/chemdraft'), linked, 'junction');
    expect(repoAccess([{ name: 'Edit', input: { file_path: path.join(linked, 'new-file.md') } }], root))
      .toContainEqual(expect.objectContaining({ classification: 'foreign-checkout', checkout: foreign }));
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
    expect(commandInputTargets(String.raw`cmd.exe /d /s /c "pnpm.cmd -s chemdraft render-document --document="C:\Users\x\input file.json" --batch C:\jobs.json"`,
      { platform: 'win32' })).toEqual(['C:\\Users\\x\\input file.json', 'C:\\jobs.json']);
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
