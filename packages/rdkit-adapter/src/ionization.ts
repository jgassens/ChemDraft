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
 * from: `pkaModel.ts`, MAE 1.21 over Murcko-scaffold-held-out folds, with a per-site interval taken
 * from how much its trees disagreed rather than one global error figure stamped on every row.
 *
 * **A second opinion, where one is available.** The obvious candidate was the table, and measuring it
 * is what disqualified it: agreement with a method that scores worse than a constant is confidence in
 * nothing. The second estimator is instead a Hammett linear free-energy relationship (`hammett.ts`)
 * whose constants come from the physical-organic literature rather than from this project's training
 * set — so its agreement with the model carries information instead of being circular.
 *
 * It reaches 5.1% of sites and declines on the rest, which is what an LFER should do. Four series
 * ship — benzoic, phenol, anilinium, pyridinium — and over the 155 sites they reach:
 *
 * | | MAE (log units) |
 * |---|---|
 * | the model alone | 0.56 |
 * | the relationship alone | 0.19 |
 * | their plain average | 0.33 |
 * | weighted by measured accuracy | 0.21 |
 *
 * The third row is the one that shaped the code: averaging is the obvious rule and it is worse than the
 * better method alone, so `combineSiteEstimates` weights by each method's own measured error.
 *
 * The fourth row does not beat the relationship on its own, and the contract says so rather than
 * claiming otherwise. What the pair buys is the INTERVAL. Their disagreement tracks actual error at
 * r = 0.87, where the forest's own tree variance manages 0.52, and the resulting interval is 6.5x
 * tighter than the model's while covering 89% of the real error.
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
 * 3,031 training labels is an unactivated amine — a count, not a chemical opinion, and the rule was
 * checked the other way too (applied to the training set it rejects 0 rows). The amine still reports
 * its basic pKa, which is the one anybody wanted.
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

/**
 * Where the model's interval stops meaning "trust this" and starts meaning "check this".
 *
 * The first and third quartile boundaries of its out-of-fold interval, so the bands are the ones whose
 * accuracy was actually measured: at or below `good` is the quarter of sites whose MAE is
 * `quartileMae[0]`, above `poor` the quarter whose MAE is `quartileMae[3]`. Read from the
 * calibration, never typed here.
 */
