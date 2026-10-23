#!/usr/bin/env node
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { args, json, readCases, saveJson, isMain, CHECKS, CAUSES, SCORING_VERSION } from './common.mjs';

export function wilson(passed, n) {
  if (!Number.isInteger(n) || !Number.isInteger(passed) || n < 0 || passed < 0 || passed > n) throw new Error('Invalid Wilson counts');
  if (!n) return { pass: 0, n: 0, rate: null, lower: null, upper: null };
  const z = 1.959963984540054, p = passed/n, denom = 1 + z*z/n;
  const center = (p + z*z/(2*n))/denom;
  const half = z*Math.sqrt(p*(1-p)/n + z*z/(4*n*n))/denom;
  return { pass: passed, n, rate: p, lower: Math.max(0, center-half), upper: Math.min(1, center+half) };
}

export function validateVisual(entries, cases) {
  if (!Array.isArray(entries)) throw new Error('Visual review must be one JSON array');
  const byId = new Map();
  for (const entry of entries) {
    const testCase = cases.find((item) => item.id === entry.id);
    if (!testCase || byId.has(entry.id)) throw new Error(`Unknown/duplicate visual case ${entry.id}`);
    if (!['accept', 'reject'].includes(entry.verdict) || typeof entry.reason !== 'string' ||
      typeof entry.honest_decline !== 'boolean' || typeof entry.wrong_and_confident !== 'boolean' || !Object.hasOwn(CAUSES, entry.cause)) {
      throw new Error(`Invalid visual verdict for ${entry.id}`);
    }
    if (!Array.isArray(entry.rubric) || entry.rubric.length !== (testCase.rubric ?? []).length) throw new Error(`Incomplete visual rubric for ${entry.id}`);
    const lines = new Set();
    for (const line of entry.rubric) {
      if (!Number.isInteger(line.line) || line.line < 1 || line.line > entry.rubric.length || lines.has(line.line) ||
        !['met', 'not_met', 'cannot_tell'].includes(line.verdict) || typeof line.note !== 'string') throw new Error(`Invalid rubric line for ${entry.id}`);
      lines.add(line.line);
    }
    if (entry.honest_decline && entry.wrong_and_confident) throw new Error(`Contradictory honest_decline/wrong_and_confident for ${entry.id}`);
    byId.set(entry.id, entry);
  }
  return byId;
}

export function mergeCase(testCase, auto, visual, visualPending) {
  const base = { id: testCase.id, category: testCase.category, split: testCase.split, prompt: testCase.prompt,
    checks: auto?.checks ?? {}, drawn: auto?.drawn ?? [], reference: testCase.expect ?? {}, auto: auto?.auto ?? null,
    visual: visual ?? null, visual_pending: visualPending, cause: null, cause_provisional: false, wrong_and_confident: false };
  if (!auto || auto.status === 'harness' || visual?.cause === 'harness') {
    return { ...base, result: 'harness', cause: 'harness', reason: auto?.error ?? visual?.reason ?? 'Automatic grade missing; re-run this case' };
  }
  const applicable = Object.values(auto.checks).filter((entry) => entry.applies);
  const autoPass = !applicable.length || (auto.auto === 'PASS' && applicable.every((entry) => entry.pass === true));
  if (visualPending) {
    return { ...base, result: autoPass ? 'pass' : 'fail', cause: autoPass ? null : 'agent-error', cause_provisional: !autoPass,
      reason: 'Visual pending; provisional automatic-only result' };
  }
  if (!visual) return { ...base, result: 'harness', cause: 'harness', reason: 'Visual review missing; re-run review' };
  // Human review attests to the absence of anything wrong for an honest decline. It is
  // intentionally allowed to override missing-figure or no-tool automatic failures.
  const result = autoPass && visual.verdict === 'accept' ? 'pass' : visual.honest_decline ? 'honest decline' : 'fail';
  return { ...base, result, reason: visual.reason, cause: result === 'pass' ? null : visual.cause,
    wrong_and_confident: result === 'fail' && visual.wrong_and_confident };
}

