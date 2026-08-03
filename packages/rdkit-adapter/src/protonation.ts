/**
 * Protonation-state enumeration: microscopic pKa in, macroscopic pKa out (PLANS.md §8).
 *
 * **The gap this closes.** Every value the method produced until now was MICROSCOPIC — one proton, one
 * atom, on one drawn structure. Tables are macroscopic. Glycine's "9.6" is not the pKa of any single
 * transition; it is the second titration step of the whole molecule, and it is measured on the species
 * whose carboxyl has already gone. Comparing a microscopic prediction to it was comparing two different
 * equilibria, which is why glycine read 7.27 against a tabulated 9.60 with nothing wrong in the model.
 *
 * **The relation between them is exact, not a fit.** Number the microstates by how many protons they
 * carry. Because pKa is a state function, a microstate `s` has a well-defined binding constant relative
 * to the fully deprotonated reference:
 *
 *     L(s) = sum of the microscopic pKa values along ANY path from the reference to s
 *
 * Collect microstates by proton count into partition sums `Z(n) = sum over s of 10^L(s)`, and the
 * macroscopic constant for the n-th proton is
 *
 *     pKa_macro(n) = log10( Z(n) / Z(n-1) )
 *
 * For a molecule with one site this collapses to the microscopic value, as it must. For several sites
 * it is what a titration actually measures.
 *
 * **"ANY path" is a claim the model does not honour, and that is worth reporting rather than hiding.**
 * Each edge is predicted independently, so two routes to the same microstate generally disagree. The
 * disagreement is a thermodynamic inconsistency and it bounds how much the macroscopic numbers can be
 * trusted: `inconsistency` carries the largest one found, and a molecule whose paths differ by three
 * log units has no meaningful macroscopic pKa no matter how confident each edge looked.
 *
 * **Cost.** The microstate count is 2^sites, and each needs its own structure built and scored. The
 * enumeration therefore declines above `MAX_SITES` rather than running away — a limit that is stated in
 * the result, never a silent truncation.
 */
import type { IonizationSite } from "@chemdraft/analysis-core";

import { distancesFrom, siteContext } from "./pkaAromaticity";
import {
  predictSitePkaWithSpread,
  ringMembership,
  siteFeatures,
  type PkaMolecularGraph
} from "./pkaModel";
import couplingJson from "../vendor/pka-model/coupling.json";

/**
 * The electrostatic coupling the microscopic model could not learn.
 *
 * Charging one site shifts every other site's pKa by their interaction, which is the oldest result in
 * this subject: dpKa_i = -W * sum_j q_j / d_ij, over the OTHER sites, with q the neighbour's formal
 * charge in that microstate and d the through-bond distance. The sign falls out of the chemistry —
 * deprotonation lowers the site's charge by one, so a positive neighbour stabilises the product and
 * lowers the pKa.
 *
 * **Why the model needs help here at all.** Measured on glycine, it shifts the carboxyl by 0.57 log
 * units between an adjacent NH3+ and an adjacent NH2, where the real effect is about 2.6 — and for the
 * ammonium it moves the wrong way. The training labels are why: Dwar-iBond records the microstates a
 * titration can populate, which for an amino acid are the cation, the zwitterion and the anion, never
 * the neutral form. The model never sees one site with and without an adjacent opposite charge, so no
 * amount of charge-counting features can teach it the contrast.
 *
 * **Applied ONLY across acid/base pairs**, and that restriction is measured rather than assumed. Like
 * charges it already handles: ethylenediamine comes out at 6.93/9.98 against a measured 6.85/9.93 with
 * no correction, because both of its microstates are populated and therefore in the labels. Applying
 * the term to like pairs as well pushed the eight independent molecules from 0.28 to 0.95 while
 * helping nothing.
 *
 * **W is fitted against MACROSCOPIC values**, an aggregate the per-site labels do not contain, so this
 * is not a second model fitted to the same data. Both halves of a Murcko-scaffold split of the 186
 * fitting molecules independently choose 7, with a flat optimum from 6 to 8.
 */
