/**
 * Ionizable-site assessment (PLANS.md §9 Later phases; §8's "protonation-state enumeration").
 *
 * **Two stages, from two different sources.** The site table *locates* ionizable positions; the model
 * in `pkaModel.ts`, trained here on measured pKa, *values* them. Keeping them apart is the whole
 * design, because the table turned out to be good at the first job and unfit for the second.
 *
 * **The table contributes no pKa value at all**, and that is measured rather than cautious. Scored
 * against 1,750 experimentally labelled sites from the open Dwar-iBond set:
 *
 * | reading of the table | MAE (log units) | within 1 |
 * |---|---|---|
 * | site matched by exactly ONE type | 2.77 | 21% |
 * | matched by several, read at its best case | 1.11 | 60% |
 * | realistic, not knowing which type applies | ~5.0 | 14% |
 * | simply predicting the dataset mean | 2.33 | — |
 *
 * The first row is the one that decides it. Restricting values to unambiguous sites is the obvious
 * safeguard, and it does not work: a lone matching type scores *worse* than several matching ones and
 * worse than a constant. Unambiguity is not a proxy for reliability.
 *
 * The cause is structural. 46% of labelled sites match more than one type, and the types describe
 * different TRANSITIONS on the same atom — the *Alcohol* entry is R-OH losing a proton (~15), while
 * the same oxygen in R-OH2+ loses one near -7. Nothing in a substructure match says which is in play,
 * so a number here would be wrong by up to 20 log units with a confident label on it.
 *
 * A pKa value belongs to a method trained on measured values per site, so that is what the values come
 * from: `pkaGnn.ts`, a four-member message-passing network at MAE 0.73 over Murcko-scaffold-held-out
 * folds, with a per-site interval taken from how much its members disagreed rather than one global
 * error figure stamped on every row.
 *
 * It replaced a random forest, which measured 1.02 on the identical split and is still trained by
 * `run_all.sh` as the transparent baseline that claim is made against. The forest also needed
 * whole-molecule descriptors — average mass, polar surface area, Crippen logP — and that is exactly the
 * channel through which a sodium counterion shifted acetic acid's answer. A network reads the graph, so
 * the channel is gone rather than guarded.
 *
 * **A second opinion, where one is available.** The obvious candidate was the table, and measuring it
 * is what disqualified it: agreement with a method that scores worse than a constant is confidence in
 * nothing. The second estimator is instead a Hammett linear free-energy relationship (`hammett.ts`)
 * whose constants come from the physical-organic literature rather than from this project's training
 * set — so its agreement with the model carries information instead of being circular.
 *
 * It reaches a small fraction of sites and declines on the rest, which is what an LFER should do. Four
 * series ship — benzoic, phenol, anilinium, pyridinium — and over the 199 sites they reach:
 *
 * | | MAE (log units) |
 * |---|---|
 * | the model alone | 0.56 |
 * | the relationship alone | 0.22 |
 * | their plain average | 0.29 |
 * | weighted by measured accuracy | 0.20 |
 *
 * The third row is the one that shaped the code: averaging is the obvious rule and it is worse than the
 * better method alone, so `combineSiteEstimates` weights by each method's own measured error.
 *
 * The fourth row does not beat the relationship on its own, and the contract says so rather than
 * claiming otherwise. What the pair buys is the INTERVAL. Their disagreement tracks actual error at
 * r = 0.87, where the forest's own tree variance manages 0.52, and the resulting interval covers 94%
 * of the real error.
 *
 * Where only one method fires, its estimate passes through as itself and is never labelled a consensus.
 *
 * **Both directions are reported, because half the chemistry is not the answer.** Dimorphite is a
 * protonation-state enumerator: it locates positions that can gain a proton as well as lose one. So
 * does this method now. A site drawn with a hydrogen gets an ACIDIC pKa — that proton leaving. A site
 * with an available lone pair gets a BASIC pKa — the pKa of its conjugate acid, which is the number a
 * chemist means by "the amine's pKa". An atom can carry both, and `transition` says which is which so
 * a reader never has to infer it from the value's size.
 *
 * The basic value is computed by building the microstate: the atom is protonated, the molecule
 * re-parsed, and the model asked for the acidity of the result. Against ChemAxon on histidine that
 * gives 8.77 for the amine (9.25), 5.42 for the ring nitrogen (6.14), and on glycine 9.56 (9.60).
 *
 * Reporting only acidity produced two failures that looked like successes. Histidine's protonless ring
 * nitrogen was given 5.83 for a proton it does not have. Its amine was given 9.03 — nearly the measured
 * 9.25 of its ammonium, and so read as correct while describing a different reaction. Both are now
 * labelled basic and computed properly.
 *
 * **What still gets no acidic value: a plain amine's N-H.** Near 35, outside water, and zero of the
 * 7,053 training labels is an unactivated amine — a count, not a chemical opinion, re-counted on the
 * corrected corpus: of 636 acidic labels on a neutral N-H, none has only saturated carbon around it.
 * The rule was checked the other way too (applied to the training set it rejects 0 rows). The amine
 * still reports its basic pKa, which is the one anybody wanted.
 *
 * **Macroscopic pKa, from the microstate ladder.** Everything above is microscopic; a reference table
 * is not. `protonation.ts` folds the ladder into what a titration measures, exactly rather than by a
 * fit. `macroscopicFold.real.test.ts` measures the SHIPPED path on sixteen molecules with tabulated
 * constants: mean error **0.30** log units, and **0.18** across the eight zwitterions. Zwitterions are
 * no longer the weak case they were — they are now the strongest class in the set.
 *
 * The fold solves every microstate's free energy at once, by weighted least squares over the whole
 * ladder, rather than walking outward by proton count and averaging the routes into each state. That
 * matters because of a defect no per-site number can show: `pKa(n) = log10(Z(n)/Z(n-1))` sums over
 * every microstate at a proton count, populated or not, so the answer depends on species a titration
 * cannot reach and no corpus can label. Glycine's neutral form is the standing example — the model was
 * measured saying 4.33 for it under one corpus and 8.56 under another while agreeing to within 0.1 on
 * every species an experiment CAN measure. Weighting each rung by the ensemble's own disagreement
 * (`EDGE_VARIANCE`, fitted on 12,096 out-of-fold predictions) lets the labelled chemistry pin the
 * unlabelled species instead of averaging them in as equals. Measured against the sweep it replaced:
 * 0.380 to 0.302 overall, 0.336 to 0.178 on zwitterions, SAMPL6's matched figure 0.553 to 0.515, and
 * every molecule whose ladder has no cycle to close is bit-identical.
 *
 * The previous corpus produced 0.52 here, and the one before that 0.44 while being measurably wrong —
 * the number moved the wrong way when the labels were corrected, which was recorded rather than
 * smoothed over and has now resolved on its own. Adding pKaCHU, which contains the amino-acid
 * microstates the earlier sources never recorded, took it to 0.34.
 *
 * **Azoles, where one proton has two homes.** Imidazole's ring nitrogens scan as two sites, and
 * flipping both at once is the proton MOVING — the tautomer, the same molecule redrawn. Enumeration
 * only assigns charges, so it built `c1c[nH+]c[n-]1`, an ylide the model scores at 6.95 where real
 * neutral imidazole is 13.84. Those microstates are excluded, which takes the azoles from 1.69 to 0.54.
 * The exclusion is no longer limited to aromatic rings: urea's two nitrogens across a carbonyl are the
 * same case, and the model placed their ylide 1.7 log units BELOW neutral urea.
 *
 * **The electrostatic coupling has almost nothing left to do, and that is the interesting part.** It
 * was introduced because zwitterions scored 2.06 against 0.28 for everything else, and a one-parameter
 * Coulomb term across acid/base pairs closed most of it — both halves of a scaffold split independently
 * choosing W = 7. Refitted after pKaCHU, the optimum is W = 1, it is worth 0.037 log units, and the old
 * W = 6 is WORSE than switching the term off. The correction was never physics the model could not
 * learn; it was physics the LABELS did not contain, and a corpus that contains it makes the hand-fitted
 * term redundant.
 *
 * **What it scores when it is given nothing but a structure.** Every figure above is oracle-site: the
 * position and its direction are supplied. On SAMPL6 — a BLIND challenge, so the values were withheld
 * while predictions were made, and checked here to share no skeleton with any training row — the whole
 * pipeline scores **MAE 0.50 and RMSE 0.60** over 31 macroscopic values when each measured value is
 * matched to its closest prediction, with 90% inside one log unit, 100% inside two, and a largest single
 * error of 1.35 — and emits 37 extra steps nothing measured. RMSE is quoted alongside because it is what
 * the challenge itself reported, and because MAE alone flatters a method with a long tail.
 *
 * The gap between 1.0 and 2.2 is the honest measure of what is still wrong, and it is not valuation:
 * SM22's phenol reads 7.48 against a measured 7.43, and SM10's amide reads 8.94 against 9.02. It is
 * OVER-DETECTION — a molecule with one real pKa comes back with several — and the causes were pursued
 * one at a time, each gated on what the corpus actually contains.
 *
 * FIXED: an N-substituted pyrrole-type ring nitrogen was treated as basic. One training label in
 * 11,472 argues otherwise, so it shipped. N-methylindole had been reporting a titration curve at
 * pH 4.75, confidently.
 *
 * FIXED: an UNACTIVATED amide nitrogen was offered a basicity. The blanket version of that rule was
 * measured twice and declined twice — the corpus holds 35 basic pKa values on plain amide nitrogens
 * and 22 on amidine-like ones, all real. Narrowed to a nitrogen carrying one carbonyl and nothing else
 * but saturated carbon and hydrogen, the count is 1 of 11,472, and acetamide, urea, N-methylacetamide
 * and formamide stop inventing a basicity while acetanilide, acylaminothiazoles, acylsulfonamides and
 * amidines keep theirs. End to end this is MAE 2.22 -> 2.14 with a sixth molecule getting the right
 * number of steps.
 *
 * STILL WRONG: the remaining over-detection is aromatic ring nitrogens and anilide nitrogens in
 * acylaminoheterocycles — SM03, SM10 and SM19 each report three or four steps against one measured.
 * Those are exactly the contexts where the corpus says the basicity is real, so the next move is not
 * another rule; it is being able to tell which ring nitrogen in a fused heterocycle actually titrates.
 *
 * ALSO CONSIDERED AND REJECTED: gating on the model's measured per-class accuracy, which ranges from
 * 0.51 for carboxyls to 4.65 for sulfonyl oxygens. It would not help — every class involved in the
 * over-detection above is one the model is decent at (1.1 to 1.4), and the badly calibrated classes do
 * not appear. The residual is site LOCATION, not valuation confidence, and a confidence gate cannot
 * reach it.
 *
 * What is done in the meantime is narrow and stated: a rung whose interval spans more than half the
 * aqueous range is not folded into the macroscopic curve, because such a rung locates no step. It is
 * still REPORTED, with its interval, so nothing is hidden — but urea no longer gets a titration curve
 * drawn through four values it cannot stand behind. Measured: end-to-end MAE 2.43 to 2.22, molecules
 * with the right step count 1 to 5, and the fifteen curated polyprotic molecules unchanged.
 *
 * **Why it declines on metals rather than guessing.** Measured across every training and test set the
 * open pKa models ship — 1.57M molecules — the count of metal-containing structures is zero. Nothing
 * in this space has evidence about a metal centre, so a site adjacent to one is reported as
 * *unassessed* with the reason, never given a number.
 */
import type {
  Classification,
  IonizationResult,
  IonizationSite,
  MethodContract
} from "@chemdraft/analysis-core";

