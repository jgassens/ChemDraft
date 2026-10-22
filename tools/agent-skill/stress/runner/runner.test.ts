import { mkdtemp, readFile, rm, writeFile, lstat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');
const runner = path.join(root, 'tools/agent-skill/stress/runner/run.mjs');
const fakeClaude = path.join(root, 'tools/agent-skill/stress/runner/fixtures/fake-claude.mjs');
const fakeAgentctl = path.join(root, 'tools/agent-skill/stress/runner/fixtures/fake-agentctl.mjs');
const temporary: string[] = [];

async function fixtureCases() {
  const directory = await mkdtemp(path.join(tmpdir(), 'chemdraft-stress-cases-'));
  temporary.push(directory);
  const file = path.join(directory, 'cases.json');
  await writeFile(file, JSON.stringify({ cases: [
    { id: 'S01', split: 'dev', prompt: 'Verbatim prompt: use $ and "quotes".' },
    { id: 'S02', split: 'heldout', prompt: 'Second prompt.' }
  ] }));
  return file;
}

async function outDirectory() { const value = await mkdtemp(path.join(tmpdir(), 'chemdraft-stress-out-')); temporary.push(value); return value; }

async function invoke(args: string[], env: Record<string, string | undefined> = {}) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [runner, ...args], { cwd: root, env: { ...process.env, CHEMDRAFT_STRESS_CLAUDE_BIN: fakeClaude, CHEMDRAFT_STRESS_AGENTCTL_BIN: fakeAgentctl, ...env } });
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
    expect(invocation.argv).toEqual(expect.arrayContaining(['--strict-mcp-config', '--setting-sources', 'project', '--bare', '--allowedTools']));
    const copied = path.join(out, 'S01/work/.claude/skills/chemdraft');
    expect((await lstat(copied)).isSymbolicLink()).toBe(false);
    expect((await readdir(path.join(out, 'S01/images'))).sort()).toEqual(['001-mcp__chemdraft__render_structure.png', '002-mcp__chemdraft__render_structure.svg']);
    expect(await readFile(path.join(out, 'S01/final.md'), 'utf8')).toBe('Finished drawing.');
    const meta = JSON.parse(await readFile(path.join(out, 'S01/meta.json'), 'utf8'));
    expect(meta).toMatchObject({ id: 'S01', status: 'complete', model: 'claude-sonnet-5-5', numTurns: 1, total_cost_usd: 0.01 });
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
});
