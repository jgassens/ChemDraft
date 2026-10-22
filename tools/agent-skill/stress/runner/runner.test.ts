import { mkdtemp, readFile, rm, writeFile, lstat, readdir, mkdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

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

async function invoke(args: string[], env: Record<string, string | undefined> = {}) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [runner, ...args], { cwd: root, env: { ...process.env, CHEMDRAFT_STRESS_CLAUDE_BIN: fakeClaude, CHEMDRAFT_STRESS_CODEX_BIN: fakeCodex, CHEMDRAFT_STRESS_AGENTCTL_BIN: fakeAgentctl, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('stress runner', () => {
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
    expect(JSON.parse(await readFile(path.join(caseDir, 'files.json'), 'utf8'))).toEqual([expect.objectContaining({ path: 'drawing.txt', size: 16 })]);
    expect(JSON.parse(await readFile(path.join(caseDir, 'meta.json'), 'utf8'))).toMatchObject({ agent: 'codex', codexVersion: 'fake-codex 0.162.1', status: 'complete', model: 'fake-default-model', numTurns: 1,
      usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 5 }, mcpServers: [{ name: 'chemdraft', status: 'connected' }], isolation: { verified: true, configuredMcpServers: ['chemdraft'] } });
    expect(JSON.parse(await readFile(path.join(out, 'run.json'), 'utf8')).agent).toBe('codex');
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

  it('halts Codex when the OpenAI usage pool is unavailable', async () => {
    const { args, env } = await codexFixture();
    expect((await invoke(args, { ...env, FAKE_USAGE_NO_OPENAI: '1' })).code).toBe(3);
    expect(existsSync(env.FAKE_CODEX_TRACE)).toBe(false);
  });

  it('clearly rejects missing Codex auth without running an agent', async () => {
    const { args, env, sourceHome } = await codexFixture();
    await rm(path.join(sourceHome, 'auth.json'));
    const result = await invoke(args, env);
    expect(result.code).toBe(2); expect(result.stderr).toContain('Codex auth.json is missing:');
    expect(existsSync(env.FAKE_CODEX_TRACE)).toBe(false);
  });

  it.each(['FAKE_CODEX_EXTRA_MCP', 'FAKE_CODEX_FAILED_MCP'])('fails Codex isolation for %s', async (flag) => {
    const { out, args, env } = await codexFixture();
    await invoke(args, { ...env, [flag]: '1' });
    expect(JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'))).toMatchObject({ status: 'error', reason: 'isolation', isolation: { verified: false } });
  });

  it('accepts a Codex MCP startup event without a tool call', async () => {
    const { out, args, env } = await codexFixture();
    await invoke(args, { ...env, FAKE_CODEX_STARTUP_ONLY: '1' });
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
