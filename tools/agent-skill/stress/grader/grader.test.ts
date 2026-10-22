import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const checkout = resolve(directory, '../../../..');
type Check = { applies: boolean; pass: boolean | null; detail: unknown };
type Auto = { id: string; status: string; auto: string | null; checks: Record<string, Check>; drawn: { smiles: string; canonical: string; source: string }[] };
type TestCase = { id: string; category: string; split: string; prompt: string; expect: Record<string, unknown>; rubric: string[] };
type Call = { name: string; input: Record<string, unknown>; result?: unknown };
const structure = 'C[C@@H](N)C(=O)O';
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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'chemdraft-grader-'));
  runs = join(root, 'runs'); casesPath = join(root, 'cases.json');
  const full = { structures: [{ smiles: structure }], full_stereo: true };
  await mkdir(runs, { recursive: true });
  await cp(join(directory, 'fixtures/exact'), join(runs, 'exact'), { recursive: true });
  cases.push({ id: 'exact', category: 'test', split: 'dev', prompt: 'Draw L-alanine', expect: full, rubric: ['Correct requested output'] });
  await fixture('absolute-wrong', full, [render('C[C@H](N)C(=O)O')]);
  await fixture('relative', { structures: [{ smiles: structure, relative: true }], full_stereo: true }, [render('C[C@H](N)C(=O)O')]);
  await fixture('relative-ez', { structures: [{ smiles: 'C[C@H](O)/C=C/C', relative: true }] }, [render('C[C@@H](O)/C=C/C')]);
  await fixture('relative-wrong-ez', { structures: [{ smiles: 'C[C@H](O)/C=C/C', relative: true }] }, [render('C[C@@H](O)/C=C\\C')]);
  await fixture('unspecified', full, [render('CC(N)C(=O)O')]);
  await fixture('unspecified-double', { structures: [{ smiles: 'C/C=C/C' }], full_stereo: true }, [render('CC=CC')]);
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
  await fixture('png-only', { style_consistency: true }, [render('CCC')], 'Figure.', { 'only.png': 'fixture placeholder' });
  await fixture('no-tool', full, [], 'I drew it.');
  await fixture('echo-only', full, [{ name: 'Bash', input: { command: 'echo "pnpm -s chemdraft render --smiles CCO"' } }]);
  const batch = await fixture('cli-batch', { structures: [{ smiles: 'CCO' }, { smiles: 'C/C=C\\C' }], set_match: true },
    [{ name: 'Bash', input: { command: 'pnpm -s chemdraft render --batch "batch file.json" --format svg --out-dir images' } }]);
  await writeFile(join(batch, 'work', 'batch file.json'), JSON.stringify([{ name: 'a', smiles: 'CCO' }, { name: 'b', smiles: 'C/C=C\\C' }]));
  await fixture('cli-smiles', full, [{ name: 'Bash', input: { command: `pnpm -s chemdraft render --smiles '${structure}' --out a.svg` } }]);
  await fixture('value', { cli_value_match: { smiles: 'CC(=O)NC1=CC=C(C=C1)O', methods: ['logp', 'tpsa'], tolerance: 0.05 } },
    [{ name: 'mcp__chemdraft__analyze_structure', input: { smiles: 'CC(=O)NC1=CC=C(C=C1)O', methods: ['rdkit.crippen-logp', 'rdkit.tpsa'] } }], 'Calculated logP: 1.35; TPSA: 49.33 Å².');
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
  it('fails A3 for unspecified tetrahedral and double bond stereo', () => {
    expect(autos.get('unspecified')?.checks.A3.pass).toBe(false);
    expect(autos.get('unspecified-double')?.checks.A3.pass).toBe(false);
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
    for (const id of ['style-different', 'style-width', 'png-only']) expect(autos.get(id)?.checks.A6.pass, id).toBe(false);
    expect(JSON.stringify(autos.get('png-only')?.checks.A6.detail)).toContain('unmeasurable');
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
  it('keeps splits and categories separate, excludes harness, labels pending V, and computes Wilson 95%', async () => {
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
});
