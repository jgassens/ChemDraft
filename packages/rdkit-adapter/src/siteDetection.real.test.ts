/**
 * Does the product find the atom the measurement is about, and when it does not, why not?
 *
 * Every accuracy figure this project publishes is conditioned on being handed the right ionizing atom. A
 * user hands over a drawing. This is the only measurement of the step in between, and it had never been
 * taken — which is how a 100% miss rate on oximes survived: nothing distinguishes "there is no site here"
 * from "I did not look".
 *
 * **Self-contained within the repo, but NOT from a bare checkout.** It reads `merged-labels.json` out of
 * the vendor directory, which is the same corpus the model trains on — and that file is GITIGNORED (the
 * labels carry CC BY / CC BY-NC terms and are never committed), so a fresh clone does not have it and
 * neither does CI. Regenerating it means running the pipeline in `vendor/pka-model/`. The earlier claim
 * here said "regenerates from a bare checkout", which was simply false and is the reason this is spelled
 * out rather than left implied. What the move to the vendored corpus DID fix is real: an earlier version
 * read a truth file an ad-hoc script wrote outside the repo, which made the published recall
 * unreproducible even for its author — the failure `macro_validate.py` was written to end.
 *
 * **Why it is env-gated, and what that costs.** The corpus is absent in CI, so this cannot be a required
 * check; `SITE_DETECTION=1` is how you ask for it locally. That means the recall figure quoted in the
 * ionization contract is NOT defended by an automated gate, which is a known and stated gap — the floor
 * below is what makes the number a gate when the suite does run, rather than something only printed.
 *
 * **Measured through `analyzeStructure`**, the real entry point, so the domain guards and the default
 * `reference-protomer` interpretation are in play. Measuring `scanIonizableSites` directly would score a
 * function rather than the product.
 *
 * **Gated off by default.** A full pass is 12,062 analyses and about 30 minutes. `SITE_LIMIT=n` samples,
 * and the sample is drawn by a seeded shuffle rather than a slice, because `merged-labels.json` is sorted
 * by pKa — slicing the first n rows takes the most acidic tail in the corpus and measures the extremes.
 * That mistake produced an apparent 70% recall whose every miss was a protonated carbonyl.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { analyzeStructure } from "./analysis";
import { ensureRdkit } from "./conformer";
import { elementSymbol } from "./composition";
import { IONIZATION_SITES_METHOD_ID } from "./ionization";
import { installRealRdkitModuleLoader } from "./testing";

const CORPUS = new URL("../vendor/pka-model/merged-labels.json", import.meta.url);
const LIMIT = Number(process.env.SITE_LIMIT ?? "0");

interface Label {
  acid: string;
  acidAtomIdx: number;
  pKa: number;
  /**
   * The conjugate base, where the corpus records one — which is what makes the labelled ionization EVENT
   * fully specified rather than just an atom index. 8,074 of 12,096 rows have it. The 4,022 that do not
   * are the QupKake rows, whose site index is ChemAxon Marvin's assignment: a predictor annotation
   * embedded in the label, disclosed as such in `ionizationContract()`. A disagreement with those is not
   * cleanly a locator gap NOR a relocation — it may be the label that is wrong — so they are counted
   * apart rather than folded into either.
   */
  base?: string;
}

/** Element, charge and hydrogen count per atom of the molecule AS DRAWN. */
interface DrawnAtom {
  element: string;
  charge: number;
  hydrogens: number;
}

beforeAll(() => {
  installRealRdkitModuleLoader();
});

async function drawnAtoms(smiles: string): Promise<DrawnAtom[] | undefined> {
  const module = await ensureRdkit();
  const mol = module.get_mol(smiles) as { get_json: () => string; delete: () => void } | null;
  if (!mol) return undefined;
  try {
    const json = JSON.parse(mol.get_json()) as {
      molecules: { atoms: { z?: number; chg?: number; impHs?: number }[] }[];
      defaults?: { atom?: { z?: number; chg?: number; impHs?: number } };
    };
    const d = json.defaults?.atom ?? {};
    return (json.molecules[0]?.atoms ?? []).map((a) => ({
      element: elementSymbol(a.z ?? d.z ?? 6),
      charge: a.chg ?? d.chg ?? 0,
      hydrogens: a.impHs ?? d.impHs ?? 0
    }));
  } finally {
    mol.delete();
  }
}