const COUPLING = couplingJson as unknown as { W: number; appliesTo: string };

/**
 * Most ionizable sites the enumeration will attempt.
 *
 * 2^8 = 256 microstates, each needing a molecule built and re-parsed. Beyond this the wait stops being
 * worth it, and the answer would be dominated by accumulated per-edge error anyway.
 */
export const MAX_SITES = 8;

export interface MicrostateSite {
  /** Index into the caller's site list, so results can be mapped back. */
  siteIndex: number;
  atomIndex: number;
  /** How the atom is drawn: an acidic site carries its proton, a basic one does not. */
  transition: "acidic" | "basic";
  /** Formal charge the atom has in the structure as drawn. */
  drawnCharge: number;
}

export interface Microstate {
  /** Which sites hold a proton, in `sites` order. */
  protonated: boolean[];
  protonCount: number;
  /** Summed microscopic pKa from the fully deprotonated reference. Undefined if unreachable. */
  logBinding?: number;
  /** Net formal charge relative to the fully deprotonated state. */
  relativeCharge: number;
}

export interface MacroscopicResult {
  /** Macroscopic pKa values, in titration order (first proton lost first). */
  pKa: number[];
  /** Largest disagreement between two routes to the same microstate, in log units. */
  inconsistency: number;
  microstateCount: number;
  siteCount: number;
  /**
   * An acidic and a basic site are both present, so the molecule forms a zwitterion.
   *
   * These used to be the method's worst case by a wide margin — mean error 2.06 log units against 0.30
   * for everything else — because the microscopic model barely responds to a neighbouring charge. The
   * electrostatic term in `COUPLING` closes most of that: 2.06 to 0.70, with the other molecules
   * untouched at 0.30.
   *
   * The flag stays because the remaining error is still twice the rest, and because it concentrates
   * where several acid/base pairs act at once: glycine 0.38 and alanine 0.18, but histidine 1.73 with
   * four sites. Nothing else in the result catches it — alanine's `inconsistency` was 0.00 while its
   * error was 2.18.
   */
  zwitterionic: boolean;
}

export interface ProtonationDeclined {
  declined: string;
}

export type ProtonationOutcome = MacroscopicResult | ProtonationDeclined;

export function macroscopicApplies(outcome: ProtonationOutcome): outcome is MacroscopicResult {
  return !("declined" in outcome);
}

/**
 * The charge an atom carries in a microstate, relative to how it was drawn.
 *
 * An acidic site is drawn holding its proton, so losing it costs a charge. A basic site is drawn
 * without one, so gaining it adds a charge. The two conventions meet here and nowhere else.
 */
export function chargeDelta(site: MicrostateSite, protonated: boolean): number {
  if (site.transition === "acidic") return protonated ? 0 : -1;
  return protonated ? 1 : 0;
}

/** Every combination of protonated sites, ordered by proton count. */
export function enumerateMicrostates(siteCount: number): Microstate[] {
  const out: Microstate[] = [];
  for (let mask = 0; mask < 1 << siteCount; mask += 1) {
    const protonated = Array.from({ length: siteCount }, (_, i) => (mask & (1 << i)) !== 0);
    out.push({
      protonated,
      protonCount: protonated.filter(Boolean).length,
      relativeCharge: 0
    });
  }
  return out.sort((a, b) => a.protonCount - b.protonCount);
}

/**
 * Build the ladder of microscopic pKa values and fold it into macroscopic ones.
 *
 * `microPka(state, siteIndex)` must return the pKa of `siteIndex` losing its proton IN THAT
 * microstate — the acid form. Returning undefined drops that edge, and a microstate reachable by no
 * edge is left out of its partition sum rather than guessed at.
 */
