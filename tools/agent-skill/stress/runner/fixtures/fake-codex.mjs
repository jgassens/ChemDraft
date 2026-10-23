#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (process.argv.includes('--version')) {
  process.stdout.write('fake-codex 0.162.1\n');
  process.exit(0);
}
if (process.env.FAKE_CODEX_TRACE) {
  await writeFile(process.env.FAKE_CODEX_TRACE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), codexHome: process.env.CODEX_HOME,
    home: process.env.HOME, userprofile: process.env.USERPROFILE, path: process.env.PATH }));
}
if (process.env.FAKE_CODEX_PLUGIN_LEAK) await mkdir(path.join(process.env.CODEX_HOME, 'plugins'), { recursive: true });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const model = process.env.FAKE_CODEX_MODEL ?? 'fake-default-model';
const call = { id: 'item_1', type: 'mcp_tool_call', server: 'chemdraft', tool: 'render_structure', arguments: { smiles: 'C' } };
if (process.env.FAKE_CODEX_DOCUMENT_PATH) {
  call.tool = 'render_document';
  call.arguments = { documentPath: process.env.FAKE_CODEX_DOCUMENT_PATH };
}
const outputFile = process.env.FAKE_CODEX_OUTPUT_FILE;
const payload = process.env.FAKE_CODEX_SOURCE_READ
  ? `rg ChemDraft "${process.env.FAKE_CODEX_CHECKOUT}/README.md"`
  : process.env.FAKE_CODEX_INPUT_COMMAND ?? (outputFile ? `pnpm -s --dir "${process.env.FAKE_CODEX_CHECKOUT}" chemdraft render --out "${outputFile}"` : null);
const shellCommand = !payload ? 'echo drawn' : process.platform === 'win32' ?
  `cmd.exe /d /s /c "${payload}"` : `/bin/zsh -lc '${payload}'`;
const events = [
  { type: 'thread.started', thread_id: 'fake-thread', ...(process.env.FAKE_CODEX_SESSION_MODEL ? {} : { model }) },
  { type: 'turn.started' },
  { type: 'item.started', item: { ...call, status: 'in_progress' } },
  { type: 'item.completed', item: { ...call, status: 'completed', result: { content: [
    { type: 'image', mimeType: 'image/png', data: png },
    { type: 'text', text: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
  ] }, error: null } },
  { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: shellCommand, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: shellCommand, aggregated_output: 'drawn\n', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: outputFile ? `![Artifact](${outputFile})` : 'Finished drawing.' } },
  { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 5 } },
];
if (process.env.FAKE_CODEX_EXTRA_MCP) events.splice(2, 0, { type: 'item.completed', item: {
  id: 'item_other', type: 'mcp_tool_call', server: 'other', tool: 'unexpected', arguments: {}, result: { content: [] }, error: null, status: 'completed',
} });
if (process.env.FAKE_CODEX_FAILED_MCP) {
  events[3].item.status = 'failed';
  events[3].item.error = { message: 'MCP call failed' };
}
if (process.env.FAKE_CODEX_STARTUP_ONLY) {
  events.splice(2, 2, { type: 'mcp_startup_update', server: 'chemdraft', status: { state: 'ready' } });
}
if (process.env.FAKE_CODEX_VARIANTS) {
  for (const event of events) {
    if (event.item?.type === 'mcp_tool_call') {
      const item = event.item;
      item.serverName = item.server; delete item.server;
      item.toolName = item.tool; delete item.tool;
      item.arguments = JSON.stringify(item.arguments);
      if (item.result) item.result = JSON.stringify(item.result);
    }
    if (event.item?.type === 'command_execution' && event.type === 'item.completed') {
      event.item.aggregatedOutput = event.item.aggregated_output; delete event.item.aggregated_output;
    }
  }
}
if (process.env.FAKE_CODEX_TURN_FAILURE) events.push({ type: 'turn.failed', error: { message: 'Failed turn' } });
if (process.env.FAKE_CODEX_WRITE_EVENT) events.push({ type: 'item.completed', item: {
  id: 'source_write', type: 'file_change', status: 'completed', changes: [{ path: process.env.FAKE_CODEX_WRITE_EVENT, kind: 'update' }]
} });
if (process.env.FAKE_CODEX_SESSION_MODEL) {
  const sessions = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '22');
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, 'fake.jsonl'), `${JSON.stringify({ type: 'turn_context', payload: { model } })}\n`);
}
await writeFile('drawing.txt', 'Agent artifact.\n');
if (process.env.FAKE_CODEX_STDERR_MCP_LEAK) process.stderr.write('rmcp auth error for mcp.box.com\n');
process.stdout.write(`${events.map(JSON.stringify).join('\n')}\n`);
