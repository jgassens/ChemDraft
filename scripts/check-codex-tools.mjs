// Opt-in: calls OpenAI using the user's Codex login. Never part of normal CI.
// node scripts/check-codex-tools.mjs --codex /absolute/path/to/pinned/codex [--model MODEL] [--output DIR]
// node scripts/check-codex-tools.mjs --self-test  (offline assertion tests)
// Also invoked by node scripts/pin-external-tools.mjs --check after pin/flag validation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const maxBytes = 8 * 1024 * 1024;
const prompt = `This is a tool parity check with a stub ChemDraft document. First enumerate EVERY tool
you can call at the top level and inside functions.exec, including deferred tools. Inside exec use
ALL_TOOLS.map(t => t.name), without filtering, and include any other callable tools you can see.
Do not infer tool availability from a skill's text. Do not invoke skills or spawn sub-agents.
Call the ChemDraft name_to_structure tool with name "benzene", then call insert_structures with
items [{"kind":"molecule","smiles":"c1ccccc1"}]. These are explicit requests to write to the stub.
Your final response MUST be exactly one JSON object, with no markdown, containing:
{"topLevelTools":["fully qualified tool names"],"execTools":["exact ALL_TOOLS names"],
"homeInstructions":["quote any AGENTS.md or user-home instructions injected into your context"]}.
Use an empty homeInstructions array if none were injected. Do not quote this prompt or the parity
system prompt. Do not read files to find instructions: report only what is already in context.
List concrete tool names, never wildcard names. Include the complete inventory even if a call fails.`;

const toolDefinitions = [
  { name: "get_document", description: "Get the stub ChemDraft document.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "name_to_structure", description: "Resolve a name to a structure.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "insert_structures", description: "Write structures to the stub document.", inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { kind: { const: "molecule" }, smiles: { type: "string" } }, required: ["kind", "smiles"], additionalProperties: false } } }, required: ["items"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } },
];

