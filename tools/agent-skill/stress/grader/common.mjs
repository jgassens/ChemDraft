import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCORING_VERSION = 1;
export const CHECKS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'];
export const CAUSES = {
  'skill-text': 'The tools could do it; the skill did not tell the agent how or that it should.',
  'cli-mcp-gap': 'The drawing code exists in the app but the CLI/MCP cannot reach it.',
  'drawing-code-missing': 'No code anywhere in ChemDraft draws it.',
  'tool-bug': 'A ChemDraft tool returned a wrong or broken result.',
  'agent-error': 'The information and tools were there and the agent still got it wrong.',
  harness: 'The runner or grader failed; the case is re-run, not scored.'
};
export const defaultCheckout = fileURLToPath(new URL('../../../../', import.meta.url));
export async function json(file) { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
export async function saveJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}
export async function filesUnder(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
export function inside(root, file) {
  const rel = relative(root, file);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
}
export async function readCases(file) {
  const input = await json(file);
  const cases = Array.isArray(input) ? input : input.cases;
  if (!Array.isArray(cases)) throw new Error('Cases must be an array or {cases: [...]}');
  const ids = new Set();
  for (const item of cases) {
    if (!/^[A-Za-z0-9_-]+$/.test(item.id) || ids.has(item.id)) throw new Error(`Invalid/duplicate case id: ${item.id}`);
    if (!['dev', 'heldout'].includes(item.split) || !item.category) throw new Error(`Missing category/split: ${item.id}`);
    ids.add(item.id);
  }
  return cases;
}
export function args(argv, allowed) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !allowed.includes(key)) throw new Error(`Unknown argument ${argv[i]}`);
    if (key === 'ids') {
      const ids = [];
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) ids.push(...argv[++i].split(',').filter(Boolean));
      if (!ids.length) throw new Error('--ids needs case ids');
      result.ids = ids;
    } else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`--${key} needs a value`);
      result[key] = resolve(argv[++i]);
    }
  }
  for (const key of ['cases', 'runs']) if (!result[key]) throw new Error(`--${key} is required`);
  return result;
}
export function isMain(url) { return process.argv[1] && fileURLToPath(url) === resolve(process.argv[1]); }
export function regex(pattern) {
  // Case files use Python-style leading global flags; the rest is ECMAScript-compatible.
  const flags = pattern.match(/^\(\?([ims]+)\)/);
  return new RegExp(flags ? pattern.slice(flags[0].length) : pattern, flags?.[1] ?? '');
}
