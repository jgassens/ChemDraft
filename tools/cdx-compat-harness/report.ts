import { appendOutput as appendFile, writeOutput as writeFile, prepareOutput } from "./safety";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { bracketValue, chemistryFeatures, compareSurvival, drawingFeatures, jsonEqual, publicSanitizationReason, type Result, type Summary } from "./model";
import { stepArrowLosses, type SurvivalCounts } from "./survival";
import { lines, results } from "./io";
import { publicGroup } from "./runner";
import { publicError, resultErrors } from "./errors";

const idSafe = (id: string) => /^[0-9a-f]{12}$/.test(id) ? id : "invalid-id";
const groupSafe = (group: string) => group === "ungrouped" || /^group-[0-9a-f]{12}$/.test(group) ? group : publicGroup(group);
const eraSafe = (era: string) => /^(?:19|20)\d{2}(?:[-–](?:19|20)\d{2})?$/.test(era) ? era : "unknown";
export function verdict(result: Result): string {
  if (result.status !== "ok") return result.status;
  if (!result.roundTrips.some(r => r.verdict !== "SKIPPED") || result.roundTrips.some(r => r.verdict === "ERROR")) return "error";
  const comparisons = [...result.roundTrips, initialComparison(result)].filter(r => r !== undefined);
  if (comparisons.some(r => r.verdict === "FAIL")) return "FAIL";
  if (comparisons.some(r => r.verdict === "WARNED")) return "WARNED";
  return comparisons.some(r => r.verdict === "DRAWN-DIFFERENTLY") ? "DRAWN-DIFFERENTLY" : "PASS";
}
const initialComparison = (row: Result) => row.sourceSurvival && row.summary?.survival
  ? compareSurvival(row.sourceSurvival, row.summary.survival, row.warnings) : row.importComparison;

const emptyCounts = (): SurvivalCounts => ({ stepArrows: 0, abbreviations: 0, display: {} });
const survivalStage = () => ({ filesMeasured: 0, source: emptyCounts(), afterImport: emptyCounts(), after: emptyCounts(),
  stepArrowLinksLost: 0, stepsWhoseArrowLinkWasLost: 0, abbreviationsLost: 0, displayLost: {} as Record<string, number>,
  filesLosingAny: 0, filesLosingStepArrows: 0, filesLosingAbbreviations: 0, filesLosingDisplay: {} as Record<string, number> });
function addCounts(total: SurvivalCounts, counts: SurvivalCounts) {
  total.stepArrows += counts.stepArrows; total.abbreviations += counts.abbreviations;
  for (const [kind, count] of Object.entries(counts.display)) total.display[kind] = (total.display[kind] ?? 0) + count;
}
function addSurvival(stage: ReturnType<typeof survivalStage>, source: SurvivalCounts, imported: SurvivalCounts, stages: SurvivalCounts[]) {
  stage.filesMeasured++;
  addCounts(stage.source, source); addCounts(stage.afterImport, imported); addCounts(stage.after, stages.at(-1)!);
  const arrowLoss = stepArrowLosses(source, stages);
  const lostSteps = arrowLoss.steps;
  const lostAbbreviations = Math.max(0, source.abbreviations - Math.min(...stages.map(s => s.abbreviations)));
  stage.stepArrowLinksLost += arrowLoss.links;
  stage.stepsWhoseArrowLinkWasLost += lostSteps; stage.abbreviationsLost += lostAbbreviations;
  if (lostSteps) stage.filesLosingStepArrows++;
  if (lostAbbreviations) stage.filesLosingAbbreviations++;
  let lostDisplay = false;
  for (const [kind, count] of Object.entries(source.display)) {
    const lost = Math.max(0, count - Math.min(...stages.map(s => s.display[kind] ?? 0)));
    if (!lost) continue;
    stage.displayLost[kind] = (stage.displayLost[kind] ?? 0) + lost;
    stage.filesLosingDisplay[kind] = (stage.filesLosingDisplay[kind] ?? 0) + 1;
    lostDisplay = true;
  }
  if (lostSteps || lostAbbreviations || lostDisplay) stage.filesLosingAny++;
}
type Counter = { count: number; examples: string[] };
const counters = (keys: readonly string[]): Record<string, Counter> => Object.fromEntries(keys.map(key => [key, { count: 0, examples: [] }]));
const bump = (counter: Counter, id: string) => { counter.count++; if (counter.examples.length < 10) counter.examples.push(idSafe(id)); };
type Rate = { total: number; pass: number; warned: number; fail: number; error: number; drawnDifferently: number; drawnDifferentlyRate: number; passRate: number };
const rate = (): Rate => ({ total: 0, pass: 0, warned: 0, fail: 0, error: 0, drawnDifferently: 0, drawnDifferentlyRate: 0, passRate: 0 });
function addRate(count: Rate, outcome: string) {
  count.total++;
  if (outcome === "PASS") count.pass++;
  else if (outcome === "WARNED") count.warned++;
  else if (outcome === "FAIL") count.fail++;
  else if (outcome === "DRAWN-DIFFERENTLY") count.drawnDifferently++;
  else count.error++;
  count.passRate = count.pass / count.total;
  count.drawnDifferentlyRate = count.drawnDifferently / count.total;
}
function addDimension(map: Record<string, Rate>, key: string, outcome: string) {
  // Cap adversarial cardinality while keeping corpus memory independent of file count.
  if (!(key in map) && Object.keys(map).length >= 1000) key = "overflow";
  addRate(map[key] ??= rate(), outcome);
}
function cdxmlScore(value: Result): number {
  if (value.status !== "ok") return 4;
  const v = value.roundTrips.find(t => t.route === "cdxml")?.verdict;
  return v === "PASS" ? 0 : v === "DRAWN-DIFFERENTLY" ? 1 : v === "WARNED" ? 2 : v === "FAIL" ? 3 : 4;
}