function jsonResponse(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

export async function startStub(token, calls, methods) {
  const session = randomBytes(16).toString("hex");
  const route = `/mcp/${randomBytes(16).toString("hex")}`;
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== route) return jsonResponse(response, 404, {});
      if (request.headers.authorization !== `Bearer ${token}`) return jsonResponse(response, 401, {});
      if (request.method !== "POST") return jsonResponse(response, 405, {}, { Allow: "POST" });
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) return jsonResponse(response, 413, {});
        chunks.push(chunk);
      }
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (rpc.method !== "initialize" && request.headers["mcp-session-id"] !== session) return jsonResponse(response, 404, {});
      methods.push(rpc.method);
      const reply = (result, headers) => jsonResponse(response, 200, { jsonrpc: "2.0", id: rpc.id, result }, headers);
      if (rpc.id === undefined) return jsonResponse(response, 202);
      if (rpc.method === "initialize") return reply({ protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "chemdraft", version: "0.0.0-parity" } }, { "Mcp-Session-Id": session });
      if (rpc.method === "ping") return reply({});
      if (rpc.method === "tools/list") return reply({ tools: toolDefinitions });
      if (rpc.method === "tools/call") {
        calls.push({ name: rpc.params?.name, arguments: rpc.params?.arguments });
        const results = {
          get_document: { objects: [], selection: [] },
          name_to_structure: { name: "benzene", smiles: "c1ccccc1" },
          insert_structures: { insertedObjectIds: ["parity-benzene"], selectedObjectIds: ["parity-benzene"] },
        };
        const result = results[rpc.params?.name];
        return reply({ content: [{ type: "text", text: JSON.stringify(result ?? { error: "Unknown tool" }) }], isError: result === undefined });
      }
      jsonResponse(response, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
    } catch {
      jsonResponse(response, 400, { error: "Invalid JSON-RPC request" });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${server.address().port}${route}` };
}

// No shell, even for Cargo or Windows paths. Bound both duration and captured bytes.
async function execute(program, args, { cwd, env, stdin = "", timeout = 180_000 }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    let bytes = 0, failure;
    const timer = setTimeout(() => { failure = "Child timed out"; child.kill("SIGKILL"); }, timeout);
    const collect = (list) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { failure = "Child exceeded output limit"; child.kill("SIGKILL"); }
      else list.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") failure = error.message; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, failure, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.end(stdin);
  });
}

function assertSuccess(result, label) {
  assert.equal(result.failure, undefined, `${label}: ${result.failure}`);
  assert.equal(result.code, 0, `${label} failed (${result.signal ?? result.code}): ${result.stderr}`);
}

export function allowedTool(name) {
  if (typeof name !== "string") return false;
  // tools.* is the JavaScript access prefix, not a distinct capability.
  const tool = name.replace(/^tools\./, "");
  return /^(functions\.(exec|wait|request_user_input|request_user_input_async)|collaboration\.[a-z_]+|apply_patch|clock__curr_time|list_mcp_resource_templates|list_mcp_resources|read_mcp_resource|web__run|mcp__chemdraft__[a-z_]+)$/.test(tool);
}

const words = (text) => text.toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];

export function assertParity({ report, calls, transcript, homeDocuments }) {
  assert.ok(calls.some((call) => call.name === "name_to_structure" && call.arguments?.name?.toLowerCase() === "benzene"), "name_to_structure(benzene) never reached the stub");
  assert.ok(calls.some((call) => call.name === "insert_structures" && call.arguments?.items?.some((item) => item.kind === "molecule" && item.smiles === "c1ccccc1")), "insert_structures(benzene) never reached the stub");
  assert.ok(Array.isArray(report.topLevelTools) && report.topLevelTools.length > 0, "Missing top-level inventory");
  assert.ok(Array.isArray(report.execTools) && report.execTools.length > 0, "Missing exec inventory");
  assert.ok(report.topLevelTools.includes("functions.exec"), "Code mode was not exposed");
  const all = [...report.topLevelTools, ...report.execTools];
  assert.ok(all.some((name) => /^(tools\.)?mcp__chemdraft__/.test(name)), "No ChemDraft tool in the inventory");
  for (const name of all) {
    assert.ok(!/(^|[._])(?:exec_command|fetch|shell|read_file|write_file)($|[._])/.test(name), `Forbidden tool: ${name}`);
    assert.ok(allowedTool(name), `Unreviewed tool: ${name}`);
  }
  assert.deepEqual(report.homeInstructions, [], "User-home instructions were injected");
  // Check all returned model text too, not just the model's claim that homeInstructions is empty.
  // Never send the actual user AGENTS.md to the model or print its contents in diagnostics.
  const normalized = ` ${words(transcript).join(" ")} `;
  for (const document of homeDocuments) {
    const tokens = words(document);
    const size = Math.min(8, tokens.length);
    if (size < 4) continue;
    for (let index = 0; index <= tokens.length - size; index++) {
      assert.ok(!normalized.includes(` ${tokens.slice(index, index + size).join(" ")} `), "Model quoted text from a user-home AGENTS.md");
    }
  }
}

function parseReport(stdout) {
  const events = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "turn.completed"), "No completed model turn");
  assert.ok(!events.some((event) => event.type === "turn.failed" || event.type === "error"), "Model turn failed");
  const messages = events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message").map((event) => event.item.text);
  assert.ok(messages.length, "No agent inventory response");
  return JSON.parse(messages.at(-1).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
}

async function homeDocuments(realHome) {
  if (!realHome) return [];
  const documents = [];
  for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
    try { documents.push(await readFile(join(realHome, name), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return documents;
}

export async function linkParityAuth(source, isolatedHome, platform = process.platform) {
  await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
  const target = join(isolatedHome, "auth.json");
  // Never chmod the link: on Windows that would change the user's original hard-linked file.
  if (platform === "win32") await link(source, target);
  else await symlink(source, target);
  return { source, target, platform };
}

export async function discardParityAuth(auth, warn = console.warn) {
  if (!auth) return;
  try {
    const target = await lstat(auth.target);
    const source = await stat(auth.source);
    const stillLinked = auth.platform === "win32"
      ? target.dev === source.dev && target.ino === source.ino
      : target.isSymbolicLink();
    if (!stillLinked) warn("WARNING: Codex refreshed its temporary login. The temporary copy will be deleted without write-back; your own Codex will refresh on next use.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  finally { await rm(auth.target, { force: true }); }
}

// The CLI itself runs outside its model sandbox. Enforce read-only access to the linked source
// at the OS boundary too: Seatbelt on macOS, a deny-write/delete file share on Windows.
export async function executeWithReadOnlyAuth(program, args, options, auth) {
  if (process.platform === "darwin") {
    const quote = (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    const profile = `(version 1)(allow default)(deny file-write* (subpath ${quote(dirname(auth.source))}))`;
    return execute("/usr/bin/sandbox-exec", ["-p", profile, program, ...args], options);
  }
  if (process.platform !== "win32") throw new Error("Read-only parity auth is supported only on macOS and Windows.");
  const wrapper = join(options.cwd, "read-only-auth.ps1");
  const invocation = join(options.cwd, "read-only-auth.json");
  // Windows PowerShell 5 does not have ProcessStartInfo.ArgumentList. Encode native argv by
  // the documented CommandLineToArgvW rules, not by PowerShell or cmd.exe interpolation.
  await writeFile(wrapper, String.raw`param([string]$Invocation)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $Invocation -Encoding UTF8 -Raw | ConvertFrom-Json
function Quote-Argument([string]$value) {
  return '"' + [regex]::Replace([regex]::Replace($value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
$authLock = [IO.File]::Open($request.auth, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $request.program
  $info.Arguments = (($request.argv | ForEach-Object { Quote-Argument $_ }) -join ' ')
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $child = [Diagnostics.Process]::Start($info)
  $out = $child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $err = $child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  [Console]::OpenStandardInput().CopyTo($child.StandardInput.BaseStream)
  $child.StandardInput.Close()
  if (-not $child.WaitForExit([int]$request.timeout)) { $child.Kill(); throw 'Codex parity timed out' }
  $out.Wait(); $err.Wait()
  exit $child.ExitCode
} finally { $authLock.Dispose() }
`, { mode: 0o600 });
  await writeFile(invocation, JSON.stringify({ auth: auth.source, program, argv: args, timeout: options.timeout ?? 180_000 }), { mode: 0o600 });
  try {
    const powershell = join(options.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return await execute(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper, invocation], { ...options, timeout: (options.timeout ?? 180_000) + 5000 });
  } finally { await rm(wrapper, { force: true }); await rm(invocation, { force: true }); }
}

export async function checkCodexTools({ binary, model, output }) {
  assert.ok(binary, "--codex must name the pinned native binary (not a shell or npm shim)");
  assert.ok(!/\.(cmd|bat)$/i.test(binary), "Batch shims are not supported");
  const directory = output ? resolve(output) : await mkdtemp(join(tmpdir(), "chemdraft-codex-parity-"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const runDir = await mkdtemp(join(directory, "run-"));
  // Always fresh, even when artifacts are written to a reused --output directory. No production
  // prepare/reconcile helper sees this home, including the Rust template-rendering test.
  const codexHome = await mkdtemp(join(tmpdir(), "chemdraft-parity-home-"));
  const realHome = process.env.CODEX_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), ".codex");
  const requestPath = join(runDir, "render-request.json"), manifestPath = join(runDir, "rendered.json");
  const token = randomBytes(32).toString("hex");
  const calls = [], methods = [];
  const { server, url } = await startStub(token, calls, methods);
  let manifest, auth;
  console.log(`Codex real-model parity artifacts: ${runDir}`);
  try {
    auth = await linkParityAuth(await realpath(join(realHome, "auth.json")), codexHome);
    await writeFile(join(runDir, "system-prompt.md"), "You are the ChemDraft tool-parity test assistant. Follow the user's inventory and stub-tool requests exactly.\n", { mode: 0o600 });
    const parentEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|windir|PATH|LANG|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i.test(key)));
    for (const key of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) parentEnv[key] = codexHome;
    await writeFile(requestPath, JSON.stringify({ binary: resolve(binary), runDir, codexHome, parentEnv, mcpUrl: url, token, model, prompt, output: manifestPath }), { mode: 0o600 });
    // Pure Rust template/environment rendering; no auth filesystem access or vendor process.
    const rendered = await execute("cargo", ["test", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml", "external_tools::tests::print_codex_template_args", "--", "--ignored", "--exact", "--nocapture"], {
      cwd: repoRoot, env: { ...process.env, CHEMDRAFT_CODEX_PARITY_REQUEST: requestPath }, timeout: 900_000,
    });
    assertSuccess(rendered, "Rust template renderer");
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    // These files contain the loopback token and possibly proxy environment values, so discard them.
    await rm(requestPath); await rm(manifestPath);
    await writeFile(join(runDir, "argv.json"), JSON.stringify(manifest.args, null, 2), { mode: 0o600 });
    console.log(`Exact Codex argv: ${JSON.stringify(manifest.args)}`);
    assert.equal(manifest.env.CODEX_HOME, codexHome, "Parity must use its disposable home");
    const options = { cwd: runDir, env: manifest.env };
    const version = await executeWithReadOnlyAuth(manifest.program, ["--version"], options, auth);
    assertSuccess(version, "Codex version");
    assert.equal(version.stdout.trim(), `codex-cli ${manifest.version}`, "The binary must match pins.rs");
    const login = await executeWithReadOnlyAuth(manifest.program, ["login", "status"], options, auth);
    assertSuccess(login, "Codex login status (sign in using your real home first)");
    assert.match(`${login.stdout}\n${login.stderr}`, /^Logged in/m, "Isolated home did not authenticate");
    const result = await executeWithReadOnlyAuth(manifest.program, manifest.args, { ...options, stdin: manifest.stdin, timeout: 300_000 }, auth);
    const redact = (text) => text.replaceAll(token, "[REDACTED_MCP_TOKEN]");
    await writeFile(join(runDir, "stdout.jsonl"), redact(result.stdout), { mode: 0o600 });
    await writeFile(join(runDir, "stderr.txt"), redact(result.stderr), { mode: 0o600 });
    assertSuccess(result, "Codex model run");
    const report = parseReport(result.stdout);
    assertParity({ report, calls, transcript: result.stdout, homeDocuments: await homeDocuments(realHome) });
    await writeFile(join(runDir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`PASS: read/write MCP calls, explicit tool allowlist, and no home instructions (${process.platform}-${process.arch}).`);
    console.log(`Run the same check on ${process.platform === "win32" ? "macOS" : "Windows"} before release.`);
    return { runDir, report };
  } finally {
    server.closeAllConnections();
    // Artifact or socket cleanup failure must never skip removing temporary credentials.
    const cleanup = await Promise.allSettled([
      (async () => { try { await discardParityAuth(auth); } finally { await rm(codexHome, { recursive: true, force: true }); } })(),
      rm(requestPath, { force: true }), rm(manifestPath, { force: true }),
      writeFile(join(runDir, "mcp-calls.json"), JSON.stringify({ methods, calls }, null, 2), { mode: 0o600 }),
      new Promise((closed) => server.close(closed)),
    ]);
    const failed = cleanup.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
}

async function selfTest() {
  const report = { topLevelTools: ["functions.exec", "functions.wait", "collaboration.spawn_agent"], execTools: ["mcp__chemdraft__name_to_structure", "mcp__chemdraft__insert_structures", "apply_patch", "web__run"], homeInstructions: [] };
  const calls = [{ name: "name_to_structure", arguments: { name: "benzene" } }, { name: "insert_structures", arguments: { items: [{ kind: "molecule", smiles: "c1ccccc1" }] } }];
  const fixture = { report, calls, transcript: JSON.stringify(report), homeDocuments: ["My secret user instructions have eight distinctive private words."] };
  assertParity(fixture);
  for (const tool of ["exec_command", "fetch", "shell", "read_file", "write_file", "image_gen__imagegen", "new_unknown_tool", "mcp__other__get_document", "mcp__chemdraft__*"]) {
    assert.throws(() => assertParity({ ...fixture, report: { ...report, execTools: [...report.execTools, tool] } }));
  }
  assert.throws(() => assertParity({ ...fixture, calls: calls.slice(0, 1) }));
  assert.throws(() => assertParity({ ...fixture, report: { ...report, execTools: [] } }));
  assert.throws(() => assertParity({ ...fixture, report: { ...report, homeInstructions: ["injected"] } }));
  assert.throws(() => assertParity({ ...fixture, transcript: "My secret user instructions have eight distinctive private words." }));
  assert.deepEqual(parseReport(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(report) } })}\n{"type":"turn.completed"}`), report);
  assert.throws(() => parseReport('{"type":"turn.failed"}'));
  const temporary = await mkdtemp(join(tmpdir(), "chemdraft-auth-self-test-"));
  try {
    const source = join(temporary, "fake-auth.json");
    const original = '{"last_refresh":"2026-10-22T12:00:00Z","tokens":{"refresh_token":"fake-old"}}';
    await writeFile(source, original, { mode: 0o600 });
    for (const platform of process.platform === "win32" ? ["win32"] : ["darwin", "win32"]) {
      for (const refresh of [false, true]) {
        const auth = await linkParityAuth(source, await mkdtemp(join(temporary, "home-")), platform);
        if (refresh) {
          await rm(auth.target);
          await writeFile(auth.target, '{"last_refresh":"2026-10-23T12:00:00Z","tokens":{"refresh_token":"fake-new"}}', { mode: 0o600 });
        }
        const warnings = [];
        await discardParityAuth(auth, (text) => warnings.push(text));
        assert.equal(warnings.length, Number(refresh));
        assert.ok(warnings.every((text) => !text.includes("fake-")));
        assert.equal(await readFile(source, "utf8"), original, "Parity must never write back credentials");
        await assert.rejects(lstat(auth.target), { code: "ENOENT" });
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
  console.log("Codex parity assertion self-tests passed (offline).");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-test") return selfTest();
  if (args.includes("--help")) {
    console.log("Usage: node scripts/check-codex-tools.mjs --codex PINNED_BINARY [--model MODEL] [--output DIR]\nCalls OpenAI using your Codex login; run on macOS and Windows. Offline: --self-test.");
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = { "--codex": "binary", "--model": "model", "--output": "output" }[args[index]];
    assert.ok(key && args[index + 1], `Unknown or incomplete option: ${args[index]}`);
    options[key] = args[++index];
  }
  await checkCodexTools(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