import { estimateHammettPka, hammettApplies } from "./hammett";
import { IONIZATION_SITE_TYPES, SENTINEL_PKA_MAGNITUDE } from "./ionizationSites";
import { ORGANIC_PARAMETER_SET, PINNED_PKA_MODEL_SHA256 } from "./methods";
import consensusJson from "../vendor/pka-model/consensus-calibration.json";
import externalJson from "../vendor/pka-model/external-validation.json";
import {
  PKA_MODEL_CALIBRATION,
  PKA_MODEL_TRAINING,
  ringMembership,
  siteFeatures,
  type PkaMolecularGraph
} from "./pkaModel";
import { PKA_GNN_TRAINING, PKA_INTERVAL_CALIBRATION, predictSitePka } from "./pkaGnn";
import { siteContext } from "./pkaAromaticity";

/**
 * The held-out figure, read from the artifact the measurement wrote.
 *
 * Typed in by hand it went stale twice — the contract still claimed a 38-row figure long after the
 * evaluation had grown to 398 rows.
 */
export const EXTERNAL_VALIDATION = externalJson as unknown as {
  samples: number; mae: number; standardError: number;
};

/** What combining the two methods was measured to be worth. Read, not asserted. */
export const CONSENSUS_CALIBRATION = consensusJson as unknown as {
  samples: number; phenolSamples: number; benzoicSamples: number;
  forestWeight: number; hammettMae: number; hammettInterval68: number;
  hammettMaePhenol: number; hammettMaeBenzoic: number;
  forestMaeHere: number; consensusMae: number; consensusMaePhenol: number;
  /** MAE of the plain average of the two, kept because it is why the code does not average. */
  meanMae: number;
  coverage: number; disagreementCorrelation: number;
  /** Median interval half-width of the consensus, and of the model alone on those same sites. */
  medianHalfWidth: number; modelHalfWidthHere: number;
};

export const IONIZATION_SITES_METHOD_ID = "dimorphite.ionizable-sites";

/**
 * The Hammett relationship's measured error within the domain it accepts.
 *
 * One figure for the whole series, not a per-site one: an LFER is fitted to a substituent series and
 * makes no claim about which of its members it fits best. Measured over the 85 Dwar-iBond sites it
 * applies to -- see `hammett.ts` for why the benzoic half of that number is partly circular.
 */
export const HAMMETT_IN_DOMAIN_MAE = CONSENSUS_CALIBRATION.hammettMae;

/**
 * The Hammett relationship's own 68% interval, on the sites where it applies.
 *
 * Its MAE was reported here as the spread, which is a different quantity on the same axis: since the
 * model's spread became a calibrated 68% quantile, the MAE's 74.6% coverage was quietly claiming more
 * confidence than the number next to it. Six points too wide rather than wrong, and now the same thing
 * either way. The MAE above is kept, because the consensus WEIGHT is argued from mean error and should
 * not silently change with this.
 */
export const HAMMETT_IN_DOMAIN_INTERVAL = CONSENSUS_CALIBRATION.hammettInterval68;

/**
 * Where the model's interval stops meaning "trust this" and starts meaning "check this".
 *
 * The first and third quartile boundaries of its out-of-fold interval, so the bands are the ones whose
 * accuracy was actually measured: at or below `good` is the quarter of sites whose MAE is
 * `quartileMae[0]`, above `poor` the quarter whose MAE is `quartileMae[3]`. Read from the
 * calibration, never typed here.
 */
export const IONIZATION_CONFIDENCE_BANDS = {
  // Quartiles of the CALIBRATED interval, not of the raw ensemble deviation. The ring is sized by the
  // calibrated number, so colouring it by the raw one would grade a ring against a scale it is not
  // drawn on. Reading the forest's here would be the same mistake one model further back.
  good: PKA_INTERVAL_CALIBRATION.intervalQuartiles[0]!,
  poor: PKA_INTERVAL_CALIBRATION.intervalQuartiles[2]!
};

const IONIZATION_ENGINE = "dimorphite-site-table";
const IONIZATION_ENGINE_VERSION = "2.0.2";

/** Elements no open pKa evidence covers. A site touching one is reported, never scored. */
const UNEVIDENCED_ELEMENTS = new Set([
  "Fe","Pt","Pd","Ru","Cu","Zn","Ni","Co","Mn","Cr","Ag","Au","Cd","Hg","Ti","V","Mo","W",
  "Sn","Pb","Sb","Bi","Al","Mg","Ca","Na","K","Li","Zr","Ce","Gd","Eu","Ir","Rh","Os","Re"
]);

export interface IonizationMatcher {
  get_qmol(smarts: string): { delete(): void } | null;
}

export interface IonizationMolecule {
  get_substruct_matches(query: unknown): string;
}

export interface IonizationScan {
  sites: IonizationSite[];
  unassessed: { atomIndices: number[]; reason: string }[];
}

/**
 * Find every ionizable site the table recognises.
 *
 * **`mol` must have explicit hydrogens.** Most of the table's patterns end `-[H]`, an explicit atom,
 * and RDKit strips hydrogens on parse — even when the SMILES writes them out. Dimorphite calls
 * `Chem.AddHs` before matching for exactly this reason. Beware that MinimalLib's `add_hs()` is a
 * silent no-op on the vendored build; `add_hs_in_place()` is the one that works, and it mutates, so
 * callers must pass a copy rather than the molecule the rest of the run is using.
 *
 * One site per (substructure match, tabulated position). Overlaps are **not** suppressed the way
 * Joback's fragmentation suppresses them: two site types can legitimately describe the same atom
 * (an aromatic nitrogen is both protonated and unprotonated depending on the state you start from),
 * and collapsing them would drop a real titration. Duplicate *positions* are collapsed, because the
 * same atom reported twice from one type is noise rather than chemistry.
 */
