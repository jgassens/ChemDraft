/**
 * The lone-hydrogen (H•) cache migration: re-deriving the cached chemistry a document saved before
 * today's reading of a lone H atom still holds. One implementation for every entry point (AGENTS.md
 * §5): the desktop runs it when an opened or restored document is committed, plugin inserts and
 * pastes run it on the molecules they bring in, and the headless CLI and MCP run it on each document
 * they load (`loadAgentDocument`), so a saved file reads the same everywhere.
 */
import {
  adoptDerivedDocument,
  atomImpliedRadicalCount,
  atomicNumberForElementSymbol,
  atomStatedHydrogenCount,
  clearChangedAtomHydrogenHints,
  ignoredHydrogenCountAtomKind,
  isDativeBond,
  moleculeToMolfileV2000,
  moleculeToMolfileV3000,
  withBracketChemistryWarnings,
  type ChemDraftDocument,
  type CompatibilityWarning,
  type DocumentObject,
  type DocumentPage,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { hydrogenCountElement, nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { nativeAtomValidationState, nativeSingleBondGraphMetadata, withNativeLabelBondSides } from "./atoms";
import { normalizeNativeMoleculeGeometry } from "./molecule";
import { tryNativeSingleBondGraphSmiles } from "./smiles";

/** The open report's code for a molecule whose lone-H (H•) cache the refresh declined to change. */
export const IMPLIED_RADICAL_CACHE_NOT_REFRESHED_CODE = "document.lone_hydrogen_cache_not_refreshed";

/**
 * A molecule's graph re-derived as every graph edit re-derives it: import hints cleared, label bond
 * sides recorded, and the stored structure (SMILES) and chemistry record recomputed from `atoms` and
 * `bonds`, with its geometry normalized.
 */
export function refreshNativeSingleBondGraph(
  molecule: MoleculeObject,
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): MoleculeObject {
  // Clear import hints before deriving labels, formula, validation and the stored structure.
  atoms = clearChangedAtomHydrogenHints(molecule, atoms, bonds);
  // Every label and bond edit passes here, and no layout change does: record the side each
  // side-dependent label ("SCN") was written with, so later moves, rotations and flips keep it.
  atoms = withNativeLabelBondSides({ atoms: [...atoms], bonds: [...bonds] }).atoms;
  const storedSmiles = tryNativeSingleBondGraphSmiles(atoms, bonds);
  return normalizeNativeMoleculeGeometry({
    ...molecule,
    // `structure` is re-derived as SMILES here, so the format must say so. Leaving an imported
    // molfile format in place would hand SMILES text to a molfile parser — the plugin selection
    // snapshot and the Ketcher adapter both choose their parser from this field.
    structureFormat: "smiles",
    // The schema requires a string. Empty means unavailable, never a stale or single-collapsed
    // SMILES; export recomputes from the graph and reports the unknown bond ids.
    structure: "smiles" in storedSmiles ? storedSmiles.smiles : "",
    chemistry: nativeSingleBondGraphMetadata(atoms, bonds),
    atoms: [...atoms],
    bonds: [...bonds]
  });
}

/**
 * Re-derives the cached chemistry (structure, formula, masses, radicalCount) of each molecule holding
 * a lone hydrogen atom's implied radical (`atomImpliedRadicalCount`; H•, owner decision 2026-11-23),
 * through the path every graph edit takes (`refreshNativeSingleBondGraph`). Documents saved before
 * that reading cache an earlier reading of the lone H (H2: "[HH]", formula H2; or the bare atom with
 * no radical), which would disagree with the H• the canvas draws. Only those molecules are touched;
 * atoms, bonds and geometry stay as stored, and every other molecule keeps its stored chemistry.
 *
 * A stored cache is replaced only when it is provably ChemDraft's own stale output for this very
 * drawing (`impliedRadicalCacheRefresh`): every field the refresh would write equals, string for
 * string, the complete record ChemDraft held for the drawing under ONE earlier lone-H reading
 * (`earlierLoneHydrogenReadings`), its diagnostics and the page's own annotations included
 * (`annotatedOnPage`). Nothing stored is parsed. The native derivation is neither isomeric nor
 * stereo-perceiving, so a stored record carrying stereo, a molfile, other chemistry, or anything else
 * the native writer would not have written fails that comparison, and so does a record of a reading
 * this cannot rebuild exactly. Such a molecule keeps its whole stored cache, and the refresh says so:
 * a console warning naming the molecule, one line per molecule naming it in `warningsOut`
 * (`impliedRadicalCacheDeclinedLine`; paste shows them in the status line, as a plugin write shows
 * its own), and, on open and restore, the open report (`impliedRadicalCacheNotRefreshedWarnings`,
 * added by `openNativeDocument`).
 *
 * The ONE implementation for every way a stored molecule object enters an open document:
 * - open and session restore, through `normalizeCommittedDocument` (every molecule);
 * - a native ChemDraft clipboard paste (`pasteSelectionClipboardPayload`, the pasted molecules);
 * - a plugin `documents.applyPatch` insert or an accepted proposal (`applyPluginDocumentPatch`,
 *   the inserted molecules; a batch can name them all at once with `rederiveImpliedRadicalChemistryOf`).
 * `only` limits it to the objects that operation brought in; `occasion` names it in the log.
 *
 * Fail safe: this is a refresh of a cache, never a reason to refuse a document or an insertion. If
 * the recompute throws on an unusual molecule, that molecule stays exactly as stored (no chemistry
 * is changed), the error is logged with the molecule id, and the rest proceeds.
 */
export function withImpliedRadicalChemistryRederived(
  document: ChemDraftDocument,
  options: { only?: (pageId: string, objectId: string) => boolean; occasion?: string; warningsOut?: string[] } = {}
): ChemDraftDocument {
  const { only, warningsOut } = options;
  // One line per kept molecule, naming it: two kept molecules are two lines, never one anonymous
  // sentence twice, and a molecule is named once.
  const named = new Set<string>();
  return rederiveImpliedRadicalCaches(
    document,
    (pageId) => only ? (objectId) => only(pageId, objectId) : () => true,
    options.occasion ?? "on open",
    (_pageId, objectId, text) => {
      const line = impliedRadicalCacheDeclinedLine(objectId, text);
      if (named.has(line)) return;
      named.add(line);
      warningsOut?.push(line);
    }
  );
}

/** A molecule an operation brought into a document: the page it is on and its object id. */
export interface ImpliedRadicalRefreshTarget {
  pageId: string;
  objectId: string;
}

/** A molecule whose lone-H cache the refresh kept as stored, and what the user is told about it. */
export interface ImpliedRadicalCacheDecline {
  pageId: string;
  objectId: string;
  /** `impliedRadicalCacheNotRefreshedText`: what was not refreshed and why. */
  text: string;
}

/**
 * `withImpliedRadicalChemistryRederived` for the named molecules only, in one pass: a plugin batch
 * that inserts N molecules names them all here instead of walking the whole document once per
 * insertion. Pages no target names are not visited; each named page is visited once. Every target
 * the refresh declines is returned with its page, id and text (in page order, then object order), so
 * the caller can attribute each warning to its molecule; each is also logged, like every refresh.
 * A target that is not a molecule, or not on that page, is ignored. The document comes back as the
 * same instance when nothing was refreshed.
 *
 * `storedCtabVerified`: the caller verifies each target's stored CTAB against its drawing before it
 * commits (a plugin insert: `refreshPluginPatchChemistry`), so a CTAB that is ChemDraft's own writing
 * of the drawing (each lone H as H•), beside a chemistry record that already states today's reading,
 * is left to that check, with no warning (`statesTodaysReading`).
 */
export function rederiveImpliedRadicalChemistryOf(
  document: ChemDraftDocument,
  targets: Iterable<ImpliedRadicalRefreshTarget>,
  options: { occasion?: string; storedCtabVerified?: boolean } = {}
): { document: ChemDraftDocument; declined: ImpliedRadicalCacheDecline[] } {
  const idsByPage = new Map<string, Set<string>>();
  for (const { pageId, objectId } of targets) {
    const ids = idsByPage.get(pageId) ?? new Set<string>();
    idsByPage.set(pageId, ids);
    ids.add(objectId);
  }
  const declined: ImpliedRadicalCacheDecline[] = [];
  if (idsByPage.size === 0) return { document, declined };
  const refreshed = rederiveImpliedRadicalCaches(
    document,
    (pageId) => {
      const ids = idsByPage.get(pageId);
      return ids ? (objectId) => ids.has(objectId) : undefined;
    },
    options.occasion ?? "on plugin insert",
    (pageId, objectId, text) => { declined.push({ pageId, objectId, text }); },
    options.storedCtabVerified === true
  );
  return { document: refreshed, declined };
}

/**
 * The refresh itself. `select(pageId)` names which objects of that page to consider (undefined: skip
 * the page unvisited); `onDeclined` hears each molecule kept as stored, after its console warning.
 * `storedCtabVerified` as in `rederiveImpliedRadicalChemistryOf`.
 */
function rederiveImpliedRadicalCaches(
  document: ChemDraftDocument,
  select: (pageId: string) => ((objectId: string) => boolean) | undefined,
  occasion: string,
  onDeclined: (pageId: string, objectId: string, text: string) => void,
  storedCtabVerified = false
): ChemDraftDocument {
  let changed = false;
  const pages = document.pages.map((page) => {
    const selected = select(page.id);
    if (!selected) return page;
    let pageChanged = false;
    // One context per page and pass, so the page's bracket notes are computed once (`annotatedOnPage`).
    const context: LoneHydrogenPageContext = { document, page };
    const objects = page.objects.map((object) => {
      if (object.type !== "molecule" || !selected(object.id)) return object;
      try {
        const refresh = impliedRadicalCacheRefresh(object, context, storedCtabVerified);
        if (refresh.kind === "unchanged") return object;
        if (refresh.kind === "declined") {
          // Kept exactly as stored, and said so: never a partly refreshed, contradictory cache.
          const text = impliedRadicalCacheNotRefreshedText();
          console.warn(`Kept the stored chemistry of molecule ${object.id} ${occasion}: ${text}`);
          onDeclined(page.id, object.id, text);
          return object;
        }
        // Only the cached chemistry is replaced: atoms, bonds and geometry stay as stored.
        const refreshed = { ...object, ...refresh.cache };
        pageChanged = true;
        return refreshed;
      } catch (error) {
        console.error(`Could not re-derive the cached chemistry of molecule ${object.id} ${occasion}; keeping it as stored`, error);
        return object;
      }
    });
    if (!pageChanged) return page;
    changed = true;
    return { ...page, objects };
  });
  return changed ? adoptDerivedDocument(document, { ...document, pages }) : document;
}

/**
 * What a declined refresh tells the user: that the molecule's lone-H cache was not refreshed, why (its
 * stored chemistry is not ChemDraft's own earlier output for the drawing, so refreshing could lose
 * what it holds), and that it is kept exactly as saved.
 */
export function impliedRadicalCacheNotRefreshedText(): string {
  return "The cached chemistry of a molecule with a lone H (H•) was not refreshed, because its stored chemistry " +
    "is not ChemDraft's own earlier output for this drawing (it may hold stereochemistry or other chemistry), and " +
    "refreshing would overwrite it. Its stored structure, formula and stereochemistry are kept exactly as saved, " +
    "so they may still read the lone H as H2.";
}

/**
 * The line a paste's status shows for a molecule whose lone-H cache was kept as stored: the molecule
 * named, then the open report's text (`impliedRadicalCacheNotRefreshedText`). A plugin write names
 * its kept molecules in the same words (`applyPluginDocumentPatch`).
 */
export function impliedRadicalCacheDeclinedLine(objectId: string, text = impliedRadicalCacheNotRefreshedText()): string {
  return `Kept the stored chemistry of molecule "${objectId}": ${text}`;
}

/** The cached fields the lone-H refresh compares with an earlier reading and writes. */
type LoneHydrogenCache = Pick<MoleculeObject, "structureFormat" | "structure" | "chemistry">;

/**
 * Where a molecule the lone-H refresh reads sits: its document, and the page of it holding the
 * molecule. One context serves every molecule of the page in one pass (`rederiveImpliedRadicalCaches`,
 * `impliedRadicalCacheNotRefreshedWarnings`), so the page's bracket notes are computed once.
 */
interface LoneHydrogenPageContext {
  document: ChemDraftDocument;
  page: DocumentPage;
  /** Filled on first use (`pageBracketNotes`): chem-core's bracket notes for each molecule of the page. */
  bracketNotes?: ReadonlyMap<DocumentObject, readonly CompatibilityWarning[]>;
}

/** The code of chem-core's page note on a molecule inside a repeat-unit or multiple-group bracket pair. */
const BRACKET_MULTIPLIER_NOTE_CODE = "chemistry.bracket_multiplier";

type ImpliedRadicalCacheRefresh =
  | { kind: "unchanged" }
  | { kind: "refreshed"; cache: Pick<MoleculeObject, "structure" | "structureFormat" | "chemistry" | "compatibility"> }
  | { kind: "declined" };

/**
 * What re-deriving `object`'s lone-H cache does. Nothing stored is parsed; stored values are only
 * compared, string for string, with complete records ChemDraft writes, each annotated as ChemDraft
 * annotates a record on `object`'s page (`annotatedOnPage`), so a stored record, which has been
 * through that annotation, is compared with records that have too:
 * 1. no lone H (`atomImpliedRadicalCount`), or a cache today's record (`today`: the native
 *    derivation, annotated) already reproduces (structure, format, chemistry record, compared as
 *    release/1.2.3 compares them, and a cached SMILES copy `compatibility.unknown.smiles`, absent,
 *    empty or today's structure): unchanged;
 * 2. a cache that is ChemDraft's own output for this drawing under ONE earlier lone-H reading
 *    (`earlierLoneHydrogenReadings`: that era's complete record, each reading applied to every
 *    hydrogen atom it read differently, and offered only where it can be rebuilt exactly;
 *    `storedCacheIs`: every field the refresh would write equals that reading's, a field absent in
 *    storage counting as equal): refreshed to today's structure, format and annotated chemistry
 *    record, and a cached SMILES copy to its structure. The stored record was the native writer's own
 *    non-isomeric output, so nothing is lost;
 * 3. a cache that already states today's reading (`statesTodaysReading`): unchanged, kept as stored
 *    with no warning. With `storedCtabVerified` (a plugin insert, whose verifier checks a stored
 *    CTAB against the drawing before it commits) that includes a stored CTAB beside a record stating
 *    today's reading, where the CTAB is ChemDraft's own writing of the drawing, every lone H as H•;
 * 4. anything else (stereo, other chemistry, a mix of readings, a record the native writer would not
 *    have written): declined, so the molecule keeps its whole stored cache and the caller warns.
 * May throw (the derivation).
 */
function impliedRadicalCacheRefresh(
  object: MoleculeObject, context: LoneHydrogenPageContext, storedCtabVerified = false
): ImpliedRadicalCacheRefresh {
  if (!object.atoms.some((atom) => atomImpliedRadicalCount(atom, object.bonds) > 0)) return { kind: "unchanged" };
  const derived = refreshNativeSingleBondGraph(object, object.atoms, object.bonds);
  const today = annotatedOnPage(context, object,
    { structureFormat: derived.structureFormat, structure: derived.structure, chemistry: derived.chemistry });
  const copy: unknown = object.compatibility?.unknown.smiles;
  if (today.structure === object.structure && today.structureFormat === object.structureFormat &&
      JSON.stringify(today.chemistry) === JSON.stringify(object.chemistry) &&
      (copy === undefined || copy === "" || copy === today.structure)) return { kind: "unchanged" };
  const readings = earlierLoneHydrogenReadings(derived).map((reading) => annotatedOnPage(context, object, reading));
  if (!readings.some((reading) => storedCacheIs(object, reading))) {
    return statesTodaysReading(object, today, storedCtabVerified) ? { kind: "unchanged" } : { kind: "declined" };
  }
  const cache = { structureFormat: today.structureFormat, structure: today.structure, chemistry: today.chemistry };
  const compatibility = object.compatibility;
  // `storedCacheIs` proved a present copy to be the earlier reading's structure: it takes today's.
  if (!compatibility || typeof copy !== "string" || copy === "" || copy === today.structure) return { kind: "refreshed", cache };
  return { kind: "refreshed", cache: { ...cache, compatibility: { ...compatibility, unknown: { ...compatibility.unknown, smiles: today.structure } } } };
}

/**
 * `cache` as ChemDraft holds it for `object` on its page: the record after chem-core's own page
 * annotation of molecule records (`withBracketChemistryWarnings`), run by that very function on that
 * very page. Every patch and every document read runs it, so a stored record the refresh reads has
 * been through it; today it adds the note of a molecule inside a repeat-unit or multiple-group
 * bracket pair (`chemistry.bracket_multiplier`). A read drops every such note a file stores and adds
 * the page's own, so whatever an era's writer stored there, a genuine record of that era carries at
 * the refresh exactly the note this adds; the note follows the page and the drawing, never how a
 * lone H is read. The refresh writes today's record annotated in the same way, as the next commit
 * would leave it. A record with no chemistry is returned as it is (nothing is annotated).
 *
 * The notes themselves are chem-core's, computed once per page and pass (`pageBracketNotes`); they
 * depend on the page's brackets and on the molecule's id and atoms, never on its cached record, so
 * every molecule and every candidate record of the page reuses them. Each record then takes them as
 * that function takes them: its own bracket notes dropped, the page's appended, and the record left
 * as it is when that changes nothing.
 */
function annotatedOnPage(context: LoneHydrogenPageContext, object: MoleculeObject, cache: LoneHydrogenCache): LoneHydrogenCache {
  if (!cache.chemistry) return cache;
  context.bracketNotes ??= pageBracketNotes(context.document, context.page);
  const notes = context.bracketNotes.get(object);
  if (!notes) return cache;
  const previous = cache.chemistry.warnings;
  if (notes.length === 0 && !previous.some((warning) => warning.code === BRACKET_MULTIPLIER_NOTE_CODE)) return cache;
  const warnings = [...previous.filter((warning) => warning.code !== BRACKET_MULTIPLIER_NOTE_CODE), ...notes];
  if (JSON.stringify(previous) === JSON.stringify(warnings)) return cache;
  return { ...cache, chemistry: { ...cache.chemistry, warnings } };
}

/**
 * chem-core's bracket notes (`chemistry.bracket_multiplier`) for each molecule of `page`, keyed by the
 * page's own molecule object: `withBracketChemistryWarnings`, run once on `page` of `document` with
 * every molecule's record emptied of warnings (a molecule with no record given an empty one, so it is
 * annotated too), so whatever it leaves on a record is exactly the page's notes for that molecule.
 * Bracket membership reads the page's brackets and each molecule's id, atoms and bonds (a stored
 * structure only for a molecule with no atoms, which holds no lone H), never a cached record, so the
 * notes hold for any record the refresh compares or writes.
 */
function pageBracketNotes(document: ChemDraftDocument, page: DocumentPage): Map<DocumentObject, readonly CompatibilityWarning[]> {
  const emptied = page.objects.map((object): DocumentObject => object.type !== "molecule" ? object : {
    ...object,
    chemistry: { isotopeLabels: [], stereochemistry: [], ...object.chemistry, warnings: [] }
  });
  const annotated = withBracketChemistryWarnings({ ...document, pages: [{ ...page, objects: emptied }] }).pages[0]?.objects ?? [];
  const notes = new Map<DocumentObject, readonly CompatibilityWarning[]>();
  page.objects.forEach((object, index) => {
    const result = annotated[index];
    if (object.type === "molecule" && result?.type === "molecule") notes.set(object, result.chemistry?.warnings ?? []);
  });
  return notes;
}

/**
 * Step 3 of `impliedRadicalCacheRefresh`: whether `object`'s stored cache already states today's
 * reading of its drawing, so there is nothing to refresh and nothing to warn about: every stored
 * field the refresh compares equals today's record (`today`: the derivation, annotated on the page;
 * `storedCacheIs`: an empty structure or copy and an absent record field count as equal). Nothing
 * stored is parsed.
 *
 * A stored CTAB (molfile V2000 or V3000) is not the native writer's (it writes SMILES only), so the
 * refresh never wrote that CTAB and never replaces it. It states today's reading only where this
 * code confirms it does without parsing it (`storedCtabIsOwnWriting`: it is, string for string,
 * ChemDraft's own CTAB writing of the drawing, which writes each lone H, D or T as H•), and is then
 * left as stored only where the caller also verifies it against the drawing before committing
 * (`storedCtabVerified`: a plugin insert, whose verifier reads it with RDKit), beside a chemistry
 * record that states the radical count, so the record itself reads the lone H as H•. The verifier
 * does not compare radicals, so a CTAB this cannot confirm (a lone H written with no radical, which a
 * reader takes as H2; any other writer's CTAB) is declined, and so is every CTAB anywhere else (open,
 * restore, paste: nothing verifies it), so the user is told its cache was kept.
 */
function statesTodaysReading(object: MoleculeObject, today: LoneHydrogenCache, storedCtabVerified: boolean): boolean {
  const ctab = object.structure !== "" && (object.structureFormat === "molfile-v2000" || object.structureFormat === "molfile-v3000");
  if (ctab && (!storedCtabVerified || object.chemistry?.radicalCount === undefined || !storedCtabIsOwnWriting(object))) return false;
  return storedCacheIs(ctab ? { ...object, structure: "" } : object, today);
}

/**
 * Whether `object`'s stored CTAB is exactly what ChemDraft's own CTAB writer writes for its drawing
 * in the stored format (`moleculeToMolfileV2000` / `moleculeToMolfileV3000`, with the drawing's
 * Kekulé orders), with nothing the writer reports as lost. That writer writes each lone H, D or T
 * (`atomImpliedRadicalCount`) at the zero-valence sentinel (V2000 valence 15, V3000 VAL=-1), which a
 * reader takes as one atom carrying one radical electron, so an equal CTAB states every lone H as
 * today's H•. Nothing stored is parsed: the stored text is only compared with the writer's. A CTAB
 * the writer cannot write, or writes only with a loss, is not confirmed.
 */
function storedCtabIsOwnWriting(object: MoleculeObject): boolean {
  try {
    const options = { kekuleBondOrders: nativeBondOrderResolution(object.atoms, object.bonds).kekuleOrders };
    const written = object.structureFormat === "molfile-v2000"
      ? moleculeToMolfileV2000(object, options)
      : moleculeToMolfileV3000(object, options);
    return written.warnings.length === 0 && written.contents === object.structure;
  } catch {
    return false;
  }
}

/**
 * Whether `object` stores exactly `reading` in every field the lone-H refresh writes: its structure
 * with its format, the cached SMILES copy `compatibility.unknown.smiles`, and each field of its
 * chemistry record (formula, masses, counts, charge, radicals, isotope labels, stereochemistry,
 * warnings, and any other). Values are compared as strings (JSON for records and lists). A field
 * absent in storage (an empty structure or copy, no chemistry record, an undefined record field)
 * counts as equal; a stored field the reading does not have does not.
 */
function storedCacheIs(object: MoleculeObject, reading: LoneHydrogenCache): boolean {
  if (object.structure !== "" &&
      (object.structure !== reading.structure || object.structureFormat !== reading.structureFormat)) return false;
  const copy: unknown = object.compatibility?.unknown.smiles;
  if (copy !== undefined && copy !== "" && copy !== reading.structure) return false;
  const stored = object.chemistry;
  if (!stored) return true;
  const expected: Record<string, unknown> = reading.chemistry ?? {};
  return Object.entries(stored).every(([key, value]) =>
    value === undefined || JSON.stringify(value) === JSON.stringify(expected[key]));
}

/**
 * The complete caches ChemDraft's native derivation wrote for this drawing under the earlier
 * readings of a hydrogen atom, each the whole record ONE earlier writer wrote (structure, format, and
 * every field of the chemistry record, its diagnostics included; `impliedRadicalCacheRefresh` then
 * adds the page's annotations through chem-core's own function), computed by today's writer from
 * `derived` (`refreshNativeSingleBondGraph`'s result: its atoms are the ones the derivation read, its
 * structure and chemistry today's H• reading). Each reading is applied to EVERY hydrogen atom it read
 * differently from today, all at once, so a stored cache matches a reading only when it is one era's
 * output throughout; a mix of eras matches none. Each record holds only the diagnostics that writer
 * wrote (`eraDiagnostics`), so a record carrying a diagnostic only a later writer wrote matches no
 * earlier one. A reading whose record today's writer cannot rebuild exactly, in every field, is not
 * offered at all, so it never matches in part:
 * - H2 (863c8f229 until e7ef3bc68): each H, D or T atom with no covalent bond (a lone one, or one
 *   bonded only datively, a dative bond costing it nothing) carried one hydrogen of its own, as RDKit
 *   read the molfile's H without a valence field (`h2ReadingHydrogenCarrier`): SMILES [HH], [2HH],
 *   [3HH] (a dative Fe–D beside a lone H: [2HH][Fe].[HH], H3DFe); no radical (`h2ReadingCache`);
 * - the bare atom with no radical: today's structure and record, with the radicals counting no lone
 *   hydrogen atom. A datively bonded H, D or T read then as it does today (the single atom, no
 *   radical), so only the lone ones differ, and in the radical count alone. Two writers wrote it, with
 *   different diagnostics, so each is its own record:
 *   - e7ef3bc68 until 95783e713 (`"bare"`): it derived no hydrogen for a hydrogen atom, as today's
 *     does, so its diagnostics about one (a stated count it does not count: "... SMILES count 0.")
 *     are today's, word for word; it wrote none about an abbreviation's stated count;
 *   - release 1.2.2 (`"release-1.2.2"`, and an earlier release where its record is the same): it read
 *     no stated hydrogen count at all, so it wrote no diagnostic about one, and its formula, masses and
 *     SMILES never counted one. Where today's writer counts a stated count (`atomStatedHydrogenCount`)
 *     its record is not release 1.2.2's, so that reading is not offered.
 * Every other part of the cache is today's derivation's: no reading is isomeric, and none ever wrote
 * stereo.
 */
function earlierLoneHydrogenReadings(derived: MoleculeObject): LoneHydrogenCache[] {
  const { atoms, bonds, chemistry } = derived;
  const readings: LoneHydrogenCache[] = [];
  const carriers = atoms.filter((atom) => h2ReadingHydrogenCarrier(atom, bonds));
  const h2 = h2ReadingCache(derived, new Set(carriers.map((atom) => atom.id)));
  if (h2) readings.push(h2);
  const lone = atoms.filter((atom) => atomImpliedRadicalCount(atom, bonds) > 0);
  const bare = (era: "bare" | "release-1.2.2"): LoneHydrogenCache | undefined => {
    const cache = { structureFormat: derived.structureFormat, structure: derived.structure };
    if (!chemistry) return { ...cache, chemistry };
    const warnings = eraDiagnostics(era, chemistry.warnings, atoms, bonds);
    return warnings && { ...cache, chemistry: { ...chemistry, radicalCount: (chemistry.radicalCount ?? 0) - lone.length, warnings } };
  };
  const developed = bare("bare");
  if (developed) readings.push(developed);
  if (!atoms.some((atom) => atomStatedHydrogenCount(atom, bonds) !== undefined)) {
    const released = bare("release-1.2.2");
    if (released && JSON.stringify(released) !== JSON.stringify(developed)) readings.push(released);
  }
  return readings;
}

/**
 * The diagnostics (`chemistry.warnings`) the earlier writer `era` wrote for a drawing, from the ones
 * today's validator writes for it read as that era read it (`warnings`, written for `atoms` and
 * `bonds`), or undefined when that writer wrote one this cannot rebuild word for word (the reading is
 * then not offered). Each diagnostic is told by the rule that wrote it (document-workflow-core's
 * `nativeAtomValidationState` for the atom it names), and kept, dropped (that writer had no such
 * rule, and wrote nothing in its place) or declined (that writer wrote it in other words), from the
 * history of the validator (document-workflow-core's atoms.ts, chem-core's hydrogenHints.ts,
 * layout-engine's `atomDerivedHydrogenCount`):
 * - about no atom (an unknown bond order, an isotope with no mass): unchanged since release 1.2.2, kept;
 * - an atom's valence, aromaticity or label (not about a stated count): unchanged since release 1.2.2,
 *   kept, but for e7ef3bc68's judging of an H atom stating 0 as a typed H. "bare" wrote that too;
 *   release 1.2.2 did not, but a stated 0 on an H atom is a count today's writer counts, so release
 *   1.2.2's reading is not offered there. 863c8f229 derived one hydrogen for every neutral H, D or T
 *   atom with no covalent bond and no radical mark, and judged a stated 0 on one as a count to check,
 *   so for "h2" no diagnostic about an H, D or T atom is rebuilt (nor one about a hydrogen that
 *   reading added);
 * - a stated count that disagrees with the derived one (9ffa39a38): written in the same words by
 *   "h2" and "bare", kept; release 1.2.2 read no stated count, and its reading is not offered where
 *   today's writer counts one (`earlierLoneHydrogenReadings`), so none reaches it here: declined;
 * - a stated count nothing counts, on a hydrogen atom, the unknown atom or a label naming no element
 *   (f5ab763ac, 937c15fed, e866c62a5): written in the same words by "h2" and "bare", kept; release
 *   1.2.2 wrote none, dropped;
 * - such a count on an abbreviation (OMe, Ph; a typed Ac, Pr or Ts on a bond: 94e7e2d1e, 043a85dd4),
 *   after every earlier writer. Release 1.2.2 wrote none, dropped. "h2" and "bare" read an
 *   abbreviation's label as their label grammar's when an element symbol begins it (OMe, Ph, CF3, a
 *   typed Ac), writing nothing, dropped; one no element symbol begins (Me, Et) they read as a label
 *   naming no element, and wrote that diagnostic in those words, declined.
 * A diagnostic about an atom its validator finds valid is no such writer's, declined.
 */
function eraDiagnostics(
  era: "h2" | "bare" | "release-1.2.2",
  warnings: readonly CompatibilityWarning[],
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): CompatibilityWarning[] | undefined {
  if (warnings.length === 0) return [];
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  let resolution: ReturnType<typeof nativeBondOrderResolution> | undefined;
  const kept: CompatibilityWarning[] = [];
  for (const warning of warnings) {
    const atom = warning.objectId === undefined ? undefined : atomById.get(warning.objectId);
    if (!atom) {
      kept.push(warning);
      continue;
    }
    if (era === "h2" && hydrogenCountElement(atom) === "H") return undefined;
    resolution ??= nativeBondOrderResolution(atoms, bonds);
    const state = nativeAtomValidationState(atom, bonds, atom.formalCharge, atoms, resolution);
    if (state.valid) return undefined;
    if (state.hydrogenCountNotCounted !== true) {
      if (state.statedHydrogens !== undefined && era === "release-1.2.2") return undefined;
      kept.push(warning);
      continue;
    }
    if (era === "release-1.2.2") continue;
    if (ignoredHydrogenCountAtomKind(atom, bonds) !== "an abbreviation") {
      kept.push(warning);
      continue;
    }
    const label = atom.element.trim();
    const elementBegins = atomicNumberForElementSymbol(label.slice(0, 2)) !== undefined ||
      atomicNumberForElementSymbol(label.slice(0, 1)) !== undefined;
    if (!elementBegins) return undefined;
  }
  return kept;
}

/**
 * Whether the H2 reading (863c8f229 until e7ef3bc68) gave `atom` a hydrogen of its own: a hydrogen
 * atom as that era's writer told one, by layout-engine's `hydrogenCountElement` (H for any label the
 * writer's element normalization folds to H, a stored "h" included, and for D and T), that is not a
 * typed literal, neutral, carries no radical mark and states no count of its own
 * (`atomStatedHydrogenCount`), with no covalent bond: its bonds, if any, are all dative, which cost
 * it no valence (layout-engine's `nativeBondValenceContribution`). Its derived count was then
 * hydrogen's valence of 1. Every lone hydrogen atom (`atomImpliedRadicalCount`) is one.
 */
function h2ReadingHydrogenCarrier(atom: MoleculeAtom, bonds: readonly MoleculeBond[]): boolean {
  if (hydrogenCountElement(atom) !== "H") return false;
  if (atom.labelLiteral === true || atom.formalCharge !== 0 || (atom.markRadicals ?? 0) !== 0) return false;
  if (atomStatedHydrogenCount(atom, bonds) !== undefined) return false;
  return bonds.every((bond) => (bond.fromAtomId !== atom.id && bond.toAtomId !== atom.id) || isDativeBond(bond));
}

/**
 * The H2 reading's complete cache (`earlierLoneHydrogenReadings`) for `derived`'s hydrogen atoms that
 * reading gave a hydrogen of their own (`loneIds`: `h2ReadingHydrogenCarrier`, lone and dative-only
 * alike), or undefined when it cannot be written exactly, in every field. Computed by today's native
 * writer from the drawing alone:
 * - the chemistry record from the drawing with each such atom bonded to a hydrogen atom of its own,
 *   listed right after it, so the formula and masses count that hydrogen where the H2 reading
 *   counted it and the atom carries no radical; the atom and bond counts are the drawing's. The H2
 *   writer's record had the same fields in the same order (only its radical count differed from
 *   today's: radical marks alone, which is what such atoms bonded to a hydrogen leave);
 * - its diagnostics (`warnings`), which that era's validator wrote reading each such atom as holding
 *   one hydrogen (its derived count 1, which a diagnostic about it states: a stated count it does not
 *   count ends "... SMILES count 1."). Today's validator never derives a hydrogen for a hydrogen atom
 *   (layout-engine's `atomDerivedHydrogenCount`), bonded or not, so a diagnostic about such an atom,
 *   or any other hydrogen atom, or its added hydrogen, cannot be rebuilt as that era wrote it: then
 *   there is no H2 reading (`eraDiagnostics`, which also leaves out the diagnostics only later writers
 *   wrote). Every other atom's diagnostics must not depend on how such an atom is read: only when the
 *   drawing as read today (`derived`) and as partnered here give the same list is that list taken as
 *   that era's; when they differ there is no H2 reading either;
 * - the structure from the drawing with each such atom written as a hydrogen atom of an isotope no
 *   atom of the molecule has, a token the writer writes for nothing else, which then becomes the H2
 *   reading's token for that atom. Components and their order follow the bonds, which are the
 *   drawing's, so every other character is today's writer's.
 */
function h2ReadingCache(derived: MoleculeObject, loneIds: ReadonlySet<string>): LoneHydrogenCache | undefined {
  const { atoms, bonds } = derived;
  if (loneIds.size === 0) return undefined;
  const takenIds = new Set([...atoms.map((atom) => atom.id), ...bonds.map((bond) => bond.id)]);
  const partneredAtoms: MoleculeAtom[] = [];
  const partnerBonds: MoleculeBond[] = [];
  for (const atom of atoms) {
    partneredAtoms.push(atom);
    if (!loneIds.has(atom.id)) continue;
    const id = `${atom.id}\u0000h2`;
    if (takenIds.has(id)) return undefined;
    partneredAtoms.push({ id, element: "H", x: atom.x, y: atom.y, formalCharge: 0 });
    partnerBonds.push({ id, fromAtomId: atom.id, toAtomId: id, order: "single" });
  }
  const partneredBonds = [...bonds, ...partnerBonds];
  const metadata = nativeSingleBondGraphMetadata(partneredAtoms, partneredBonds);
  // The H2 writer's diagnostics, where they can be rebuilt (see above): the same whichever way those
  // atoms are read, none about a hydrogen atom, and only those that era's writer wrote.
  if (JSON.stringify(metadata.warnings) !== JSON.stringify(derived.chemistry?.warnings ?? [])) return undefined;
  const warnings = eraDiagnostics("h2", metadata.warnings, partneredAtoms, partneredBonds);
  if (!warnings) return undefined;
  const chemistry = { ...metadata, atomCount: atoms.length, bondCount: bonds.length, warnings };

  const takenIsotopes = new Set(atoms.map((atom) => atom.isotope));
  let isotope = 900_000;
  const tokens: [sentinel: string, token: string][] = [];
  const marked = atoms.map((atom): MoleculeAtom => {
    if (!loneIds.has(atom.id)) return atom;
    do {
      isotope += 1;
    } while (takenIsotopes.has(isotope));
    // The H2 reading's token: the atom's own isotope prefix and one hydrogen ([HH], [2HH], [3HH]).
    const prefix = atom.element === "D" ? "2" : atom.element === "T" ? "3" : String(atom.isotope ?? "");
    tokens.push([`[${isotope}H]`, `[${prefix}HH]`]);
    return { id: atom.id, element: "H", isotope, x: atom.x, y: atom.y, formalCharge: 0 };
  });
  const written = tryNativeSingleBondGraphSmiles(marked, bonds);
  let structure = "smiles" in written ? written.smiles : "";
  if (structure !== "") {
    for (const [sentinel, token] of tokens) {
      const parts = structure.split(sentinel);
      // Each such atom is written once.
      if (parts.length !== 2) return undefined;
      structure = parts.join(token);
    }
  }
  return { structureFormat: "smiles", structure, chemistry };
}

/**
 * One open warning per molecule of `document` whose lone-H cache the open refresh
 * (`withImpliedRadicalChemistryRederived`, run when the read document is committed) will decline
 * to change, naming why. `openNativeDocument` adds them to the open report, so File > Open and
 * session restore show what was kept stale. `source` begins each message: which document it is
 * about, when an open offers two. A molecule whose recompute throws is left to the refresh, which
 * logs it.
 */
export function impliedRadicalCacheNotRefreshedWarnings(
  document: ChemDraftDocument,
  source = "ChemDraft document"
): { code: string; message: string; sourceObjectId: string }[] {
  return document.pages.flatMap((page) => {
    // One context per page, as the refresh keeps one (`annotatedOnPage`).
    const context: LoneHydrogenPageContext = { document, page };
    return page.objects.flatMap((object) => {
      if (object.type !== "molecule") return [];
      try {
        const refresh = impliedRadicalCacheRefresh(object, context);
        return refresh.kind === "declined" ? [{
          code: IMPLIED_RADICAL_CACHE_NOT_REFRESHED_CODE,
          message: `${source}: ${impliedRadicalCacheNotRefreshedText()}`,
          sourceObjectId: object.id
        }] : [];
      } catch {
        return [];
      }
    });
  });
}

