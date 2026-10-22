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

/** A PNG and SVG export of one drawing are often separate tool calls.  For an
 * exact set, count each canonical structure once across calls, while retaining
 * repeated items from a single call as genuine duplicate grid entries. */
function distinctDrawingCalls(drawn) {
  const retained = [], seenAcrossCalls = new Set(), seenInCall = new Map();
  for (const item of drawn) {
    // Extraction sources are deliberately prefixed with this stable call id.
    const call = /^call\[\d+\]/.exec(item.source)?.[0] ?? item.source;
    const key = item.error ? `invalid:${item.smiles}` : item.canonical;
    const inCall = seenInCall.get(call) ?? new Set();
    const repeatedInCall = inCall.has(key);
    inCall.add(key);
    seenInCall.set(call, inCall);
    if (repeatedInCall || !seenAcrossCalls.has(key)) retained.push(item);
    seenAcrossCalls.add(key);
  }
  return retained;
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

function countPair(value) {
  const counts = value?.stereo ?? value?.stereoCounts ?? value?.counts ?? value;
  if (!Number.isInteger(counts?.unspecifiedStereoCenters) || counts.unspecifiedStereoCenters < 0 ||
    !Number.isInteger(counts?.unspecifiedDoubleBonds) || counts.unspecifiedDoubleBonds < 0) return null;
  return { unspecifiedStereoCenters: counts.unspecifiedStereoCenters, unspecifiedDoubleBonds: counts.unspecifiedDoubleBonds };
}

/** The lock is deliberately permissive about its outer case/reference indexing so an older lock
 * remains useful. Only an explicit pair of ChemDraft stereo counts is trusted. */
function lockedStereoCounts(lock, testCase, ref, index) {
  if (!lock || typeof lock !== 'object') return null;
  const cases = lock.cases;
  const caseEntry = Array.isArray(cases) ? cases.find((entry) => entry?.id === testCase.id) :
    cases?.[testCase.id] ?? lock[testCase.id] ?? lock.references?.[testCase.id];
  const candidates = [
    caseEntry, caseEntry?.structures?.[index], caseEntry?.references?.[index], caseEntry?.[index],
    caseEntry?.structures?.[ref.smiles], caseEntry?.references?.[ref.smiles],
    caseEntry?.bySmiles?.[ref.smiles], caseEntry?.by_smiles?.[ref.smiles],
    lock.bySmiles?.[ref.smiles], lock.by_smiles?.[ref.smiles], lock.references?.[ref.smiles]
  ];
  for (const candidate of candidates) {
    const counts = countPair(candidate);
    if (counts) return counts;
  }
  return null;
}

export async function gradeCase(testCase, run, extracted, chemistry, referenceLock) {
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
    const setDrawn = expect.set_match ? distinctDrawingCalls(drawn) : drawn;
    const result = assignment(setDrawn, refs);
    checks.A2 = check(true, extracted.reached && !extracted.errors.length && result.missing.length === 0 &&
      (!expect.set_match || result.extra.length === 0),
    { mode: expect.set_match ? 'set_match' : 'set_contains', ...result, references: refs, errors: extracted.errors });
  }
  if (expect.full_stereo) {
    const comparisons = [], missing = [];
    for (const [index, ref] of refs.entries()) {
      const constitution = await chemistry.canonical(ref.smiles, true);
      let relevant = drawn.filter((item) => matches(item, ref));
      if (!relevant.length && !ref.optional) {
        missing.push(ref.smiles);
        // Keep diagnostic counts for an unspecified version of a missing reference.
        // Constitutional decoys do not affect A3 when an exact match is present.
        relevant = drawn.filter((item) => !item.error && item.constitution === constitution);
      }
      const locked = lockedStereoCounts(referenceLock, testCase, ref, index);
      const referenceCounts = locked ?? await chemistry.stereo(ref.smiles);
      for (const item of relevant) {
        try {
          const drawnCounts = await chemistry.stereo(item.smiles);
          comparisons.push({ smiles: item.smiles, source: item.source, reference: ref.smiles,
            referenceCounts: { unspecifiedStereoCenters: referenceCounts.unspecifiedStereoCenters,
              unspecifiedDoubleBonds: referenceCounts.unspecifiedDoubleBonds },
            referenceCountSource: locked ? 'references.lock.json' : 'computed', ...drawnCounts });
        } catch (error) { comparisons.push({ smiles: item.smiles, source: item.source, reference: ref.smiles, error: error.message }); }
      }
    }
    if (!refs.length) for (const item of drawn) {
      try {
        const drawnCounts = await chemistry.stereo(item.smiles);
        comparisons.push({ smiles: item.smiles, source: item.source, reference: null,
          referenceCounts: { unspecifiedStereoCenters: 0, unspecifiedDoubleBonds: 0 }, referenceCountSource: 'default', ...drawnCounts });
      } catch (error) { comparisons.push({ smiles: item.smiles, source: item.source, error: error.message }); }
    }
    const passes = (item) => !item.error && item.unspecifiedStereoCenters <= item.referenceCounts.unspecifiedStereoCenters &&
      item.unspecifiedDoubleBonds <= item.referenceCounts.unspecifiedDoubleBonds;
    checks.A3 = check(true, extracted.reached && !extracted.errors.length && !missing.length && comparisons.length > 0 &&
      comparisons.every(passes), { counts: comparisons, missing, errors: extracted.errors });
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
