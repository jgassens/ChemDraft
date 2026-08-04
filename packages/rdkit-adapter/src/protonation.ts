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

import { distancesFrom, shareARing, siteContext } from "./pkaAromaticity";
import { type PkaMolecularGraph } from "./pkaModel";
import { predictSitePka } from "./pkaGnn";
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

/**
 * Most microstates the enumeration will build.
 *
 * The count is a PRODUCT of ladder heights, not 2^n — an amphoteric nitrogen contributes three levels
 * rather than two. 2^8 is exactly the budget the boolean version had, kept so that no molecule which
 * used to be answered starts declining.
 */
export const MAX_MICROSTATES = 2 ** MAX_SITES;

/**
 * Widest interval a rung may carry and still be folded into a titration curve.
 *
 * Half of water's roughly 14-unit range. Beyond it the rung is not locating a step, and a curve built
 * from such rungs has plateaus the molecule does not have.
 */
export const HALF_THE_AQUEOUS_RANGE = 3.5;

/**
 * One rung of an atom's ladder: a single proton leaving, between two adjacent levels.
 *
 * `acidCharge` is the rung's whole identity, and it is what makes a ladder a ladder. The acid side
 * carries that formal charge; the base side carries one less. Two rungs on one atom are adjacent
 * exactly when their `acidCharge` values differ by one — so "this nitrogen is -1 and +1 at the same
 * time" is not a state the enumeration can reach, rather than a state it happens not to build.
 */
export interface ProtonationRung {
  /** Index into the caller's site list, so results can be mapped back. */
  siteIndex: number;
  /** Formal charge the ionizable atom carries in the ACID of this rung. */
  acidCharge: number;
}

/**
 * One ionizable ATOM's ordered ladder — the variable the enumeration moves.
 *
 * Levels are contiguous formal charges, ascending: level `k` carries `rungs[0].acidCharge - 1 + k`, so
 * level 0 is the most deprotonated form and `rungs.length` the most protonated. Rung `r` connects
 * level `r` (its base) to level `r + 1` (its acid).
 *
 * There is no per-atom "transition" here any more. A direction is a property of a RUNG, and an atom
 * that both loses and gains a proton is ONE variable with two rungs rather than two variables. That is
 * the difference between describing aniline and describing a nitrogen that is simultaneously an anion
 * and a cation, which is what the previous representation allowed.
 */
export interface ProtonationLadder {
  atomIndex: number;
  /** Formal charge the atom carries as drawn. Always one of the ladder's levels. */
  drawnCharge: number;
  /** Ascending in `acidCharge`, contiguous, at least one. */
  rungs: ProtonationRung[];
}

export interface Microstate {
  /** Level index per ladder, in `ladders` order. */
  levels: number[];
  /** Protons held above the fully deprotonated reference: the sum of the level indices. */
  protonCount: number;
  /** Summed microscopic pKa from that reference. Undefined if no route reaches this state. */
  logBinding?: number;
  /** Total molecular formal charge in this state — absolute, not relative to the drawing. */
  charge: number;
}

/** Where a ladder's drawn level sits, which is all the old per-site `transition` ever meant. */
export type LadderRole = "acid" | "base" | "amphoteric";

export const levelCount = (ladder: ProtonationLadder): number => ladder.rungs.length + 1;

/** The formal charge the ionizable atom carries at a given level. Linear, with no direction branch. */
export const chargeAtLevel = (ladder: ProtonationLadder, level: number): number =>
  ladder.rungs[0]!.acidCharge - 1 + level;

/** The level the atom actually sits at in the structure as drawn. */
export const drawnLevel = (ladder: ProtonationLadder): number =>
  ladder.drawnCharge - (ladder.rungs[0]!.acidCharge - 1);

/**
 * Whether a ladder can only lose a proton, only gain one, or both.
 *
 * `amphoteric` is the case the boolean model could not express at all: an atom whose drawn form sits
 * between two rungs, so it is genuinely both an acid and a base. Aniline's nitrogen is one.
 */