function groupResults(cases) {
  const groups = [];
  for (const category of [...new Set(cases.map((item) => item.category))].sort()) for (const split of ['dev', 'heldout']) {
    const all = cases.filter((item) => item.category === category && item.split === split);
    if (!all.length) continue;
    const scored = all.filter((item) => item.result !== 'harness');
    const count = (result) => scored.filter((item) => item.result === result).length;
    const checks = {};
    for (const id of CHECKS) {
      const applicable = scored.filter((item) => item.checks[id]?.applies);
      checks[id] = wilson(applicable.filter((item) => item.checks[id].pass).length, applicable.length);
    }
    const reviewed = scored.filter((item) => item.visual);
    checks.V = wilson(reviewed.filter((item) => item.visual.verdict === 'accept').length, reviewed.length);
    const causes = Object.fromEntries(Object.keys(CAUSES).map((cause) => [cause, all.filter((item) => item.result !== 'pass' && item.cause === cause).length]));
    groups.push({ category, split, n: scored.length, pass: count('pass'), honest_decline: count('honest decline'), fail: count('fail'),
      wrong_and_confident: scored.filter((item) => item.wrong_and_confident).length, harness: all.length-scored.length,
      visual_pending: scored.filter((item) => item.visual_pending).length, pass_rate: wilson(count('pass'), scored.length), checks, causes });
    groups.at(-1).repo_source_read_cases = all.filter((item) => item.repo_source_read).map((item) => item.id);
    groups.at(-1).foreign_checkout_cases = all.filter((item) => item.foreign_checkout_access).map((item) => item.id);
  }
  return groups;
}

function referenceSmiles(expect) {
  return [...(expect.structures ?? []).map((item) => typeof item === 'string' ? item : item.smiles),
    ...['reactants', 'products', 'products_any_of', 'intermediates'].flatMap((role) => (expect.reaction?.[role] ?? []).map((item) => typeof item === 'string' ? item : item.smiles))];
}
export function buildReport(cases, automatic, visualEntries, finals = {}, agent = null, repoSourceReads = new Set(), unrunCaseIds = [], foreignCheckoutCases = new Set()) {
  const byId = new Map(automatic.cases.map((item) => [item.id, item]));
  if (byId.size !== automatic.cases.length) throw new Error('Duplicate automatic case ids');
  const visualPending = visualEntries === undefined;
  const visual = visualPending ? new Map() : validateVisual(visualEntries, cases);
  const merged = cases.map((item) => ({ ...mergeCase(item, byId.get(item.id), visual.get(item.id), visualPending),
    repo_source_read: repoSourceReads.has(item.id), foreign_checkout_access: foreignCheckoutCases.has(item.id) }));
  const worst = merged.filter((item) => item.result !== 'pass').map((item) => {
    const failed = CHECKS.filter((id) => item.checks[id]?.applies && item.checks[id].pass === false);
    return { id: item.id, category: item.category, split: item.split, result: item.result,
      wrong_and_confident: item.wrong_and_confident, failed_checks: failed,
      failed_check_count: failed.length + (item.visual?.verdict === 'reject' ? 1 : 0), prompt: item.prompt,
      drawn_smiles: item.drawn.map((entry) => entry.canonical ?? entry.smiles), reference_smiles: referenceSmiles(item.reference),
      final_excerpt: (finals[item.id] ?? '').slice(0, 300),
      what_was_wrong: [...failed.map((id) => `${id}: ${JSON.stringify(item.checks[id].detail)}`),
        ...(item.visual?.verdict === 'reject' ? [`V: ${item.visual.reason}`] : []),
        ...(item.result === 'harness' ? [item.reason] : [])], cause: item.cause };
  }).sort((a, b) => Number(b.wrong_and_confident)-Number(a.wrong_and_confident) || b.failed_check_count-a.failed_check_count || a.id.localeCompare(b.id));
  return { scoring_version: SCORING_VERSION, automatic_scoring_version: automatic.scoring_version, agent,
    visual_pending: visualPending, mode: visualPending ? 'provisional automatic only; visual pending' : 'automatic + independent visual',
    sampling: 'One run per case (n = 1). Rates and Wilson 95% intervals are reported separately for each category and split; harness cases are excluded from scored n.',
    groups: groupResults(merged), cases: merged, unrun_case_ids: unrunCaseIds, worst_failures: worst };
}

