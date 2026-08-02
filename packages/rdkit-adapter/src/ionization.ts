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
 * from: `pkaModel.ts`, MAE 1.17 over held-out scaffolds, with a per-site interval taken from how much
 * its trees disagreed rather than one global error figure stamped on every row.
 *
 * **A second opinion, where one is available.** The obvious candidate was the table, and measuring it
 * is what disqualified it: agreement with a method that scores worse than a constant is confidence in
 * nothing. The second estimator is instead a Hammett linear free-energy relationship (`hammett.ts`)
 * whose constants come from the physical-organic literature rather than from this project's training
 * set — so its agreement with the model carries information instead of being circular.
 *
 * It reaches only 2.8% of sites and declines on the rest, which is what an LFER should do. Where it
 * does reach, measured over those 85 sites:
 *
 * | | MAE (log units) |
 * |---|---|
 * | the model alone | 0.43 |
 * | the relationship alone | 0.16 |
 * | their plain average | 0.23 |
 * | weighted by measured accuracy | **0.15** |
 *
 * The third row is the one that shaped the code. Averaging is the obvious rule and it makes the answer
 * *worse than the better method alone*, so `combineSiteEstimates` weights by each method's own measured
 * error instead. Their disagreement is also the best confidence signal available — r = 0.84 against
 * actual error, where the forest's internal tree variance manages 0.42 on the same sites — and the
 * resulting interval is 2.1x tighter than the model's own while covering more of the real error
 * (91% against 81%).
 *
 * Where only one method fires, its estimate passes through as itself and is never labelled a consensus.
 *
 * **Why it declines on metals rather than guessing.** Measured across every training and test set the
 * open pKa models ship — 1.57M molecules — the count of metal-containing structures is zero. Nothing
 * in this space has evidence about a metal centre, so a site adjacent to one is reported as
 * *unassessed* with the reason, never given a number.
 */
import type { Classification, IonizationSite, MethodContract } from "@chemdraft/analysis-core";

import { estimateHammettPka, hammettApplies } from "./hammett";
import { IONIZATION_SITE_TYPES, SENTINEL_PKA_MAGNITUDE } from "./ionizationSites";
import consensusJson from "../vendor/pka-model/consensus-calibration.json";
import {
  PKA_MODEL_CALIBRATION,
  PKA_MODEL_TRAINING,
  predictSitePkaWithSpread,
  ringMembership,
  siteFeatures,
  type PkaMolecularGraph
} from "./pkaModel";

