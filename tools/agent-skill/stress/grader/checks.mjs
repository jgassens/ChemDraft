import { CHECKS, SCORING_VERSION, regex } from './common.mjs';
import { invertTetrahedral } from './chemistry.mjs';
import { checkStyle } from './style.mjs';

const check = (applies = false, pass = null, detail = 'Not requested by expect') => ({ applies, pass, detail });
export function harnessResult(testCase, reason) {
  return { id: testCase.id, category: testCase.category, split: testCase.split, scoring_version: SCORING_VERSION,
    status: 'harness', cause: 'harness', auto: null, drawn: [], checks: Object.fromEntries(CHECKS.map((id) => [id, check(false, null, reason)])), error: reason };
}
async function reference(value, chemistry, defaults = {}) {
  const ref = typeof value === 'string' ? { smiles: value } : value;
  const constitution = ref.mode === 'constitution' || ref.constitution === true || defaults.constitution;
  const canonical = await chemistry.canonical(ref.smiles, constitution);
  const accepted = [canonical];
  if ((ref.relative ?? defaults.relative) && !constitution) accepted.push(await chemistry.canonical(invertTetrahedral(canonical)));
  return { ...ref, canonical, constitution: Boolean(constitution), accepted: [...new Set(accepted)] };
}
function matches(drawn, ref) {
  return !drawn.error && ref.accepted.includes(ref.constitution ? drawn.constitution : drawn.canonical);
}
// Maximum matching preserves multiplicity, including references accepting two enantiomers.
function assignment(drawn, refs) {
  const owners = new Map();
  function assign(refIndex, seen) {
    for (let i = 0; i < drawn.length; i++) {
      if (seen.has(i) || !matches(drawn[i], refs[refIndex])) continue;
      seen.add(i);
      if (!owners.has(i) || assign(owners.get(i), seen)) { owners.set(i, refIndex); return true; }
    }
    return false;
  }
  const missing = [];
  refs.forEach((ref, index) => { if (!assign(index, new Set()) && !ref.optional) missing.push(index); });
  return { missing, extra: drawn.map((_, i) => i).filter((i) => !owners.has(i)),
    pairs: [...owners].map(([drawn, reference]) => ({ drawn, reference })) };
}

const aliases = { logp: 'log\\s*P|Crippen(?:[- ]logP)?', tpsa: 'TPSA|(?:topological\\s+)?polar\\s+surface(?:\\s+area)?',
  hbd: 'HBD|hydrogen[- ]bond\\s+donors?', hba: 'HBA|hydrogen[- ]bond\\s+acceptors?',
  'monoisotopic-mass': 'monoisotopic(?:\\s+mass)?|exact\\s+mass', 'average-mass': 'average\\s+mass|molecular\\s+weight' };
/** Associate numbers with their method label; an unrelated correct number elsewhere in the
 * answer must not rescue a swapped/wrong property. Markdown table rows are supported. */