export async function report(out: string, baseline?: string): Promise<void> {
  await prepareOutput(out);
  const baselineIndex = join(out, "private", "report-baseline");
  if (baseline) {
    await rm(baselineIndex, { recursive: true, force: true });
    await mkdir(baselineIndex, { mode: 0o700 });
    for await (const row of results(baseline, true)) if (row.format === "cdxml" && /^[0-9a-f]{12}$/.test(row.id)) {
      await writeFile(join(baselineIndex, row.id), JSON.stringify({ score: cdxmlScore(row), drawing: row.roundTrips.filter(t => t.route === "cdxml").flatMap(t => t.drawingLoss) }), { mode: 0o600 });
    }
  }
  const totals = rate();
  const speciesMethods = { "standard-inchi": "standard-inchi", "electron-pair-resonance": "electron-pair-resonance" } as const;
  const sameSpecies = counters(Object.keys(speciesMethods));
  let comparisonInternalErrors = 0;
  let identityPasses = 0;
  const sanitizationCounter = () => ({ total: 0, strict: 0, nonStrict: 0, strictRate: 0, nonStrictRate: 0, reasons: Object.create(null) as Record<string, number>, rdkitReasons: Object.create(null) as Record<string, number> });
  const sanitization = sanitizationCounter(), roundTripSanitization = sanitizationCounter();
  const countSanitization = (summary: Summary | undefined, count: ReturnType<typeof sanitizationCounter>) => {
    for (const molecule of summary?.molecules ?? []) {
      count.total++;
      if (molecule.strict !== false) count.strict++;
      else {
        count.nonStrict++;
        const reason = publicSanitizationReason(molecule.sanitization?.reason);
        count.reasons[reason] = (count.reasons[reason] ?? 0) + 1;
        if (molecule.sanitization?.rdkitReason) {
          const rdkit = publicSanitizationReason(molecule.sanitization.rdkitReason);
          count.rdkitReasons[rdkit] = (count.rdkitReasons[rdkit] ?? 0) + 1;
        }
      }
    }
    count.strictRate = count.total ? count.strict / count.total : 0;
    count.nonStrictRate = count.total ? count.nonStrict / count.total : 0;
  };
  const byFormat: Record<string, Rate> = Object.create(null);
  const byGroup: Record<string, Rate> = Object.create(null);
  const byEra: Record<string, Rate> = Object.create(null);
  const failures = counters(chemistryFeatures), warnedLosses = counters(chemistryFeatures), drawingLoss = counters(drawingFeatures);
  const undetermined = counters(["connectivity", "bond-order"]);
  const warningCategories: Record<string, number> = Object.create(null);
  const errorCounts: Record<string, Record<string, number>> = Object.create(null);
  const rdkitErrors: Record<string, number> = Object.create(null);
  const countError = (error: Parameters<typeof publicError>[0]) => {
    const { stage, category } = publicError(error);
    const categories = errorCounts[stage] ??= Object.create(null);
    categories[category] = (categories[category] ?? 0) + 1;
    if (error.rdkitReason) {
      const reason = publicSanitizationReason(error.rdkitReason);
      rdkitErrors[reason] = (rdkitErrors[reason] ?? 0) + 1;
    }
  };
  const crashes = { crash: 0, timeout: 0, oom: 0 };
  const timeouts = { importHang: 0, harnessSlow: 0, unclassified: 0 };
  const crashSpool = join(out, "private", "report-crashes.jsonl");
  await writeFile(crashSpool, "", { mode: 0o600 });
  const regression = { compared: 0, regressions: 0, improvements: 0, newIds: 0, examples: [] as string[] };
  let drawingDenominator = 0;
  let wavyOriginals = 0;
  let wavySurvivedEveryLeg = 0;
  const brackets = { pairs: 0, unpaired: 0, byUsage: { sru: 0, multiple: 0, generic: 0, unknown: 0, absent: 0 }, routes: Object.fromEntries(["cdx", "cdxml", "cdx-cdxml-cdx"].map(route => [route, { survivingUnchanged: 0, filesLosingPairs: 0 }])) as Record<string, { survivingUnchanged: number; filesLosingPairs: number }> };
  const survival = { source: emptyCounts(), afterImport: survivalStage(), routes: {} as Record<string, ReturnType<typeof survivalStage>> };
  for await (const row of results(out, true)) {
    const source = row.sourceSurvival;
    if (source) {
      addCounts(survival.source, source);
      if (row.summary?.survival) addSurvival(survival.afterImport, source, row.summary.survival, [row.summary.survival]);
      for (const trip of row.roundTrips) {
        if (trip.verdict === "SKIPPED" || !trip.summary) continue;
        const stages = [row.summary, ...(trip.legs?.length ? trip.legs.map(leg => leg.after) : [trip.summary])].map(s => s?.survival);
        if (stages.some(s => !s)) continue;
        const route = survival.routes[trip.route] ??= survivalStage();
        addSurvival(route, source, row.summary!.survival!, stages as SurvivalCounts[]);
      }
    }
    const originalBrackets = row.summary?.brackets ?? [];
    brackets.pairs += originalBrackets.length;
    brackets.unpaired += row.summary?.unpairedBrackets ?? 0;
    for (const bracket of originalBrackets) {
      const values = bracket.bracketUsage;
      const usage = Array.isArray(values) ? (values.every(value => value === values[0]) ? values[0] ?? null : "unknown") : values;
      const key = usage == null ? "absent" : usage === "sru" || usage === "multiple" || usage === "generic" ? usage : "unknown";
      brackets.byUsage[key]++;
    }
    for (const trip of row.roundTrips) {
      const route = brackets.routes[trip.route];
      if (!route || trip.verdict === "SKIPPED" || !trip.summary || !row.summary?.brackets || !trip.summary.brackets) continue;
      const stages = trip.legs?.length ? trip.legs.map(leg => leg.after) : [trip.summary];
      if (stages.some(stage => !stage.brackets)) continue;
      let remaining = originalBrackets.map(bracketValue);
      let previousCount = originalBrackets.length, lost = false;
      for (const stage of stages) {
        const next = stage.brackets!.map(bracketValue);
        if (next.length < previousCount) lost = true;
        previousCount = next.length;
        remaining = remaining.filter(item => { const i = next.findIndex(candidate => jsonEqual(item, candidate)); if (i < 0) return false; next.splice(i, 1); return true; });
      }
      route.survivingUnchanged += remaining.length;
      if (lost) route.filesLosingPairs++;
    }
    const wavyMolecules = row.summary?.molecules.filter(molecule => (molecule.displays?.wavy ?? 0) > 0) ?? [];
    const originalWavy = wavyMolecules.reduce((n, molecule) => n + (molecule.displays?.wavy ?? 0), 0);
    wavyOriginals += originalWavy;
    const completedLegs = row.roundTrips.filter(trip => trip.verdict !== "SKIPPED" && trip.summary);
    if (completedLegs.length > 0) for (const molecule of wavyMolecules) {
      if (completedLegs.every(trip => !trip.differences.some(difference =>
        difference.feature === "stereo-display" && difference.molecule?.before === molecule.objectId))) {
        wavySurvivedEveryLeg += molecule.displays.wavy;
      }
    }
    countSanitization(row.summary, sanitization);
    for (const trip of row.roundTrips) countSanitization(trip.summary, roundTripSanitization);
    for (const error of resultErrors(row)) countError(error);
    const outcome = verdict(row), id = idSafe(row.id);
    addRate(totals, outcome);
    addDimension(byFormat, row.format === "cdx" || row.format === "cdxml" ? row.format : "unknown", outcome);
    addDimension(byGroup, groupSafe(row.group), outcome);
    addDimension(byEra, eraSafe(row.era), outcome);
    if (row.status === "crash" || row.status === "timeout" || row.status === "oom") {
      crashes[row.status]++;
      await appendFile(crashSpool, `${JSON.stringify({ id, category: row.status })}\n`);
    }
    if (row.status === "timeout") {
      if (row.timeoutKind === "import-hang") timeouts.importHang++;
      else if (row.timeoutKind === "harness-slow") timeouts.harnessSlow++;
      else timeouts.unclassified++;
    }
    const failed = new Set<string>(), warned = new Set<string>(), drawings = new Set<string>(), unresolved = new Set<string>();
    for (const trip of [...row.roundTrips, initialComparison(row)].filter(t => t !== undefined)) {
      comparisonInternalErrors += trip.comparisonInternalErrors ?? 0;
      identityPasses += trip.identityPasses ?? 0;
      for (const check of trip.undetermined ?? []) unresolved.add(check.feature);
      for (const diff of trip.differences) if (!diff.classification) (diff.warned ? warned : failed).add(diff.feature);
      for (const feature of trip.drawingLoss) drawings.add(feature);
    }
    for (const [method, privateMethod] of Object.entries(speciesMethods)) if (row.roundTrips.some(t => t.differences.some(d => d.classification === "same-species-different-drawing" && d.identityCheck === privateMethod))) bump(sameSpecies[method], id);
    if (row.summary || row.roundTrips.some(t => t.summary)) drawingDenominator++;
    for (const feature of chemistryFeatures) {
      if (failed.has(feature)) bump(failures[feature], id);
      if (warned.has(feature)) bump(warnedLosses[feature], id);
    }
    for (const feature of drawingFeatures) if (drawings.has(feature)) bump(drawingLoss[feature], id);
    for (const feature of ["connectivity", "bond-order"]) if (unresolved.has(feature)) bump(undetermined[feature], id);
    const categories = new Set([...row.warnings, ...row.roundTrips.flatMap(t => t.warnings)].map(w => w.category));
    for (const key of categories) {
      const safe = /^(?:cdx|cdxml|summary|roundtrip|worker|harness)\.[a-z_]{1,80}$/.test(key) ? key : "warning.unclassified";
      warningCategories[safe] = (warningCategories[safe] ?? 0) + 1;
    }
    if (baseline && row.format === "cdxml") {
      let old: { score: number; drawing: string[] } | undefined;
      try { old = JSON.parse(await readFile(join(baselineIndex, id), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!old) regression.newIds++;
      else {
        regression.compared++;
        const before = old.score, after = cdxmlScore(row);
        const addedDrawingLoss = row.roundTrips.filter(t => t.route === "cdxml").some(t => t.drawingLoss.some(f => !old!.drawing.includes(f)));
        if (after > before || addedDrawingLoss) { regression.regressions++; if (regression.examples.length < 10) regression.examples.push(id); }
        if (after < before) regression.improvements++;
      }
    }
  }
  let groundTruth: { total: number; agreed: number; errors: number; matched: number; missing: number; extra: number; agreementRate: number; categories: Record<string, number> } | undefined;
  try {
    groundTruth = { total: 0, agreed: 0, errors: 0, matched: 0, missing: 0, extra: 0, agreementRate: 0, categories: Object.create(null) };
    for await (const line of lines(join(out, "private", "groundtruth.jsonl"))) {
      const row = JSON.parse(line);
      for (const comparison of row.comparisons ?? [row]) if (comparison.error) countError(comparison.error);
      groundTruth.total++;
      if (row.status === "error") groundTruth.errors++;
      else if (row.agreement ?? (!row.missing.length && !row.extra.length)) groundTruth.agreed++;
      groundTruth.matched += row.matched ?? 0;
      groundTruth.missing += row.missing?.length ?? 0;
      groundTruth.extra += row.extra?.length ?? 0;
      for (const key of new Set<string>(row.categories ?? [])) if (["stereo", "charge", "isotope", "H-count", "connectivity"].includes(key)) groundTruth.categories[key] = (groundTruth.categories[key] ?? 0) + 1;
    }
    groundTruth.agreementRate = groundTruth.total ? groundTruth.agreed / groundTruth.total : 0;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; groundTruth = undefined; }
  const safeReport = {
    totals, byFormat, byGroup, byEra, sameSpecies, identityPasses, comparisonInternalErrors, crashes, timeouts, failures, warnedLosses, undetermined, errorCounts, rdkitErrors, sanitization, roundTripSanitization,
    drawingLoss: Object.fromEntries(Object.entries(drawingLoss).map(([key, counter]) => [key, { ...counter, rate: drawingDenominator ? counter.count / drawingDenominator : 0 }])),
    drawingDenominator, warningCategories, brackets, survival, ...(baseline ? { cdxmlRegression: regression } : {}), ...(groundTruth ? { groundTruth } : {})
  };
  const jsonPath = join(out, "report.json");
  await writeFile(jsonPath, `${JSON.stringify(safeReport, null, 2).slice(0, -1)},\n"crashIds":[`);
  let first = true;
  for await (const line of lines(crashSpool)) { await appendFile(jsonPath, `${first ? "" : ","}${line}`); first = false; }
  await appendFile(jsonPath, "]}\n");
  const mdPath = join(out, "report.md");
  await writeFile(mdPath, "# Compatibility report\n\n");
  await appendFile(mdPath, `Molecule identity passes across comparison legs: ${identityPasses}.\n\n`);
  await appendFile(mdPath, `Wavy single bonds: ${wavyOriginals} in originals; ${wavySurvivedEveryLeg} survived every leg.\n\n`);
  await appendFile(mdPath, `Brackets: ${brackets.pairs} pairs after import (${Object.entries(brackets.byUsage).map(([key, count]) => `${key}: ${count}`).join(", ")}); ${brackets.unpaired} unpaired objects. ${Object.entries(brackets.routes).map(([route, count]) => `${route}: ${count.survivingUnchanged} pairs survived unchanged, ${count.filesLosingPairs} files lost pairs`).join("; ")}.\n\n`);
  await appendFile(mdPath, `Survival source: ${survival.source.stepArrows} step arrow links; ${survival.source.abbreviations} abbreviations; display ${JSON.stringify(survival.source.display)}.\n\n`);
  await appendFile(mdPath, "Stage | Metric | Source | After import | After route | Lost | Files losing any\n--- | --- | --- | --- | --- | --- | ---\n");
  for (const [route, counts] of [["import", survival.afterImport], ...Object.entries(survival.routes)] as [string, ReturnType<typeof survivalStage>][]) {
    const metrics: [string, number | string, number | string, number | string, number, number][] = [
      ["step arrow links", counts.source.stepArrows, counts.afterImport.stepArrows, counts.after.stepArrows, counts.stepArrowLinksLost, counts.filesLosingStepArrows],
      ["steps whose arrow link was lost", "—", "—", "—", counts.stepsWhoseArrowLinkWasLost, counts.filesLosingStepArrows],
      ["abbreviations", counts.source.abbreviations, counts.afterImport.abbreviations, counts.after.abbreviations, counts.abbreviationsLost, counts.filesLosingAbbreviations],
      ...Object.keys({ ...counts.source.display, ...counts.afterImport.display, ...counts.after.display }).sort().map(kind => [kind, counts.source.display[kind] ?? 0, counts.afterImport.display[kind] ?? 0, counts.after.display[kind] ?? 0, counts.displayLost[kind] ?? 0, counts.filesLosingDisplay[kind] ?? 0] as [string, number, number, number, number, number])
    ];
    for (const [metric, source, imported, after, lost, files] of metrics) await appendFile(mdPath, `${route} | ${metric} | ${source} | ${imported} | ${route === "import" ? "—" : after} | ${lost} | ${files}\n`);
  }
  await appendFile(mdPath, "\n");
  await appendFile(mdPath, `Files: ${totals.total}. PASS: ${totals.pass}. WARNED: ${totals.warned}. FAIL: ${totals.fail}. DRAWN-DIFFERENTLY: ${totals.drawnDifferently} (${(100 * totals.drawnDifferentlyRate).toFixed(1)}%). Errors: ${totals.error}.\n\nPass rate counts PASS only. Drawing loss is reported independently. Example lists are capped at 10 IDs. Groups are opaque hashes; labels remain private.\n\n`);
  await appendFile(mdPath, `IMPORT HANG (product findings): ${timeouts.importHang}. Harness-slow (not product findings): ${timeouts.harnessSlow}. Unclassified legacy timeouts: ${timeouts.unclassified}.\n\n`);
  await appendFile(mdPath, "## Molecule sanitization\n\nStage | Molecules | Strict | Non-strict | Strict rate | Non-strict rate\n--- | --- | --- | --- | --- | ---\n");
  for (const [label, count] of [["Original", sanitization], ["Round trips", roundTripSanitization]] as const) {
    await appendFile(mdPath, `${label} | ${count.total} | ${count.strict} | ${count.nonStrict} | ${(100 * count.strictRate).toFixed(1)}% | ${(100 * count.nonStrictRate).toFixed(1)}%\n`);
  }
  await appendFile(mdPath, "\nStage | Reason | Non-strict molecules | RDKit rejections\n--- | --- | --- | ---\n");
  for (const [label, count] of [["Original", sanitization], ["Round trips", roundTripSanitization]] as const) {
    for (const reason of Object.keys(count.reasons)) await appendFile(mdPath, `${label} | ${reason} | ${count.reasons[reason]} | ${count.rdkitReasons[reason] ?? 0}\n`);
  }
  await appendFile(mdPath, "\n");
  for (const [label, dimension] of [["Format", byFormat], ["Group", byGroup], ["Era", byEra]] as const) {
    await appendFile(mdPath, `## ${label}\n\n${label} | Files | PASS | WARNED | FAIL | DRAWN-DIFFERENTLY | Errors | Pass rate\n--- | --- | --- | --- | --- | --- | --- | ---\n`);
    for (const [key, value] of Object.entries(dimension)) await appendFile(mdPath, `${key} | ${value.total} | ${value.pass} | ${value.warned} | ${value.fail} | ${value.drawnDifferently} | ${value.error} | ${(100 * value.passRate).toFixed(1)}%\n`);
    await appendFile(mdPath, "\n");
  }
  for (const [label, counts] of [["DRAWN-DIFFERENTLY", sameSpecies], ["Chemistry FAIL", failures], ["Undetermined graph checks", undetermined], ["Warned chemistry losses", warnedLosses], ["DRAWING-LOSS", drawingLoss]] as const) {
    await appendFile(mdPath, `## ${label}\n\nCategory | Files | Rate | Example IDs\n--- | --- | --- | ---\n`);
    for (const [key, value] of Object.entries(counts)) {
      const denominator = label === "DRAWING-LOSS" ? drawingDenominator : totals.total;
      await appendFile(mdPath, `${key} | ${value.count} | ${(denominator ? 100 * value.count / denominator : 0).toFixed(1)}% | ${value.examples.join(", ")}\n`);
    }
    await appendFile(mdPath, "\n");
  }
  await appendFile(mdPath, "## Import and export warnings\n\nCategory | Files\n--- | ---\n");
  for (const [key, count] of Object.entries(warningCategories)) await appendFile(mdPath, `${key} | ${count}\n`);
  await appendFile(mdPath, "\n## Errors by stage and category\n\nStage | Category | Errors\n--- | --- | ---\n");
  for (const [stage, categories] of Object.entries(errorCounts)) for (const [category, count] of Object.entries(categories)) await appendFile(mdPath, `${stage} | ${category} | ${count}\n`);
  await appendFile(mdPath, "\n## Unparseable RDKit graphs\n\nReason | Errors\n--- | ---\n");
  for (const [reason, count] of Object.entries(rdkitErrors)) await appendFile(mdPath, `${reason} | ${count}\n`);
  await appendFile(mdPath, "\n## Crashes and timeouts\n\nID | Category\n--- | ---\n");
  for await (const line of lines(crashSpool)) { const row = JSON.parse(line); await appendFile(mdPath, `${row.id} | ${row.category}\n`); }
  if (baseline) await appendFile(mdPath, `\n## CDXML regression\n\nCompared: ${regression.compared}. Regressions: ${regression.regressions}. Improvements: ${regression.improvements}. New IDs: ${regression.newIds}.\n\nExample IDs: ${regression.examples.join(", ")}\n`);
  if (groundTruth) await appendFile(mdPath, `\n## Ground truth\n\nCompared: ${groundTruth.total}. Agreed: ${groundTruth.agreed}. Errors: ${groundTruth.errors}. Agreement rate: ${(100 * groundTruth.agreementRate).toFixed(1)}%.\n\nCategory | Files\n--- | ---\n${Object.entries(groundTruth.categories).map(([k, v]) => `${k} | ${v}`).join("\n")}\n`);
  if (baseline) await rm(baselineIndex, { recursive: true, force: true });
}
