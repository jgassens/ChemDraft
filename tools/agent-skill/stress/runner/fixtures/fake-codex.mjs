#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (process.argv.includes('--version')) {
  process.stdout.write('fake-codex 0.162.1\n');
  process.exit(0);
}
if (process.env.FAKE_CODEX_TRACE) {
  await writeFile(process.env.FAKE_CODEX_TRACE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), codexHome: process.env.CODEX_HOME }));
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const model = process.env.FAKE_CODEX_MODEL ?? 'fake-default-model';
const call = { id: 'item_1', type: 'mcp_tool_call', server: 'chemdraft', tool: 'render_structure', arguments: { smiles: 'C' } };
const events = [
  { type: 'thread.started', thread_id: 'fake-thread', ...(process.env.FAKE_CODEX_SESSION_MODEL ? {} : { model }) },
  { type: 'turn.started' },
  { type: 'item.started', item: { ...call, status: 'in_progress' } },
  { type: 'item.completed', item: { ...call, status: 'completed', result: { content: [
    { type: 'image', mimeType: 'image/png', data: png },
    { type: 'text', text: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
  ] } } },
  { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'echo drawn', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'echo drawn', aggregated_output: 'drawn\n', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Finished drawing.' } },
  { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 5 } },
];
if (process.env.FAKE_CODEX_EXTRA_MCP) events.splice(1, 0, { type: 'mcp_startup_update', server: 'other', status: { state: 'ready' } });
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
if (process.env.FAKE_CODEX_SESSION_MODEL) {
  const sessions = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '22');
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, 'fake.jsonl'), `${JSON.stringify({ type: 'turn_context', payload: { model } })}\n`);
}
await writeFile('drawing.txt', 'Agent artifact.\n');
process.stdout.write(`${events.map(JSON.stringify).join('\n')}\n`);