/** What combining the two methods was measured to be worth. Read, not asserted. */
export const CONSENSUS_CALIBRATION = consensusJson as unknown as {
  samples: number; phenolSamples: number; benzoicSamples: number;
  forestWeight: number; hammettMae: number; hammettMaePhenol: number; hammettMaeBenzoic: number;
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
  model: PKA_MODEL_TRAINING.cvMae,
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
  const byAtom = new Map<number, { method: string; site: IonizationSite }[]>();
  for (const [method, list] of Object.entries(perMethod)) {
    for (const site of list) {
      const bucket = byAtom.get(site.ionizableAtomIndex) ?? [];
      bucket.push({ method, site });
      byAtom.set(site.ionizableAtomIndex, bucket);
    }
  }

  const merged: IonizationSite[] = [];
  for (const [atom, entries] of [...byAtom.entries()].sort((a, b) => a[0] - b[0])) {
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
    const weights = scored.map((entry) => 1 / (METHOD_MAE[entry.method] ?? 1));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const combined = scored.reduce((sum, entry, i) => sum + entry.site.pKa! * weights[i]!, 0) / total;
    const floor = Math.min(...scored.map((entry) => entry.site.spread ?? Infinity));

    merged.push({
      atomIndices: scored[0]!.site.atomIndices,
      ionizableAtomIndex: atom,
      siteType: scored[0]!.site.siteType,
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
      pKa: outcome.pKa,
      // The method's measured in-domain error, not a per-site figure: an LFER has one residual for the
      // whole series it was fitted to and does not claim to know which members it fits best.
      spread: HAMMETT_IN_DOMAIN_MAE,
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
 * Score each located site with the trained model.
 *
 * Independent of the table by construction: the features use no Dimorphite data, so when the two
 * methods are compared their agreement carries information rather than being circular. The model is
 * the only one of the pair that offers a pKa — see the header for why the table does not.
 *
 * A site the model cannot feature-ise is left as the table found it rather than dropped: knowing
 * there is an ionizable position is worth more than a silent omission.
 */
export function scoreSitesWithModel(scan: IonizationScan, graph: PkaMolecularGraph): IonizationScan {
  const ring = ringMembership(graph);
  const sites = scan.sites.map((site) => {
    if (site.ionizableAtomIndex >= graph.atoms.length) return site;
    try {
      const prediction = predictSitePkaWithSpread(siteFeatures(graph, site.ionizableAtomIndex, ring));
      return {
        ...site,
        pKa: prediction.value,
        // PER-SITE, from how much the forest's trees disagreed here — not one global error figure
        // repeated on every row. Measured on held-out scaffolds, the lowest-disagreement quartile has
        // MAE 0.49 against 2.20 for the highest, so this genuinely separates the sites worth trusting
        // from the ones that need checking.
        spread: prediction.spread,
        basis: "experimentally-trained-model" as const
      };
    } catch {
      return site;
    }
  });
  return { sites, unassessed: scan.unassessed };
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
    version: "1.0.0",
    implementation: {
      engine: IONIZATION_ENGINE,
      engineVersion: IONIZATION_ENGINE_VERSION,
      symbol: "site_substructures.smarts",
      parameters: { siteTypes: IONIZATION_SITE_TYPES.length }
    },
    defaultInterpretationId: "source",
    resultKind: "ionization",
    conventions: [
      "EACH VALUE IS THE ACIDITY OF THAT SITE AS DRAWN — the pKa of it losing a proton. A microscopic " +
        "pKa for one transition, not a molecule-wide figure.",
      "IT DOES NOT REPORT BASICITY, and for amines that is the number most people want. The site " +
        "patterns locate an amine on its NEUTRAL nitrogen, so what gets scored is that N-H losing a " +
        "proton — very weakly acidic, hence a high value — and not the ~10 of the corresponding " +
        "ammonium. Redrawing the amine protonated does not help: the pattern requires a neutral " +
        "nitrogen and finds no site at all. Treat a high value on a basic nitrogen as 'not acidic' " +
        "rather than as that centre's pKa.",
      `trained on ${PKA_MODEL_TRAINING.samples} sites from the open Dwar-iBond experimental set, ` +
        `cross-validated by scaffold at a mean absolute error of ${PKA_MODEL_TRAINING.cvMae.toFixed(2)} ` +
        "log units against 2.94 for predicting the dataset mean. That figure describes the method " +
        "overall; the interval printed beside each value is the one that describes that site.",
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
      `each interval is per-site, from how much the model's ${PKA_MODEL_TRAINING.trees} trees ` +
        `disagreed about THIS site — not one error figure repeated on every row. Out of fold it ` +
        `separates: sites in the least-disagreeing quarter have a mean absolute error of ` +
        `${PKA_MODEL_CALIBRATION.quartileMae[0]!.toFixed(2)} against ` +
        `${PKA_MODEL_CALIBRATION.quartileMae[3]!.toFixed(2)} for the most, and the interval as drawn ` +
        `(${PKA_MODEL_CALIBRATION.spreadMultiplier} x that disagreement) contains ` +
        `${Math.round(PKA_MODEL_CALIBRATION.coverage[PKA_MODEL_CALIBRATION.spreadMultiplier.toFixed(1)]! * 100)}% ` +
        "of held-out errors.",
      "A NARROW INTERVAL MEANS THE MODEL SAW MANY SIMILAR SITES, NOT THAT THE VALUE IS RIGHT. Tree " +
        "agreement measures where the training data was dense; a molecule unlike anything in the set " +
        "can still draw confident agreement from trees that are all extrapolating the same way.",
      `a SECOND, INDEPENDENT method scores the sites it reaches: a Hammett relationship whose ` +
        `substituent and reaction constants come from the physical-organic literature, not from this ` +
        `project's training data. It applies to substituted benzoic acids and phenols with no ortho ` +
        `substituent and an unfused ring — ${CONSENSUS_CALIBRATION.samples} of the labelled sites — ` +
        `and declines everywhere else with a reason.`,
      `where both methods fire the value is WEIGHTED BY THEIR MEASURED ACCURACY, not averaged. ` +
        `Averaging is the obvious rule and it is worse than the better method alone ` +
        `(${CONSENSUS_CALIBRATION.meanMae.toFixed(2)} against ` +
        `${CONSENSUS_CALIBRATION.hammettMae.toFixed(2)}); weighting scores ` +
        `${CONSENSUS_CALIBRATION.consensusMae.toFixed(2)}, where the model alone scores ` +
        `${CONSENSUS_CALIBRATION.forestMaeHere.toFixed(2)} on those same sites.`,
      `where two methods agree the interval is their DISAGREEMENT, floored by the tighter method's own. ` +
        `Cross-method disagreement predicts error better than anything internal to either ` +
        `(r = ${CONSENSUS_CALIBRATION.disagreementCorrelation.toFixed(2)}, against ` +
        `${PKA_MODEL_CALIBRATION.correlation.toFixed(2)} for the model's tree variance), and the ` +
        `result covers ${Math.round(CONSENSUS_CALIBRATION.coverage * 100)}% of actual error at ` +
        `${(CONSENSUS_CALIBRATION.modelHalfWidthHere / CONSENSUS_CALIBRATION.medianHalfWidth).toFixed(1)}x ` +
        `the precision of the model alone.`,
      `the Hammett method's ${CONSENSUS_CALIBRATION.hammettMaeBenzoic.toFixed(2)} on benzoic acids is ` +
        `PARTLY CIRCULAR and should not be read as out-of-sample accuracy: sigma was defined by benzoic ` +
        `acid ionisation and rho is 1.00 there by construction, so it largely measures that the ` +
        `compilation is self-consistent. The phenol figure ` +
        `(${CONSENSUS_CALIBRATION.hammettMaePhenol.toFixed(2)}) is the honest one.`,
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
      "substituted benzoic acids and phenols, which additionally get an independent Hammett estimate"
    ],
    knownUnsupportedChemistry: [
      "anything containing a metal: no open pKa dataset contains a metal-bearing structure, so such " +
        "sites are reported as unassessed rather than scored",
      "non-aqueous media entirely",
      "ionizable groups outside the tabulated site set"
    ],
    declinesWhen: [
      "no tabulated site substructure matches the structure",
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
          `Scaffold-grouped 5-fold cross-validation over ${PKA_MODEL_TRAINING.samples} sites from the ` +
          "Dwar-iBond experimental set. Grouped by canonical skeleton so no scaffold appears in both " +
          "train and test; an ungrouped split scores better and means less. Predicting the dataset " +
          "mean scores 2.94 for comparison.",
        citationId: "dwar-ibond"
      },
      {
        metric: "mae",
        value: CONSENSUS_CALIBRATION.hammettMae,
        unit: "log10-unit",
        basis:
          `The Hammett relationship over the ${CONSENSUS_CALIBRATION.samples} Dwar-iBond sites it ` +
          `applies to — ${CONSENSUS_CALIBRATION.phenolSamples} phenols and ` +
          `${CONSENSUS_CALIBRATION.benzoicSamples} benzoic acids. Its constants were not fitted to this ` +
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
        recordCount: PKA_MODEL_TRAINING.samples,
        obligations: [
          "Measured values, attributed per row in the source (predominantly DataWarrior, with " +
            "literature DOIs for the remainder). The shipped model's weights are trained on these " +
            "and on nothing derived from another predictor."
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
      "adding a second estimator, which changes what `basis` a site can carry"
    ],
    tautomerSensitive: true
  };
}