/** Deterministic, order-independent sample. See the note about the corpus being pKa-sorted. */
function sample<T>(items: T[], count: number): T[] {
  if (count <= 0 || count >= items.length) return items;
  let seed = 12345;
  const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  return items
    .map((item) => [next(), item] as const)
    .sort((a, b) => a[0] - b[0])
    .slice(0, count)
    .map(([, item]) => item);
}

type Bucket =
  | "found"
  | "equivalent-atom"
  | "same-event-relocated"
  | "policy-removed-unreported"
  | "genuine-gap"
  | "label-site-from-a-predictor"
  | "unassessable"
  | "index-unstable"
  | "error";

describe.runIf(process.env.SITE_DETECTION === "1")("site detection through the product path", () => {
  it("reports recall and why each miss was missed", async () => {
    const labels = JSON.parse(readFileSync(CORPUS, "utf8")) as Label[];
    const byMolecule = new Map<string, Label[]>();
    for (const row of labels) {
      const list = byMolecule.get(row.acid) ?? [];
      list.push(row);
      byMolecule.set(row.acid, list);
    }
    // Both derivations record an identity atom mapping and it is genuine — verified over all 12,062
    // molecules by an independent probe. But it is identity relative to each derivation's own BASE, and
    // `reference-protomer` stacks on `largest-organic-fragment`: for a salt the composed mapping shifts
    // by the counterion's atom count, so reading the labelled index straight onto the scored structure
    // would be wrong. This corpus has no multi-component rows, which is why the shortcut is safe here —
    // asserted rather than assumed, so a corpus that gains one fails instead of quietly mis-scoring.
    const multiComponent = labels.filter((row) => row.acid.includes("."));
    expect(multiComponent, `${multiComponent.length} multi-component rows break the index shortcut`)
      .toHaveLength(0);
    const molecules = sample([...byMolecule.entries()], LIMIT);

    const tally = new Map<Bucket, number>();
    const bump = (b: Bucket): void => {
      tally.set(b, (tally.get(b) ?? 0) + 1);
    };
    const byElement = new Map<string, Map<Bucket, number>>();
    const examples = new Map<Bucket, string[]>();
    const note = (b: Bucket, line: string): void => {
      const list = examples.get(b) ?? [];
      if (list.length < 8) list.push(line);
      examples.set(b, list);
    };
    let interpretationApplied = 0;
    const records: Record<string, unknown>[] = [];
    const started = Date.now();

    for (const [smiles, rows] of molecules) {
      let verdicts: Bucket[];
      const evidence = new Map<number, Record<string, unknown>>();
      try {
        const drawn = await drawnAtoms(smiles);
        const run = await analyzeStructure({
          format: "smiles", value: smiles,
          runId: `site-${smiles}`, startedAt: "2026-08-08T00:00:00.000Z"
        } as never);
        const result = run.results.find((e) => e.methodId === IONIZATION_SITES_METHOD_ID);
        if (!result || result.kind !== "ionization" || !drawn) {
          verdicts = rows.map(() => "error");
        } else {
          const derived = new Map(
            (result.depiction?.atoms ?? []).map((a) => [a.index, a])
          );
          const bonds = result.depiction?.bonds ?? [];
          const neighbours = (i: number): number[] =>
            bonds.filter((b) => b.from === i || b.to === i).map((b) => (b.from === i ? b.to : b.from));
          const reported = new Set(result.sites.map((s) => s.ionizableAtomIndex));
          const flagged = new Set(result.unassessed.flatMap((u) => u.atomIndices));
          if (result.interpretationId !== "source") interpretationApplied += 1;

          // Which atoms GAINED a proton relative to the drawing? A tautomer shift moves a proton from one
          // atom to another; the ionization event survives on whichever atom now carries it.
          const gained: number[] = [];
          for (const [index, atom] of derived) {
            const before = drawn[index];
            if (before && atom.hydrogens > before.hydrogens) gained.push(index);
          }

          for (const row of rows) {
            evidence.set(row.acidAtomIdx, {
              interpretation: result.interpretationId,
              // The DERIVED structure in full, because verifying a relocation claim needs the frame the
              // app actually scored. Two attempts to verify from the drawn frame failed: deprotonating the
              // reported atom in the drawing removes a second proton from the wrong position, and
              // hand-moving a proton without adjusting bond orders produces radicals. The depiction IS the
              // derived molecule, so dumping it removes the guesswork.
              derivedAtoms: (result.depiction?.atoms ?? []).map((a) =>
                [a.index, a.element, a.charge, a.hydrogens]),
              derivedBonds: bonds.map((b) => [b.from, b.to, b.order]),
              derivedAtom: derived.get(row.acidAtomIdx) ?? null,
              reported: [...reported],
              gainedProton: gained,
              neighbours: neighbours(row.acidAtomIdx)
            });
          }
          verdicts = rows.map((row) => {
            const before = drawn[row.acidAtomIdx];
            const after = derived.get(row.acidAtomIdx);
            // The identity atomMapping both derivations record is CHECKED here, not trusted. Element is
            // invariant under removing a charge or moving a proton, so a mismatch means the indices moved
            // and nothing index-based about this molecule can be believed.
            if (before && after && before.element !== after.element) return "index-unstable";
            if (reported.has(row.acidAtomIdx)) return "found";
            if (flagged.has(row.acidAtomIdx)) return "unassessable";
            // Before attributing a miss to the app, ask whether the label can bear the weight.
            if (!row.base) return "label-site-from-a-predictor";

            // Same ionization event, different atom of the same group: a carboxyl's two oxygens are one
            // resonance structure apart, so which one carries the label is a convention rather than a
            // fact about the chemistry. Qualifying is deliberately narrow — the same element, sharing a
            // neighbour with the labelled atom. Any same-element atom anywhere in the molecule would
            // credit a phenol for a missed carboxyl.
            if (after && neighbours(row.acidAtomIdx).length > 0) {
              const mine = new Set(neighbours(row.acidAtomIdx));
              const twin = [...derived.keys()].some((t) =>
                t !== row.acidAtomIdx
                && derived.get(t)!.element === after.element
                && reported.has(t)
                && neighbours(t).some((n) => mine.has(n))
              );
              if (twin) return "equivalent-atom";
            }

            // Did canonicalization take the proton off this atom? If so the event moved; credit the app
            // only if it reported a site on an atom that actually GAINED that proton.
            const lostProton = before && after && after.hydrogens < before.hydrogens;
            const lostCharge = before && after && before.charge !== 0 && after.charge === 0;
            if (lostProton || lostCharge) {
              return gained.some((g) => reported.has(g))
                ? "same-event-relocated"
                : "policy-removed-unreported";
            }
            return "genuine-gap";
          });
        }
      } catch {
        // Bucketed as `error` and then EXCLUDED from `judged`, so a partial engine failure used to
        // shrink the denominator and the printed recall silently described only the molecules that
        // survived. The assertion below now requires this bucket to be empty, so a failure has to be
        // dealt with rather than quietly improving the score.
        verdicts = rows.map(() => "error");
      }
      const drawnForTally = await drawnAtoms(smiles);
      rows.forEach((row, i) => {
        const verdict = verdicts[i]!;
        bump(verdict);
        const element = drawnForTally?.[row.acidAtomIdx]?.element ?? "?";
        records.push({
          smiles, site: row.acidAtomIdx, pKa: row.pKa, element, verdict,
          drawn: drawnForTally?.[row.acidAtomIdx] ?? null,
          ...(evidence.get(row.acidAtomIdx) ?? {})
        });
        const slot = byElement.get(element) ?? new Map<Bucket, number>();
        slot.set(verdict, (slot.get(verdict) ?? 0) + 1);
        byElement.set(element, slot);
        if (verdict !== "found") {
          note(verdict, `${smiles} @${row.acidAtomIdx} pKa ${row.pKa}`);
        }
      });
    }

    const get = (b: Bucket): number => tally.get(b) ?? 0;
    // Rows whose site index came from a predictor are excluded from the denominator, not scored as
    // failures: charging the locator for disagreeing with Marvin measures agreement between two
    // predictors, not accuracy.
    const judged = get("found") + get("equivalent-atom") + get("same-event-relocated")
      + get("policy-removed-unreported") + get("genuine-gap") + get("unassessable");
    const credited = get("found") + get("equivalent-atom");
    const lines = [
      "",
      `molecules analysed          ${molecules.length}  (${((Date.now() - started) / 1000).toFixed(0)}s)`,
      `interpretation applied      ${interpretationApplied}`,
      "",
      `found at the labelled atom  ${get("found")}`,
      `equivalent atom, same group ${get("equivalent-atom")}`,
      `same event, relocated       ${get("same-event-relocated")}`,
      `policy removed, unreported  ${get("policy-removed-unreported")}`,
      `genuine gap                 ${get("genuine-gap")}`,
      `label site from a predictor  ${get("label-site-from-a-predictor")}   (excluded from recall)`,
      `flagged unassessable        ${get("unassessable")}`,
      `INDEX UNSTABLE              ${get("index-unstable")}   <- must be 0, or indices moved`,
      `threw                       ${get("error")}`,
      "",
      `RECALL, strict              ${((100 * credited) / judged).toFixed(1)}%  ` +
        `(found + equivalent atom, of ${judged})`,
      `RECALL, credit relocation   ${((100 * (credited + get("same-event-relocated"))) / judged).toFixed(1)}%`,
      ""
    ];
    lines.push("by element (strict recall):");
    for (const [element, slot] of [...byElement.entries()].sort(
      (a, b) => [...b[1].values()].reduce((x, y) => x + y, 0)
        - [...a[1].values()].reduce((x, y) => x + y, 0)
    )) {
      const n = [...slot.values()].reduce((x, y) => x + y, 0);
      const ok = (slot.get("found") ?? 0) + (slot.get("equivalent-atom") ?? 0);
      lines.push(
        `  ${element.padEnd(3)} n=${String(n).padStart(5)}  strict ${((100 * ok) / n).toFixed(1).padStart(5)}%` +
        `   relocated ${String(slot.get("same-event-relocated") ?? 0).padStart(4)}` +
        `   policy-unreported ${String(slot.get("policy-removed-unreported") ?? 0).padStart(4)}` +
        `   gap ${String(slot.get("genuine-gap") ?? 0).padStart(4)}`
      );
    }
    lines.push("");
    for (const bucket of ["genuine-gap", "policy-removed-unreported", "same-event-relocated",
      "label-site-from-a-predictor", "index-unstable"] as Bucket[]) {
      const list = examples.get(bucket);
      if (list?.length) lines.push(`${bucket}:`, ...list.map((s) => "  " + s));
    }
    // Every input to the classification, dumped, so tightening the criterion is a re-read rather than
    // another half-hour pass. `SITE_DUMP` names the file; omitted, nothing is written.
    if (process.env.SITE_DUMP) {
      writeFileSync(process.env.SITE_DUMP, JSON.stringify(records));
      lines.push("", `wrote ${records.length} classification records to ${process.env.SITE_DUMP}`);
    }
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
    expect(get("index-unstable")).toBe(0);
    expect(judged).toBeGreaterThan(0);

    // THE NUMBER IS A GATE, NOT A PRINTOUT. Everything above was `console.log`ged and the only
    // assertions were index stability and a non-empty denominator, so recall could have fallen to 20%
    // with the suite still green while the ionization contract went on quoting 91.6% to users.
    //
    // A molecule that threw must not vanish from the denominator either — that is the other way the
    // figure could improve without the engine improving.
    expect(get("error"), "molecules that threw are excluded from recall and must not be silent").toBe(0);

    // The floor sits below the measured 91.6% strict recall with room for ordinary movement, and well
    // above the level at which the published claim would be wrong. It is a regression guard, not a
    // restatement of the measurement: the measurement is what the log prints.
    const strictRecall = (100 * credited) / judged;
    expect(strictRecall, `strict recall fell to ${strictRecall.toFixed(1)}%`).toBeGreaterThan(85);
  }, 3_600_000);
});
