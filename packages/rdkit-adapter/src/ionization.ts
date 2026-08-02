/**
 * Ionizable-site assessment (PLANS.md §9 Later phases; §8's "protonation-state enumeration").
 *
 * **What this is.** For each ionizable position it finds, a pKa taken from a table of *site-type*
 * averages fitted over compounds with measured values. That is the honest description and the label
 * every result carries: `site-type-average`.
 *
 * **What it is not.** Not a pKa prediction for your molecule. The table knows "carboxylic acids sit
 * near 4"; it does not know that this one has three fluorines two bonds away. Substituents move real
 * pKa by more than the tabulated spread, routinely. §8 requires any pKa-adjacent number to record
 * whether it is experimentally trained, quantum-derived, or inherited from another predictor — a
 * type average is a fourth thing, and saying so is the point.
 *
 * **Why it declines on metals rather than guessing.** Measured across every training and test set the
 * open pKa models ship — 1.57M molecules — the count of metal-containing structures is zero. Nothing
 * in this space has evidence about a metal centre, so a site adjacent to one is reported as
 * *unassessed* with the reason, never given a number.
 */
import type { Classification, IonizationSite, MethodContract } from "@chemdraft/analysis-core";

import { IONIZATION_SITE_TYPES, SENTINEL_PKA_MAGNITUDE } from "./ionizationSites";

export const IONIZATION_SITES_METHOD_ID = "dimorphite.ionizable-sites";

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

          // A sentinel, not a value: the site is recognised and never titrates in any accessible range.
          if (Math.abs(site.pKaMean) > SENTINEL_PKA_MAGNITUDE) {
            sites.push({
              atomIndices: [...match.atoms],
              ionizableAtomIndex: atom,
              siteType: type.name,
              pKa: null,
              basis: "site-type-average"
            });
            continue;
          }

          sites.push({
            atomIndices: [...match.atoms],
            ionizableAtomIndex: atom,
            siteType: type.name,
            pKa: site.pKaMean,
            spread: site.pKaStd,
            basis: "site-type-average"
          });
        }
      }
    } catch {
      // A pattern this build cannot compile finds nothing. Silence here loses a site rather than
      // inventing one, which is the safe direction.
    } finally {
      query.delete();
    }
  }

  sites.sort((a, b) => a.ionizableAtomIndex - b.ionizableAtomIndex);
  return { sites, unassessed };
}

/**
 * Merge what several methods said about the same atom, and let their disagreement set the confidence.
 *
 * The consensus value is the mean; the **span** — the widest gap between any two methods — is what a
 * reader should look at. Two independent routes agreeing within a few tenths is worth more than either
 * alone; two disagreeing by three log units means neither should be trusted for that site, and the
 * span says so without anyone having to decide which was right.
 *
 * The spread is the larger of the methods' own spreads and half the span, so consensus can never look
 * *more* certain than the disagreement between its inputs.
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
      merged.push(scored[0]!.site);
      continue;
    }

    const values = scored.map((entry) => entry.site.pKa!);
    const methods = scored.map((entry) => entry.method);
    const span = Math.max(...values) - Math.min(...values);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const widest = Math.max(...scored.map((entry) => entry.site.spread ?? 0));

    merged.push({
      atomIndices: scored[0]!.site.atomIndices,
      ionizableAtomIndex: atom,
      siteType: scored[0]!.site.siteType,
      pKa: mean,
      // Never narrower than the disagreement it is averaging over.
      spread: Math.max(widest, span / 2),
      basis: "consensus",
      agreement: { methods, values, span }
    });
  }
  return merged;
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
      "EACH pKa IS AN AVERAGE OVER A SITE TYPE, NOT A PREDICTION FOR THIS MOLECULE. The table knows " +
        "that carboxylic acids sit near 4; it does not know what this molecule's substituents do to " +
        "that. Real substituent effects routinely exceed the quoted spread.",
      "the spread is the standard deviation across the compounds the site type was fitted over — a " +
        "statement about the class, not a confidence interval for this site",
      "aqueous only, at room temperature. No value here says anything about DMSO, acetonitrile, or " +
        "any mixed solvent.",
      "sites are found by substructure match, so a genuinely ionizable group the table has no pattern " +
        "for is not reported. Absence of a site is not evidence that there is none.",
      "a site the table recognises but which never titrates in an accessible range is listed with no " +
        "value rather than with its sentinel figure"
    ],
    classification: CLASSIFICATION,
    supportedChemistry: [
      "organic acids and bases matching one of the tabulated site substructures",
      "polyprotic molecules — every matching site is reported separately"
    ],
    knownUnsupportedChemistry: [
      "anything containing a metal: no open pKa dataset contains a metal-bearing structure, so such " +
        "sites are reported as unassessed rather than scored",
      "non-aqueous media entirely",
      "ionizable groups outside the tabulated site set"
    ],
    declinesWhen: [
      "no tabulated site substructure matches the structure",
      "a matching site is adjacent to a metal centre — reported as unassessed, with the reason"
    ],
    accuracyClaims: [],
    citations: [
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