export function macroscopicPka(
  sites: readonly MicrostateSite[],
  microPka: (state: Microstate, siteIndex: number) => number | undefined
): ProtonationOutcome {
  if (sites.length === 0) return { declined: "no ionizable sites to enumerate" };
  if (sites.length > MAX_SITES) {
    return {
      declined:
        `${sites.length} ionizable sites would need ${2 ** sites.length} microstates, above the ` +
        `${MAX_SITES}-site limit this enumeration accepts. No macroscopic value is reported rather ` +
        "than a truncated one."
    };
  }

  const states = enumerateMicrostates(sites.length);
  const key = (protonated: readonly boolean[]) => protonated.map((p) => (p ? "1" : "0")).join("");
  const byKey = new Map(states.map((state) => [key(state.protonated), state]));

  // Reference: the fully deprotonated state, L = 0 by definition.
  const reference = byKey.get("0".repeat(sites.length))!;
  reference.logBinding = 0;

  // Walk outward by proton count. Each state's L is reached from every state one proton lighter, and
  // where those routes disagree the spread is recorded — it is the thermodynamic inconsistency.
  let inconsistency = 0;
  for (let n = 1; n <= sites.length; n += 1) {
    for (const state of states.filter((s) => s.protonCount === n)) {
      const routes: number[] = [];
      for (let i = 0; i < sites.length; i += 1) {
        if (!state.protonated[i]) continue;
        const lighter = byKey.get(
          key(state.protonated.map((p, j) => (j === i ? false : p)))
        );
        if (!lighter || lighter.logBinding === undefined) continue;
        // The edge's pKa belongs to the ACID — the state that still holds the proton.
        const pKa = microPka(state, i);
        if (pKa === undefined) continue;
        routes.push(lighter.logBinding + pKa);
      }
      if (routes.length === 0) continue;
      const min = Math.min(...routes);
      const max = Math.max(...routes);
      inconsistency = Math.max(inconsistency, max - min);
      // The mean over routes: with no reason to prefer one path, averaging is the least arbitrary
      // reconciliation, and the spread is reported separately rather than buried by it.
      state.logBinding = routes.reduce((sum, value) => sum + value, 0) / routes.length;
    }
  }

  // Partition sums per proton count, in log space — 10^L overflows for a strongly basic polyamine.
  const partitions: (number | undefined)[] = [];
  for (let n = 0; n <= sites.length; n += 1) {
    const bound = states
      .filter((s) => s.protonCount === n && s.logBinding !== undefined)
      .map((s) => s.logBinding!);
    partitions.push(bound.length === 0 ? undefined : logSumExp10(bound));
  }

  const pKa: number[] = [];
  for (let n = sites.length; n >= 1; n -= 1) {
    const upper = partitions[n];
    const lower = partitions[n - 1];
    if (upper === undefined || lower === undefined) continue;
    pKa.push(upper - lower);
  }
  // Already in titration order: the loop starts at the fully protonated state, and the first proton
  // to leave it is the most acidic one.

  if (pKa.length === 0) return { declined: "no microstate ladder could be built from the site values" };
  return {
    pKa,
    inconsistency,
    microstateCount: states.filter((s) => s.logBinding !== undefined).length,
    siteCount: sites.length,
    zwitterionic:
      sites.some((site) => site.transition === "acidic") &&
      sites.some((site) => site.transition === "basic")
  };
}

/**
 * log10 of a sum of 10^x, computed without ever forming 10^x.
 *
 * A tetraamine's most protonated microstate has L above 40; `10 ** 40` is representable but the sum
 * loses every low-order term, and a hexavalent one overflows outright. Factoring out the largest
 * exponent keeps the arithmetic in range.
 */
export function logSumExp10(values: readonly number[]): number {
  const max = Math.max(...values);
  const sum = values.reduce((total, value) => total + 10 ** (value - max), 0);
  return max + Math.log10(sum);
}

/**
 * Fold a structure's scored sites into macroscopic pKa values.
 *
 * `graphFor` must return the molecule with the given per-atom charge DELTAS applied, relative to the
 * structure as drawn — the same construction the basic-pKa path already uses, and the same guard: a
 * microstate that cannot be built contributes nothing rather than silently reusing the neutral form.
 *
 * Only sites carrying a value take part. A site the method declined to score has no rung on the
 * ladder, and inventing one would put a macroscopic number on top of a microscopic gap.
 */
