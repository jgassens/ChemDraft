import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Harness modules are intentionally plain JavaScript.
import { gradeCase } from './checks.mjs';
// @ts-expect-error Harness modules are intentionally plain JavaScript.
import { extract, savedPath } from './extract.mjs';
// @ts-expect-error Harness modules are intentionally plain JavaScript.
import { saveToolAssets } from '../runner/stream.mjs';
// @ts-expect-error Harness modules are intentionally plain JavaScript.
import { checkStyle } from './style.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const checkout = resolve(directory, '../../../..');
type Check = { applies: boolean; pass: boolean | null; detail: unknown };
type Auto = { id: string; status: string; auto: string | null; agent?: string | null; checks: Record<string, Check>; drawn: { smiles: string; canonical: string; source: string }[] };
type TestCase = { id: string; category: string; split: string; prompt: string; expect: Record<string, unknown>; rubric: string[] };
type Call = { name: string; input: Record<string, unknown>; result?: unknown };
const structure = 'C[C@@H](N)C(=O)O';
const testosterone = 'C[C@]12CC[C@H]3[C@H]([C@@H]1CC[C@@H]2O)CCC4=CC(=O)CC[C@]34C';
const quinine = 'COC1=CC2=C(C=CN=C2C=C1)[C@H]([C@@H]3C[C@@H]4CCN3C[C@@H]4C=C)O';
const render = (smiles: string): Call => ({ name: 'mcp__chemdraft__render_structure', input: { smiles } });
const svg = (length: number, width = 2) => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><g data-object-id="m1"><line data-bond-id="b1" x1="10" y1="10" x2="${10+length}" y2="10" stroke="black" stroke-width="${width}"/></g></svg>`;
let root: string;
let runs: string;
let casesPath: string;
let aggregate: { cases: Auto[]; engine_loads: number };
const cases: TestCase[] = [];
const autos = new Map<string, Auto>();

async function fixture(id: string, expectation: Record<string, unknown>, calls: Call[], final = 'Here is the requested figure.',
  images: Record<string, string> = {}, split = 'dev', category = 'test') {
  const folder = join(runs, id);
  await mkdir(join(folder, 'images'), { recursive: true });
  await mkdir(join(folder, 'work'), { recursive: true });
  await writeFile(join(folder, 'meta.json'), JSON.stringify({ id, status: 'complete' }));
  await writeFile(join(folder, 'final.md'), final);
  await writeFile(join(folder, 'tool-calls.json'), JSON.stringify(calls));
  const transcript = [{ type: 'system', subtype: 'init' }, ...calls.flatMap((call, i) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: call.name, input: call.input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: call.result ?? [] }] } }
  ]), { type: 'result', subtype: 'success', result: final }];
  await writeFile(join(folder, 'transcript.jsonl'), transcript.map((event) => JSON.stringify(event)).join('\n'));
  for (const [name, contents] of Object.entries(images)) await writeFile(join(folder, 'images', name), contents);
  cases.push({ id, category, split, prompt: `Fixture request ${id}`, expect: expectation, rubric: ['Correct requested output'] });
  return folder;
}
function node(script: string, extra: string[] = []) {
  return execFileSync(process.execPath, [join(directory, script), '--cases', casesPath, '--runs', runs, ...extra],
    { cwd: checkout, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function nodeFor(runRoot: string, script: string, extra: string[] = []) {
  return execFileSync(process.execPath, [join(directory, script), '--cases', casesPath, '--runs', runRoot, ...extra],
    { cwd: checkout, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'chemdraft-grader-'));
  runs = join(root, 'runs'); casesPath = join(root, 'cases.json');
  const full = { structures: [{ smiles: structure }], full_stereo: true };
  await mkdir(runs, { recursive: true });
  await cp(join(directory, 'fixtures/exact'), join(runs, 'exact'), { recursive: true });
  cases.push({ id: 'exact', category: 'test', split: 'dev', prompt: 'Draw L-alanine', expect: full, rubric: ['Correct requested output'] });
  await cp(join(directory, 'fixtures/codex'), join(runs, 'codex'), { recursive: true });
  cases.push({ id: 'codex', category: 'test', split: 'dev', prompt: 'Draw ethanol', expect: { structures: [{ smiles: 'CCO' }] }, rubric: ['Correct requested output'] });
  await fixture('absolute-wrong', full, [render('C[C@H](N)C(=O)O')]);
  await fixture('relative', { structures: [{ smiles: structure, relative: true }], full_stereo: true }, [render('C[C@H](N)C(=O)O')]);
  await fixture('relative-ez', { structures: [{ smiles: 'C[C@H](O)/C=C/C', relative: true }] }, [render('C[C@@H](O)/C=C/C')]);
  await fixture('relative-wrong-ez', { structures: [{ smiles: 'C[C@H](O)/C=C/C', relative: true }] }, [render('C[C@@H](O)/C=C\\C')]);
  await fixture('unspecified', full, [render('CC(N)C(=O)O')]);
  await fixture('unspecified-double', { structures: [{ smiles: 'C/C=C/C' }], full_stereo: true }, [render('CC=CC')]);
  await fixture('quinine-reference', { structures: [{ smiles: quinine }], full_stereo: true }, [render(quinine)]);
  await fixture('N07', { structures: [{ smiles: quinine }], full_stereo: true }, [render(quinine)]);
  await fixture('quinine-extra-unspecified', { structures: [{ smiles: quinine }], full_stereo: true },
    [render(quinine.replace('[C@H]([C@@H]3', '[CH]([C@@H]3'))]);
  await fixture('duplicate', { structures: [{ smiles: 'CCO' }, { smiles: 'CC' }], set_match: true },
    [{ name: 'mcp__chemdraft__render_grid', input: { items: [{ name: 'a', smiles: 'CCO' }, { name: 'b', smiles: 'CC' }, { name: 'dup', smiles: 'CCO' }] } }]);
  await fixture('contains', { structures: [{ smiles: 'CCO' }], set_contains: true }, [render('CCO'), render('CCC')]);
  await fixture('stereo-decoy', { ...full, set_contains: true }, [render(structure), render('CC(N)C(=O)O')]);
  await fixture('constitution', { structures: [{ smiles: structure }], set_match: 'constitution' }, [render('C[C@H](N)C(=O)O')]);
  await fixture('optional', { structures: [{ smiles: structure, optional: true }], answer_regex: ['(?i)natural'] },
    [{ name: 'mcp__chemdraft__check_stereo', input: { smiles: structure } }], 'The natural amino acid.');
  await fixture('regex', { answer_regex: ['(?i)chiral', '\\bS\\b'], answer_forbid_regex: ['(?i)achiral|meso'] },
    [{ name: 'mcp__chemdraft__check_stereo', input: { smiles: structure } }], 'CHIRAL, configuration S.');
  await fixture('regex-fail', { answer_regex: ['(?i)chiral'], answer_forbid_regex: ['(?i)meso'] }, [render(structure)], 'chiral meso');
  const reaction = { reactants: ['CC(=O)O', 'CCO'], products: ['CCOC(C)=O'], conditions_regex: ['H2SO4|H₂SO₄'] };
  await fixture('missing-conditions', { reaction }, [{ name: 'mcp__chemdraft__render_reaction', input: { reactionSmiles: 'CC(=O)O.CCO>>CCOC(C)=O' } }]);
  await fixture('reaction', { reaction }, [{ name: 'mcp__chemdraft__render_reaction', input: { reactants: ['CC(=O)O', 'CCO'], products: ['CCOC(C)=O'], conditions: 'H₂SO₄' } }]);
  await fixture('reaction-tool-failed', { reaction }, [{ name: 'mcp__chemdraft__render_reaction', input: { reactants: ['CC(=O)O', 'CCO'], products: ['CCOC(C)=O'], conditions: 'H₂SO₄' }, result: { isError: true, content: [{ type: 'text', text: 'Renderer failed' }] } }]);
  await fixture('reaction-corrected', { reaction }, [
    { name: 'mcp__chemdraft__render_reaction', input: { reactionSmiles: 'invalid>reaction' } },
    { name: 'mcp__chemdraft__render_reaction', input: { reactionSmiles: 'malformed' }, result: { isError: true } },
    { name: 'mcp__chemdraft__render_reaction', input: { reactants: ['CC(=O)O', 'CCO'], products: ['CCOC(C)=O'], conditions: 'H₂SO₄' } },
  ]);
  await fixture('structure-corrected', { structures: [{ smiles: structure }], full_stereo: true, set_match: true }, [
    { ...render('broken SMILES'), result: { is_error: true } }, render('broken SMILES'), render(structure),
  ]);
  await fixture('document-corrected', { structures: [{ smiles: structure }] }, [
    { name: 'mcp__chemdraft__render_document', input: { documentJson: '{}' } }, render(structure),
  ]);
  await fixture('reaction-any', { reaction: { reactants: ['CCBr'], products_any_of: ['CCO', 'CCN'], conditions_regex: ['NaOH'] } },
    [{ name: 'mcp__chemdraft__render_reaction', input: { reactionSmiles: 'CCBr>[Na+].[OH-]>CCO' },
      result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, reactants: ['CCBr'], products: ['CCO'], agentTexts: [{ text: 'NaOH' }] }) }] } }]);
  await fixture('reaction-missing-intermediate', { reaction: { reactants: ['CCBr'], products: ['CCO'], intermediates: ['CCN'] } },
    [{ name: 'mcp__chemdraft__render_reaction', input: { reactants: ['CCBr'], products: ['CCO'] } }]);
  await fixture('reaction-count', { reaction_count: 3 }, [1, 2, 3].map(() => ({ name: 'mcp__chemdraft__render_reaction', input: { reactants: ['CCBr'], products: ['CCO'] } })));
  await fixture('style-same', { style_consistency: true }, [render('CCC')], 'Figure.', { 'a.svg': svg(28), 'b.svg': svg(28) });
  await fixture('style-different', { style_consistency: true }, [render('CCC')], 'Figure.', { 'a.svg': svg(28), 'b.svg': svg(40) });
  await fixture('style-width', { style_consistency: true }, [render('CCC')], 'Figure.', { 'a.svg': svg(28), 'b.svg': svg(28, 3) });
  await fixture('style-path', { style_consistency: true }, [render('CCC')], 'Figure.', { 'a.svg': '<svg><g transform="scale(2)" stroke-width="1"><path data-bond-id="b1" stroke="black" d="M 0 0 L 14 0 l 0 14"/></g></svg>', 'b.svg': svg(28) });
  const realSvg = await readFile(join(directory, 'fixtures/real-render.svg'), 'utf8');
  await fixture('style-real', { style_consistency: true }, [render('CCC')], 'Real CLI SVG.', { 'a.svg': realSvg, 'b.svg': realSvg });
  const bond28 = await readFile(join(directory, 'fixtures/bond-length-28.svg'), 'utf8');
  const bond40 = await readFile(join(directory, 'fixtures/bond-length-40.svg'), 'utf8');
  const hetero28 = await readFile(join(directory, 'fixtures/bond-length-hetero-28.svg'), 'utf8');
  await fixture('style-cli-bond-length-different', { style_consistency: true }, [render('C1=CC=CC=C1')], 'Bond length fixtures.',
    { 'benzene-28.svg': bond28, 'benzene-40.svg': bond40 });
  await fixture('style-cli-hetero-carbon', { style_consistency: true }, [render('N1=CC=CC=C1')], 'Bond length fixtures.',
    { 'benzene-28.svg': bond28, 'pyridine-28.svg': hetero28 });
  const d01Calls = JSON.parse(await readFile(join(directory, 'fixtures/d01/tool-calls.json'), 'utf8')) as Call[];
  const d01 = await fixture('d01', { structures: [
    { smiles: 'C1=CC=CC=C1' }, { smiles: 'N1=CC=CC=C1' }, { smiles: 'N1C=CC=C1' },
    { smiles: 'O1C=CC=C1' }, { smiles: 'C1=CC=CC=CC=C1' }, { smiles: '[CH-]1C=CC=C1' }
  ], set_match: true, style_consistency: true }, d01Calls, 'Aromaticity grid.');
  await cp(join(directory, 'fixtures/d01/aromaticity.svg'), join(d01, 'work/aromaticity.svg'));
  await fixture('png-only', { style_consistency: true }, [render('CCC')], 'Figure.', { 'only.png': 'fixture placeholder' });
  const both = await fixture('mcp-both', { style_consistency: true }, [{ name: 'mcp__chemdraft__render_structure', input: { smiles: 'CCC', format: 'both' } }]);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const assets = await saveToolAssets([
    { content: [{ type: 'tool_use', id: 'both', name: 'mcp__chemdraft__render_structure' }] },
    { content: [{ type: 'tool_result', tool_use_id: 'both', content: [
      { type: 'image', mimeType: 'image/png', data: png }, { type: 'text', text: svg(28) },
    ] }] },
  ], join(both, 'images'));
  await writeFile(join(both, 'assets.json'), JSON.stringify(assets));
  await fixture('no-tool', full, [], 'I drew it.');
  await fixture('echo-only', full, [{ name: 'Bash', input: { command: 'echo "pnpm -s chemdraft render --smiles CCO"' } }]);
  const batch = await fixture('cli-batch', { structures: [{ smiles: 'CCO' }, { smiles: 'C/C=C\\C' }], set_match: true },
    [{ name: 'Bash', input: { command: 'pnpm -s chemdraft render --batch "batch file.json" --format svg --out-dir images' } }]);
  await writeFile(join(batch, 'work', 'batch file.json'), JSON.stringify([{ name: 'a', smiles: 'CCO' }, { name: 'b', smiles: 'C/C=C\\C' }]));
  await fixture('cli-smiles', full, [{ name: 'Bash', input: { command: `pnpm -s chemdraft render --smiles '${structure}' --out a.svg` } }]);
  await fixture('cli-cmd', { structures: [{ smiles: 'CCO' }] }, [{ name: 'Bash', input: { command: String.raw`cmd /c "pnpm -s --dir C:\path chemdraft render --smiles CCO --out C:\Users\x\a.svg"` } }]);
  await fixture('cli-powershell', { structures: [{ smiles: 'C/C=C\\C' }] }, [{ name: 'Bash', input: { command: String.raw`pwsh -Command "pnpm -s --dir C:\path chemdraft render --smiles 'C/C=C\C' --out C:\Users\x\a.svg"` } }]);
  // The Codex N05 smoke call has this wrapper and a quoted testosterone SMILES.
  await fixture('cli-zsh-render', { structures: [{ smiles: testosterone }], full_stereo: true }, [{ name: 'Bash', input: { command: `/bin/zsh -lc "pnpm -s --config.shell-emulator=true --dir /expired/checkout chemdraft render --smiles '${testosterone}' --out /expired/work/testosterone.svg"` } }]);
  const shellGrid = await fixture('cli-zsh-heredoc', { structures: [
    { smiles: 'C1=CC=CC=C1' }, { smiles: 'N1=CC=CC=C1' }, { smiles: 'N1C=CC=C1' },
    { smiles: 'O1C=CC=C1' }, { smiles: 'C1=CC=CC=CC=C1' }, { smiles: '[CH-]1C=CC=C1' }
  ], set_match: true }, [{ name: 'Bash', input: { command: `/bin/zsh -lc "cat > structures.json <<'EOF'