const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
function rate(value) {
  if (!value.n) return '— (n=0)';
  const percentage = (n) => (100*n).toFixed(1) + '%';
  return `${value.pass}/${value.n} = ${percentage(value.rate)} [${percentage(value.lower)}, ${percentage(value.upper)}], n=${value.n}`;
}
export function markdown(report, { heldoutDetails = false } = {}) {
  const unrun = report.unrun_cases ?? report.unrun_case_ids.map((id) => ({ id, split: 'unknown' }));
  const visibleUnrun = unrun.filter((item) => heldoutDetails ? item.split === 'heldout' : item.split === 'dev');
  const hiddenUnrunCount = unrun.length - visibleUnrun.length;
  const lines = ['# ChemDraft stress report', '', `SCORING_VERSION = ${report.scoring_version}; automatic SCORING_VERSION = ${report.automatic_scoring_version}.`, '',
    `Agent: ${report.agent ?? 'unspecified'}.`, '',
    `Mode: **${report.mode}**.`, '', report.sampling, '',
    `Cases not run: ${[...visibleUnrun.map((item) => `\`${item.id}\``), ...(hiddenUnrunCount ? [`${hiddenUnrunCount} ${heldoutDetails ? 'dev' : 'heldout'} cases`] : [])].join(', ') || 'none'}.`, '',
    '| Category | Split | n | Pass | Honest decline | Fail | Wrong-and-confident | Harness (not scored) | Repo source-read cases | Foreign-checkout cases | Pass rate (Wilson 95%) |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|---|---|'];
  const accessCases = (ids, split) => split === 'heldout' && !heldoutDetails ? String(ids.length) :
    `${ids.length}${ids.length ? ` (${ids.map((id) => `\`${id}\``).join(', ')})` : ''}`;
  for (const group of report.groups) lines.push(`| ${cell(group.category)} | ${group.split} | ${group.n} | ${group.pass} | ${group.honest_decline} | ${group.fail} | ${group.wrong_and_confident} | ${group.harness} | ${group.split === 'heldout' && !heldoutDetails ? group.repo_source_read_cases.length : group.repo_source_read_cases.map((id) => `\`${id}\``).join(', ') || '—'} | ${accessCases(group.foreign_checkout_cases, group.split)} | ${rate(group.pass_rate)} |`);
  lines.push('', '## Check pass rates', '', 'Each denominator includes only scored cases for which that check applies. V includes completed visual reviews only.', '',
    '| Category | Split | Check | Pass rate (Wilson 95%) |', '|---|---|---|---|');
  for (const group of report.groups) for (const [id, value] of Object.entries(group.checks)) lines.push(`| ${cell(group.category)} | ${group.split} | ${id} | ${id === 'V' && report.visual_pending ? 'Visual pending (n=0)' : rate(value)} |`);
  lines.push('', '## Causes by category and split', '',
    ...(report.visual_pending ? ['Causes are provisional automatic-only labels until independent visual review and conductor adjudication.', ''] : []),
    `| Category | Split | ${Object.keys(CAUSES).join(' | ')} |`, `|---|---|${Object.keys(CAUSES).map(() => '---:').join('|')}|`);
  for (const group of report.groups) lines.push(`| ${cell(group.category)} | ${group.split} | ${Object.values(group.causes).join(' | ')} |`);
  lines.push('', '## Worst failures', '', 'Non-passes ranked by wrong-and-confident first, then failed A/V check count. Harness entries are not scored.', '');
  for (const item of report.worst_failures.filter((item) => heldoutDetails ? item.split === 'heldout' : item.split !== 'heldout')) {
    lines.push(`### ${item.id} (${item.category}, ${item.split}): ${item.result}${item.wrong_and_confident ? ' — wrong-and-confident' : ''}`, '',
      `Prompt: ${item.prompt}`, '', `Drawn SMILES: ${item.drawn_smiles.map((smiles) => `\`${smiles}\``).join(', ') || '(none)'}`, '',
      `Reference SMILES: ${item.reference_smiles.map((smiles) => `\`${smiles}\``).join(', ') || '(none)'}`, '',
      `Final message excerpt (≤300 characters): ${item.final_excerpt}`, '',
      `Cause: ${item.cause ?? 'pending'}; failed checks: ${item.failed_checks.join(', ') || '(none)'}.`, '',
      ...item.what_was_wrong.map((detail) => `- ${detail.replace(/[\r\n]+/g, ' ')}`), '');
  }
  if (heldoutDetails) lines.unshift('For the final adjudicator only, not for anyone fixing the skill.', '');
  return lines.join('\n') + '\n';
}

export async function report(options) {
  const allCases = await readCases(options.cases), automatic = await json(join(options.runs, 'grade', 'auto.json'));
  if (automatic.scoring_version !== SCORING_VERSION) throw new Error(`Automatic scoring version ${automatic.scoring_version} does not match ${SCORING_VERSION}`);
  if (options.ids) for (const id of options.ids) if (!allCases.some((item) => item.id === id)) throw new Error(`Unknown case id ${id}`);
  const hasRunFolder = async (id) => {
    try { await access(join(options.runs, id)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const selected = options.ids ? allCases.filter((item) => options.ids.includes(item.id)) :
    (await Promise.all(allCases.map(async (item) => (await hasRunFolder(item.id)) ? item : null))).filter(Boolean);
  const unrunCaseIds = allCases.filter((item) => !selected.some((selectedCase) => selectedCase.id === item.id)).map((item) => item.id);
  const visual = options.visual ? await json(options.visual) : undefined, finals = {};
  const agents = new Set(), repoSourceReads = new Set(), foreignCheckoutCases = new Set();
  for (const item of selected) {
    const meta = await json(join(options.runs, item.id, 'meta.json'));
    agents.add(meta.agent ?? null);
    if ((meta.repoAccess ?? []).some((entry) => entry?.classification === 'source-read')) repoSourceReads.add(item.id);
    if ((meta.repoAccess ?? []).some((entry) => entry?.classification === 'foreign-checkout')) foreignCheckoutCases.add(item.id);
    try { finals[item.id] = await readFile(join(options.runs, item.id, 'final.md'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (agents.size !== 1) throw new Error(`Cannot mix runs from different agents in one report: ${[...agents].map((agent) => agent ?? 'unspecified').join(', ')}`);
  const result = buildReport(selected, automatic, visual, finals, [...agents][0], repoSourceReads, unrunCaseIds, foreignCheckoutCases);
  result.unrun_cases = allCases.filter((item) => unrunCaseIds.includes(item.id)).map(({ id, split }) => ({ id, split }));
  await mkdir(join(options.runs, 'grade'), { recursive: true });
  await saveJson(join(options.runs, 'grade', 'report.json'), result);
  await writeFile(join(options.runs, 'grade', 'report.md'), markdown(result));
  await writeFile(join(options.runs, 'grade', 'report-heldout.md'), markdown(result, { heldoutDetails: true }));
  return result;
}
if (isMain(import.meta.url)) {
  report(args(process.argv.slice(2), ['cases', 'runs', 'visual', 'ids'])).catch((error) => {
    process.stderr.write(`Report failed: ${error.message}\n`); process.exitCode = 1;
  });
}
