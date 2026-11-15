import { appendOutput as appendFile, writeOutput as writeFile, prepareOutput } from "./safety";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describeStructure } from "./chemistry";
import { readBounded, results, withCopy } from "./io";
import type { MoleculeSummary, StageError } from "./model";
import { stageError } from "./errors";
import { report } from "./report";

export function matchTruth(imported: MoleculeSummary[], truth: (MoleculeSummary | MoleculeSummary[])[]) {
  const remaining = [...imported];
  const missing: MoleculeSummary[] = [];
  const choices = truth.map(item => Array.isArray(item) ? item : [item]);
  const assigned = new Map<number, number>();
  const assign = (expected: number, visited: Set<number>): boolean => {
    for (let i = 0; i < imported.length; i++) {
      if (visited.has(i) || !choices[expected].some(option => option.smiles === imported[i].smiles)) continue;
      visited.add(i);
      const previous = assigned.get(i);
      if (previous === undefined || assign(previous, visited)) { assigned.set(i, expected); return true; }
    }
    return false;
  };
  for (let i = 0; i < choices.length; i++) if (!assign(i, new Set())) missing.push(choices[i][0]);
  for (const index of [...assigned.keys()].sort((a, b) => b - a)) remaining.splice(index, 1);
  const matched = assigned.size;
  const extra = [...remaining];
  const nearMisses: { expected: string; actual: string; categories: string[] }[] = [];
  const categories = new Set<string>();
  for (const expected of missing) {
    // Prefer the same connectivity. Otherwise offer a count-near candidate, explicitly
    // labelled connectivity; no similarity guess ever contributes to the match count.
    let index = remaining.findIndex(actual => actual.connectivity === expected.connectivity);
    if (index < 0) index = remaining.findIndex(actual => actual.heavyAtoms === expected.heavyAtoms && actual.bonds === expected.bonds);
    if (index < 0) { categories.add("connectivity"); continue; }
    const actual = remaining.splice(index, 1)[0];
    const differences: string[] = [];
    if (actual.withoutStereo === expected.withoutStereo) differences.push("stereo");
    else {
      if (actual.charge !== expected.charge || actual.featureKeys.charge !== expected.featureKeys.charge) differences.push("charge");
      if (actual.featureKeys.isotope !== expected.featureKeys.isotope) differences.push("isotope");
      if (actual.hydrogenCount !== expected.hydrogenCount) differences.push("H-count");
      if (actual.connectivity !== expected.connectivity || !differences.length) differences.push("connectivity");
    }
    differences.forEach(f => categories.add(f));
    nearMisses.push({ expected: expected.smiles, actual: actual.smiles, categories: differences });
  }
  if (extra.length && !missing.length) categories.add("connectivity");
  return { matched, missing: missing.map(m => m.smiles), extra: extra.map(m => m.smiles), nearMisses, categories: [...categories] };
}

export async function groundTruth(out: string, truthDirectory: string): Promise<void> {
  await prepareOutput(out);
  const tempRoot = join(out, "private", "tmp");
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const destination = join(out, "private", "groundtruth.jsonl");
  await writeFile(destination, "", { mode: 0o600 });
  for await (const row of results(out)) {
    if (row.status === "copy-error" && row.id === "unavailable") continue;
    if (!/^[0-9a-f]{12}$/.test(row.id)) throw new Error("Ground truth refused an invalid result ID.");
    const files: { format: string; path: string }[] = [];
    for (const format of ["smi", "mol", "sdf"]) {
      const path = join(truthDirectory, `${row.id}.${format}`);
      try { await access(path); files.push({ format, path }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (!files.length) continue;
    // Each independently provided truth set is compared separately (do not concatenate .smi
    // and .sdf copies of the same molecules into a doubled multiset).
    const comparisons: (ReturnType<typeof matchTruth> & { truthFormat: string; status: "ok" | "error"; category?: string; error?: StageError })[] = [];
    for (const file of files) {
      try {
        if (!row.parseOk || !row.summary || row.summary.summaryErrors?.length) throw new Error("Import has no complete chemistry summary.");
        const expected = await withCopy(file.path, async copy => {
          const content = await readBounded(copy);
          const structures = file.format === "smi" ? content.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
            : file.format === "sdf" ? content.split(/\$\$\$\$\s*(?:\r?\n|$)/).filter(s => s.trim()) : [content];
          const molecules: MoleculeSummary[][] = [];
          for (const structure of structures) {
            const alternatives = file.format === "smi" ? structure.split(" || ") : [structure];
            if (alternatives.some(s => !s.trim())) throw new Error("Empty truth alternative.");
            molecules.push(await Promise.all(alternatives.map(s => describeStructure(file.format === "smi" ? s.trim() : s))));
          }
          return molecules;
        }, tempRoot);
        comparisons.push({ truthFormat: file.format, status: "ok", ...matchTruth(row.truthSru?.molecules ?? row.summary.molecules, expected) });
      } catch (error) {
        comparisons.push({ truthFormat: file.format, status: "error", error: stageError("truth", error, [file.path, truthDirectory]), category: row.parseOk ? "truth.invalid_or_unverifiable_structure" : "truth.import_unavailable", matched: 0, missing: [], extra: [], nearMisses: [], categories: [] });
      }
    }
    // One record and one agreement vote per ID. If references disagree, expose every comparison
    // and put the worst reference's molecule counts at the top level rather than double-counting.
    const score = (c: typeof comparisons[number]) => c.status === "error" ? Infinity : c.missing.length + c.extra.length;
    const worst = comparisons.reduce((a, b) => score(b) > score(a) ? b : a);
    const agreement = comparisons.every(c => c.status === "ok" && !c.missing.length && !c.extra.length);
    await appendFile(destination, `${JSON.stringify({ id: row.id, ...worst, agreement, notes: row.truthSru?.notes ?? [], categories: [...new Set(comparisons.flatMap(c => c.categories))], comparisons })}\n`);
  }
  await report(out);
}