[{\\"name\\":\\"benzene\\",\\"smiles\\":\\"C1=CC=CC=C1\\"},{\\"name\\":\\"pyridine\\",\\"smiles\\":\\"N1=CC=CC=C1\\"},{\\"name\\":\\"pyrrole\\",\\"smiles\\":\\"N1C=CC=C1\\"},{\\"name\\":\\"furan\\",\\"smiles\\":\\"O1C=CC=C1\\"},{\\"name\\":\\"cyclooctatetraene\\",\\"smiles\\":\\"C1=CC=CC=CC=C1\\"},{\\"name\\":\\"cyclopentadienyl anion\\",\\"smiles\\":\\"[CH-]1C=CC=C1\\"}]
EOF
pnpm -s --config.shell-emulator=true --dir /expired/checkout chemdraft grid --batch /expired/work/structures.json --out /expired/work/aromaticity.svg"` } }]);
  await mkdir(join(shellGrid, 'outputs'), { recursive: true });
  await writeFile(join(shellGrid, 'outputs', 'aromaticity.svg'), svg(28));
  await writeFile(join(shellGrid, 'outputs.json'), JSON.stringify([{ path: 'aromaticity.svg' }]));
  await fixture('style-output-folder', { style_consistency: true }, [render('CCC')], 'Figure.');
  const outputStyle = join(runs, 'style-output-folder');
  await mkdir(join(outputStyle, 'outputs'), { recursive: true });
  await writeFile(join(outputStyle, 'outputs', 'figure.svg'), svg(28));
  await writeFile(join(outputStyle, 'outputs.json'), JSON.stringify([{ path: 'figure.svg' }]));
  await fixture('value', { cli_value_match: { smiles: 'CC(=O)NC1=CC=C(C=C1)O', methods: ['logp', 'tpsa'], tolerance: 0.05 } },
    [{ name: 'mcp__chemdraft__analyze_structure', input: { smiles: 'CC(=O)NC1=CC=C(C=C1)O', methods: ['rdkit.crippen-logp', 'rdkit.tpsa'] } }], "Calculated logP: 1.35; TPSA: 49.33 Å² (for comparison, octanol's logP is ~3).");
  await fixture('value-swapped', { cli_value_match: { smiles: 'CC(=O)NC1=CC=C(C=C1)O', methods: ['logp', 'tpsa'], tolerance: 0.05 } },
    [{ name: 'mcp__chemdraft__analyze_structure', input: { smiles: 'CC(=O)NC1=CC=C(C=C1)O' } }], 'logP: 49.33; TPSA: 1.35 Å².');
  const timeout = await fixture('timeout', full, []);
  await writeFile(join(timeout, 'meta.json'), JSON.stringify({ id: 'timeout', status: 'timeout' }));
  await fixture('split-dev', {}, [render('CCC')], 'correct', {}, 'dev', 'split-test');
  await fixture('split-heldout', {}, [], 'uncomputed', {}, 'heldout', 'split-test');
  await fixture('decline', full, [], 'ChemDraft cannot draw the requested projection.');
  // Regenerate chemistry from an edited live graph, never the stale stored source SMILES.
  const template = join(root, 'template.json');
  execFileSync(process.execPath, ['--import', 'tsx', 'packages/chemdraft-cli/src/cli.ts', 'document', '--smiles', 'CCO', '--out', template],
    { cwd: checkout, stdio: 'pipe', timeout: 30000 });
  const native = JSON.parse(await readFile(template, 'utf8'));
  const scheme = structuredClone(native);
  const members = ['O', 'N', 'S'].map((element, i) => {
    const molecule = structuredClone(native.pages[0].objects[0]);
    molecule.id = `stage${i}`;
    const centerX = molecule.atoms.reduce((sum: number, atom: { x: number }) => sum + atom.x, 0) / molecule.atoms.length;
    const centerY = molecule.atoms.reduce((sum: number, atom: { y: number }) => sum + atom.y, 0) / molecule.atoms.length;
    const dx = 100 + i*200 - centerX, dy = 200 - centerY;
    molecule.x += dx; molecule.y += dy;
    for (const atom of molecule.atoms) { atom.x += dx; atom.y += dy; if (atom.element === 'O') atom.element = element; }
    return molecule;
  });
  const arrows = [0, 1].map((i) => ({ id: `arrow${i}`, type: 'reaction-arrow', arrowKind: 'forward',
    x: 180 + i*200, y: 188, width: 40, height: 24, rotation: 0, style: {}, labels: [],
    start: { kind: 'point', point: { x: 180 + i*200, y: 200 } }, end: { kind: 'point', point: { x: 220 + i*200, y: 200 } },
    compatibility: { sourceFormat: 'chemdraft-native', warnings: [], unknown: {} } }));
  scheme.pages[0].objects = [...members, ...arrows];
  await fixture('native-reaction', { reaction: { reactants: ['CCO'], products: ['CCS'], intermediates: ['CCN'] } },
    [{ name: 'mcp__chemdraft__render_document', input: { documentJson: JSON.stringify(scheme) } }]);
  native.pages[0].objects[0].atoms.find((atom: { element: string }) => atom.element === 'O').element = 'N';
  await fixture('native-inline', { structures: [{ smiles: 'CCN' }] }, [{ name: 'mcp__chemdraft__render_document', input: { documentJson: JSON.stringify(native) } }]);
  await fixture('native-reported', { structures: [{ smiles: 'CCO' }] }, [{ name: 'mcp__chemdraft__render_document', input: { documentPath: '/expired/native.json' },
    result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, molecules: [{ objectId: 'm1', canonicalSmiles: 'CCO' }] }) }] } }]);
  await writeFile(casesPath, JSON.stringify({ version: 1, cases }));
  node('grade.mjs', ['--checkout', checkout]);
  aggregate = JSON.parse(await readFile(join(runs, 'grade/auto.json'), 'utf8'));
  for (const item of aggregate.cases) autos.set(item.id, item);
}, 120000);

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe('automatic scoring on fixture run folders', () => {
  it('loads RDKit exactly once for all cases', () => { expect(aggregate.engine_loads).toBe(1); });
  it('passes an exact absolute stereo match using the real RDKit path', () => {
    expect(autos.get('exact')?.checks.A1.pass).toBe(true); expect(autos.get('exact')?.checks.A3.pass).toBe(true);
  });
  it('rejects the wrong absolute enantiomer but accepts a relative enantiomer without changing E/Z', () => {
    expect(autos.get('absolute-wrong')?.checks.A1.pass).toBe(false);
    expect(autos.get('relative')?.checks.A1.pass).toBe(true);
    expect(autos.get('relative-ez')?.checks.A1.pass).toBe(true);
    expect(autos.get('relative-wrong-ez')?.checks.A1.pass).toBe(false);
  });
  it('compares A3 against reference counts, including the quinine bridgehead N exception', () => {
    expect(autos.get('unspecified')?.checks.A3.pass).toBe(false);
    expect(autos.get('unspecified-double')?.checks.A3.pass).toBe(false);
    expect(autos.get('quinine-reference')?.checks.A3.pass).toBe(true);
    expect(autos.get('quinine-extra-unspecified')?.checks.A3.pass).toBe(false);
    expect(autos.get('N07')?.checks.A3).toMatchObject({ pass: true, detail: { counts: [
      expect.objectContaining({ referenceCountSource: 'lock', referenceCounts: { unspecifiedStereoCenters: 1, unspecifiedDoubleBonds: 0 } })
    ] } });
  });
  it('ignores failed and corrected input calls while retaining extraction diagnostics', () => {
    expect(autos.get('reaction-corrected')?.checks.A5).toMatchObject({ pass: true, detail: { errors: [expect.stringContaining('Invalid reaction'), expect.stringContaining('tool returned an error')] } });
    expect(autos.get('structure-corrected')?.auto).toBe('PASS');
    expect(autos.get('document-corrected')?.auto).toBe('PASS');
  });
  it('pairs runner-saved PNG/SVG from a single MCP format both call', () => {
    expect(autos.get('mcp-both')?.checks.A6).toMatchObject({ pass: true, detail: { unmeasurable: [] } });
  });
  it('recognises Windows CLI wrappers and preserves their SMILES and paths', () => {
    expect(autos.get('cli-cmd')?.auto).toBe('PASS');
    expect(autos.get('cli-powershell')?.auto).toBe('PASS');
  });
  it('keeps missing retained files and chemistry engine crashes as harness failures', async () => {
    const folder = join(runs, 'exact');
    const run = { folder, calls: [{ name: 'mcp__chemdraft__render_document', input: { documentPath: 'missing.json' } }] };
    const missing = await extract(run, {}, join(root, 'scratch'));
    expect(missing.harnessErrors).toEqual([expect.stringContaining('Retained run file is missing')]);
    const engine = await extract({ ...run, calls: [{ name: 'mcp__chemdraft__render_document', input: { documentJson: '{}' } }] },
      { native: async () => { throw new Error('engine crashed'); } }, join(root, 'scratch'));
    expect(engine.harnessErrors).toEqual([expect.stringContaining('engine crashed')]);
    const item = cases.find((item) => item.id === 'exact');
    const result = await gradeCase(item, { meta: { status: 'complete' } }, engine, {});
    expect(result.status).toBe('harness');
    await expect(gradeCase(item, { meta: { status: 'complete' } }, { drawn: [{ smiles: 'CC', source: 'call[0]' }], errors: [], reached: true },
      { canonical: async () => { throw new Error('engine crashed'); } })).rejects.toThrow('engine crashed');
  });
  it('recovers native documents retained from paths outside work through both manifests', async () => {
    const folder = join(root, 'retained-native-manifests');
    const calls = [
      { name: 'Bash', input: { command: 'pnpm -s chemdraft render-document --document /tmp/outputs-document.json' } },
      { name: 'Bash', input: { command: "pnpm -s chemdraft render-document --document 'C:\\temp\\assets-document.json'" } },
    ];
    await mkdir(join(folder, 'outputs'), { recursive: true });
    const outputDocument = join(folder, 'outputs', '001-outputs-document.json');
    const assetDocument = join(folder, 'outputs', '002-assets-document.json');
    await writeFile(outputDocument, '{}'); await writeFile(assetDocument, '{}');
    await writeFile(join(folder, 'outputs.json'), JSON.stringify([
      { originalPath: '/tmp/outputs-document.json', copiedName: '001-outputs-document.json' },
    ]));
    await writeFile(join(folder, 'assets.json'), JSON.stringify([
      { originalPath: 'C:\\temp\\assets-document.json', path: 'outputs/002-assets-document.json' },
    ]));
    const recovered: string[] = [];
    const result = await extract({ folder, calls }, {
      native: async (file: string) => {
        recovered.push(file);
        return { molecules: [{ smiles: 'CC', objectId: 'm1' }], document: { pages: [] } };
      },
    }, join(root, 'scratch'));
    expect(recovered).toEqual([outputDocument, assetDocument]);
    expect(result.harnessErrors).toEqual([]);
    expect(result.drawn).toHaveLength(2);
  });
  it('matches retained manifests by requested spelling, canonical path, then a unique basename', async () => {
    const folder = join(root, 'manifest-path-matching');
    await mkdir(join(folder, 'outputs'), { recursive: true });
    const retained = join(folder, 'outputs', '001-x.json');
    await writeFile(retained, '{}');
    await writeFile(join(folder, 'outputs.json'), JSON.stringify([
      { originalPath: '/private/tmp/x.json', requestedPath: '/agent-spelling/x.json', copiedName: '001-x.json' },
      { originalPath: '/private/tmp/requested.json', requestedPath: '/tmp/requested.json', copiedName: '001-x.json' },
    ]));
    expect(await savedPath(folder, '/tmp/requested.json')).toBe(retained);
    const macosRealpath = (value: string) => value === '/tmp/x.json' ? '/private/tmp/x.json' : value;
    expect(await savedPath(folder, '/tmp/x.json', { realpathNative: macosRealpath })).toBe(retained);

    await writeFile(join(folder, 'assets.json'), JSON.stringify([
      { originalPath: String.raw`C:\Users\runneradmin\AppData\Local\Temp\artifact.json`, path: 'outputs/001-x.json' },
    ]));
    const realpathNative = (value: string) => value.toLowerCase().includes('runner~1')
      ? String.raw`C:\Users\runneradmin\AppData\Local\Temp\artifact.json`
      : value;
    expect(await savedPath(folder, String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\ARTIFACT.json`, { platform: 'win32', realpathNative })).toBe(retained);

    await writeFile(join(folder, 'outputs.json'), JSON.stringify([
      { originalPath: '/expired/a/unique.json', copiedName: '001-x.json' },
    ]));
    expect(await savedPath(folder, '/other/unique.json')).toBe(retained);
    await writeFile(join(folder, 'outputs.json'), JSON.stringify([
      { originalPath: '/expired/a/ambiguous.json', copiedName: '001-x.json' },
      { originalPath: '/expired/b/ambiguous.json', copiedName: '001-x.json' },
    ]));
    await expect(savedPath(folder, '/other/ambiguous.json')).rejects.toThrow('Retained run file is missing or ambiguous');
  });
  it('pairs copied assets by their original Windows basename without pairing unrelated calls', async () => {
    const folder = join(runs, 'mcp-both', 'images');
    const files = [join(folder, '001-mcp__chemdraft__render_structure.png'), join(folder, '002-mcp__chemdraft__render_structure.svg')];
    const assets = [
      { path: files[0], toolCallIndex: 0, originalPath: 'C:\\old\\figure.png' },
      { path: files[1], toolCallIndex: 1, originalPath: 'C:\\old\\figure.svg' },
    ];
    expect((await checkStyle(files, assets)).pass).toBe(true);
    assets[1].originalPath = 'C:\\old\\unrelated.svg';
    expect((await checkStyle(files, assets)).pass).toBe(false);
  });
  it('uses Codex tool-calls.json rather than its non-Claude event transcript', () => {
    expect(autos.get('codex')?.checks.A1.pass).toBe(true);
    expect(autos.get('codex')?.checks.A8.pass).toBe(true);
    expect(autos.get('codex')?.agent).toBe('codex');
  });
  it('counts duplicates for set_match and allows decoys for set_contains', () => {
    expect(autos.get('duplicate')?.checks.A2.pass).toBe(false);
    expect(autos.get('contains')?.checks.A2.pass).toBe(true);
    expect(autos.get('stereo-decoy')?.checks.A3.pass).toBe(true);
    expect(autos.get('constitution')?.checks.A1.pass).toBe(true);
    expect(autos.get('constitution')?.checks.A2.pass).toBe(true);
  });
  it('honors optional references and Python-style regex flags and forbidden expressions', () => {
    expect(autos.get('optional')?.auto).toBe('PASS'); expect(autos.get('optional')?.checks.A1.applies).toBe(false);
    expect(autos.get('regex')?.checks.A4.pass).toBe(true); expect(autos.get('regex-fail')?.checks.A4.pass).toBe(false);
  });
  it('checks reaction roles, conditions, alternative products, intermediates, and count', () => {
    expect(autos.get('missing-conditions')?.checks.A5.pass).toBe(false);
    expect(autos.get('reaction')?.checks.A5.pass).toBe(true);
    expect(autos.get('reaction-tool-failed')?.checks.A5.pass).toBe(false);
    expect(autos.get('reaction-any')?.checks.A5.pass).toBe(true);
    expect(autos.get('reaction-missing-intermediate')?.checks.A5.pass).toBe(false);
    expect(autos.get('reaction-count')?.checks.A5.pass).toBe(true);
  });
  it('measures SVG bond lines/paths, transforms and stroke width, including a real CLI SVG', () => {
    for (const id of ['style-same', 'style-path', 'style-real']) expect(autos.get(id)?.checks.A6.pass, id).toBe(true);
    for (const id of ['style-different', 'style-width', 'style-cli-bond-length-different', 'png-only']) expect(autos.get(id)?.checks.A6.pass, id).toBe(false);
    expect(autos.get('style-cli-hetero-carbon')?.checks.A6.pass).toBe(true);
    expect(JSON.stringify(autos.get('png-only')?.checks.A6.detail)).toContain('unmeasurable');
  });
  it('accepts the D01 PNG/SVG duplicate grid as one requested structure set', () => {
    expect(autos.get('d01')?.checks.A2.pass).toBe(true);
    expect(autos.get('d01')?.checks.A6.pass).toBe(true);
  });
  it('requires a ChemDraft call, distinguishes echo from execution, and excludes incomplete cases', () => {
    expect(autos.get('no-tool')?.checks.A8.pass).toBe(false); expect(autos.get('no-tool')?.checks.A1.pass).toBe(false);
    expect(autos.get('echo-only')?.checks.A8.pass).toBe(false);
    expect(autos.get('timeout')?.status).toBe('harness'); expect(autos.get('timeout')?.auto).toBeNull();
  });
  it('extracts shell --smiles and retained batch files without losing E/Z backslashes', () => {
    expect(autos.get('cli-smiles')?.auto).toBe('PASS'); expect(autos.get('cli-batch')?.checks.A2.pass).toBe(true);
    expect(autos.get('cli-batch')?.drawn[0]?.source).toContain('batch[0]');
  });
  it('unwraps Codex zsh commands, recovers a removed heredoc batch, and uses runner outputs', () => {
    expect(autos.get('cli-zsh-heredoc')?.checks.A1.pass).toBe(true);
    expect(autos.get('cli-zsh-render')?.checks.A3.pass).toBe(true);
    expect(autos.get('cli-zsh-render')?.checks.A8.pass).toBe(true);
    expect(autos.get('cli-zsh-heredoc')?.drawn).toHaveLength(6);
    expect(autos.get('style-output-folder')?.checks.A6.pass).toBe(true);
  });
  it('canonicalises edited native graphs and accepts reported identities when document paths expired', () => {
    expect(autos.get('native-inline')?.checks.A1.pass).toBe(true);
    expect(autos.get('native-inline')?.drawn[0]?.canonical).toBe('CCN');
    expect(autos.get('native-reported')?.checks.A1.pass).toBe(true);
    expect(autos.get('native-reaction')?.checks.A5.pass).toBe(true);
  });
  it('runs only requested analysis methods and rejects swapped numeric answers', () => {
    expect(autos.get('value')?.checks.A7.pass).toBe(true); expect(autos.get('value-swapped')?.checks.A7.pass).toBe(false);
  });
  it('writes blind visual packs, verbatim final messages and actual PNG previews', async () => {
    const pack = await readFile(join(runs, 'visual-pack/exact/case.md'), 'utf8');
    const final = await readFile(join(runs, 'exact/final.md'), 'utf8');
    expect(pack.endsWith(final)).toBe(true); expect(pack).not.toMatch(/automatic|A[1-8]|PASS|FAIL/);
    const png = await readFile(join(runs, 'visual-pack/exact/images/alanine.svg.png'));
    expect(png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))).toBe(true);
    const instructions = await readFile(join(runs, 'visual-pack/INSTRUCTIONS.md'), 'utf8');
    expect(instructions).toContain('EVERY image'); expect(instructions).toContain('"wrong_and_confident"');
  });
});

describe('report', () => {
  it('rejects cases from different agents', async () => {
    expect(() => node('report.mjs')).toThrow(/Cannot mix runs from different agents/);
    // The remaining report checks exercise a single-agent selection, after proving the guard.
    await writeFile(join(runs, 'codex/meta.json'), JSON.stringify({ id: 'codex', status: 'complete' }));
  });
  it('keeps splits and categories separate, excludes harness, labels pending V, and computes Wilson 95%', async () => {
    await writeFile(join(runs, 'exact/meta.json'), JSON.stringify({ id: 'exact', status: 'complete', repoAccess: [{ classification: 'source-read', path: 'packages/chem-core/src/index.ts' }] }));
    node('report.mjs');
    const report = JSON.parse(await readFile(join(runs, 'grade/report.json'), 'utf8'));
    const dev = report.groups.find((group: { category: string; split: string }) => group.category === 'split-test' && group.split === 'dev');
    const heldout = report.groups.find((group: { category: string; split: string }) => group.category === 'split-test' && group.split === 'heldout');
    expect(dev.n).toBe(1); expect(dev.pass).toBe(1); expect(heldout.n).toBe(1); expect(heldout.pass).toBe(0);
    // Hand calculation: with p=1,n=1, lower = 1/(1+1.95996398454²) = 0.2065493, upper = 1.
    expect(dev.pass_rate.lower).toBeCloseTo(0.2065493144, 8); expect(dev.pass_rate.upper).toBeCloseTo(1, 12);
    expect(heldout.pass_rate.lower).toBeCloseTo(0, 12); expect(heldout.pass_rate.upper).toBeCloseTo(0.7934506856, 8);
    expect(report.visual_pending).toBe(true); expect(dev.checks.V.n).toBe(0); expect(report).not.toHaveProperty('overall');
    expect(report.groups.every((group: { split: string }) => ['dev', 'heldout'].includes(group.split))).toBe(true);
    const sourceReads = report.groups.find((group: { category: string; split: string }) => group.category === 'test' && group.split === 'dev');
    expect(sourceReads.repo_source_read_cases).toContain('exact');
    const publicReport = await readFile(join(runs, 'grade/report.md'), 'utf8');
    const heldoutReport = await readFile(join(runs, 'grade/report-heldout.md'), 'utf8');
    expect(publicReport).toContain('| split-test | heldout |');
    expect(publicReport).not.toContain('Fixture request split-heldout');
    expect(publicReport).not.toContain('uncomputed');
    expect(publicReport).not.toContain('### split-heldout');
    expect(publicReport).toContain('### absolute-wrong');
    expect(heldoutReport.split('\n')[0]).toBe('For the final adjudicator only, not for anyone fixing the skill.');
    expect(heldoutReport).toContain('Fixture request split-heldout');
    expect(heldoutReport).toContain('uncomputed');
    expect(heldoutReport).not.toContain('### absolute-wrong');
  });
  it('merges visual pass/honest decline/fail, ranks wrong confidence first and bounds excerpts', async () => {
    const visual = cases.map((testCase) => ({ id: testCase.id,
      rubric: [{ line: 1, verdict: testCase.id === 'exact' ? 'met' : 'not_met', note: 'Independent fixture review' }],
      verdict: testCase.id === 'exact' || testCase.id === 'absolute-wrong' ? 'accept' : 'reject', reason: 'Fixture visual verdict',
      honest_decline: testCase.id === 'decline', wrong_and_confident: testCase.id === 'absolute-wrong', cause: 'agent-error' }));
    const visualPath = join(root, 'visual.json'); await writeFile(visualPath, JSON.stringify(visual));
    node('report.mjs', ['--visual', visualPath]);
    const report = JSON.parse(await readFile(join(runs, 'grade/report.json'), 'utf8'));
    const result = (id: string) => report.cases.find((item: { id: string }) => item.id === id);
    expect(result('exact').result).toBe('pass'); expect(result('decline').result).toBe('honest decline');
    expect(result('relative').result).toBe('fail'); expect(result('absolute-wrong').result).toBe('fail');
    expect(result('absolute-wrong').wrong_and_confident).toBe(true); expect(result('timeout').result).toBe('harness');
    expect(report.worst_failures[0].id).toBe('absolute-wrong');
    expect(report.worst_failures.every((item: { final_excerpt: string }) => item.final_excerpt.length <= 300)).toBe(true);
  });
  it('grades and reports only cases present in a partial run, naming cases not run', async () => {
    const partial = join(root, 'partial-runs');
    await mkdir(partial, { recursive: true });
    await cp(join(runs, 'exact'), join(partial, 'exact'), { recursive: true });
    nodeFor(partial, 'grade.mjs', ['--checkout', checkout]);
    const automatic = JSON.parse(await readFile(join(partial, 'grade/auto.json'), 'utf8'));
    expect(automatic.cases.map((item: { id: string }) => item.id)).toEqual(['exact']);
    nodeFor(partial, 'report.mjs');
    const report = JSON.parse(await readFile(join(partial, 'grade/report.json'), 'utf8'));
    expect(report.cases.map((item: { id: string }) => item.id)).toEqual(['exact']);
    expect(report.unrun_case_ids).toContain('codex');
    expect(await readFile(join(partial, 'grade/report.md'), 'utf8')).toContain('Cases not run:');
    expect(await readFile(join(partial, 'grade/report.md'), 'utf8')).not.toContain('split-heldout');
  });
});