export function scanIonizableSites(
  rdkit: IonizationMatcher,
  mol: IonizationMolecule,
  elementByAtom: readonly string[]
): IonizationScan {
  const sites: IonizationSite[] = [];
  const unassessed: { atomIndices: number[]; reason: string }[] = [];
  const seen = new Set<string>();
  const byAtom = new Map<number, { atoms: number[]; typeName: string; mean: number | null; std: number }[]>();

  for (const type of IONIZATION_SITE_TYPES) {
    const query = rdkit.get_qmol(type.smarts);
    if (!query) continue;
    try {
      // MinimalLib returns `{}` rather than `[]` when nothing matches, so this cannot be iterated
      // blind. Relying on the catch below would work but would hide a real parse failure behind the
      // same silence as an ordinary no-match.
      const parsed = JSON.parse(mol.get_substruct_matches(query)) as unknown;
      const matches = Array.isArray(parsed) ? (parsed as { atoms: number[] }[]) : [];
      for (const match of matches) {
        for (const site of type.sites) {
          const atom = match.atoms[site.matchPosition];
          if (atom === undefined) continue;

          const key = `${type.name}:${atom}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const metal = match.atoms.find((index) => UNEVIDENCED_ELEMENTS.has(elementByAtom[index] ?? ""));
          if (metal !== undefined) {
            unassessed.push({
              atomIndices: [...match.atoms],
              reason:
                `This ${type.name} site is adjacent to ${elementByAtom[metal]}. No open pKa dataset ` +
                "contains a metal-bearing structure, so there is no evidence on which to give it a value."
            });
            continue;
          }

          const candidates = byAtom.get(atom) ?? [];
          candidates.push({
            atoms: [...match.atoms],
            typeName: type.name,
            // A sentinel, not a value: recognised, but never titrates in an accessible range.
            mean: Math.abs(site.pKaMean) > SENTINEL_PKA_MAGNITUDE ? null : site.pKaMean,
            std: site.pKaStd
          });
          byAtom.set(atom, candidates);
        }
      }
    } catch {
      // A pattern this build cannot compile finds nothing. Silence here loses a site rather than
      // inventing one, which is the safe direction.
    } finally {
      query.delete();
    }
  }

  // One site per ATOM, not per matching pattern — and where several site types claim the same atom,
  // no value is offered at all.
  //
  // This is measured, not cautious. Across 1,750 experimentally labelled sites from the Dwar-iBond
  // set, only 54% match exactly one type; 26% match three and 12% match four. Picking among them
  // requires knowing the answer: the table's *Alcohol* entry describes R-OH losing a proton (~15),
  // and the same oxygen in R-OH2+ losing one measures near -7. Same atom, opposite ends of the scale,
  // and nothing in the match says which transition is in play. Reported ambiguous, the reader learns
  // there is a site and that its class is undetermined. Reported as a number, they learn something
  // false to 20 log units.
  for (const [atom, candidates] of byAtom) {
    const typeNames = [...new Set(candidates.map((entry) => entry.typeName))].sort();
    const scored = candidates.filter((entry) => entry.mean !== null);

    // NO pKa VALUE, ever, from this table. See the measurement in the module header: unambiguity is
    // not a proxy for reliability here — a lone matching type scores WORSE (MAE 2.77) than several
    // matching ones read at their best (1.11), and worse than predicting the dataset mean (2.33).
    // What the table does reliably is locate the site and name its candidate classes.
    sites.push({
      atomIndices: candidates[0]!.atoms,
      ionizableAtomIndex: atom,
      siteType: typeNames.join(" / "),
      // Placeholder: the scan only LOCATES. `scoreSiteTransitions` decides which rungs this atom
      // actually has and emits one site per rung.
      transition: "acidic",
      acidCharge: 0,
      pKa: null,
      basis: "site-type-average",
      ...(typeNames.length > 1
        ? { ambiguity: { candidateTypes: typeNames, candidateValues: scored.map((entry) => entry.mean!) } }
        : {})
    });
  }

  sites.sort((a, b) => a.ionizableAtomIndex - b.ionizableAtomIndex);
  return { sites, unassessed };
}

/**
 * How much each method's estimate counts, as the inverse of the error it has been measured to make.
 *
 * A plain average would be the obvious thing and it is measurably wrong here. On the 94 sites where
 * both methods fire, the forest scores MAE 0.42 and the Hammett relationship 0.16; averaging them
 * gives 0.22 — *worse than the better method alone*. Weighting by inverse MAE gives 0.15, and on the
 * non-circular phenol half it beats Hammett alone too (0.18 against 0.22).
 *
 * The exact weight is not a knob that was tuned: inverse-MAE from each method's own published figure
 * puts the forest at 0.164, and the optimum measured across the sweep is flat from 0.10 to 0.30.
 */
const METHOD_MAE: Readonly<Record<string, number>> = {
  model: PKA_GNN_TRAINING.cvMae,
  hammett: HAMMETT_IN_DOMAIN_MAE
};

/**
 * Merge what several methods said about the same atom, and let their disagreement set the confidence.
 *
 * The **span** — the widest gap between any two methods — is what a reader should look at. Two
 * independent routes agreeing within a few tenths is worth more than either alone; two disagreeing by
 * three log units means neither should be trusted for that site, and the span says so without anyone
 * having to decide which was right. It is the best error signal available here: measured against actual
 * error it scores r = 0.85, where the forest's own tree disagreement manages 0.42.
 *
 * The value is weighted by measured accuracy rather than averaged — see `METHOD_MAE`. A method with no
 * measured figure falls back to an equal share, which is the honest default for an unknown.
 *
 * The interval is the span itself (measured coverage 93%), floored so that two methods agreeing exactly
 * cannot report perfect certainty.
 */
export function combineSiteEstimates(perMethod: Readonly<Record<string, readonly IonizationSite[]>>): IonizationSite[] {
  // Keyed by atom AND transition. An atom can carry both an acidic and a basic value — histidine's
  // amine has a basic 9.25 and an acidity near 35 — and merging those two would average a molecule's
  // deprotonation with its protonation and call the result a consensus.
  const byKey = new Map<string, { method: string; site: IonizationSite }[]>();
  for (const [method, list] of Object.entries(perMethod)) {
    for (const site of list) {
      // Keyed on the RUNG, not on the direction. Direction is each method's description of the rung,
      // and two methods legitimately describe one equilibrium from opposite sides — the forest reads
      // pyridinium's N-H as an acid losing its proton, the Hammett pyridinium series reads the same
      // edge as a conjugate acid. Keyed on direction those became two sites on one nitrogen, and the
      // molecule was flagged a zwitterion for it.
      const key = `${site.ionizableAtomIndex}:${site.acidCharge}`;
      const bucket = byKey.get(key) ?? [];
      bucket.push({ method, site });
      byKey.set(key, bucket);
    }
  }

  const merged: IonizationSite[] = [];
  const ordered = [...byKey.entries()].sort(
    (a, b) => a[1][0]!.site.ionizableAtomIndex - b[1][0]!.site.ionizableAtomIndex
  );
  for (const [, entries] of ordered) {
    const atom = entries[0]!.site.ionizableAtomIndex;
    const scored = entries.filter((entry) => entry.site.pKa !== null);
    if (scored.length === 0) {
      merged.push(entries[0]!.site);
      continue;
    }
    if (scored.length === 1) {
      // Passed through as itself, never relabelled a consensus. One opinion is one opinion.
      merged.push(scored[0]!.site);
      continue;
    }

    const values = scored.map((entry) => entry.site.pKa!);
    const methods = scored.map((entry) => entry.method);
    const span = Math.max(...values) - Math.min(...values);
    // Per METHOD, not per prediction, and that was re-examined once a calibrated per-prediction
    // interval existed. Weighting each estimate by its own variance is the obvious upgrade and it was
    // measured on the 342 sites where both methods fire:
    //
    //   fixed per-method weight (this)             0.2494    terciles 0.158 / 0.239 / 0.351
    //   per-prediction, Hammett as MAE^2           0.2467    terciles 0.146 / 0.213 / 0.382
    //   per-prediction, Hammett as RMSE^2          0.2560
    //   per-prediction, Hammett RMSE per series    0.2614
    //
    // A 1% overall gain that costs 9% on the tercile where the model is least sure, which is where a
    // consensus earns its keep. The cause is that the two methods cannot be put on one footing: the
    // Hammett relationship's RMSE is 0.556 against an MAE of 0.259, so it is usually excellent and
    // occasionally terrible, and any variance-based weight either over-penalises its typical case or
    // under-penalises its tail.
    //
    // PER-SERIES weighting was tried too, and is the most promising of the three because Hammett's own
    // accuracy varies 4.5x across them — benzoic 0.119, phenol 0.272, anilinium 0.312, pyridinium
    // 0.532, and it beats the model on all four. Scaffold-grouped out-of-fold it scores 0.2491 against
    // 0.2494. Nothing.
    //
    // Three attempts, one explanation, recorded so there is not a fourth: the consensus is INSENSITIVE
    // to its weight. Each series' own optimum is 0.245, 0.354, 0.313 and 0.430 against the global
    // 0.338, and a weighted mean's error is quadratic and therefore flat near the optimum, so being
    // 0.09 off on a class costs almost nothing. The weight is not where the remaining error lives.
    const weights = scored.map((entry) => 1 / (METHOD_MAE[entry.method] ?? 1));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const combined = scored.reduce((sum, entry, i) => sum + entry.site.pKa! * weights[i]!, 0) / total;
    const floor = Math.min(...scored.map((entry) => entry.site.spread ?? Infinity));

    merged.push({
      atomIndices: scored[0]!.site.atomIndices,
      ionizableAtomIndex: atom,
      siteType: scored[0]!.site.siteType,
      // Both inputs describe the SAME rung — that is what the key guarantees — so the identity is
      // carried across unchanged and `transition` is derived from it rather than picked from a winner.
      acidCharge: scored[0]!.site.acidCharge,
      transition: transitionFor(scored[0]!.site.acidCharge),
      pKa: combined,
      // Never narrower than the disagreement, nor than the tightest input claimed on its own: exact
      // agreement between two methods is not evidence that both are right.
      spread: Math.max(span, Number.isFinite(floor) ? floor : 0),
      basis: "consensus",
      agreement: { methods, values, span }
    });
  }
  return merged;
}



/**
 * Whether a neutral nitrogen has a lone pair to offer a proton.
 *
 * The one case that has to be excluded is the pyrrole-type ring nitrogen: imidazole's N-H, pyrrole's,
 * indole's. Its lone pair is in the aromatic sextet, not available, and protonating it would describe a
 * species that does not form. Every other neutral nitrogen is basic to some degree — including anilines
 * (4.6) and piperidines (11.1), which is why the test cannot simply be "is it next to a double bond".
 *
 * Detected on Kekulé bond orders, which is all `get_json()` gives: a pyrrole-type nitrogen is in a ring,
 * carries a hydrogen, has only single bonds of its own, and sits between ring atoms that carry the
 * ring's double bonds. Piperidine fails the last clause and stays basic; aniline is not a ring atom at
 * all and stays basic.
 */
function acceptsAProton(
  graph: PkaMolecularGraph,
  atomIndex: number,
  ring: readonly boolean[],
  carbocyclicAromatic: readonly boolean[]
): boolean {
  const atom = graph.atoms[atomIndex];
  if (!atom || atom.element !== "N" || atom.charge !== 0) return false;

  const neighbours: number[] = [];
  let ownDoubleBonds = 0;
  for (const bond of graph.bonds) {
    const [a, b] = bond.atoms;
    if (a !== atomIndex && b !== atomIndex) continue;
    neighbours.push(a === atomIndex ? b : a);
    if (bond.order > 1) ownDoubleBonds += 1;
  }
  // Already at four bonds' worth of valence: nothing left to protonate.
  if (neighbours.length + ownDoubleBonds + atom.hydrogens >= 4) return false;
  // An amide's lone pair is in the carbonyl, not on the nitrogen. Acetamide and urea protonate on
  // OXYGEN; offering the nitrogen a basicity is what made urea a tetraprotic acid.
  if (isUnactivatedAmide(graph, atomIndex, carbocyclicAromatic)) return false;
  // Outside a ring there is no sextet to donate into, so a lone pair is available.
  if (!ring[atomIndex]) return true;
  // Pyridine-type: the nitrogen carries the ring's double bond itself, so its lone pair sits in the
  // sigma plane and is free. This is the basic ring nitrogen.
  if (ownDoubleBonds > 0) return true;

  const ringNeighboursWithDoubleBond = neighbours.filter((neighbour) => {
    if (!ring[neighbour]) return false;
    return graph.bonds.some((bond) => {
      const [a, b] = bond.atoms;
      return bond.order > 1 && (a === neighbour || b === neighbour) && ring[a === neighbour ? b : a];
    });
  });
  /**
   * Pyrrole-type: a ring nitrogen with no double bond of its own, whose neighbours carry the ring's.
   * Its lone pair is IN the aromatic sextet and is not available to a proton.
   *
   * This deliberately does not ask whether the third substituent is a hydrogen. It used to — a
   * nitrogen with no hydrogen returned "basic" before reaching this test at all — and that is a
   * statement about drawing rather than about chemistry. N-methylpyrrole's nitrogen is exactly as
   * unavailable as pyrrole's; the methyl replaces the hydrogen, not the lone pair. The consequences
   * were not subtle: N-methylpyrrole was given a basic pKa of 5.6 and N-methylindole 4.7, when neither
   * nitrogen is basic at all (pyrrole protonates on CARBON, near -3.8), and N-methylimidazole and
   * 1-phenylpyrazole each reported two basic sites where they have one. N-substituted azoles are
   * everywhere in drug molecules, which is why the SAMPL6 blind set surfaced this and no curated test
   * had.
   *
   * Evidence, on the same standard as the unactivated-amine rule: of 11,472 training labels, exactly
   * ONE is a basic pKa on an N-substituted pyrrole-type ring nitrogen — a bridged diarylamine whose
   * geometry keeps its lone pair out of conjugation. One row is the price of not inventing a basicity
   * for every N-alkyl azole.
   */
  return ringNeighboursWithDoubleBond.length < 2;
}

/** A molecule whose formal charges can be edited through its molblock. */
export interface ProtonatableModule {
  get_mol(input: string): (RdkitLikeMol & { delete(): void }) | null;
}
interface RdkitLikeMol {
  get_json(): string;
  get_descriptors(): string;
}

/**
 * The molblock with `atomIndex` carrying a +1 formal charge.
 *
 * Only the charge is written. RDKit then adds the proton itself when it re-parses — a pyridine nitrogen
 * at charge +1 with two ring bonds takes one implicit hydrogen, an -NH2 at +1 takes a third — so the
 * microstate comes out right without this code ever reasoning about valence.
 */
export function molblockWithChargedAtom(molblock: string, atomIndex: number): string | undefined {
  return molblockWithCharges(molblock, new Map([[atomIndex, 1]]));
}

/**
 * The molblock with a whole set of formal-charge DELTAS applied.
 *
 * Protonation-state enumeration needs to move several sites at once, and in both directions: a
 * carboxyl deprotonates to -1 while an amine protonates to +1. Same trick as the single-atom case —
 * write the charge, let RDKit work out the hydrogens on re-parse.
 */
export function molblockWithCharges(
  molblock: string,
  deltas: ReadonlyMap<number, number>
): string | undefined {
  const lines = molblock.split("\n");
  const counts = lines[3];
  if (!counts) return undefined;
  const atomCount = Number.parseInt(counts.slice(0, 3), 10);
  if (!Number.isFinite(atomCount)) return undefined;
  for (const atom of deltas.keys()) if (atom >= atomCount) return undefined;

  // Existing charges have to be carried over, not replaced: a nitro group's molblock already has an
  // `M  CHG` line, and dropping it would neutralise the group while protonating something else.
  const charges = new Map<number, number>();
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("M  CHG")) {
      kept.push(line);
      continue;
    }
    const fields = line.slice(6).trim().split(/\s+/);
    for (let i = 1; i + 1 < fields.length; i += 2) {
      const atom = Number.parseInt(fields[i]!, 10);
      const charge = Number.parseInt(fields[i + 1]!, 10);
      if (Number.isFinite(atom) && Number.isFinite(charge)) charges.set(atom, charge);
    }
  }
  for (const [atom, delta] of deltas) {
    charges.set(atom + 1, (charges.get(atom + 1) ?? 0) + delta);
  }

  const entries = [...charges.entries()].filter(([, charge]) => charge !== 0).sort((a, b) => a[0] - b[0]);
  const chgLines: string[] = [];
  for (let i = 0; i < entries.length; i += 8) {
    const chunk = entries.slice(i, i + 8);
    chgLines.push(
      `M  CHG${String(chunk.length).padStart(3, " ")}` +
        chunk.map(([atom, charge]) => `${String(atom).padStart(4, " ")}${String(charge).padStart(4, " ")}`).join("")
    );
  }

  const end = kept.findIndex((line) => line.startsWith("M  END"));
  if (end < 0) return undefined;
  return [...kept.slice(0, end), ...chgLines, ...kept.slice(end)].join("\n");
}

/** The subset of MinimalLib a depiction needs. Both are optional on the vendored build. */
export interface DepictableMolecule {
  set_new_coords?(useCoordGen?: boolean): boolean;
  get_molblock?(): string;
}

/**
 * 2D coordinates for the molecule the sites were found on, in the sites' own atom numbering.
 *
 * **The numbering is the entire risk here.** Site indices come from `get_json()`; these coordinates
 * come from a molblock. If the two ever disagree, every pKa lands on the wrong atom — drawn
 * confidently, on a plausible-looking structure, with nothing to reveal it. That is the same defect
 * shape as the training-label extraction bug (a canonical SMILES stored beside a pre-canonicalisation
 * index) and as Dimorphite's match-position trap.
 *
 * Two things make it safe rather than hoped-for. The molblock is generated from a COPY of the very
 * molecule the scan ran on, so RDKit's atom order carries through untouched — not from a re-parsed
 * SMILES, which is where reordering would come from. And the element sequence is then checked against
 * the graph's; a mismatch returns undefined and the figure is simply not drawn. Declining to draw is
 * a visible absence, whereas a shifted label is an invisible lie.
 */
export function depictionFor(
  molecule: DepictableMolecule,
  graph: PkaMolecularGraph
): NonNullable<IonizationResult["depiction"]> | undefined {
  if (!molecule.set_new_coords || !molecule.get_molblock) return undefined;
  try {
    if (!molecule.set_new_coords(true) && !molecule.set_new_coords(false)) return undefined;
  } catch {
    return undefined;
  }

  const molblock = molecule.get_molblock();
  const lines = molblock.split("\n");
  // V2000 counts line: atom count in columns 0-2, bond count in 3-5.
  const counts = lines[3];
  if (!counts) return undefined;
  const atomCount = Number.parseInt(counts.slice(0, 3), 10);
  const bondCount = Number.parseInt(counts.slice(3, 6), 10);
  if (!Number.isFinite(atomCount) || !Number.isFinite(bondCount)) return undefined;
  if (atomCount !== graph.atoms.length) return undefined;

  const atoms: NonNullable<IonizationResult["depiction"]>["atoms"] = [];
  for (let i = 0; i < atomCount; i += 1) {
    const line = lines[4 + i];
    if (!line) return undefined;
    const x = Number.parseFloat(line.slice(0, 10));
    const y = Number.parseFloat(line.slice(10, 20));
    const element = line.slice(31, 34).trim();
    if (!Number.isFinite(x) || !Number.isFinite(y) || element.length === 0) return undefined;
    // The guard. Same element, same position, or nothing is drawn.
    if (element !== graph.atoms[i]!.element) return undefined;
    atoms.push({
      index: i,
      x,
      // Molfile y grows upward, SVG y grows downward. Flipped once, here, so no consumer has to
      // remember — a figure drawn upside down is the kind of thing that survives review.
      y: -y,
      element,
      charge: graph.atoms[i]!.charge,
      hydrogens: graph.atoms[i]!.hydrogens
    });
  }

  const bonds: NonNullable<IonizationResult["depiction"]>["bonds"] = [];
  for (let i = 0; i < bondCount; i += 1) {
    const line = lines[4 + atomCount + i];
    if (!line) return undefined;
    const from = Number.parseInt(line.slice(0, 3), 10) - 1;
    const to = Number.parseInt(line.slice(3, 6), 10) - 1;
    const order = Number.parseInt(line.slice(6, 9), 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
    if (from < 0 || to < 0 || from >= atomCount || to >= atomCount) return undefined;
    // Aromatic (4) and other query orders are drawn as single rather than dropped: a missing bond
    // reads as a different molecule, a plain line reads as a simplified drawing.
    bonds.push({ from, to, order: order >= 1 && order <= 3 ? order : 1 });
  }

  return { atoms, bonds };
}

/**
 * Add the Hammett estimate wherever the relationship reaches, leaving every other site untouched.
 *
 * Only sites the table already located are considered: this is a second opinion on a known ionizable
 * position, not a second way of finding them.
 */
export function scoreSitesWithHammett(scan: IonizationScan, graph: PkaMolecularGraph): IonizationSite[] {
  const sites: IonizationSite[] = [];
  for (const site of scan.sites) {
    if (site.ionizableAtomIndex >= graph.atoms.length) continue;
    const outcome = estimateHammettPka(graph, site.ionizableAtomIndex);
    if (!hammettApplies(outcome)) continue;
    sites.push({
      atomIndices: site.atomIndices,
      ionizableAtomIndex: site.ionizableAtomIndex,
      siteType: site.siteType,
      // The series decides the rung, and it does so independently of the drawing: benzoic and phenol
      // describe a NEUTRAL acid losing a proton, anilinium and pyridinium a CATIONIC one. Pyridine and
      // pyridinium therefore name the same +1 rung, which is what lets the model's estimate and this
      // one merge instead of appearing as two sites on one nitrogen.
      acidCharge: outcome.transition === "basic" ? 1 : 0,
      transition: outcome.transition,
      pKa: outcome.pKa,
      // The method's measured in-domain error, not a per-site figure: an LFER has one residual for the
      // whole series it was fitted to and does not claim to know which members it fits best.
      spread: HAMMETT_IN_DOMAIN_INTERVAL,
      basis: "linear-free-energy-relationship",
      derivation:
        `${outcome.series} series, rho applied to ` +
        (outcome.substituents.length === 0
          ? "the unsubstituted parent"
          : outcome.substituents
              .map((entry) => `${entry.position}-${entry.name} (sigma ${entry.sigma.toFixed(2)})`)
              .join(", "))
    });
  }
  return sites;
}

/**
 * Score every transition each located site actually has, acidic and basic alike.
 *
 * **Both directions, because a pKa tool that reports only one is reporting half the chemistry.** For a
 * site drawn with a proton the question is what happens when it leaves; for a site with a lone pair it
 * is what happens when one arrives. Histidine has all of it at once: a carboxyl that loses a proton, a
 * ring N-H that loses one, a ring nitrogen that gains one, an amine that gains one.
 *
 * **The basic value is computed by building the microstate, not by relabelling the neutral one.** The
 * atom is protonated, the molecule re-parsed, and the model asked for the acidity of the result — which
 * is exactly what "the pKa of the conjugate acid" means. Against ChemAxon's values for the same
 * transitions this lands within 0.04 (glycine amine), 0.48 (histidine amine), 0.72 (histidine
 * imidazole) and 0.84 (pyridine).
 *
 * The previous version reported the neutral form's prediction under an acidity label and produced 9.03
 * for histidine's amine — near enough to its ammonium's measured 9.25 to read as correct while
 * describing a different reaction. Nothing in the output invited a check. That is what this splits.
 */
/**
 * Which direction a rung reads as, derived from the charge of its acid rather than from the drawing.
 *
 * "Does this number describe a CATIONIC acid — in which case it is a conjugate acid's pKa, and a
 * chemist calls it a basicity — or a neutral or anionic one?" That question has an answer for every
 * rung of any ladder. The old definition, "relative to the form as drawn", has none for a rung that
 * touches neither drawn level, and it is what let two methods label one equilibrium from opposite
 * sides.
 */
export function transitionFor(acidCharge: number): "acidic" | "basic" {
  return acidCharge > 0 ? "basic" : "acidic";
}

export function scoreSiteTransitions(
  scan: IonizationScan,
  graph: PkaMolecularGraph,
  protonatedAt: (atomIndex: number) => PkaMolecularGraph | undefined
): IonizationScan {
  const ring = ringMembership(graph);
  // Which aromatic positions are plain benzene ones. Kekulé-invariant, and the discriminator the
  // anilide rule in `isUnactivatedAmide` turns on.
  const { carbocyclicAromatic } = siteContext(graph);
  const sites: IonizationSite[] = [];
  const unassessed = [...scan.unassessed];

  for (const site of scan.sites) {
    const atom = graph.atoms[site.ionizableAtomIndex];
    if (!atom) continue;
    const before = sites.length;

    // --- acidic: this atom losing the proton it is drawn with ---
    if (
      atom.hydrogens > 0 &&
      !isUnactivatedAmine(graph, site.ionizableAtomIndex) &&
      !isFullyDissociatedSulfonic(graph, site.ionizableAtomIndex)
    ) {
      try {
        const prediction = predictSitePka(graph, site.ionizableAtomIndex);
        sites.push({
          ...site,
          // The acid of this rung is the atom as drawn — it is the form still holding the proton.
          acidCharge: atom.charge,
          transition: transitionFor(atom.charge),
          pKa: prediction.value,
          spread: prediction.spread,
          basis: "experimentally-trained-model"
        });
      } catch {
        // A site the model cannot feature-ise contributes nothing here; the basic side may still.
      }
    }

    // --- basic: this atom gaining one, scored on the microstate where it has ---
    if (acceptsAProton(graph, site.ionizableAtomIndex, ring, carbocyclicAromatic)) {
      const protonated = protonatedAt(site.ionizableAtomIndex);
      if (protonated) {
        try {
          const prediction = predictSitePka(protonated, site.ionizableAtomIndex);
          sites.push({
            ...site,
            // The acid of this rung is the microstate just built, one charge above the drawn atom —
            // which is the same rung the Hammett anilinium and pyridinium series describe.
            acidCharge: atom.charge + 1,
            transition: transitionFor(atom.charge + 1),
            pKa: prediction.value,
            spread: prediction.spread,
            basis: "experimentally-trained-model"
          });
        } catch {
          // Same: no value rather than a wrong one.
        }
      }
    }

    if (sites.length === before) {
      unassessed.push({ atomIndices: site.atomIndices, reason: unscorableReason(graph, site) });
    }
  }

  // Carbon acids, which the located sites cannot contain because Dimorphite's table covers O, N and S.
  // Added here rather than as a SMARTS entry so that table stays what its header says it is, and because
  // the gate is structural — an activation COUNT — which is the same shape as `acceptsAProton`.
  const alreadyScored = new Set(sites.map((entry) => entry.ionizableAtomIndex));
  const aromatic = siteContext(graph).aromatic;
  for (let atomIndex = 0; atomIndex < graph.atoms.length; atomIndex += 1) {
    if (alreadyScored.has(atomIndex)) continue;
    if (!isActivatedCarbonAcid(graph, atomIndex, aromatic)) continue;
    try {
      const prediction = predictSitePka(graph, atomIndex);
      sites.push({
        atomIndices: [atomIndex],
        ionizableAtomIndex: atomIndex,
        siteType: "Activated_carbon_acid",
        acidCharge: graph.atoms[atomIndex]!.charge,
        transition: transitionFor(graph.atoms[atomIndex]!.charge),
        pKa: prediction.value,
        spread: prediction.spread,
        basis: "experimentally-trained-model"
      });
    } catch {
      // A carbon the model cannot feature-ise contributes nothing, same as any other site.
    }
  }

  return { sites, unassessed };
}

/**
 * How many groups on this carbon can delocalise a carbanion, split by whether any is a nitro.
 *
 * Counted PER NEIGHBOUR and per ATOM — "this neighbour carries a multiple bond to oxygen or sulfur" and
 * "this neighbour is aromatic" — never per bond of a ring, so the answer does not depend on which Kekulé
 * structure the engine chose. That distinction has been shipped wrong five times in this file's history.
 */
function carbanionStabilisers(
  graph: PkaMolecularGraph,
  atomIndex: number,
  aromatic: readonly boolean[]
): { nitro: number; other: number } {
  const bondsAt = (index: number) =>
    graph.bonds.filter((bond) => bond.atoms[0] === index || bond.atoms[1] === index);
  const other = (bond: { atoms: [number, number] }, index: number) =>
    bond.atoms[0] === index ? bond.atoms[1] : bond.atoms[0];

  let nitro = 0;
  let stabilisers = 0;
  for (const bond of bondsAt(atomIndex)) {
    const neighbour = other(bond, atomIndex);
    const element = graph.atoms[neighbour]?.element;
    const edges = bondsAt(neighbour);
    if (
      element === "N" &&
      (graph.atoms[neighbour]?.charge ?? 0) > 0 &&
      edges.some((edge) => graph.atoms[other(edge, neighbour)]?.element === "O")
    ) {
      nitro += 1;
      continue;
    }
    if (
      element === "S" &&
      edges.filter((edge) => edge.order > 1 && graph.atoms[other(edge, neighbour)]?.element === "O").length >= 2
    ) {
      stabilisers += 1;
      continue;
    }
    if (element !== "C") continue;
    if (edges.some((edge) => edge.order > 1 && ["O", "S"].includes(graph.atoms[other(edge, neighbour)]?.element ?? ""))) {
      // A carbonyl that is itself part of a CARBOXYL does not count, and that exclusion is measured.
      // Diethyl malonate's central CH is 13.3 because its esters cannot ionise; malonic acid's is far
      // less acidic, because by the time both carboxyls have gone the carbanion would sit between two
      // negative charges. The corpus cannot teach that difference — moving this clause changes the
      // admitted set by ONE label of 350, so every carbon acid it holds is flanked by esters, ketones
      // or nitro groups and none by a carboxylic acid. Counting them anyway offered malonic acid a
      // third rung, doubled its macroscopic error from 0.305 to 0.500, and made its thermodynamic
      // cycle miss by 3.07 log units — the diagnostic naming an unlabelled region, as it did for the
      // second ring protonation and for glycine's neutral form.
      const ionisable = edges.some((edge) => {
        const partner = other(edge, neighbour);
        if (partner === atomIndex) return false;
        const carried = graph.atoms[partner];
        return carried?.element === "O" && (carried.hydrogens > 0 || carried.charge < 0);
      });
      if (!ionisable) stabilisers += 1; // ester, ketone, amide or thiocarbonyl
    } else if (edges.some((edge) => edge.order > 2)) {
      stabilisers += 1; // nitrile or alkyne
    } else if (aromatic[neighbour] === true) {
      stabilisers += 1; // aryl
    }
  }
  return { nitro, other: stabilisers };
}

/**
 * A carbon acidic enough to titrate in water, which this method could not see at all until now.
 *
 * The site table is transcribed from Dimorphite-DL and covers O, N and S. So a 1,3-diketone reported
 * NOTHING — acetylacetone's pKa is 8.9 and its acidic proton is the central CH2 — while the same
 * molecule drawn as its enol reported 8.72 off the O-H. One compound, two drawings, and one of them
 * silently had no answer. Nitroalkanes, malonates, cyanoacetates and β-ketoesters were all invisible
 * the same way.
 *
 * **The model was already trained on them**, which is what makes this a detection fix rather than a new
 * prediction: 445 of the 12,096 labels sit on a carbon. So the only question was which of them to offer,
 * and it is answered by activation count rather than by opinion:
 *
 *     admitted (>=1 nitro, or >=2 stabilisers)   n=350   MAE 1.15   bias +0.01   97% inside pH 1-14
 *     excluded                                   n= 95   MAE 2.63   bias -0.22   79% inside pH 1-14
 *
 * The admitted set is UNBIASED at 1.15, which is worse than the corpus-wide 0.73 and squarely in the
 * range of classes already reported — anilide N-H is 1.07 and plain amide N-H 1.39. The excluded set is
 * where the damage would be: it holds the lone ketones and unactivated carbons whose real values run to
 * 18, 19 and 30.9, and the model puts them at 11.6, 18.7 and 16.4. Offering those would be the
 * carbon-acid version of scoring an amide N-H near 8 when it is really 16.
 *
 * ONE nitro is enough on its own (n=29, MAE 0.96): nitromethane is 10.2 and nitroethane 8.5, both
 * genuinely in water. One carbonyl is not (n=60, MAE 2.68): acetone's alpha proton is near 20.
 */
/**
 * **TRAINING ON ONLY WHAT THIS GATE DETECTS WAS MEASURED AND REJECTED.** The corpus holds 449
 * carbon-ionizing labels and this fires on 349; the other 100 are sites the product will never present,
 * they are the worst-fit rows in the class (out-of-fold MAE 2.552 against 1.142), and 20 sit outside the
 * aqueous window. Removing them from TRAINING makes the 349 it does present WORSE by 0.0278 — twice the
 * same-split noise floor of 0.0164, and every larger class regresses too. On 398 held-out external rows
 * the pruned model is worse on the total and on both sub-sets (1.1287 to 1.1667). They are auxiliary
 * signal: carbanion chemistry learned from a site nobody asks about still transfers to one they do.
 *
 * So this gate decides what is REPORTED, never what is trained on. `carbon_prune.py` holds the table.
 */
function isActivatedCarbonAcid(
  graph: PkaMolecularGraph,
  atomIndex: number,
  aromatic: readonly boolean[]
): boolean {
  const atom = graph.atoms[atomIndex];
  if (!atom || atom.element !== "C" || atom.charge !== 0 || atom.hydrogens === 0) return false;
  // An aromatic ring carbon's C-H is not this chemistry — benzene is not a carbon acid in water.
  if (aromatic[atomIndex] === true) return false;
  const { nitro, other } = carbanionStabilisers(graph, atomIndex, aromatic);
  return nitro >= 1 || nitro + other >= 2;
}

/**
 * An amide nitrogen with nothing activating it but its own carbonyl.
 *
 * Such a nitrogen's lone pair is delocalised into the C=O and is not available to a proton: acetamide
 * and urea protonate on OXYGEN, near -0.5 and 0.1, not on nitrogen. Offering them a nitrogen basicity
 * is what let urea be reported as a tetraprotic acid, and it put a step near pH 6 into acetamide's
 * curve where the molecule has none in water at all.
 *
 * The word doing the work is UNACTIVATED, and it is the same idea as `isUnactivatedAmine`. A blanket
 * "amide nitrogens are not basic" rule was measured twice and declined twice — the corpus holds 35
 * basic pKa values on plain amide nitrogens and 22 more on amidine-like ones, because an aryl, a
 * sulfonyl, a second carbonyl or a heteroatom on the nitrogen all change the picture:
 * acylaminothiazoles near 8.9 and acylsulfonamides near 4.9 are real measurements.
 *
 * So this requires the nitrogen to carry exactly ONE carbonyl and nothing else but saturated carbon
 * and hydrogen. Narrowed that way the count is **1 of 11,472** — a bridged bicyclic lactam,
 * `CC1(C)CC2CC[NH+]1C(=O)C2`, whose ring geometry pyramidalises the nitrogen and genuinely does keep
 * its lone pair out of conjugation. One anti-Bredt amide is the price of not inventing a basicity for
 * every acetamide.
 *
 * A urea-like second nitrogen on the carbonyl is allowed, and that is measured too rather than
 * assumed: permitting it suppresses no additional label. It is also the chemically consistent choice,
 * since a second nitrogen delocalises the carbonyl further rather than less.
 *
 * Double bonds are counted PER ATOM, which is Kekule-invariant — every aromatic carbon carries exactly
 * one whichever structure is chosen — so "this neighbour has a non-carbonyl double bond" reliably means
 * aryl, vinyl or imine without reading an aromaticity flag that RDKit's JSON does not carry.
 *
 * This suppresses only the BASIC half. An activated amide's N-H acidity is well within range and is
 * still reported.
 *
 * **AND THE ACID HALF MUST STAY, which is worth a count because the opposite sounds so reasonable.**
 * "An amide N-H is really about 16, so suppress it too" is the obvious companion rule and it is wrong.
 * Measured on the model's own out-of-fold predictions, by what the nitrogen carries:
 *
 *     class                            n    observed range   median    MAE    bias   inside pH 2-12
 *     sulfonamide N-H                559     -2.00..11.80     7.54   0.64   +0.02        557 / 559
 *     anilide N-H (carbonyl + aryl)  192      3.50..16.00     9.89   1.07   +0.03        184 / 192
 *     imide N-H (two carbonyls)      175      1.20..13.15     8.45   0.89   +0.09        170 / 175
 *     amide N-H, other substituent   152      2.55..13.17     8.61   0.77   -0.06        134 / 152
 *     plain amide N-H                 46      3.38..15.10    11.51   1.39   -0.34         29 /  46
 *
 * These are ordinary aqueous acidities, they are the commonest N-H the corpus holds, and the model
 * predicts them with essentially no bias. Suppressing anilide N-H alone would delete 184 real
 * measurements. The "amide N-H near 15" that shows up among SAMPL6's out-of-window extra steps is the
 * tail of the plain-amide row, not a class the method mishandles.
 */
function isUnactivatedAmide(
  graph: PkaMolecularGraph,
  atomIndex: number,
  carbocyclicAromatic: readonly boolean[]
): boolean {
  const bondsAt = (index: number) =>
    graph.bonds.filter((bond) => bond.atoms[0] === index || bond.atoms[1] === index);
  const other = (bond: { atoms: [number, number] }, index: number) =>
    bond.atoms[0] === index ? bond.atoms[1] : bond.atoms[0];

  // A nitrogen carrying its own double bond is an imine or amidine nitrogen, a different site.
  if (bondsAt(atomIndex).some((bond) => bond.order > 1)) return false;

  let carbonyls = 0;
  for (const bond of bondsAt(atomIndex)) {
    const neighbour = other(bond, atomIndex);
    if (graph.atoms[neighbour]?.element !== "C") return false;

    const doubles = bondsAt(neighbour).filter((edge) => edge.order > 1);
    const toChalcogen = doubles.filter((edge) => {
      const element = graph.atoms[other(edge, neighbour)]?.element;
      return element === "O" || element === "S";
    });
    if (toChalcogen.length === 0) {
      // A plain benzene position is NOT activating, and that is a count rather than an opinion: an
      // anilide nitrogen — one carbonyl, one carbocyclic aryl, nothing else — holds **0 basic labels
      // of 12,096**, where the amidine-like neighbours below hold 8 that are real (isocytosine at 8.20,
      // triazolinone at 9.43). Withholding it costs nothing measurable and removes 6 of the 23
      // in-window extra steps SAMPL6 reports. Chemically it is the direction the ring pushes anyway:
      // an aryl group WITHDRAWS from the nitrogen, so an anilide is less basic than the acetamide this
      // rule already covers, not more.
      if (carbocyclicAromatic[neighbour] === true) continue;
      // Any other double bond on the neighbour means a heteroaryl, vinyl or imine carbon — an amidine
      // or a vinylogous amide, where the nitrogen really can take a proton.
      if (doubles.length > 0) return false;
      continue;
    }
    carbonyls += 1;
    for (const edge of bondsAt(neighbour)) {
      const substituent = other(edge, neighbour);
      if (substituent === atomIndex) continue;
      const element = graph.atoms[substituent]?.element;
      if (element === "O" || element === "S" || element === "C") continue;
      // A urea/carbamate nitrogen is fine; an amidine one is not.
      if (element === "N" && !bondsAt(substituent).some((e) => e.order > 1)) continue;
      return false;
    }
  }
  return carbonyls === 1;
}

/**
 * A neutral amine whose every neighbour is a saturated carbon.
 *
 * Its N-H acidity is near 35 — outside water, outside the training range (-9.02 to 30.90), and outside
 * what a forest bounded by its own leaf values could return. The justification is a count rather than a
 * chemical opinion, the same shape as the metal decline: of the 17 training labels that look like
 * "neutral N-H on saturated carbon" every one is activated (thioamides, cyano-enamines), so unactivated
 * amines number zero of 3,031. Checked the other way too — applied to the training set the rule rejects
 * 0 rows, so it can only withhold chemistry the model never learned.
 *
 * This suppresses only the ACIDIC half. The amine's basic pKa is well predicted and is reported.
 */
function isUnactivatedAmine(graph: PkaMolecularGraph, atomIndex: number): boolean {
  const atom = graph.atoms[atomIndex];
  if (!atom || atom.element !== "N" || atom.charge !== 0 || atom.hydrogens === 0) return false;
  for (const bond of graph.bonds) {
    const [a, b] = bond.atoms;
    if (a !== atomIndex && b !== atomIndex) continue;
    const other = a === atomIndex ? b : a;
    if (graph.atoms[other]!.element !== "C") return false;
    if (graph.bonds.some((inner) => inner.order > 1 && (inner.atoms[0] === other || inner.atoms[1] === other))) {
      return false;
    }
  }
  return true;
}

/**
 * The -OH of a sulfonic acid, a sulfuric-acid ester, or sulfuric acid itself.
 *
 * These do not have an aqueous pKa. Every one of the corpus's 15 such labels lies BELOW pH 0 — the range
 * is -7.15 (4-nitrobenzenesulfonic) to -1.25 (methanesulfonic) — so they are measured by Hammett acidity
 * functions in concentrated acid, which is a different thermodynamic scale from the aqueous constant this
 * method reports. `iupac_labels.py` already refuses to pool that scale on the basic side, for the same
 * reason, and these rows predate that filter.
 *
 * The count argument is the same shape as `isUnactivatedAmine`'s, and it runs the other way: applied to
 * the training set this rule withholds 15 of 12,096 labels, and not one of them is inside the aqueous
 * window the contract declares. They are also the worst-predicted class in the corpus — out-of-fold MAE
 * 3.64 against a corpus mean of 0.73, biased systematically toward zero (observations of -7.15 to -1.25
 * are predicted between -1.00 and +0.79). So the number withheld is both off-scale and wrong.
 *
 * What replaces it is a statement, not a silence: fully dissociated across the whole aqueous range. That
 * is what a chemist needs from a sulfonate, and reporting +0.29 for MES — as this did before the rule —
 * asserts a titration inside the measurable window that does not happen.
 *
 * **THE OBVIOUS ALTERNATIVE WAS BUILT AND THE CYCLE DEFECT REFUTED IT.** Removing the rung also removes a
 * charge the molecule really carries, so a neighbouring base is scored next to a neutral sulfonic acid
 * instead of the anion. Keeping the rung at a declared bound of -2 was tried to hold that charge, and it
 * recovers part of the base's value while destroying the fold's self-consistency:
 *
 *     molecule          expt    model rung        bound -2         withheld
 *     taurine           8.74    8.72  d 0.00     8.52  d 1.60     8.27  d 0.00
 *     MES               6.15    6.12  d 0.74     5.91  d 3.03     5.74  d 0.00
 *     sulfanilic acid   3.23    3.95  d 2.03     3.96  d 1.24     2.36  d 0.00
 *     homotaurine      10.1        -            9.71  d 1.81     9.64  d 0.00
 *     cysteic acid      8.7         -            8.55  d 1.97     8.24  d 0.83
 *
 * `d` is the cycle defect — two protons leaving in either order must cost the same. A hand-placed edge
 * does not agree with the model's other edges, so the square stops closing, and the defect is detecting
 * the fabrication rather than merely disliking it. The 0.25 it buys on the base is bought with an answer
 * that contradicts itself by up to 3 log units. Note the first column: the ORIGINAL behaviour carried the
 * same disease in milder form (MES 0.74, sulfanilic 2.03) and its apparently good 6.12 was a fold
 * distortion cancelling a 2.3-log-unit error, not skill.
 *
 * Withholding leaves the reported value equal to the model's own site prediction with no fold correction
 * at all, which is why the defect is 0. Holding the charge properly means canonicalising the sulfonate to
 * its anion in `reference-protomer` — the reference state at every aqueous pH — and that is a change to
 * the interpretation layer, not to this rule.
 *
 * **One =O is a sulfinic acid, not a sulfonic one**, and those titrate near 1.8 and are predicted well
 * (16 labels, MAE 0.392), so the test is for at least TWO. Sulfonamides key on nitrogen and are untouched.
 */
function isFullyDissociatedSulfonic(graph: PkaMolecularGraph, atomIndex: number): boolean {
  const atom = graph.atoms[atomIndex];
  if (!atom || atom.element !== "O" || atom.charge !== 0 || atom.hydrogens === 0) return false;
  const neighbours = graph.bonds
    .filter((bond) => bond.atoms[0] === atomIndex || bond.atoms[1] === atomIndex)
    .map((bond) => (bond.atoms[0] === atomIndex ? bond.atoms[1] : bond.atoms[0]));
  if (neighbours.length !== 1) return false;
  const sulfur = neighbours[0]!;
  if (graph.atoms[sulfur]?.element !== "S") return false;
  // Count per ATOM rather than per bond: a double bond is one bond, but counting bonds here would be
  // the Kekule-invariance trap this codebase has shipped five times. Sulfonyl oxygens are terminal, so
  // the set of doubly-bonded oxygen NEIGHBOURS is the quantity that matters.
  const sulfonylOxygens = new Set<number>();
  for (const bond of graph.bonds) {
    if (bond.order < 2) continue;
    const [a, b] = bond.atoms;
    if (a !== sulfur && b !== sulfur) continue;
    const partner = a === sulfur ? b : a;
    if (graph.atoms[partner]?.element === "O") sulfonylOxygens.add(partner);
  }
  return sulfonylOxygens.size >= 2;
}

/** Why a located site produced no value at all — always specific, never a bare absence. */
function unscorableReason(graph: PkaMolecularGraph, site: IonizationSite): string {
  const atom = graph.atoms[site.ionizableAtomIndex]!;
  if (isFullyDissociatedSulfonic(graph, site.ionizableAtomIndex)) {
    return (
      "A sulfonic acid, fully dissociated across the entire aqueous range — no pKa is reported because " +
      "it has none in water. All 15 such labels in the training corpus fall below pH 0 (-7.15 to -1.25), " +
      "where the measurement is a Hammett acidity function rather than an aqueous dissociation constant."
    );
  }
  if (isUnactivatedAmine(graph, site.ionizableAtomIndex)) {
    return (
      "Drawn neutral, this amine's only acidity is that N-H losing a proton — a pKa near 35, which " +
      "water cannot hold and no aqueous dataset records; zero of the model's 7,053 training labels is " +
      "an unactivated amine. Its basic pKa could not be built for this structure either."
    );
  }
  if (atom.hydrogens === 0) {
    return (
      `This ${site.siteType} site carries no hydrogen as drawn, so it has no acidity to report, and ` +
      "its lone pair is not available to accept one — so neither transition applies here."
    );
  }
  return `The model could not build features for this ${site.siteType} site, so it carries no value.`;
}

const CLASSIFICATION: Classification = {
  derivation: "database-lookup",
  claim: "prediction",
  determinism: "deterministic",
  flags: { conventionDependent: true, experimentallyCalibrated: true, trainedOnExperimentalData: true }
};

export function ionizationContract(): MethodContract {
  return {
    id: IONIZATION_SITES_METHOD_ID,
    publicName: "Ionizable sites",
    // 2.0.0: the state model changed from independent per-(atom, transition) switches to ordered
    // per-atom ladders, the corpus was corrected and the model retrained, and the values are now
    // computed on a canonical protomer rather than on the drawing. Every number a caller cached under
    // 1.x describes a different computation.
    // 2.5.0: a sulfonic acid no longer reports a pKa. It has none in water, and the number it used to
    // report could land inside the measurable window — MES buffer at 0.29 — asserting a titration that
    // does not occur.
    // 2.6.0: the interval taxonomy gained a carbon stratum. Every carbon-acid interval widens and every
    // macroscopic value shifts, because the fold weights each rung by its interval.
    version: "2.6.0",
    implementation: {
      engine: IONIZATION_ENGINE,
      engineVersion: IONIZATION_ENGINE_VERSION,
      symbol: "site_substructures.smarts",
      // The forest IS what changes the number, so its identity belongs in the method key. This moves
      // the cache key on a retrain without anyone having to remember to bump `version`.
      parameters: { siteTypes: IONIZATION_SITE_TYPES.length, model: PINNED_PKA_MODEL_SHA256 }
    },
    // The pKa ladder is built outward from a canonical protomer, so the answer does not depend on
    // which member of the family was drawn. Four drawings of glycine used to give four answers, and
    // the zwitterion — the form a chemist draws at pH 7 — gave none at all.
    defaultInterpretationId: "reference-protomer",
    // The same set the Crippen and TPSA methods use, and independently right here: it is exactly the
    // model's own one-hot `ELEMENTS` plus hydrogen. An element outside it one-hots to all zeros, which
    // the forest reads as "none of the above" rather than as unknown. The whole-molecule descriptors
    // are the transmission path — `baseSiteFeatures` feeds the model a Crippen logP that
    // `rdkit.crippen-logp` refuses to report for the same structure.
    parameterizedElements: ORGANIC_PARAMETER_SET,
    resultKind: "ionization",
    conventions: [
      "EXPERIMENTAL, and the honest end-to-end figure is the one to read. Supplied a structure and " +
        "nothing else, on the SAMPL6 blind challenge set — 24 drug-like molecules, 31 measured " +
        "macroscopic values, a BLIND challenge whose answers were withheld while predictions were " +
        "submitted, and checked to share no skeleton with any training row — this method matches every " +
        "measured value to MAE 0.50, RMSE 0.60, with 90% inside one log unit, 100% inside two, a " +
        "largest single error of 1.35 and a bias of -0.03. RMSE is quoted because that is what the " +
        "SAMPL6 challenge itself reported and MAE alone flatters. On COUNTING the steps it does far " +
        "worse, and the honest figure is the harsh one: exactly as many values as were measured on 2 " +
        "of 24 molecules, or 12 of 24 once predictions outside an aqueous assay's 2-12 window are set " +
        "aside. Both are stated because quoting only the second overstates the method.",
      "HOW MANY STEPS IT FINDS was thought to be the weak half, and measuring it properly says " +
        "otherwise. On SAMPL6 the method reports 37 steps nothing measured, 19 of them inside the " +
        "window that assay could reach, and gets the count right on 12 of 24 molecules — or 2 of 24 " +
        "read raw. But SAMPL6 cannot settle the question: it reports 31 values across 24 drug-like " +
        "molecules, 1.29 each, against 3.33 scored sites each, so a prediction it never reported counts " +
        "as an extra step whether it is wrong or merely unmeasured. Measured instead on twenty " +
        "molecules whose aqueous values ARE tabulated exhaustively — amino acids, diacids, azoles — the " +
        "method finds the right number on 19 of 20 with ZERO extra steps, the exception being oxalic " +
        "acid, whose first value is predicted 0.8 against a measured 1.25 and so falls out of the " +
        "window rather than out of the model. So over-detection is largely a property of that " +
        "benchmark's coverage, and what remains on drug-like molecules is a mix of real sites nobody " +
        "titrated and genuine extras that cannot be separated without more complete reference data. " +
        "The per-site figures below are ORACLE-SITE measurements — the site and its direction are " +
        "handed in — and at 0.73 they describe valuation, not discovery.",
      "EACH VALUE IS THE ACIDITY OF THAT RUNG — the pKa of one proton leaving one atom, at the charge " +
        "state named by that row. A microscopic pKa for one transition, not a molecule-wide figure. " +
        "The values are computed on a CANONICAL PROTOMER rather than on the structure as drawn, so " +
        "every protonation state of one molecule returns the same answer.",
      "EVERY VALUE SAYS WHICH DIRECTION IT DESCRIBES, and the two are not comparable. An ACIDIC pKa is " +
        "that atom losing the proton it is drawn with. A BASIC pKa is that atom GAINING one, so the " +
        "number is the pKa of its conjugate acid — which is what is meant by an amine's or a " +
        "pyridine's pKa. A basic value is computed on the protonated microstate, not read off the " +
        "neutral form; against ChemAxon it lands within 0.5-0.8 on histidine's two nitrogens.",
      "A PLAIN AMINE GETS NO ACIDIC VALUE, only a basic one. A PLAIN AMINE " +
        "drawn neutral has an N-H acidity near 35, which water cannot hold and no aqueous dataset " +
        "records — zero of the 7,053 training labels is an unactivated amine — so that half is " +
        "withheld. Its BASIC pKa is reported and is the familiar number. Anilines, amides, " +
        "sulfonamides and thioamides keep their acidic values too: their N-H acidity IS " +
        "aqueous-measurable and IS in the data.",
      "A SULFONIC ACID GETS NO NUMBER, because it has none in water: it is reported as fully " +
        "dissociated across the whole aqueous range. All 15 such labels in the training corpus fall " +
        "below pH 0, from -7.15 to -1.25, where the measurement is a Hammett acidity function in " +
        "concentrated acid rather than an aqueous dissociation constant — a different thermodynamic " +
        "scale, and the one this method's other filters already refuse to pool. They are also the " +
        "worst-predicted class in the corpus, out-of-fold MAE 3.64 against a corpus mean of 0.73, and " +
        "biased toward zero, so before this rule MES buffer's sulfonate was reported at pH 0.29 — a " +
        "titration inside the measurable window that does not happen. Sulfinic acids keep their values " +
        "(they titrate near 1.8 and are predicted to MAE 0.39), and sulfonamides are untouched.",
      `a ${PKA_GNN_TRAINING.ensemble}-member message-passing network trained on ` +
        `${PKA_GNN_TRAINING.samples} sites from four experimental sources. ` +
        `Cross-validated with folds held out by ${PKA_GNN_TRAINING.grouping} ` +
        `(${PKA_GNN_TRAINING.groups} groups), MEAN ABSOLUTE ERROR ` +
        `${PKA_GNN_TRAINING.cvMae.toFixed(2)} log units, against ` +
        `${PKA_GNN_TRAINING.baselinePredictTheMean.toFixed(2)} for predicting the dataset mean. ` +
        `Against external data it has never seen (QupKake's Novartis and literature sets, ` +
        `${EXTERNAL_VALIDATION.samples} rows) it scores ${EXTERNAL_VALIDATION.mae.toFixed(2)} +/- ` +
        `${EXTERNAL_VALIDATION.standardError.toFixed(2)}. ` +
        "That figure describes the method overall; the interval printed beside each value is " +
        "the one that describes that site.",
      "aqueous, room temperature, and drug-like organic chemistry. The training set contains no metals " +
        "at all, which is why a metal-adjacent site is reported without a value.",
      "THE SITE TABLE ITSELF REPORTS NO pKa, by design and on evidence: " +
        "scored against 1,750 experimentally labelled sites, the tabulated averages give a mean " +
        "absolute error of 2.8 log units where exactly one site type matches, against 2.3 for simply " +
        "predicting the dataset mean. They are not fit to estimate a molecule's pKa.",
      "restricting values to unambiguous sites does not rescue it — a lone matching type scores WORSE " +
        "(2.8) than several matching types read at their best case (1.1). Unambiguity is not a proxy " +
        "for reliability here.",
      "46% of labelled sites match more than one type, and the types describe different TRANSITIONS " +
        "on the same atom: the Alcohol entry is R-OH losing a proton (~15), while the same oxygen in " +
        "R-OH2+ loses one near -7. Every candidate class is listed rather than one being chosen.",
      `each interval is per-site, from how much the ${PKA_GNN_TRAINING.ensemble} independently ` +
      `trained members ` +
        `disagreed about THIS site — not one error figure repeated on every row. Out of fold it ` +
        `separates: sites in the least-disagreeing quarter have a mean absolute error of ` +
        `${PKA_MODEL_CALIBRATION.quartileMae[0]!.toFixed(2)} against ` +
        `${PKA_MODEL_CALIBRATION.quartileMae[3]!.toFixed(2)} for the most. The disagreement is not ` +
        `reported as the interval, nor scaled by a constant into one: it is the empirical quantile of ` +
        `held-out |error| among sites that disagreed by a similar amount, which contains ` +
        `${Math.round(PKA_INTERVAL_CALIBRATION.achievedCoverage * 100)}% of held-out errors and is ` +
        `calibrated to ${Math.round(PKA_INTERVAL_CALIBRATION.targetCoverage * 100)}% within one point ` +
        `in every bin. One multiplier could not do that — coverage under it ran 50.1% among the most ` +
        `confident sites and 85.6% among the least, against the same claimed figure.`,
      "A NARROW INTERVAL MEANS THE MODEL SAW MANY SIMILAR SITES, NOT THAT THE VALUE IS RIGHT. Tree " +
        "agreement measures where the training data was dense; a molecule unlike anything in the set " +
        "can still draw confident agreement from ensemble members that are all extrapolating the " +
        "same way.",
      "CARBON ACIDS ARE CALIBRATED SEPARATELY, because one pooled interval under-covered them. The " +
        "interval is an empirical quantile binned by ensemble disagreement, and conditioned on the " +
        "ionizing atom that taxonomy was not enough: carbon sites were covered 59.2% against a claimed " +
        "68%, where nitrogen ran 68.1% and oxygen 68.5%. A carbon acid is simply harder than a nitrogen " +
        "at the same disagreement — mean error 1.46 against 0.73 corpus-wide — so pooling handed it an " +
        "interval fitted on molecules unlike it. Carbon now reads its own curve and lands at 67.0%, " +
        "measured on held-out folds at 67.5%. Sulfur stays pooled: 189 rows would make its own curve " +
        "noisier than the 4 points of over-coverage it already carries.",
      `a SECOND, INDEPENDENT method scores the sites it reaches: a Hammett relationship whose ` +
        `substituent and reaction constants come from the physical-organic literature, not from this ` +
        `project's training data. It applies to substituted benzoic acids and phenols with no ortho ` +
        `substituent and an unfused ring — ${CONSENSUS_CALIBRATION.samples} of the labelled sites — ` +
        `and declines everywhere else with a reason. Four series ship: benzoic acids, phenols, ` +
        `anilines and pyridines, the last two reporting their conjugate acid's pKa.`,
      `where both methods fire the value is WEIGHTED BY THEIR MEASURED ACCURACY, not averaged. ` +
        `Averaging is the obvious rule and it is more than twice as bad as the better method alone ` +
        `(${CONSENSUS_CALIBRATION.meanMae.toFixed(2)} against ` +
        `${CONSENSUS_CALIBRATION.hammettMae.toFixed(2)}); weighting scores ` +
        `${CONSENSUS_CALIBRATION.consensusMae.toFixed(2)}, where the model alone scores ` +
        `${CONSENSUS_CALIBRATION.forestMaeHere.toFixed(2)} on those same sites. The pair does NOT ` +
        "beat the relationship on its own here; what it buys is the interval below.",
      `where two methods agree the interval is their DISAGREEMENT, floored by the tighter method's own. ` +
        `Cross-method disagreement predicts error better than anything internal to either ` +
        `(r = ${CONSENSUS_CALIBRATION.disagreementCorrelation.toFixed(2)}, against ` +
        `${PKA_GNN_TRAINING.spreadCorrelation.toFixed(2)} for the model's own ensemble spread), and the ` +
        `result covers ${Math.round(CONSENSUS_CALIBRATION.coverage * 100)}% of actual error at ` +
        `${(CONSENSUS_CALIBRATION.modelHalfWidthHere / CONSENSUS_CALIBRATION.medianHalfWidth).toFixed(1)}x ` +
        `the precision of the model alone.`,
      `the Hammett method's ${CONSENSUS_CALIBRATION.hammettMaeBenzoic.toFixed(2)} on benzoic acids is ` +
        `PARTLY CIRCULAR and should not be read as out-of-sample accuracy: sigma was defined by benzoic ` +
        `acid ionisation and rho is 1.00 there by construction, so it largely measures that the ` +
        `compilation is self-consistent. The phenol figure ` +
        `(${CONSENSUS_CALIBRATION.hammettMaePhenol.toFixed(2)}) is the honest one.`,
      "EVERY PER-SITE VALUE IS MICROSCOPIC — one proton, one atom — and a reference table's figure is " +
        "not. Glycine's 9.6 is the second titration step of the whole molecule and equals no single " +
        "one of them. The MACROSCOPIC values reported alongside are what a titration measures, folded " +
        "from the microscopic ladder over every protonation microstate: pKa(n) = log10(Z(n)/Z(n-1)), " +
        "which is exact rather than fitted.",
      "A ZWITTERION carries an electrostatic correction, and the result says which molecules got one. " +
        "The microscopic model barely responds to a neighbouring charge — on glycine it shifts the " +
        "carboxyl by 0.6 log units where the real effect is 2.6, and for the ammonium it moves the " +
        "wrong way — because the training labels only contain microstates a titration can populate, " +
        "never an amino acid's neutral form. A Coulomb term across acid/base site pairs, one parameter " +
        "fitted against MACROSCOPIC values, takes those molecules from 2.06 log units of error to 0.53 " +
        "while leaving every other molecule alone. Like-charge pairs get no correction: the model " +
        "already handles them, and applying it there made things worse.",
      "zwitterions remain the weakest case even corrected, which is why they are flagged. Glycine " +
        "lands at 0.38, alanine at 0.18, aspartic acid at 0.52 and histidine at 0.86 — the error grows " +
        "where several acid/base pairs act at once. Diacids and diamines are the reliable end: " +
        "piperazine 0.05, ethylenediamine 0.07, succinic acid 0.29, though oxalic acid is the worst " +
        "case anywhere in the set at 1.22, where the two carboxyls sit directly bonded.",
      "an AZOLE shares one proton between two ring nitrogens, and the two arrangements are tautomers " +
        "rather than different species. The enumeration assigns charges, which cannot move a double " +
        "bond, so combining both flips built an ylide the model scored seven log units too acidic. " +
        "Those microstates are excluded rather than scored, which is why imidazole reads near 6.8 " +
        "against a measured 6.95. What is NOT done is computing the tautomer’s own stability: for " +
        "an azole both tautomers are the same protonation state, so the cost is at most log10(2).",
      "TAUTOMERS are CANONICALISED, so the answer describes the DOMINANT form rather than whichever was " +
        "drawn. 4-methylimidazole and 5-methylimidazole are one substance sharing a tabulated 7.5, yet as " +
        "drawn they scored 7.48 and 7.69; acetylacetone's keto and enol drawings gave nothing and 8.72. " +
        "Both pairs now agree — 7.48/13.85 and 9.13 against a measured 8.9 — as do dimedone at 5.18 " +
        "against 5.23 and 2-pyridone/2-hydroxypyridine at 6.36/11.51. The representative is the one " +
        "RDKit's MolStandardize scores as canonical (Sitzmann et al. 2010): a published deterministic " +
        "heuristic, not a free-energy weighting. It needed the vendored WASM rebuilt, MinimalLib shipping " +
        "no tautomer support at all — vendor patch #7. This is a CORRECTNESS gain, not only a consistency " +
        "one: cyclohexanone now reports nothing from either drawing, which is right, because its alpha " +
        "C-H is near 26 and the enol whose O-H the drawn form used to be answered on is about a millionth " +
        "of the population. Phenol, formally an enol, keeps its 9.94 because its aromatic form IS stable.",
      "CARBON ACIDS are reported, which they were not before: the site table is Dimorphite's and covers " +
        "O, N and S, so a 1,3-diketone returned NOTHING while the same compound drawn as its enol " +
        "returned a value. The model was already trained on them — 445 of 12,096 labels sit on a " +
        "carbon — so this located sites rather than predicting anything new. Offered when the carbon " +
        "carries at least one nitro or at least two carbanion stabilisers (carbonyl, nitro, sulfonyl, " +
        "nitrile, aryl), which splits the evidence: admitted 350 labels at MAE 1.15 and bias +0.01 with " +
        "97% inside pH 1-14, excluded 95 at MAE 2.63 whose real values run to 30.9 where the model says " +
        "16.4. Against literature it reads 0.19 over eight — acetylacetone 9.13/8.9, dimedone 5.18/5.23, " +
        "Meldrum's acid 5.11/4.97, nitroethane 8.74/8.5. A carbonyl belonging to a CARBOXYL does not " +
        "count toward the two: malonic acid's central carbon is not diethyl malonate's, the corpus holds " +
        "one label of 350 that could teach the difference, and counting it gave malonic acid a third rung " +
        "and a thermodynamic cycle that missed by 3.07.",
      "the fold also reports WHICH SPECIES the molecule is in at pH 7.4, as the fraction carrying each " +
        "net charge. It costs nothing extra — the fold already solves every microstate's free energy, " +
        "and mass action gives the population as 10^(L - n*pH), normalised and summed by charge — and it " +
        "is the question a macroscopic pKa is usually a proxy for. TWO quantities are reported where a " +
        "zwitterion makes them differ, because conflating them is a five-order-of-magnitude error: " +
        "glycine at pH 7.4 is 99.5% NET-neutral and 0.0004% UNCHARGED, since the net-zero population " +
        "carries +1 on nitrogen and -1 on oxygen and does not cross a membrane. Their ratio is the " +
        "tautomerization constant, and at 10^5.4 against a literature 10^5.3 it is a check on the one " +
        "microstate no titration can populate. The fractions inherit every caveat the pKa values carry, " +
        "being built from the same rungs.",
      "the macroscopic fold also reports its own THERMODYNAMIC INCONSISTENCY: the largest closed cycle " +
        "the model failed to close, in log units. Two protons leaving in either order must cost the " +
        "same, each rung is predicted independently, and they do not agree. It is measured on the " +
        "predicted values rather than on the solved energies, because the fold distributes a " +
        "contradiction over every rung around it and its residuals would understate it. This is the " +
        "only signal here that needs no reference value to compute, and it tracks the error it cannot " +
        "see — glycine 0.25, alanine 0.97, aspartic 1.36, histidine 2.03 against macroscopic errors of " +
        "0.06, 0.11, 0.20, 0.13. A molecule with one ionizable site reports exactly zero and that says " +
        "nothing about its accuracy.",
      "aqueous only, at room temperature. No value here says anything about DMSO, acetonitrile, or " +
        "any mixed solvent.",
      "sites are found by substructure match, so a genuinely ionizable group the table has no pattern " +
        "for is not reported. Absence of a site is not evidence that there is none.",
      "a site the table recognises but which never titrates in an accessible range is listed with no " +
        "value rather than with its sentinel figure"
    ],
    classification: CLASSIFICATION,
    supportedChemistry: [
      "locating ionizable positions in organic acids and bases matching a tabulated site substructure",
      "polyprotic molecules — every ionizable atom is reported separately",
      "substituted benzoic acids, phenols, anilines and pyridines, which additionally get an " +
        "independent Hammett estimate"
    ],
    knownUnsupportedChemistry: [
      "anything containing a metal: no open pKa dataset contains a metal-bearing structure, so such " +
        "sites are reported as unassessed rather than scored",
      "non-aqueous media entirely",
      "ionizable groups outside the tabulated site set"
    ],
    declinesWhen: [
      "no tabulated site substructure matches the structure",
      "macroscopic pKa above eight ionizable sites — 2^n microstates, each needing its own structure " +
        "built and scored; the limit is reported rather than the enumeration being truncated",
      "a site offers NEITHER transition — no hydrogen to lose and no lone pair free to accept one",
      "the ACIDIC half of a plain amine, whose N-H pKa near 35 is beyond water and beyond the training " +
        "range (-9.02 to 30.90); its basic half is still reported",
      "a matching site is adjacent to a metal centre — reported as unassessed, with the reason",
      "the Hammett method alone declines on an ortho substituent, a fused ring, a non-benzene ring, " +
        "or a substituent with no tabulated constant; the model still scores those sites"
    ],
    accuracyClaims: [
      {
        metric: "mae",
        value: PKA_MODEL_TRAINING.cvMae,
        unit: "log10-unit",
        basis:
          `5-fold cross-validation over ${PKA_MODEL_TRAINING.samples} sites from TWO experimental ` +
          "sets — 3,031 Dwar-iBond and 4,022 QupKake — with folds held out by " +
          `${PKA_MODEL_TRAINING.grouping}. An earlier version of this figure said 1.18; it was ` +
          "grouped by canonical SMILES, which separates identical molecules and nothing else and so " +
          "left every congeneric series straddling the folds. " +
          `Predicting the dataset mean scores ${PKA_MODEL_TRAINING.baselinePredictTheMean.toFixed(2)}. ` +
          "THIS IS AN ORACLE-SITE FIGURE: the site and its direction are supplied, so it measures how " +
          "well a known site is valued and says nothing about whether the right sites were found. No " +
          "end-to-end number is published yet, which is why the method is marked experimental.",
        citationId: "dwar-ibond"
      },
      {
        metric: "mae",
        value: CONSENSUS_CALIBRATION.hammettMae,
        unit: "log10-unit",
        basis:
          `The Hammett relationship over the ${CONSENSUS_CALIBRATION.samples} labelled sites it ` +
          `applies to, across four series. Its constants were not fitted to this ` +
          "dataset, so this is a held-out figure for the phenols; for the benzoic acids it is partly " +
          "circular, sigma having been defined by benzoic acid ionisation in the first place.",
        citationId: "hansch-leo-taft-1991"
      },
      {
        metric: "mae",
        value: CONSENSUS_CALIBRATION.consensusMae,
        unit: "log10-unit",
        basis:
          "Both methods combined, weighted by each one's measured error, over the same sites. The " +
          `model alone scores ${CONSENSUS_CALIBRATION.forestMaeHere.toFixed(2)} there and a plain ` +
          `average of the two scores ${CONSENSUS_CALIBRATION.meanMae.toFixed(2)}.`,
        citationId: "dwar-ibond"
      }
    ],
    citations: [
      {
        id: "hansch-leo-taft-1991",
        kind: "journal",
        title:
          "A survey of Hammett substituent constants and resonance and field parameters. " +
          "Chemical Reviews 91 (2) 165-195. The source of every sigma this method uses, including the " +
          "sigma-para-minus values applied to phenols with a through-conjugating para substituent.",
        authors: "Hansch, C.; Leo, A.; Taft, R. W.",
        year: 1991,
        doi: "10.1021/cr00002a004"
      },
      {
        id: "dwar-ibond",
        kind: "dataset",
        title: "Dwar-iBond pKa dataset (DataWarrior + iBond), as distributed with Uni-pKa",
        url: "https://github.com/dptech-corp/Uni-pKa"
      },
      {
        id: "dimorphite-2019",
        kind: "journal",
        authors: "Patrick J. Ropp, Jesse C. Kaminsky, Sara Yablonski, Jacob D. Durrant",
        title: "Dimorphite-DL: an open-source program for enumerating the ionization states of drug-like small molecules",
        year: 2019,
        doi: "10.1186/s13321-019-0336-9"
      }
    ],
    datasets: [
      {
        id: "dwar-ibond",
        title: "Dwar-iBond experimental pKa set",
        version: "as distributed with Uni-pKa",
        source: "https://github.com/dptech-corp/Uni-pKa",
        license: "Apache-2.0",
        redistributable: true,
        recordCount: 3031,
        obligations: [
          "Measured values, attributed per row in the source (predominantly DataWarrior, with " +
            "literature DOIs for the remainder). The shipped model's weights are trained on these " +
            "and on nothing derived from another predictor.",
          "The DataWarrior author has stated that the original literature references for part of " +
            "this set were lost, so these rows cannot all be audited back to a measurement. A " +
            "software licence is also not automatically a licence for an associated dataset."
        ]
      },
      {
        id: "pkachu",
        title: "pKaCHU experimental microscopic pKa set",
        version: "Zenodo 20089807",
        source: "https://zenodo.org/records/20089807",
        license: "CC-BY-4.0",
        redistributable: true,
        recordCount: 4419,
        obligations: [
          "Attribution required. Values are experimental and arrive as explicit acid/base microstate " +
            "pairs, so the site comes from the data. Its `prefix` column independently confirms the " +
            "site's direction and agrees with this project's own diffing on 8,764 of 8,764 rows.",
          "Windowed to pKa 2.0-12.0, which is the pharmaceutically interesting range rather than the " +
            "whole of chemistry."
        ]
      },
      {
        id: "d2a-pka",
        title: "D2A-pKa experimental set, AQUEOUS ROWS ONLY",
        version: "Zenodo 15277342",
        source: "https://zenodo.org/records/15277342",
        license: "CC-BY-4.0",
        redistributable: true,
        recordCount: 624,
        obligations: [
          "Attribution required. Only the neat-water rows are used; the DMSO, acetonitrile, DMF and " +
            "alcohol rows measure a different quantity — the same molecule's pKa differs by more " +
            "than ten log units between them — and are excluded rather than pooled.",
          "Every aqueous row is a neutral acid losing a proton, so it widens the range (-3.88 to " +
            "16.90) without adding anything on the basic side."
        ]
      },
      {
        id: "iupac-dissociation-constants",
        title: "IUPAC Dissociation-Constants v2.3e",
        version: "Zenodo 21533589",
        source: "https://zenodo.org/records/21533589",
        license: "CC-BY-NC-4.0",
        redistributable: false,
        recordCount: 0,
        obligations: [
          "NOT IN THE SHIPPED MODEL, and listed because the ingest is vendored and the decision was " +
            "measured. It is the only source carrying weakly basic nitrogens in the numbers this " +
            "method needs — 11.5% of its basic labels sit below pH 2 against 5.2% elsewhere — and the " +
            "network absorbs it where the forest could not. It also moves glycine's first macroscopic " +
            "step to -0.55 against a measured 2.35, so it is out until that is understood.",
          "NON-COMMERCIAL, which would be a real constraint on redistributing trained weights. It is " +
            "not one today because no shipped weight was fitted to this set.",
          "Neat water and 20-30 C only — 73% of this set's sub-zero basic values carry an H2SO4 or " +
            "HCl cosolvent, which is a Hammett acidity function and a different scale.",
          "This source gives no site index. One is assigned ONLY where the molecule has exactly one " +
            "candidate of the required direction, never by choosing between candidates; on 2,510 " +
            "molecules shared with the other sources that assignment matches a known site 2,509 times."
        ]
      },
      {
        id: "qupkake-exp",
        title: "QupKake experimental pKa set (Novartis, ChEMBL and literature)",
        version: "as distributed in qupkake/data",
        source: "https://github.com/Shualdon/QupKake",
        license: "BSD-3-Clause",
        redistributable: true,
        recordCount: 4022,
        obligations: [
          "Originally Baltruschat & Czodrowski. The VALUES are measurements; the SITE INDEX is " +
            "ChemAxon Marvin's assignment, which is a predictor annotation sitting inside the label " +
            "and is recorded as such on every row rather than presented as measured.",
          "1,462 of these rows were once sited on the wrong atom, because the index was read while " +
            "explicit hydrogens were present and then written out without them. The index now travels " +
            "with the molecule and the chemistry gates run again on the atom actually stored."
        ]
      },
      {
        id: "dimorphite-site-substructures",
        title: "Dimorphite-DL site_substructures.smarts",
        version: IONIZATION_ENGINE_VERSION,
        source: "https://github.com/durrantlab/dimorphite_dl",
        license: "Apache-2.0",
        redistributable: true,
        recordCount: IONIZATION_SITE_TYPES.length,
        obligations: [
          "Per-site-type pKa means and standard deviations fitted by Dimorphite-DL's authors over " +
            "compounds with experimentally measured pKa. Transcribed unmodified; attribution retained " +
            "in the citation above."
        ]
      }
    ],
    versionIncrementTriggers: [
      "any change to a site substructure, its tabulated mean, or its spread",
      "a change to which sites are reported as unassessed",
      "adding a second estimator, which changes what `basis` a site can carry",
      "retraining the network or regenerating any vendored pKa artifact — the hash in " +
        "`implementation.parameters` moves the method key on its own; the version says so to a reader",
      "a change to the protonation state model, or to which protomer the ladder is built from",
      "a change to the pH the species distribution is reported at, or to how charge states are " +
        "aggregated — the fractions move without any pKa moving",
      "a change to which tautomers are canonicalised rather than read as drawn, or to the rebuilt " +
        "MinimalLib artifact that makes canonicalisation possible at all",
      "a change to HOW the ladder is reconciled — the fold solves every microstate's free energy at " +
        "once by weighted least squares, and both the solve and `edge-variance.json`'s weighting move " +
        "every polyprotic answer while leaving every per-site value untouched",
      "a change to the interval TAXONOMY — which sites share a calibration curve. It moves every " +
        "interval in an affected stratum, and because the fold weights each rung by its interval, every " +
        "macroscopic value in that stratum moves with it"
    ],
    tautomerSensitive: true
  };
}