export function ladderRole(ladder: ProtonationLadder): LadderRole {
  const drawn = drawnLevel(ladder);
  if (drawn === levelCount(ladder) - 1) return "acid";
  if (drawn === 0) return "base";
  return "amphoteric";
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
 * The charge an atom carries at a level, relative to how it was drawn.
 *
 * This used to branch on whether the site was acidic or basic, because a boolean cannot say where a
 * proton went without knowing which convention it was drawn under. A level index can, so the charge is
 * now linear in it and the branch is gone.
 */
export function chargeDelta(ladder: ProtonationLadder, level: number): number {
  return chargeAtLevel(ladder, level) - ladder.drawnCharge;
}

/**
 * Every combination of ladder levels, ordered by proton count.
 *
 * Mixed radix rather than a bitmask: ladders have different heights, so the state space is a product
 * and not a power. That is the whole reason an impossible microstate can no longer be indexed.
 */
export function enumerateMicrostates(
  ladders: readonly ProtonationLadder[],
  drawnMolecularCharge = 0
): Microstate[] {
  const radices = ladders.map(levelCount);
  const total = radices.reduce((product, n) => product * n, 1);
  const out: Microstate[] = [];
  for (let index = 0; index < total; index += 1) {
    let rest = index;
    const levels = radices.map((n) => {
      const level = rest % n;
      rest = Math.floor(rest / n);
      return level;
    });
    out.push({
      levels,
      protonCount: levels.reduce((sum, level) => sum + level, 0),
      charge:
        drawnMolecularCharge +
        levels.reduce((sum, level, i) => sum + chargeDelta(ladders[i]!, level), 0)
    });
  }
  return out.sort((a, b) => a.protonCount - b.protonCount);
}

/**
 * Whether a molecule's dominant species carries opposite charges on different atoms.
 *
 * NOT "it has an acidic site and a basic site". That sentence is a claim about site TYPES, and it is
 * true of acetamide — whose single nitrogen is merely amphoteric — and of pyridinium, where two
 * methods described one rung from opposite sides. Both were flagged; neither is a zwitterion. What the
 * flag exists for is the case where the electrostatic coupling carries the answer, and that case is
 * defined by CHARGES IN A STATE.
 */
export function zwitterionic(
  ladders: readonly ProtonationLadder[],
  states: readonly Microstate[]
): boolean {
  const reachable = states.filter((state) => state.logBinding !== undefined);
  if (reachable.length === 0) return false;
  // The state nearest neutral, most stable among ties. Nearest rather than exactly zero so that a
  // molecule with a permanent charge — betaine's quaternary nitrogen — is still judged on a species
  // that exists rather than on one that does not.
  const dominant = reachable.reduce((best, state) => {
    const closer = Math.abs(state.charge) - Math.abs(best.charge);
    return closer < 0 || (closer === 0 && state.logBinding! > best.logBinding!) ? state : best;
  });
  const charges = ladders.map((ladder, i) => chargeAtLevel(ladder, dominant.levels[i]!));
  return charges.some((q) => q > 0) && charges.some((q) => q < 0);
}

/**
 * Build the ladder of microscopic pKa values and fold it into macroscopic ones.
 *
 * `microPka(state, ladderIndex)` must return the pKa of that ladder dropping ONE LEVEL from where it
 * sits in `state` — the acid form. Returning undefined drops that edge, and a microstate reachable by
 * no edge is left out of its partition sum rather than guessed at.
 */
export function macroscopicPka(
  ladders: readonly ProtonationLadder[],
  microPka: (state: Microstate, ladderIndex: number) => number | undefined,
  /**
   * Pairs (acidic, basic) whose combined flip is a TAUTOMER rather than a distinct species.
   *
   * An azole's two ring nitrogens look like two independent sites — one drawn with a hydrogen, one
   * without — but deprotonating the first while protonating the second is the proton MOVING, giving
   * the tautomer with the hydrogen on the other nitrogen. Reaching it needs the ring's double bonds
   * rearranged, which assigning charges cannot do: the enumeration builds `c1c[nH+]c[n-]1` instead, an
   * ylide that does not meaningfully exist and which the model scores at 6.95 where the real neutral
   * imidazole is 13.84.
   *
   * Those microstates are dropped rather than scored. Measured: imidazole's first macroscopic pKa goes
   * from 3.28 to 6.83 against a reference 6.95, pyrazole from -0.00 to 3.42 against 2.49, and
   * histidine's second from 2.82 to 6.45 against 6.00. Molecules without such a pair are untouched.
   *
   * What this does NOT do is compute the tautomer's own binding constant — the state is omitted from
   * the partition sum, not replaced by the right species. For an azole both tautomers are the same
   * protonation state, so the cost is a degeneracy factor of at most log10(2), well inside the
   * method's error.
   */
  tautomerPairs: readonly (readonly [number, number])[] = [],
  drawnMolecularCharge = 0
): ProtonationOutcome {
  if (ladders.length === 0) return { declined: "no ionizable sites to enumerate" };

  if (ladders.length > MAX_SITES) {
    return {
      declined:
        `${ladders.length} ionizable atoms is above the ${MAX_SITES} this enumeration accepts; each ` +
        "carries its own ladder of microstates. No macroscopic value is reported rather " +
        "than a truncated one."
    };
  }
  const stateCount = ladders.map(levelCount).reduce((product, n) => product * n, 1);
  if (stateCount > MAX_MICROSTATES) {
    return {
      declined:
        `these ladders would need ${stateCount} microstates, above the ${MAX_MICROSTATES} this ` +
        "enumeration accepts. No macroscopic value is reported rather than a truncated one."
    };
  }

  const states = enumerateMicrostates(ladders, drawnMolecularCharge);
  // Dot-separated, not digits joined: a level index can in principle exceed 9, and a joined-digit key
  // would silently collide two different states onto one entry.
  const key = (levels: readonly number[]) => levels.join(".");
  const byKey = new Map(states.map((state) => [key(state.levels), state]));

  // Only an acid/base pair can be tautomer-related: the proton has to have somewhere to go. Two acidic
  // sites deprotonating one at a time are two genuinely different microstates, and dropping one of
  // them would delete a real rung, so such a pair is ignored rather than trusted.
  // No role filter here, deliberately. An earlier version required an acid paired with a base, which
  // excluded urea — whose two nitrogens are both amphoteric and are exactly the pair that needs
  // excluding. The state test below is what actually distinguishes a moved proton from a lost one, and
  // it is already safe for same-role pairs: two carboxyls are both drawn at the top of their ladders,
  // so neither can ever be ABOVE its drawn level and no real rung is ever dropped.
  const pairs = tautomerPairs.filter(
    ([a, b]) => ladders[a] !== undefined && ladders[b] !== undefined
  );

  /** One partner below its drawn level while the other is above it: a proton that moved, not one that left. */
  const isTautomerState = (state: Microstate): boolean =>
    pairs.some(([a, b]) => {
      const gaveUp = state.levels[a]! < drawnLevel(ladders[a]!) && state.levels[b]! > drawnLevel(ladders[b]!);
      const tookOn = state.levels[b]! < drawnLevel(ladders[b]!) && state.levels[a]! > drawnLevel(ladders[a]!);
      return gaveUp || tookOn;
    });

  // Reference: the fully deprotonated state, L = 0 by definition.
  const reference = byKey.get(key(ladders.map(() => 0)))!;
  reference.logBinding = 0;

  // Walk outward by proton count. Each state's L is reached from every state one proton lighter, and
  // where those routes disagree the spread is recorded — it is the thermodynamic inconsistency.
  let inconsistency = 0;
  const maxProtons = ladders.reduce((sum, ladder) => sum + levelCount(ladder) - 1, 0);
  for (let n = 1; n <= maxProtons; n += 1) {
    for (const state of states.filter((s) => s.protonCount === n)) {
      if (isTautomerState(state)) continue;
      const routes: number[] = [];
      for (let i = 0; i < ladders.length; i += 1) {
        if (state.levels[i] === 0) continue;
        const lighter = byKey.get(
          key(state.levels.map((level, j) => (j === i ? level - 1 : level)))
        );
        if (!lighter || lighter.logBinding === undefined || isTautomerState(lighter)) continue;
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
  for (let n = 0; n <= maxProtons; n += 1) {
    const bound = states
      .filter((s) => s.protonCount === n && s.logBinding !== undefined)
      .map((s) => s.logBinding!);
    partitions.push(bound.length === 0 ? undefined : logSumExp10(bound));
  }

  const pKa: number[] = [];
  for (let n = maxProtons; n >= 1; n -= 1) {
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
    siteCount: ladders.length,
    zwitterionic: zwitterionic(ladders, states)
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

  // Group the scored rows by ATOM. One atom is one variable however many rungs it has — that is the
  // whole change, and it is why an impossible microstate can no longer be indexed.
  /**
   * Whether a rung is confident enough to be a step in a titration curve.
   *
   * A microscopic value with a wide interval is still worth SHOWING — it is the method's honest
   * estimate for that site, and the interval says how much to trust it. Folding it into a macroscopic
   * ladder is a different act: it asserts that a titration has a step there. A rung whose own interval
   * spans five log units is not a step, it is an admission that the model does not know, and putting it
   * in the curve invents a plateau the molecule does not have.
   *
   * The threshold is argued from the pH scale rather than from the model. Water spans roughly 14 log
   * units, so an interval of +/-3.5 covers half of it: such a rung says "this titrates somewhere in
   * the acidic half, or maybe the basic half", which is not a step. The model's own upper interval
   * QUARTILE was tried first and is wrong for this — it is a property of the interval distribution, so
   * a quarter of all sites exceed it by construction, and at the current calibration (2.477) it
   * excluded ACETIC ACID, whose carboxyl carries 2.59. A filter that silences acetic acid is not
   * measuring confidence, it is measuring the shape of a histogram.
   *
   * Measured on SAMPL6, end to end, where a structure is supplied and nothing else:
   *
   *   no filter   MAE 2.43,  1 of 24 molecules with the right number of steps, 26% within 1 log unit
   *   this        MAE 2.09,  8 of 24,                                          32%
   *
   * and on the fifteen curated polyprotic molecules it changes almost nothing (0.341 -> 0.327, still
   * 15 of 15 answered), which is what says it is removing noise rather than removing signal.
   *
   * This does NOT fix the underlying problem, which is that the scan finds sites that do not titrate:
   * amide nitrogens offered a basicity, every aromatic ring nitrogen offered one, an amide N-H scored
   * near 8 where it is really about 16. Those are site-detection and valuation defects and they need
   * chemistry, not a filter. This keeps the worst of them out of the curve in the meantime, and the
   * sites themselves are still reported with their intervals so nothing is hidden.
   */
  const confidentEnough = (site: IonizationSite) =>
    site.spread === undefined || site.spread <= HALF_THE_AQUEOUS_RANGE;

  const byAtom = new Map<number, ProtonationRung[]>();
  const scoredCount = sites.filter((site) => site.pKa !== null).length;
  let located = 0;
  for (const [index, site] of sites.entries()) {
    if (site.pKa === null) continue;
    if (!confidentEnough(site)) continue;
    const atom = graph.atoms[site.ionizableAtomIndex];
    if (!atom) continue;
    located += 1;
    byAtom.set(site.ionizableAtomIndex, [
      ...(byAtom.get(site.ionizableAtomIndex) ?? []),
      { siteIndex: index, acidCharge: site.acidCharge }
    ]);
  }
  if (located !== sites.filter((site) => site.pKa !== null && confidentEnough(site)).length) {
    return { declined: "some scored sites could not be located on the structure" };
  }
  if (scoredCount > 0 && located === 0) {
    // Sites were found and valued; none is confident enough to be a step. Saying "no ionizable sites"
    // here would be false, and it is the reader's most likely misreading.
    return {
      declined:
        `every site's estimate spans more than ${2 * HALF_THE_AQUEOUS_RANGE} log units, which places no ` +
        "titration step. The per-site values are still reported above, with their intervals."
    };
  }

  const scored: ProtonationLadder[] = [];
  for (const [atomIndex, rungs] of [...byAtom.entries()].sort((a, b) => a[0] - b[0])) {
    const ordered = [...rungs].sort((a, b) => a.acidCharge - b.acidCharge);
    // Contiguity is enforced at the result contract too, but a hole here would silently produce a
    // ladder whose levels do not mean what `chargeAtLevel` says they mean, so it declines instead.
    const span = ordered[ordered.length - 1]!.acidCharge - ordered[0]!.acidCharge;
    if (span !== ordered.length - 1) {
      return { declined: `atom ${atomIndex}'s transitions do not form a contiguous ladder` };
    }
    const drawnCharge = graph.atoms[atomIndex]!.charge;
    const ladder = { atomIndex, drawnCharge, rungs: ordered };
    // The atom as drawn must BE one of the ladder's levels, or every charge on it is off by a constant
    // and the coupling term would read the wrong sign.
    const level = drawnLevel(ladder);
    if (level < 0 || level >= levelCount(ladder)) {
      return { declined: `atom ${atomIndex} is drawn at a charge its own ladder does not contain` };
    }
    scored.push(ladder);
  }

  // One structure per microstate, built once and reused across every edge that needs it.
  const cache = new Map<string, PkaMolecularGraph | null>();
  const graphOf = (state: Microstate): PkaMolecularGraph | undefined => {
    const cacheKey = state.levels.join(".");
    if (!cache.has(cacheKey)) {
      const deltas = new Map<number, number>();
      for (const [i, ladder] of scored.entries()) {
        const delta = chargeDelta(ladder, state.levels[i]!);
        if (delta !== 0) deltas.set(ladder.atomIndex, (deltas.get(ladder.atomIndex) ?? 0) + delta);
      }
      cache.set(cacheKey, graphFor(deltas) ?? null);
    }
    return cache.get(cacheKey) ?? undefined;
  };

  /**
   * Whether every OTHER ladder sits where it is drawn.
   *
   * When it does, the scored value for this rung already describes exactly this environment — it is
   * what the site table shows beside the structure, possibly a consensus with the Hammett relationship
   * — so it is reused rather than recomputed. Rebuilding it from the model alone put phenol's
   * macroscopic pKa at 10.24 against its own displayed 9.99.
   *
   * This replaces a check against one hard-coded "as drawn" state, and it is strictly wider: it now
   * covers BASIC rungs too, which were silently recomputed from the model even when the row beside them
   * showed a consensus. It is also self-consistent — if every other ladder is at its drawn level then
   * every neighbouring charge is the drawn charge, so the coupling correction is zero and the reused
   * value is not double-counting anything.
   */
  const othersAsDrawn = (state: Microstate, i: number): boolean =>
    state.levels.every((level, j) => j === i || level === drawnLevel(scored[j]!));

  // Through-bond distances between the sites, for the coupling term.
  const distanceBetween = scored.map((ladder) => distancesFrom(adjacency, ladder.atomIndex));

  /** How much every OTHER site's charge shifts this one, in this microstate. */
  const coupling = (state: Microstate, i: number): number => {
    let shift = 0;
    const roleI = ladderRole(scored[i]!);
    for (let j = 0; j < scored.length; j += 1) {
      if (j === i) continue;
      // Acid/base pairs only — see COUPLING. Like charges the model already handles. An amphoteric
      // ladder has no single role and is never excluded: which face it presents depends on the state.
      const roleJ = ladderRole(scored[j]!);
      if (roleI === roleJ && roleI !== "amphoteric") continue;
      // The ABSOLUTE charge at this level, not the delta from the drawing. Identical on every molecule
      // W was fitted against — their drawn forms are neutral — and correct for one whose canonical
      // protomer is not, which is a case protomer canonicalization is about to make reachable.
      const q = chargeAtLevel(scored[j]!, state.levels[j]!);
      if (q === 0) continue;
      const d = distanceBetween[i]!.get(scored[j]!.atomIndex);
      if (d === undefined || d === 0) continue;
      shift -= (COUPLING.W * q) / d;
    }
    return shift;
  };

  // Site pairs sharing an aromatic ring: an azole's two nitrogens, whose combined flip is a tautomer.
  // Ladder pairs between which a proton MOVES rather than leaves. Per-atom ladders do not subsume this
  // — imidazole's ylide is two DIFFERENT atoms, each at a level its own ladder allows — so the
  // exclusion stays, now expressed in ladder coordinates and no longer limited to aromatic rings.
  //
  // Two heteroatoms attached to one CONJUGATED centre are the general case. Urea's nitrogens are the
  // example that forced the generalisation: the model placed its ylide, one nitrogen at -1 and the
  // other at +1, 1.7 log units BELOW neutral urea in free energy and so declared urea a zwitterion.
  // That is the coupling term doing what it was fitted to do for glycine — stabilising opposite
  // charges — applied to two nitrogens 2 bonds apart across a carbonyl, where the charges annihilate
  // through the pi system instead of persisting. Moving urea's proton from one nitrogen to the other
  // gives urea back.
  //
  // Glycine is the case that must NOT be caught, and is not: its amine hangs off an sp3 carbon and its
  // carboxyl off a different one, so the two share no neighbour and its zwitterion is a real species.
  const context = siteContext(graph);
  const doubleBonded = new Set<number>();
  for (const bond of graph.bonds) {
    if (bond.order >= 2) {
      doubleBonded.add(bond.atoms[0]);
      doubleBonded.add(bond.atoms[1]);
    }
  }
  // Per ATOM, never per bond: which bond of an aromatic ring carries the double bond depends on the
  // Kekule structure chosen, and this project has shipped that bug four times.
  const conjugated = (atom: number) => context.aromatic[atom] === true || doubleBonded.has(atom);

  const tautomerPairs: [number, number][] = [];
  for (let a = 0; a < scored.length; a += 1) {
    for (let b = a + 1; b < scored.length; b += 1) {
      const first = scored[a]!.atomIndex;
      const second = scored[b]!.atomIndex;
      const sharedRing =
        context.aromatic[first] === true &&
        context.aromatic[second] === true &&
        shareARing(adjacency, first, second);
      const sharedCentre = (adjacency[first] ?? []).some(
        (neighbour) => conjugated(neighbour) && (adjacency[second] ?? []).includes(neighbour)
      );
      if (sharedRing || sharedCentre) tautomerPairs.push([a, b]);
    }
  }

  const drawnMolecularCharge = graph.atoms.reduce((sum, atom) => sum + atom.charge, 0);

  return macroscopicPka(scored, (state, i) => {
    // The rung being descended: this ladder dropping from its current level to the one below.
    const rung = scored[i]!.rungs[state.levels[i]! - 1];
    if (rung && othersAsDrawn(state, i)) {
      const known = sites[rung.siteIndex]?.pKa;
      // Its environment is the drawn one, so the value takes no coupling correction — adding one would
      // count the same interaction twice.
      if (known !== null && known !== undefined) return known;
    }
    // The edge belongs to the ACID: the microstate that still holds this proton.
    const acid = graphOf(state);
    if (!acid) return undefined;
    const ladder = scored[i]!;
    const atom = acid.atoms[ladder.atomIndex];
    // The proton has to actually be there, or the value would describe a different reaction.
    if (!atom || atom.hydrogens === 0) return undefined;
    try {
      const base = predictSitePka(acid, ladder.atomIndex).value;
      return base + coupling(state, i);
    } catch {
      return undefined;
    }
  }, tautomerPairs, drawnMolecularCharge);
}
