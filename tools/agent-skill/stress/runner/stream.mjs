import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const safeName = (value) => String(value || 'tool').replace(/[^a-zA-Z0-9._-]/g, '_');

export function parseStream(raw) {
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* Keep malformed raw lines in the transcript. */ }
  }
  return events;
}

function contentOf(event) {
  return event?.message?.content ?? event?.content ?? [];
}

function isInit(event) {
  return event?.subtype === 'init' || event?.type === 'init' || event?.type === 'system' && event?.subtype === 'init';
}

function names(items) {
  return (Array.isArray(items) ? items : []).map((item) => typeof item === 'string' ? item : item?.name).filter(Boolean);
}

export function inspectStream(events, { userSkillsPath = path.join(homedir(), '.claude', 'skills') } = {}) {
  const init = events.find(isInit);
  const result = [...events].reverse().find((event) => event?.type === 'result');
  const uses = new Map();
  const toolCalls = [];
  let assistantTurns = 0;

  for (const event of events) {
    if (event?.type === 'assistant') assistantTurns++;
    for (const block of contentOf(event)) {
      if (block?.type === 'tool_use') {
        const call = { id: block.id, name: block.name, input: block.input ?? {}, result: null };
        uses.set(block.id, call);
        toolCalls.push(call);
      }
      if (block?.type === 'tool_result') {
        const call = uses.get(block.tool_use_id);
        if (call) call.result = block.is_error ? { is_error: true, content: withoutBase64(block.content) } : withoutBase64(block.content);
      }
    }
  }

  const servers = init?.mcp_servers ?? init?.mcpServers ?? [];
  const skills = init?.skills ?? init?.available_skills ?? [];
  const leakedSkills = names(skills).filter((name) => name !== 'chemdraft' &&
    !/[\\/]|^\.\.?$/.test(name) && existsSync(path.join(userSkillsPath, name)) && statSync(path.join(userSkillsPath, name)).isDirectory());
  const isolated = Array.isArray(servers) && servers.length === 1 &&
    servers[0]?.name === 'chemdraft' && servers[0]?.status === 'connected' && names(skills).includes('chemdraft') && !leakedSkills.length;
  const final = result?.result ?? result?.final ?? result?.message?.content ?? '';
  return {
    init,
    result,
    toolCalls,
    isolated,
    isolationLeak: leakedSkills.length > 0,
    leakedSkills,
    failed: result?.is_error === true || /^error(?:_|$)/.test(result?.subtype ?? ''),
    failureReason: result?.is_error === true || /^error(?:_|$)/.test(result?.subtype ?? '') ?
      [result?.subtype, ...(result?.errors ?? []), typeof final === 'string' ? final : ''].filter(Boolean).join(': ') : null,
    final: typeof final === 'string' ? final : JSON.stringify(final),
    numTurns: result?.num_turns ?? result?.numTurns ?? assistantTurns,
  };
}

export function withoutBase64(value) {
  if (typeof value === 'string' || value == null) return value;
  if (Array.isArray(value)) return value.map(withoutBase64);
  if (typeof value !== 'object') return value;
  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'data' && (value.type === 'image' || value.type === 'base64' || value.source?.type === 'base64')) continue;
    copy[key] = withoutBase64(child);
  }
  return copy;
}

function imageData(block) {
  return block?.source?.data ?? block?.data;
}

function resourceData(block) {
  const resource = block?.resource ?? block;
  return resource?.blob;
}

function extensionFor(mime = '') {
  const known = { 'application/json': 'json', 'text/plain': 'txt', 'image/svg+xml': 'svg', 'application/pdf': 'pdf' };
  return known[mime] ?? (mime.split('/')[1]?.replace(/[^a-zA-Z0-9]/g, '') || 'bin');
}

/** Save visual and binary output returned by tools, retaining tool order in file names. */
export async function saveToolAssets(events, imageDir) {
  await mkdir(imageDir, { recursive: true });
  const tools = new Map();
  let index = 0;
  const written = [];
  for (const event of events) {
    for (const block of contentOf(event)) {
      if (block?.type === 'tool_use' && !tools.has(block.id)) tools.set(block.id, { name: block.name, index: tools.size });
      if (block?.type !== 'tool_result') continue;
      const producer = tools.get(block.tool_use_id);
      const tool = safeName(producer?.name);
      const blocks = Array.isArray(block.content) ? block.content : [block.content];
      for (const item of blocks) {
        if (!item || typeof item === 'string') continue;
        const image = item.type === 'image' && imageData(item);
        const svg = item.type === 'text' && typeof item.text === 'string' &&
          (/^\s*<svg\b/i.test(item.text) || (/^\s*<\?xml/i.test(item.text) && /<svg\b/i.test(item.text)));
        const blob = item.type === 'resource' && resourceData(item);
        if (!image && !svg && !blob) continue;
        index++;
        const prefix = `${String(index).padStart(3, '0')}-${tool}`;
        const filename = image ? `${prefix}.png` : svg ? `${prefix}.svg` : `${prefix}.${extensionFor((item.resource ?? item).mimeType)}`;
        const destination = path.join(imageDir, filename);
        await writeFile(destination, image || blob ? Buffer.from(image || blob, 'base64') : item.text, image || blob ? undefined : 'utf8');
        written.push({ path: `images/${filename}`, toolCallIndex: producer?.index ?? null,
          toolCallId: block.tool_use_id, originalPath: item.resource?.uri ?? null, requestedPath: item.resource?.uri ?? null });
      }
    }
  }
  return written;
}

export async function hashTree(root) {
  const hash = createHash('sha256');
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) { hash.update(`d:${relative}\0`); await visit(full); }
      else if (entry.isFile()) { hash.update(`f:${relative}\0`); hash.update(await readFile(full)); }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

export async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.claude' && directory === root) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        const data = await readFile(full);
        files.push({ path: path.relative(root, full).split(path.sep).join('/'), size: (await stat(full)).size,
          sha256: createHash('sha256').update(data).digest('hex') });
      }
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
