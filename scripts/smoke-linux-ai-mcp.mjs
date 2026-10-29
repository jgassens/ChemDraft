#!/usr/bin/env node
// Offline integration smoke: real pinned Codex code mode -> fixture MCP inside Linux Flatpak.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const options = { context: 'sdk', sdkBuildDir: join(root, 'artifacts/flatpak-build'), appId: 'org.chemdraft.desktop.dev', outputDir: join(root, 'artifacts') };
const argumentsList = process.argv.slice(2);
if (argumentsList.includes('--help') || argumentsList.includes('-h')) {
  console.log(`Usage: node scripts/smoke-linux-ai-mcp.mjs --codex-bin-dir PATH [options]

  --codex-bin-dir PATH   Directory containing the verified pinned codex + codex-code-mode-host
  --context sdk|runtime GNOME SDK build sandbox or installed Flatpak runtime (default: sdk)
  --sdk-build-dir PATH  Initialized SDK directory (default: artifacts/flatpak-build)
  --app-id ID           Installed Flatpak ID (default: org.chemdraft.desktop.dev)
  --output-dir PATH     Evidence directory (default: artifacts/)
  --help                Show this help

Uses real Codex with ChemDraft's production read-only policy and disabled shell features.
Both the Responses model and MCP server are local fixtures. No provider account or model billing.
Uses a new empty HOME/CODEX_HOME and excludes three available CPUs for the operating system.`);
  process.exit(0);
}
const optionKeys = { '--codex-bin-dir': 'codexBinDir', '--context': 'context', '--sdk-build-dir': 'sdkBuildDir', '--app-id': 'appId', '--output-dir': 'outputDir' };
for (let index = 0; index < argumentsList.length; index++) {
  const key = optionKeys[argumentsList[index]];
  const value = argumentsList[++index];
  if (!key || !value || value.startsWith('--') || /[\r\n\0]/.test(value)) throw new Error('Invalid argument; use --help.');
  options[key] = value;
}
if (process.platform !== 'linux') throw new Error('The Linux Flatpak smoke must run on Linux.');
if (!options.codexBinDir) throw new Error('--codex-bin-dir is required; use explicitly verified release binaries.');
if (!['sdk', 'runtime'].includes(options.context)) throw new Error('--context must be sdk or runtime.');
if (!/^[A-Za-z0-9_.-]+$/.test(options.appId)) throw new Error('Invalid Flatpak app ID.');
options.codexBinDir = resolve(root, options.codexBinDir);
options.sdkBuildDir = resolve(root, options.sdkBuildDir);
options.outputDir = resolve(root, options.outputDir);
const allowedMask = /^Cpus_allowed_list:\s*(.+)$/m.exec(await readFile('/proc/self/status', 'utf8'))?.[1];
if (!allowedMask) throw new Error('Cannot determine allowed CPUs.');
const cpus = allowedMask.trim().split(',').flatMap(part => {
  const [first, last = first] = part.split('-').map(Number);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
});
if (cpus.length < 4) throw new Error('At least four allowed CPUs are needed to reserve three for the OS.');
const affinity = spawnSync('taskset', ['--pid', '--cpu-list', cpus.slice(0, -3).join(','), String(process.pid)], { stdio: 'ignore' });
if (affinity.status !== 0) throw new Error('Could not reserve three CPU cores.');
for (const name of ['codex', 'codex-code-mode-host']) await access(join(options.codexBinDir, name));
const mode = options.context;
await mkdir(options.outputDir, { recursive: true });
const profile = await mkdtemp(join(options.outputDir, `linux-codex-${mode}-`));
await mkdir(join(profile, 'home', 'codex'), { recursive: true });
await mkdir(join(profile, 'tmp'));
await mkdir(join(profile, 'run'));
await writeFile(join(profile, 'instructions.md'), 'This is an entirely offline transport fixture. Call only the configured ChemDraft echo tool.');
const requests = [];
const mcpCalls = [];
const failures = [];
let modelCalls = 0;
const complete = id => ({ type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: null, output_tokens_details: null } } });
const sse = (response, events) => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
};
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('fixture input too large'); chunks.push(chunk); }
    let bytes = Buffer.concat(chunks);
    if (request.headers['content-encoding'] === 'zstd') bytes = zlib.zstdDecompressSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
    if (request.headers['content-encoding'] === 'gzip') bytes = zlib.gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
    const body = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
    requests.push({ method: request.method, url: request.url, body });
    if (request.url === '/mcp') {
      if (request.method === 'GET') { response.writeHead(405); response.end(); return; }
      if (request.method === 'DELETE') { response.writeHead(200); response.end(); return; }
      assert.equal(request.headers.authorization, 'Bearer fixture-only-not-a-secret');
      if (body.id === undefined) { response.writeHead(202); response.end(); return; }
      let result;
      if (body.method === 'initialize') result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ChemDraft offline Linux fixture', version: '1.0' } };
      else if (body.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Return the fixture text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, annotations: { readOnlyHint: true } }] };
      else if (body.method === 'tools/call') { mcpCalls.push(body.params); result = { content: [{ type: 'text', text: 'MCP_LINUX_OK:' + body.params.arguments.text }], isError: false }; }
      else throw new Error('Unexpected MCP method ' + body.method);
      response.writeHead(200, { 'content-type': 'application/json', 'Mcp-Session-Id': 'offline-linux-fixture' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/responses') {
      modelCalls++;
      if (modelCalls === 1) {
        sse(response, [
          { type: 'response.created', response: { id: 'fixture-1' } },
          { type: 'response.output_item.done', item: { type: 'custom_tool_call', call_id: 'fixture-call', name: 'exec', input: 'const result = await tools.mcp__chemdraft__echo({ text: "flatpak-code-mode" }); text(result);' } },
          complete('fixture-1'),
        ]);
      } else {
        sse(response, [
          { type: 'response.created', response: { id: 'fixture-2' } },
          { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'fixture-message', content: [{ type: 'output_text', text: 'Offline fixture complete.' }] } },
          complete('fixture-2'),
        ]);
      }
      return;
    }
    response.writeHead(404); response.end('offline fixture only');
  } catch (error) { failures.push(String(error.stack)); response.writeHead(500); response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const catalog = await readFile(join(root, 'apps/desktop/src-tauri/src/external_tools/catalog.rs'), 'utf8');
const disabled = [...catalog.split('pub const CODEX_FEATURES_DISABLE')[1].split('];', 1)[0].matchAll(/"([a-z0-9_]+)"/g)].map(match => match[1]);
const cliArgs = ['exec', '--json', '-C', join(profile, 'run'), '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only'];
for (const name of disabled) cliArgs.push('--disable', name);
for (const config of [
  'approval_policy="never"', 'web_search="live"', 'check_for_update_on_startup=false', 'analytics.enabled=false',
  `mcp_servers.chemdraft.url="http://127.0.0.1:${port}/mcp"`,
  'mcp_servers.chemdraft.bearer_token_env_var="CHEMDRAFT_MCP_TOKEN"',
  'mcp_servers.chemdraft.required=true', 'mcp_servers.chemdraft.default_tools_approval_mode="approve"',
  'mcp_servers.chemdraft.startup_timeout_sec=30', 'mcp_servers.chemdraft.tool_timeout_sec=480',
  `model_instructions_file=${JSON.stringify(join(profile, 'instructions.md'))}`,
  // Test-only transport points entirely at the loopback fixture and never authenticates to OpenAI.
  'model_provider="offline_fixture"', 'model_providers.offline_fixture.name="Offline fixture"',
  `model_providers.offline_fixture.base_url="http://127.0.0.1:${port}/v1"`,
  'model_providers.offline_fixture.wire_api="responses"', 'model_providers.offline_fixture.requires_openai_auth=false',
  'model_providers.offline_fixture.request_max_retries=0', 'model_providers.offline_fixture.stream_max_retries=0',
]) cliArgs.push('-c', config);
cliArgs.push('-m', 'gpt-6.1-sol', '-');
const executable = join(options.codexBinDir, 'codex');
const childEnvironment = {
  HOME: join(profile, 'home'), CODEX_HOME: join(profile, 'home', 'codex'), TMPDIR: join(profile, 'tmp'),
  PATH: '/usr/bin:/bin', LANG: 'en_US.utf8', LC_ALL: 'en_US.utf8', NO_PROXY: '*',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1',
  CHEMDRAFT_MCP_TOKEN: 'fixture-only-not-a-secret',
};
const args = mode === 'runtime'
  ? ['run', ...Object.entries(childEnvironment).map(([key, value]) => `--env=${key}=${value}`), `--command=${executable}`, options.appId, ...cliArgs]
  : ['build', '--filesystem=home', '--share=network', ...Object.entries(childEnvironment).map(([key, value]) => `--env=${key}=${value}`), options.sdkBuildDir, executable, ...cliArgs];
const clientEnv = Object.fromEntries(['HOME', 'PATH', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
let stdout = '', stderr = '';
const child = spawn('flatpak', args, { cwd: root, env: clientEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
child.stdin.end('Call the offline ChemDraft echo fixture, then finish.');
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, 90000);
const exitCode = await new Promise(resolve => {
  child.once('error', error => { failures.push(String(error)); resolve(null); });
  child.once('exit', resolve);
});
clearTimeout(timer);
await new Promise(resolve => server.close(resolve));
await writeFile(join(profile, 'stdout.jsonl'), stdout);
await writeFile(join(profile, 'stderr.log'), stderr);
await writeFile(join(profile, 'requests.json'), JSON.stringify(requests, null, 2));
const outputs = requests.filter(request => request.url === '/v1/responses').flatMap(request => request.body?.input ?? []).filter(item => item.type === 'custom_tool_call_output');
const report = { context: mode, status: exitCode === 0 && mcpCalls.length === 1 && JSON.stringify(outputs).includes('MCP_LINUX_OK:flatpak-code-mode') && !failures.length ? 'PASS' : 'FAIL', exitCode, modelCalls, mcpCalls, outputs, failures, profile, stdoutTail: stdout.slice(-4000), stderrTail: stderr.slice(-4000), productionSandbox: 'read-only', productionShellFeaturesDisabled: true, credentialsUsed: false, providerRequests: 'loopback fixture only' };
await writeFile(join(options.outputDir, `linux-codex-code-mode-${mode}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exitCode = 1;