export function answerValues(text, method) {
  const label = new RegExp(`(?:${aliases[method] ?? method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
  const found = [];
  for (const match of text.matchAll(label)) {
    const rest = text.slice(match.index + match[0].length).split(/\r?\n/)[0];
    // Stop at the next method's label so rows/sentences cannot steal another property's value.
    const boundary = rest.search(/\b(?:log\s*P|TPSA|polar\s+surface|HBD|HBA)\b/i);
    const segment = boundary === -1 ? rest : rest.slice(0, boundary);
    const number = segment.replace(/Å(?:²|\^?2)|A\^2|nm(?:²|\^?2)/g, '').match(/[-+−]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/);
    if (number) found.push(Number(number[0].replace('−', '-')));
  }
  return found;
}

export async function gradeCase(testCase, run, extracted, chemistry) {
  if (run.meta.status !== 'complete') return harnessResult(testCase, `Runner status: ${run.meta.status ?? 'missing'}`);
  const expect = testCase.expect ?? {};
  const checks = Object.fromEntries(CHECKS.map((id) => [id, check()]));
  const drawn = [];
  for (const item of extracted.drawn) {
    try { drawn.push({ ...item, canonical: await chemistry.canonical(item.smiles), constitution: await chemistry.canonical(item.smiles, true) }); }
    catch (error) { drawn.push({ ...item, error: error.message }); }
  }
  const refs = [];
  for (const ref of expect.structures ?? []) refs.push(await reference(ref, chemistry, {
    constitution: expect.mode === 'constitution' || expect.constitution === true || expect.set_match === 'constitution' || expect.set_contains === 'constitution', relative: expect.relative }));
  const required = refs.filter((ref) => !ref.optional);
  if (required.length) {
    const missing = required.filter((ref) => !drawn.some((item) => matches(item, ref)));
    checks.A1 = check(true, extracted.reached && !missing.length && !extracted.errors.length,
      { references: refs, missing: missing.map((ref) => ref.smiles), errors: extracted.errors });
  }
  if (expect.set_match || expect.set_contains) {
    const result = assignment(drawn, refs);
    checks.A2 = check(true, extracted.reached && !extracted.errors.length && result.missing.length === 0 &&
      (!expect.set_match || result.extra.length === 0),
    { mode: expect.set_match ? 'set_match' : 'set_contains', ...result, references: refs, errors: extracted.errors });
  }
  if (expect.full_stereo) {
    const candidates = [], missing = [];
    for (const ref of refs) {
      const constitution = await chemistry.canonical(ref.smiles, true);
      let relevant = drawn.filter((item) => matches(item, ref));
      if (!relevant.length && !ref.optional) {
        missing.push(ref.smiles);
        // Keep diagnostic counts for an unspecified version of a missing reference.
        // Constitutional decoys do not affect A3 when an exact match is present.
        relevant = drawn.filter((item) => !item.error && item.constitution === constitution);
      }
      for (const item of relevant) if (!candidates.includes(item)) candidates.push(item);
    }
    if (!refs.length) candidates.push(...drawn);
    const counts = [];
    for (const item of candidates) {
      try { counts.push({ smiles: item.smiles, source: item.source, ...await chemistry.stereo(item.smiles) }); }
      catch (error) { counts.push({ smiles: item.smiles, source: item.source, error: error.message }); }
    }
    checks.A3 = check(true, extracted.reached && !extracted.errors.length && !missing.length && counts.length > 0 &&
      counts.every((item) => !item.error && item.unspecifiedCount === 0), { counts, missing, errors: extracted.errors });
  }
  if (expect.answer_regex?.length || expect.answer_forbid_regex?.length) {
    const required = (expect.answer_regex ?? []).map((pattern) => ({ pattern, matched: regex(pattern).test(run.final) }));
    const forbidden = (expect.answer_forbid_regex ?? []).map((pattern) => ({ pattern, matched: regex(pattern).test(run.final) }));
    checks.A4 = check(true, required.every((entry) => entry.matched) && forbidden.every((entry) => !entry.matched), { required, forbidden });
  }
  if (expect.reaction || expect.reaction_count !== undefined) {
    const evaluations = [];
    const target = expect.reaction;
    for (const scheme of extracted.schemes) {
      const failures = [];
      if (target) {
        for (const role of ['reactants', 'products', 'intermediates']) {
          const available = [];
          for (const smiles of scheme[role]) {
            try { available.push({ canonical: await chemistry.canonical(smiles), constitution: await chemistry.canonical(smiles, true) }); }
            catch { failures.push(`Invalid ${role} SMILES: ${smiles}`); }
          }
          for (const ref of target[role] ?? []) {
            const expected = await reference(ref, chemistry, { relative: target.relative, constitution: target.mode === 'constitution' });
            if (!available.some((item) => matches(item, expected))) failures.push(`Missing ${role}: ${expected.smiles}`);
          }
          if (role === 'intermediates') {
            let previous = -1;
            for (const ref of target.intermediates ?? []) {
              const expected = await reference(ref, chemistry, { relative: target.relative, constitution: target.mode === 'constitution' });
              const index = available.findIndex((item, i) => i > previous && matches(item, expected));
              if (index === -1) { failures.push('Intermediates missing or out of listed order'); break; }
              previous = index;
            }
          }
          if (role === 'products' && target.products_any_of?.length) {
            let found = false;
            for (const ref of target.products_any_of) {
              const expected = await reference(ref, chemistry, { relative: target.relative });
              if (available.some((item) => matches(item, expected))) found = true;
            }
            if (!found) failures.push('No products_any_of alternative was drawn as a product');
          }
        }
        for (const pattern of target.conditions_regex ?? []) if (!regex(pattern).test(scheme.conditions)) failures.push(`Missing conditions: ${pattern}`);
      }
      evaluations.push({ source: scheme.source, pass: !failures.length, failures, scheme });
    }
    const countPass = expect.reaction_count === undefined || extracted.schemes.length === expect.reaction_count;
    checks.A5 = check(true, extracted.reached && !extracted.errors.length && countPass &&
      (target ? evaluations.some((entry) => entry.pass) : evaluations.length > 0),
    { evaluations, count: extracted.schemes.length, expectedCount: expect.reaction_count ?? null, errors: extracted.errors });
  }
  if (expect.style_consistency) {
    const style = await checkStyle(run.images);
    checks.A6 = check(true, style.pass && extracted.reached, style.detail);
  }
  if (expect.cli_value_match) {
    const target = expect.cli_value_match;
    const values = await chemistry.analyze(target.smiles, target.methods);
    const comparisons = values.map((value) => {
      const numbers = answerValues(run.final, value.method);
      return { ...value, reported: numbers, pass: typeof value.value === 'number' && Number.isFinite(value.value) &&
        numbers.length > 0 && numbers.every((number) => Math.abs(number - value.value) <= target.tolerance + 1e-10) };
    });
    checks.A7 = check(true, comparisons.length > 0 && comparisons.every((entry) => entry.pass), { tolerance: target.tolerance, comparisons });
  }
  checks.A8 = check(true, extracted.reached, extracted.reached ? 'ChemDraft MCP tool or CLI call recorded' : 'No ChemDraft call recorded');
  return { id: testCase.id, category: testCase.category, split: testCase.split, scoring_version: SCORING_VERSION,
    status: 'scored', checks, drawn, reactions: extracted.schemes, auto: Object.values(checks).every((entry) => !entry.applies || entry.pass) ? 'PASS' : 'FAIL' };
}
