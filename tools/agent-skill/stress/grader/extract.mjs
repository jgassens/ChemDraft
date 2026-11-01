import { commandWords, shellWords, unwrapShell } from '../shell-words.mjs';
export { shellWords, unwrapShell } from '../shell-words.mjs';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve, basename, relative, win32 } from 'node:path';
import { json, filesUnder, inside } from './common.mjs';

export function resultObjects(value) {
  const found = [];
  function visit(item) {
    if (typeof item === 'string') {
      let whole;
      try { whole = JSON.parse(item); } catch { /* Try JSON Lines below. */ }
      if (whole && typeof whole === 'object') visit(whole);
      else for (const line of item.split('\n')) {
        try { const parsed = JSON.parse(line); if (parsed && typeof parsed === 'object') visit(parsed); } catch { /* Plain text. */ }
      }
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') {
      found.push(item);
      for (const [key, child] of Object.entries(item)) if (!['data', 'blob'].includes(key)) visit(child);
    }
  }
  visit(value);
  return found;
}

export async function readRun(folder) {
  const meta = await json(join(folder, 'meta.json'));
  if (meta.status !== 'complete') {
    let final = '';
    try { final = await readFile(join(folder, 'final.md'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const images = [...await filesUnder(join(folder, 'images')), ...await filesUnder(join(folder, 'outputs')), ...await filesUnder(join(folder, 'work'))].filter((file) => /\.(png|svg)$/i.test(file));
    return { folder, meta, calls: [], final, images };
  }
  const final = await readFile(join(folder, 'final.md'), 'utf8');
  let saved = [];
  try { saved = await json(join(folder, 'tool-calls.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(saved)) throw new Error('tool-calls.json must be an array');
  const calls = [], results = new Map();
  let hasClaudeInit = false;
  try {
    const transcript = await readFile(join(folder, 'transcript.jsonl'), 'utf8');
    for (const line of transcript.split(/\r?\n/).filter((line) => line.trim())) {
      const event = JSON.parse(line);
      if (event.type === 'system' && event.subtype === 'init') hasClaudeInit = true;
      const blocks = event.message?.content ?? event.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block.type === 'tool_use') calls.push({ id: block.id, name: block.name, input: block.input });
        if (block.type === 'tool_result') results.set(block.tool_use_id, block);
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Codex records JSON events rather than Claude stream-json blocks. Its complete,
  // runner-normalised call record is therefore the only transcript source we use.
  if (meta.agent === 'codex' || !hasClaudeInit) {
    calls.length = 0;
    calls.push(...saved);
  } else if (calls.length) {
    const used = new Set();
    for (const call of calls) {
      const index = saved.findIndex((item, i) => !used.has(i) && item.name === call.name &&
        JSON.stringify(item.input) === JSON.stringify(call.input));
      if (index !== -1) used.add(index);
      call.result = index !== -1 ? saved[index].result : results.get(call.id);
    }
  } else calls.push(...saved);
  const images = [...await filesUnder(join(folder, 'images')), ...await filesUnder(join(folder, 'outputs')), ...await filesUnder(join(folder, 'work'))]
    .filter((file) => /\.(png|svg)$/i.test(file));
  let assets = [];
  try { assets = (await json(join(folder, 'assets.json'))).map((asset) => ({ ...asset, path: resolve(folder, asset.path) })); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { folder, meta, calls, final, images, assets };
}

export function cliCalls(command, options = {}) {
  const tokens = commandWords(command, options), calls = [];
  let start = 0;
  for (let end = 0; end <= tokens.length; end++) {
    if (end !== tokens.length && ![';', '&', '|'].includes(tokens[end])) continue;
    const part = tokens.slice(start, end); start = end + 1;
    const at = part.findIndex((word) => /(?:^|[\\/])chemdraft(?:\.cmd|\.exe)?$/i.test(word) || /(?:^|[\\/])chemdraft-cli[\\/]src[\\/]cli\.ts$/.test(word));
    if (at === -1) continue;
    // Printed examples and grep/cat commands do not reach ChemDraft.
    if (part.slice(0, at).some((word) => /^(echo|printf|cat|rg|grep|Write-Output)$/i.test(word))) continue;
    const verb = part[at + 1];
    if (!['render', 'grid', 'reaction', 'document', 'render-document', 'export', 'analyze', 'name', 'stereo', 'nmr'].includes(verb)) continue;
    const options = {};
    for (let i = at + 2; i < part.length; i++) {
      if (!part[i].startsWith('--')) continue;
      const [key, ...suffix] = part[i].slice(2).split('=');
      const value = suffix.length ? suffix.join('=') : part[i + 1] && !part[i + 1].startsWith('--') ? part[++i] : true;
      (options[key] ??= []).push(value);
    }
    calls.push({ verb, options, source: part.join(' ') });
  }
  return calls;
}

/** Capture retained shell heredocs without executing them.  The runner can remove
 * work/ after a run, so a later --batch absolute path may only survive here. */
export function heredocFiles(command) {
  const files = new Map();
  const source = unwrapShell(command);
  const header = /(?:^|[;&\n])\s*(cat|tee)\s+([^\r\n]+)\r?\n/gm;
  for (const match of source.matchAll(header)) {
    const words = shellWords(match[2], { shell: 'posix' });
    const delimiterAt = words.indexOf('<<');
    if (delimiterAt === -1 || !words[delimiterAt + 1]) continue;
    const delimiter = words[delimiterAt + 1];
    const outputAt = words.indexOf('>');
    const file = outputAt !== -1 ? words[outputAt + 1] : match[1] === 'tee' ?
      words.find((word, index) => index !== delimiterAt && index !== delimiterAt + 1 && !word.startsWith('-')) : null;
    if (!file) continue;
    const bodyStart = match.index + match[0].length;
    const end = new RegExp(`(?:^|\\n)${delimiter.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:\\r?\\n|$)`, 'm').exec(source.slice(bodyStart));
    if (!end) continue;
    files.set(file.replace(/\\/g, '/'), source.slice(bodyStart, bodyStart + end.index).replace(/\r?\n$/, ''));
  }
  return files;
}

async function batchJobs(folder, requested, heredocs) {
  try { return await json(await savedPath(folder, requested)); }
  catch (error) {
    const portable = requested.replace(/\\/g, '/');
    const body = heredocs.get(portable) ?? heredocs.get(portable.split('/').at(-1));
    if (body === undefined) throw error;
    return JSON.parse(body);
  }
}

function portablePath(value) { return value.replace(/\\/g, '/'); }

function manifestBasename(value, options) {
  const name = portablePath(value).split('/').at(-1);
  return (options?.platform ?? process.platform) === 'win32' ? name.toLowerCase() : name;
}

function canonicalManifestPath(value, { platform = process.platform, realpathNative = realpathSync.native } = {}) {
  const paths = platform === 'win32' ? win32 : { resolve };
  const resolved = paths.resolve(value);
  try { return realpathNative(resolved); } catch { return resolved; }
}

function manifestPathsEqual(left, right, options) {
  const normalise = (value) => (options?.platform ?? process.platform) === 'win32' ? value.toLowerCase() : value;
  return normalise(canonicalManifestPath(left, options)) === normalise(canonicalManifestPath(right, options));
}

function retainedManifestPath(folder, entry) {
  if (typeof entry?.copiedName === 'string') return join(folder, 'outputs', entry.copiedName);
  if (typeof entry?.path === 'string') return resolve(folder, entry.path);
  return null;
}

export async function savedPath(folder, requested, options = {}) {
  // Only retained run artifacts are read; original absolute tool temp paths may be gone.
  const portable = portablePath(requested);
  const candidates = [resolve(folder, 'work', requested), resolve(folder, requested)];
  const workAt = portable.lastIndexOf('/work/');
  if (workAt >= 0) candidates.push(resolve(folder, 'work', portable.slice(workAt + 6)));
  const all = await filesUnder(join(folder, 'work'));
  const matching = all.filter((file) => basename(file) === portable.split('/').at(-1));
  if (matching.length === 1) candidates.push(matching[0]);
  for (const candidate of candidates) {
    if (!inside(folder, candidate)) continue;
    try { await access(candidate); return candidate; } catch { /* Try retained copy. */ }
  }
  // Outputs written outside work/ are retained under outputs/.  Match their
  // original paths with the same slash-normalisation used for shell paths so
  // a Windows-run manifest can be graded on another host.
  const manifestEntries = [];
  for (const manifestName of ['outputs.json', 'assets.json']) {
    let manifest;
    try { manifest = await json(join(folder, manifestName)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!Array.isArray(manifest)) continue;
    manifestEntries.push(...manifest);
  }
  const tryEntries = async (entries) => {
    for (const entry of entries) {
      const retained = retainedManifestPath(folder, entry);
      if (!retained || !inside(folder, retained)) continue;
      try { await access(retained); return retained; } catch { /* Try another retained manifest entry. */ }
    }
    return null;
  };
  // requestedPath preserves exactly what the agent typed, while originalPath
  // is the runner's realpath.native result. Older manifests omit requestedPath.
  const requestedForComparison = (options.platform ?? process.platform) === 'win32' ? portable.toLowerCase() : portable;
  const byRequestedPath = await tryEntries(manifestEntries.filter((entry) => {
    if (typeof entry?.requestedPath !== 'string') return false;
    const stored = portablePath(entry.requestedPath);
    return ((options.platform ?? process.platform) === 'win32' ? stored.toLowerCase() : stored) === requestedForComparison;
  }));
  if (byRequestedPath) return byRequestedPath;
  const byCanonicalOriginal = await tryEntries(manifestEntries.filter((entry) =>
    typeof entry?.originalPath === 'string' && manifestPathsEqual(entry.originalPath, requested, options)));
  if (byCanonicalOriginal) return byCanonicalOriginal;
  const sameBasename = manifestEntries.filter((entry) =>
    typeof entry?.originalPath === 'string' && manifestBasename(entry.originalPath, options) === manifestBasename(requested, options));
  if (sameBasename.length === 1) {
    const byBasename = await tryEntries(sameBasename);
    if (byBasename) return byBasename;
  }
  throw new Error(`Retained run file is missing or ambiguous: ${requested}`);
}

function reactionInput(input, objects) {
  const rxn = input.reactionSmiles ?? input.rxn;
  let roles = input;
  if (typeof rxn === 'string') {
    const parts = rxn.split('>');
    if (parts.length !== 3) throw new Error(`Invalid reaction SMILES: ${rxn}`);
    roles = Object.fromEntries(['reactants', 'agents', 'products'].map((role, i) => [role, parts[i].split('.').filter(Boolean)]));
  }
  const reported = objects.find((object) => object.ok === true &&
    JSON.stringify(object.reactants) === JSON.stringify(roles.reactants) && JSON.stringify(object.products) === JSON.stringify(roles.products));
  return { reactants: roles.reactants ?? [], products: roles.products ?? [], agents: roles.agents ?? [],
    intermediates: [], conditions: [input.conditions ?? '', reported?.conditions ?? '',
      ...(reported?.agentTexts ?? []).map((agent) => agent.text)].join('\n') };
}

/** A native document can carry explicit reaction membership, or a horizontal scheme with
 * reaction-arrow objects. Infer stages only for this unambiguous horizontal layout. */
function documentSchemes(native) {
  const schemes = [];
  for (const page of native.document.pages) {
    const molecules = native.molecules.filter((molecule) => molecule.pageId === page.id && molecule.status !== 'unresolvable');
    const byId = new Map(molecules.map((molecule) => [molecule.objectId, molecule.smiles]));
    const text = (object) => object?.text ?? '';
    const reactions = page.objects.filter((object) => object.type === 'reaction');
    if (reactions.length) {
      const roles = { reactants: [], products: [], agents: [], intermediates: [], conditions: '' };
      const left = new Set(), right = new Set();
      for (const reaction of reactions) {
        for (const component of reaction.components) {
          if (component.role === 'reactant') left.add(component.objectId);
          if (component.role === 'product') right.add(component.objectId);
        }
        roles.conditions += '\n' + reaction.conditionsTextObjectIds.map((id) => text(page.objects.find((object) => object.id === id))).join('\n');
      }
      for (const id of left) if (byId.has(id)) roles[right.has(id) ? 'intermediates' : 'reactants'].push(byId.get(id));
      for (const id of right) if (byId.has(id) && !left.has(id)) roles.products.push(byId.get(id));
      schemes.push(roles);
      continue;
    }
    const arrows = page.objects.filter((object) => object.type === 'reaction-arrow' &&
      Number.isFinite(object.start?.point?.x) && Number.isFinite(object.end?.point?.x))
      .map((object) => ({ ...object, start: object.start.point, end: object.end.point }));
    if (!arrows.length || arrows.some((arrow) => Math.abs(arrow.start.y - arrow.end.y) > 5 || Math.abs(arrow.start.y - arrows[0].start.y) > 5)) continue;
    arrows.sort((a, b) => a.start.x - b.start.x);
    if (arrows.some((arrow) => arrow.end.x <= arrow.start.x || arrow.arrowKind === 'retrosynthesis')) continue;
    const roles = { reactants: [], products: [], agents: [], intermediates: [],
      conditions: page.objects.filter((object) => object.type === 'text').map(text).join('\n') };
    for (const molecule of [...molecules].sort((a, b) => Math.min(...a.object.atoms.map((atom) => atom.x)) - Math.min(...b.object.atoms.map((atom) => atom.x)))) {
      const xs = molecule.object.atoms.map((atom) => atom.x);
      const x = (Math.min(...xs) + Math.max(...xs)) / 2;
      const role = x < arrows[0].start.x ? 'reactants' : x > arrows.at(-1).end.x ? 'products' : 'intermediates';
      roles[role].push(molecule.smiles);
    }
    schemes.push(roles);
  }
  return schemes;
}

export async function extract(run, chemistry, scratch) {
  const drawn = [], schemes = [], errors = [], harnessErrors = [], documents = new Set();
  const heredocs = new Map();
  let reached = false;
  const add = (smiles, source, extra = {}) => { if (typeof smiles === 'string' && smiles.trim()) drawn.push({ smiles, source, ...extra }); };
  const native = async (file, source, rendered = false) => {
    documents.add(resolve(file));
    try {
      const recovered = await chemistry.native(file);
      for (const molecule of recovered.molecules) {
        const location = `${source}#${molecule.objectId}`;
        if (molecule.status === 'unresolvable') {
          drawn.push({ status: 'unresolvable', source: location, error: molecule.error, warnings: molecule.warnings });
          errors.push(`${location}: ${molecule.error}`);
        } else add(molecule.smiles, location);
      }
      if (rendered) schemes.push(...documentSchemes(recovered).map((scheme) => ({ ...scheme, source })));
    }
    catch (error) { error.harness = !error.agentInput && !['SyntaxError', 'ZodError'].includes(error.name); throw error; }
  };
  for (let index = 0; index < run.calls.length; index++) {
    const drawnBefore = drawn.length, schemesBefore = schemes.length;
    const call = run.calls[index], input = call.input ?? {}, objects = resultObjects(call.result);
    const source = `call[${index}] ${call.name}`;
    const failed = call.result?.isError === true || call.result?.is_error === true || objects.some((object) => object.ok === false || object.isError === true || object.is_error === true);
    try {
      if (call.name?.startsWith('mcp__chemdraft__')) {
        reached = true;
        if (failed) { errors.push(`${source}: tool returned an error; ignored for structure extraction`); continue; }
        const tool = call.name.slice('mcp__chemdraft__'.length);
        if (['render_structure', 'build_document', 'export_structure'].includes(tool)) {
          add(input.smiles, `${source}.smiles`);
          // A saved builder output represents the same occurrence, not a second drawing.
          if (tool === 'build_document') for (const result of objects) if (typeof result.document === 'string') {
            try { documents.add(await savedPath(run.folder, result.document)); } catch { /* Input already supplies chemistry. */ }
          }
        }
        if (tool === 'render_grid') for (const [i, item] of (input.items ?? []).entries()) add(item.smiles, `${source}.items[${i}].smiles`);
        if (tool === 'name_to_structure' && input.render === true) {
          const result = objects.find((object) => object.ok === true && (object.smiles || object.canonicalSmiles));
          add(result?.smiles ?? result?.canonicalSmiles, `${source}.result.smiles`);
        }
        if (tool === 'render_reaction') {
          const scheme = { ...reactionInput(input, objects), source };
          if (!failed) schemes.push(scheme);
          for (const role of ['reactants', 'products']) for (const [i, smiles] of scheme[role].entries()) add(smiles, `${source}.${role}[${i}]`, { role });
        }
        if (tool === 'render_document') {
          let file;
          if (input.documentJson !== undefined) {
            await mkdir(scratch, { recursive: true });
            file = join(scratch, `input-${index}.json`);
            await writeFile(file, typeof input.documentJson === 'string' ? input.documentJson : JSON.stringify(input.documentJson));
          } else {
            try { file = await savedPath(run.folder, input.documentPath); }
            catch (error) {
              const result = objects.find((object) => Array.isArray(object.molecules) && object.molecules.every((molecule) => molecule.canonicalSmiles));
              if (!result) throw error;
              for (const molecule of result.molecules) add(molecule.canonicalSmiles, `${source}.result#${molecule.objectId}`);
            }
          }
          if (file) await native(file, source, !failed);
        }
      } else if (['Bash', 'bash', 'Shell', 'shell'].includes(call.name)) {
        const command = input.command ?? '';
        for (const [file, body] of heredocFiles(command)) heredocs.set(file, body);
        // Claude's Bash tool is POSIX on both hosts (Git Bash on Windows).
        // Explicit cmd/PowerShell wrappers still choose their own payload rules.
        const shell = /^bash$/i.test(call.name) ? 'posix' : undefined;
        for (const cli of cliCalls(command, { shell })) {
          reached = true;
          if (failed) { errors.push(`${source}: tool returned an error; ignored for structure extraction`); continue; }
          const option = (key) => cli.options[key]?.at(-1);
          if (cli.verb === 'name' && option('render')) {
            const named = objects.find((object) => object.ok === true && typeof object.smiles === 'string');
            add(named?.smiles, `${source}.name.result.smiles`);
          }
          if (!['render', 'grid', 'reaction', 'document', 'render-document', 'export'].includes(cli.verb)) continue;
          if (cli.verb === 'render-document') { await native(await savedPath(run.folder, option('document')), `${source} --document`, !failed); continue; }
          const jobs = option('batch') ? await batchJobs(run.folder, option('batch'), heredocs) : [{}];
          for (const [i, job] of jobs.entries()) {
            if (cli.verb === 'reaction') {
              const scheme = { ...reactionInput({ ...job, rxn: job.rxn ?? option('rxn'),
                reactants: job.reactants ?? cli.options.reactant, products: job.products ?? cli.options.product,
                agents: job.agents ?? cli.options.agent, conditions: job.conditions ?? option('conditions') }, objects), source };
              if (!failed) schemes.push(scheme);
              for (const role of ['reactants', 'products']) for (const smiles of scheme[role]) add(smiles, `${source}.batch[${i}].${role}`, { role });
            } else add(job.smiles ?? option('smiles'), `${source}${option('batch') ? `.batch[${i}]` : ' --smiles'}`);
          }
          if (cli.verb === 'document') {
            const outputs = [option('out'), ...objects.map((object) => object.document)].filter((file) => typeof file === 'string');
            if (option('out-dir')) for (const job of jobs) if (job.name) outputs.push(join(option('out-dir'), `${job.name}.json`));
            for (const file of outputs) try { documents.add(await savedPath(run.folder, file)); } catch { /* Builder input already counted. */ }
          }
        }
      }
    } catch (error) {
      drawn.length = drawnBefore; schemes.length = schemesBefore;
      const message = `${source}: ${error.message}`;
      if (error.harness || /Retained run file is missing or ambiguous/.test(error.message)) harnessErrors.push(message);
      else errors.push(`${message}; ignored for structure extraction`);
    }
  }
  // Native documents the agent wrote without sending to a rendering tool still count.
  for (const file of await filesUnder(join(run.folder, 'work'))) {
    if (!/\.(json|chemdraft)$/i.test(file) || documents.has(resolve(file))) continue;
    let value;
    try { value = await json(file); } catch { continue; }
    if (value?.schema !== 'chemdraft.document.v1' && !value?.document?.pages && !value?.pages) continue;
    try { await native(file, `work/${relative(join(run.folder, 'work'), file)}`); }
    catch (error) { (error.harness ? harnessErrors : errors).push(`${file}: ${error.message}`); }
  }
  return { drawn, schemes, errors, harnessErrors, reached };
}
