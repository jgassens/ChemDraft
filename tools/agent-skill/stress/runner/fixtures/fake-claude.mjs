#!/usr/bin/env node
import { appendFile, writeFile } from 'node:fs/promises';

if (process.argv.includes('--version')) {
  process.stdout.write('fake-claude 1.0.0\n');
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_TRACE) {
  await writeFile(process.env.FAKE_CLAUDE_TRACE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME }));
}
if (process.env.FAKE_CLAUDE_SLEEP === '1') {
  setInterval(() => {}, 1_000);
} else {
  const extra = process.env.FAKE_CLAUDE_EXTRA_MCP === '1' ? [{ name: 'other', status: 'connected' }] : [];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const events = [
    { type: 'system', subtype: 'init', mcp_servers: [{ name: 'chemdraft', status: 'connected' }, ...extra], skills: [{ name: 'chemdraft' }], tools: ['mcp__chemdraft__render_structure'] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call_1', name: 'mcp__chemdraft__render_structure', input: { smiles: 'C' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      { type: 'text', text: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }
    ] }] } },
    { type: 'result', result: 'Finished drawing.', num_turns: 1, usage: { input_tokens: 2 }, total_cost_usd: 0.01 }
  ];
  if (process.env.FAKE_CLAUDE_SKILL) events[0].skills.push({ name: process.env.FAKE_CLAUDE_SKILL });
  if (process.env.FAKE_CLAUDE_RESULT_ERROR) {
    events.at(-1).is_error = process.env.FAKE_CLAUDE_RESULT_ERROR === 'is_error';
    events.at(-1).subtype = process.env.FAKE_CLAUDE_RESULT_ERROR;
  }
  if (process.env.FAKE_CLAUDE_WRITE) {
    await writeFile(process.env.FAKE_CLAUDE_WRITE, 'checkout changed');
  }
  if (process.env.FAKE_CLAUDE_WRITE_EVENT) events.splice(1, 0, { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'source_write', name: 'Edit', input: { file_path: process.env.FAKE_CLAUDE_WRITE_EVENT } }
  ] } });
  process.stdout.write(`${events.map(JSON.stringify).join('\n')}\n`);
}
