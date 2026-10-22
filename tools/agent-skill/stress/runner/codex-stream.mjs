import { withoutBase64 } from './stream.mjs';

function jsonValue(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function mcpResult(value) {
  value = jsonValue(value);
  if (Array.isArray(value)) return { content: value };
  if (value && typeof value === 'object') return { ...value, content: value.content ?? [] };
  return { content: value == null ? [] : [{ type: 'text', text: String(value) }] };
}

// Public exec JSONL uses item.* envelopes. Also accept the snake/camel case
// fields and event_msg startup envelopes present in Codex protocol events.
export function inspectCodexStream(events) {
  const calls = new Map();
  const servers = new Set();
  let connected = false, final = '', model = null, numTurns = 0, usage = null, failed = false;
  for (const envelope of events) {
    const event = envelope.type === 'event_msg' ? envelope.payload : envelope;
    if (!event) continue;
    model = reportedCodexModel([envelope]) ?? model;
    if (event.type === 'turn.completed') {
      numTurns++;
      if (event.usage) {
        usage ??= {};
        for (const [key, value] of Object.entries(event.usage)) if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
      }
    }
    if (event.type === 'turn.failed' || event.type === 'error') failed = true;
    if (event.type === 'mcp_startup_update' || event.type === 'mcp.startup_update') {
      const server = event.server ?? event.name;
      if (server) servers.add(server);
      const status = event.status?.state ?? event.status;
      if (server === 'chemdraft' && ['ready', 'connected'].includes(status)) connected = true;
    }
    const item = event.item;
    if (!item || !['item.started', 'item.updated', 'item.completed'].includes(event.type)) continue;
    if (item.type === 'agent_message' && event.type === 'item.completed' && item.phase !== 'commentary') final = item.text ?? '';
    if (!['mcp_tool_call', 'command_execution'].includes(item.type)) continue;
    const key = item.id ?? item.call_id ?? item.callId;
    if (!key) continue;
    const call = calls.get(key) ?? { name: '', input: {}, result: null };
    calls.set(key, call);
    if (item.type === 'mcp_tool_call') {
      const server = item.server ?? item.server_name ?? item.serverName;
      const tool = item.tool ?? item.tool_name ?? item.toolName;
      if (server) servers.add(server);
      if (server && tool) call.name = `mcp__${server}__${tool}`;
      if (item.arguments !== undefined || item.input !== undefined) call.input = jsonValue(item.arguments ?? item.input);
      if (item.result != null) call.result = mcpResult(item.result);
      else if (item.error) call.result = { isError: true, content: [{ type: 'text', text: typeof item.error === 'string' ? item.error : JSON.stringify(item.error) }] };
      // A completed or failed call both prove Codex addressed this named MCP server.
      // Do not turn a tool failure into an isolation failure: the case result reports
      // that failure separately.
      if (server === 'chemdraft' && event.type === 'item.completed') connected = true;
    } else {
      call.name = 'Bash';
      if (item.command !== undefined) call.input = { command: item.command };
      if (event.type === 'item.completed') call.result = { content: [{ type: 'text', text: item.aggregated_output ?? item.aggregatedOutput ?? item.output ?? '' }] };
    }
  }
  const rawCalls = [...calls.values()];
  // Reuse the same asset writer as Claude, before stripping image data.
  const assetEvents = rawCalls.flatMap((call, index) => [
    { content: [{ type: 'tool_use', id: String(index), name: call.name }] },
    { content: [{ type: 'tool_result', tool_use_id: String(index), content: call.result?.content ?? [] }] },
  ]);
  return { toolCalls: withoutBase64(rawCalls), assetEvents, final, model, numTurns, usage, failed,
    // Runner-level config and filesystem checks complete Codex isolation. Keep this
    // event-only signal for callers that need the observed server names.
    isolated: servers.size === 0 || (servers.size === 1 && servers.has('chemdraft')),
    mcpServers: [...servers].map((name) => ({ name, status: name === 'chemdraft' && connected ? 'connected' : 'unknown' })),
    tools: [...new Set(rawCalls.map((call) => call.name))] };
}

export function reportedCodexModel(events) {
  let model = null;
  for (const event of events) {
    const payload = event?.payload ?? event;
    const value = payload?.model ?? payload?.model_name ?? payload?.modelName ?? payload?.config?.model ?? payload?.settings?.model ?? payload?.thread_settings?.model;
    if (typeof value === 'string') model = value;
  }
  return model;
}