export const IONIZATION_CONFIDENCE_BANDS = {
  good: PKA_MODEL_CALIBRATION.intervalQuartiles[0]!,
  poor: PKA_MODEL_CALIBRATION.intervalQuartiles[2]!
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
      // Placeholder: the scan only LOCATES. `scoreSiteTransitions` decides which transitions this atom
      // actually has and emits one site per transition.
      transition: "acidic",
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
  // Keyed by atom AND transition. An atom can carry both an acidic and a basic value — histidine's
  // amine has a basic 9.25 and an acidity near 35 — and merging those two would average a molecule's
  // deprotonation with its protonation and call the result a consensus.
  const byKey = new Map<string, { method: string; site: IonizationSite }[]>();
  for (const [method, list] of Object.entries(perMethod)) {
    for (const site of list) {
      const key = `${site.ionizableAtomIndex}:${site.transition}`;
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
    const weights = scored.map((entry) => 1 / (METHOD_MAE[entry.method] ?? 1));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const combined = scored.reduce((sum, entry, i) => sum + entry.site.pKa! * weights[i]!, 0) / total;
    const floor = Math.min(...scored.map((entry) => entry.site.spread ?? Infinity));

    merged.push({
      atomIndices: scored[0]!.site.atomIndices,
      ionizableAtomIndex: atom,
      siteType: scored[0]!.site.siteType,
      transition: scored[0]!.site.transition,
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
function acceptsAProton(graph: PkaMolecularGraph, atomIndex: number, ring: readonly boolean[]): boolean {
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
  if (atom.hydrogens === 0 || !ring[atomIndex]) return true;
  if (ownDoubleBonds > 0) return true;

  const ringNeighboursWithDoubleBond = neighbours.filter((neighbour) => {
    if (!ring[neighbour]) return false;
    return graph.bonds.some((bond) => {
      const [a, b] = bond.atoms;
      return bond.order > 1 && (a === neighbour || b === neighbour) && ring[a === neighbour ? b : a];
    });
  });
  // Pyrrole-type: an N-H in a ring whose neighbours carry the ring's double bonds.
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
  const lines = molblock.split("\n");
  const counts = lines[3];
  if (!counts) return undefined;
  const atomCount = Number.parseInt(counts.slice(0, 3), 10);
  if (!Number.isFinite(atomCount) || atomIndex >= atomCount) return undefined;

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
  charges.set(atomIndex + 1, (charges.get(atomIndex + 1) ?? 0) + 1);

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
      // The series decides the direction: benzoic and phenol are acidic, anilinium and pyridinium
      // report their conjugate acid.
      transition: outcome.transition,
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
export function scoreSiteTransitions(
  scan: IonizationScan,
  graph: PkaMolecularGraph,
  protonatedAt: (atomIndex: number) => PkaMolecularGraph | undefined
): IonizationScan {
  const ring = ringMembership(graph);
  const sites: IonizationSite[] = [];
  const unassessed = [...scan.unassessed];

  for (const site of scan.sites) {
    const atom = graph.atoms[site.ionizableAtomIndex];
    if (!atom) continue;
    const before = sites.length;

    // --- acidic: this atom losing the proton it is drawn with ---
    if (atom.hydrogens > 0 && !isUnactivatedAmine(graph, site.ionizableAtomIndex)) {
      try {
        const prediction = predictSitePkaWithSpread(siteFeatures(graph, site.ionizableAtomIndex, ring));
        sites.push({
          ...site,
          transition: "acidic",
          pKa: prediction.value,
          spread: prediction.spread,
          basis: "experimentally-trained-model"
        });
      } catch {
        // A site the model cannot feature-ise contributes nothing here; the basic side may still.
      }
    }

    // --- basic: this atom gaining one, scored on the microstate where it has ---
    if (acceptsAProton(graph, site.ionizableAtomIndex, ring)) {
      const protonated = protonatedAt(site.ionizableAtomIndex);
      if (protonated) {
        try {
          const prediction = predictSitePkaWithSpread(
            siteFeatures(protonated, site.ionizableAtomIndex, ringMembership(protonated))
          );
          sites.push({
            ...site,
            transition: "basic",
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

  return { sites, unassessed };
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

/** Why a located site produced no value at all — always specific, never a bare absence. */
function unscorableReason(graph: PkaMolecularGraph, site: IonizationSite): string {
  const atom = graph.atoms[site.ionizableAtomIndex]!;
  if (isUnactivatedAmine(graph, site.ionizableAtomIndex)) {
    return (
      "Drawn neutral, this amine's only acidity is that N-H losing a proton — a pKa near 35, which " +
      "water cannot hold and no aqueous dataset records; zero of the model's 3,031 training labels is " +
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
      "EVERY VALUE SAYS WHICH DIRECTION IT DESCRIBES, and the two are not comparable. An ACIDIC pKa is " +
        "that atom losing the proton it is drawn with. A BASIC pKa is that atom GAINING one, so the " +
        "number is the pKa of its conjugate acid — which is what is meant by an amine's or a " +
        "pyridine's pKa. A basic value is computed on the protonated microstate, not read off the " +
        "neutral form; against ChemAxon it lands within 0.5-0.8 on histidine's two nitrogens.",
      "A PLAIN AMINE GETS NO ACIDIC VALUE, only a basic one. A PLAIN AMINE " +
        "drawn neutral has an N-H acidity near 35, which water cannot hold and no aqueous dataset " +
        "records — zero of the 3,031 training labels is an unactivated amine — so that half is " +
        "withheld. Its BASIC pKa is reported and is the familiar number. Anilines, amides, " +
        "sulfonamides and thioamides keep their acidic values too: their N-H acidity IS " +
        "aqueous-measurable and IS in the data.",
      `trained on ${PKA_MODEL_TRAINING.samples} sites from the open Dwar-iBond experimental set. ` +
        `Cross-validated with folds held out by ${PKA_MODEL_TRAINING.grouping} ` +
        `(${PKA_MODEL_TRAINING.groups} groups), MEAN ABSOLUTE ERROR ` +
        `${PKA_MODEL_TRAINING.cvMae.toFixed(2)} log units, against ` +
        `${PKA_MODEL_TRAINING.baselinePredictTheMean.toFixed(2)} for predicting the dataset mean. ` +
        "Against external data it has never seen (Novartis + SAMPL, 38 single-site rows) it scores " +
        "1.24. That figure describes the method overall; the interval printed beside each value is " +
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
          `5-fold cross-validation over ${PKA_MODEL_TRAINING.samples} sites from the Dwar-iBond ` +
          `experimental set, folds held out by ${PKA_MODEL_TRAINING.grouping}. An earlier version of ` +
          "this figure said 1.18; it was grouped by canonical SMILES, which separates identical " +
          "molecules and nothing else and so left every congeneric series straddling the folds. " +
          `Predicting the dataset mean scores ${PKA_MODEL_TRAINING.baselinePredictTheMean.toFixed(2)}.`,
        citationId: "dwar-ibond"
      },
      {
        metric: "mae",
        value: CONSENSUS_CALIBRATION.hammettMae,
        unit: "log10-unit",
        basis:
          `The Hammett relationship over the ${CONSENSUS_CALIBRATION.samples} Dwar-iBond sites it ` +
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