export function macroscopicFromSites(
  sites: readonly IonizationSite[],
  graph: PkaMolecularGraph,
  graphFor: (deltas: ReadonlyMap<number, number>) => PkaMolecularGraph | undefined
): ProtonationOutcome {
  const adjacency = siteContext(graph).adjacency;
  const scored: MicrostateSite[] = [];
  for (const [index, site] of sites.entries()) {
    if (site.pKa === null) continue;
    const atom = graph.atoms[site.ionizableAtomIndex];
    if (!atom) continue;
    scored.push({
      siteIndex: index,
      atomIndex: site.ionizableAtomIndex,
      transition: site.transition,
      drawnCharge: atom.charge
    });
  }
  if (scored.length !== sites.filter((site) => site.pKa !== null).length) {
    return { declined: "some scored sites could not be located on the structure" };
  }

  // One structure per microstate, built once and reused across every edge that needs it.
  const cache = new Map<string, PkaMolecularGraph | null>();
  const graphOf = (state: Microstate): PkaMolecularGraph | undefined => {
    const key = state.protonated.map((p) => (p ? "1" : "0")).join("");
    if (!cache.has(key)) {
      const deltas = new Map<number, number>();
      for (const [i, site] of scored.entries()) {
        const delta = chargeDelta(site, state.protonated[i] === true);
        if (delta !== 0) deltas.set(site.atomIndex, (deltas.get(site.atomIndex) ?? 0) + delta);
      }
      cache.set(key, graphFor(deltas) ?? null);
    }
    return cache.get(key) ?? undefined;
  };

  // The microstate that IS the structure as drawn: acidic sites holding their proton, basic ones not.
  // Its edges already have a scored value — possibly a consensus with the Hammett relationship — and
  // reusing it is what makes a one-site molecule's macroscopic pKa equal the site value shown beside
  // it. Rebuilding it from the model alone put phenol at 10.24 against its own displayed 9.99.
  const drawnKey = scored.map((site) => (site.transition === "acidic" ? "1" : "0")).join("");

  // Through-bond distances between the sites, for the coupling term.
  const distanceBetween = scored.map((site) => distancesFrom(adjacency, site.atomIndex));

  /** How much every OTHER site's charge shifts this one, in this microstate. */
  const coupling = (state: Microstate, i: number): number => {
    let shift = 0;
    for (let j = 0; j < scored.length; j += 1) {
      if (j === i) continue;
      // Acid/base pairs only — see COUPLING. Like charges the model already handles.
      if (scored[j]!.transition === scored[i]!.transition) continue;
      const q = chargeDelta(scored[j]!, state.protonated[j] === true);
      if (q === 0) continue;
      const d = distanceBetween[i]!.get(scored[j]!.atomIndex);
      if (d === undefined || d === 0) continue;
      shift -= (COUPLING.W * q) / d;
    }
    return shift;
  };

  return macroscopicPka(scored, (state, i) => {
    if (state.protonated.map((p) => (p ? "1" : "0")).join("") === drawnKey) {
      const known = sites[scored[i]!.siteIndex]?.pKa;
      // The drawn microstate's value already reflects the charges actually present in it, so it takes
      // no correction — adding one would count the same interaction twice.
      if (known !== null && known !== undefined) return known;
    }
    // The edge belongs to the ACID: the microstate that still holds this proton.
    const acid = graphOf(state);
    if (!acid) return undefined;
    const site = scored[i]!;
    const atom = acid.atoms[site.atomIndex];
    // The proton has to actually be there, or the value would describe a different reaction.
    if (!atom || atom.hydrogens === 0) return undefined;
    try {
      const base = predictSitePkaWithSpread(
        siteFeatures(acid, site.atomIndex, ringMembership(acid))
      ).value;
      return base + coupling(state, i);
    } catch {
      return undefined;
    }
  });
}
