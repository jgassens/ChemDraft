import {
  diffChemicalIdentity, snapshotChemicalIdentity, type ChemDraftDocument, type DocumentObject, type MoleculeObject,
} from "@chemdraft/chem-core";
import {
  importOfficeStructures, OfficeImportError, type OfficeCarrierWarningReason, type OfficeImportResult, type OfficeStructure,
} from "@chemdraft/clipboard-adapter";
import type { CommandSpec } from "./commands";
import { assertDocumentSize, readNativeFileBytes } from "./documentText";
import {
  parseSelectionClipboardPayload, pasteSelectionClipboardPayload, selectDocumentObjects, selectionBounds,
  serializeSelectionClipboardPayload, type ChemDraftSelectionClipboardPayload,
} from "./documentWorkflow";
import { isDesktopRuntime } from "./window-manager";

/**
 * File ▸ Import Structures from Word or PowerPoint… (docs/architecture/office-editing.md, slice 3).
 * The package layer (`importOfficeStructures`) finds the carriers; this layer reads each one with
 * the same parser as a ChemDraft paste, refuses any whose chemistry does not survive a round trip
 * or placement (AGENTS.md §7), lays the rest out left to right, and commits them as one undo step.
 */

export const IMPORT_OFFICE_STRUCTURES_COMMAND_ID = "document.importOfficeStructures";
export const IMPORT_OFFICE_STRUCTURES_TITLE = "Import Structures from Word or PowerPoint…";
export const IMPORT_OFFICE_STRUCTURES_UNDO_LABEL = "Import Structures from Word or PowerPoint";
export const OFFICE_IMPORT_FILE_FILTERS = [{ name: "Word or PowerPoint", extensions: ["docx", "pptx"] }];

export const importOfficeStructuresCommand: CommandSpec = {
  id: IMPORT_OFFICE_STRUCTURES_COMMAND_ID,
  title: IMPORT_OFFICE_STRUCTURES_TITLE,
  icon: "open",
  source: "core",
  description: "Insert the ChemDraft structures placed in a Word document or PowerPoint presentation",
};

export type OfficeStructureCheck =
  | { ok: true; payload: ChemDraftSelectionClipboardPayload }
  | { ok: false; reason: string };

function moleculesOf(objects: readonly DocumentObject[]): MoleculeObject[] {
  return objects.filter((object): object is MoleculeObject => object.type === "molecule");
}

/** First identity difference between two molecule lists, or undefined when they agree. */
function identityDifference(before: readonly MoleculeObject[], after: readonly MoleculeObject[]): string | undefined {
  if (before.length !== after.length) return `the number of structures changed from ${before.length} to ${after.length}`;
  for (const [index, molecule] of before.entries()) {
    const diff = diffChemicalIdentity(snapshotChemicalIdentity(molecule), snapshotChemicalIdentity(after[index]!));
    if (diff.verdict === "changed") return diff.reasons.join("; ") || "its atoms or bonds changed";
  }
  return undefined;
}

/** Refuse an Office paste if normalization changes a molecule already on the page. */
export function assertOfficePastePreservesExistingChemistry(before: ChemDraftDocument, after: ChemDraftDocument): void {
  const finalMolecules = new Map(after.pages.flatMap((page) => moleculesOf(page.objects).map((molecule) => [molecule.id, molecule] as const)));
  for (const page of before.pages) {
    for (const molecule of moleculesOf(page.objects)) {
      const final = finalMolecules.get(molecule.id);
      if (final === molecule) continue;
      const refusal = (reason: string) => new Error(`Paste refused because it would change existing chemistry: ${reason}. Nothing was pasted.`);
      if (!final) throw refusal(`structure ${molecule.id} would be lost`);
      const finalAtoms = new Map(final.atoms.map((atom) => [atom.id, atom] as const));
      for (const atom of molecule.atoms) {
        const next = finalAtoms.get(atom.id);
        if (!next) throw refusal(`atom ${atom.id} would be lost`);
        if (atom.formalCharge !== next.formalCharge) {
          throw refusal(`the formal charge on ${atom.element} atom ${atom.id} would change from ${atom.formalCharge} to ${next.formalCharge}`);
        }
        if ((atom.markRadicals ?? 0) !== (next.markRadicals ?? 0)) {
          throw refusal(`the radical marks on ${atom.element} atom ${atom.id} would change`);
        }
      }
      const changed = identityDifference([molecule], [final]);
      if (changed) throw refusal(`structure ${molecule.id} would change (${changed})`);
    }
  }
}

type RawMolecule = { atoms: unknown[]; bonds: unknown[] };

function rawMolecules(document: Record<string, unknown>): RawMolecule[] | undefined {
  const objects = document.objects;
  if (!Array.isArray(objects)) return undefined;
  return objects.filter((object): object is RawMolecule =>
    typeof object === "object" && object !== null && (object as { type?: unknown }).type === "molecule" &&
    Array.isArray((object as RawMolecule).atoms) && Array.isArray((object as RawMolecule).bonds));
}

/**
 * Chemistry check (AGENTS.md §7). The carrier records no SMILES of its own, so the check is:
 * the native reader kept every molecule with all its atoms and bonds; and the drawing survives
 * serialize → parse with the same element, charge, isotope, radical, bond-order, connectivity
 * and wedge/hash identity.
 */
export function checkOfficeStructure(structure: Pick<OfficeStructure, "json" | "document">): OfficeStructureCheck {
  const payload = parseSelectionClipboardPayload(structure.json);
  if (!payload) return { ok: false, reason: "its drawing data could not be read" };
  const raw = rawMolecules(structure.document);
  const molecules = moleculesOf(payload.objects);
  if (!raw || raw.length !== molecules.length ||
      raw.some((molecule, index) => molecule.atoms.length !== molecules[index]!.atoms.length ||
        molecule.bonds.length !== molecules[index]!.bonds.length)) {
    return { ok: false, reason: "reading it would drop atoms, bonds or structures" };
  }
  const reread = parseSelectionClipboardPayload(serializeSelectionClipboardPayload(payload));
  if (!reread || reread.objects.length !== payload.objects.length ||
      reread.objects.some((object, index) => object.type !== payload.objects[index]!.type)) {
    return { ok: false, reason: "its drawing did not survive a save and reload" };
  }
  const changed = identityDifference(molecules, moleculesOf(reread.objects));
  if (changed) return { ok: false, reason: `its chemistry changed on a save and reload (${changed})` };
  // Lay out by the drawing's real extent, never by bounds the file claims.
  const bounds = selectionBounds(payload.objects, payload.objects.map((object) => object.id));
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    return { ok: false, reason: "its drawing has no usable size" };
  }
  return { ok: true, payload: { ...payload, bounds } };
}

export interface PlacedStructure {
  location: string;
  objectIds: string[];
  /**
   * What placing it could not keep (bracket membership or crossing references, an explicit
   * electron-mark association) and the warnings stored with the drawing. The drawing is placed, as
   * an ordinary paste places it, but the user must be told (AGENTS.md §7).
   */
  warnings: string[];
}

export interface OfficeStructureInsertion {
  document: ChemDraftDocument;
  placed: PlacedStructure[];
  failed: { location: string; reason: string }[];
}

const LAYOUT_GAP = 24;
const LAYOUT_MARGIN = 36;

/**
 * Insert checked drawings into the first page, left to right in rows that wrap at the page
 * width, below any existing content (or centered on an empty page), without overlap. Every
 * placed molecule is compared with the drawing it came from; a drawing whose chemistry changed
 * on placement is left out and reported; one that loses other data keeps the paste's warnings. The
 * inserted objects end up selected.
 */
export function insertOfficeStructures(
  document: ChemDraftDocument,
  drawings: readonly { location: string; payload: ChemDraftSelectionClipboardPayload }[],
): OfficeStructureInsertion {
  const page = document.pages[0];
  if (!page) throw new Error("The document has no page to import structures into.");
  const existing = selectionBounds(page.objects, page.objects.map((object) => object.id));
  const preferredLeft = Math.max(LAYOUT_MARGIN, existing?.x ?? LAYOUT_MARGIN);
  const right = page.width - LAYOUT_MARGIN;

  const rows: { items: typeof drawings[number][]; left: number; width: number; height: number }[] = [];
  for (const drawing of drawings) {
    const { width, height } = drawing.payload.bounds;
    const row = rows.at(-1);
    if (row && row.left + row.width + LAYOUT_GAP + width <= right) {
      row.items.push(drawing);
      row.width += LAYOUT_GAP + width;
      row.height = Math.max(row.height, height);
    } else {
      const left = preferredLeft + width <= right ? preferredLeft : LAYOUT_MARGIN;
      rows.push({ items: [drawing], left, width, height });
    }
  }
  const blockHeight = rows.reduce((sum, row) => sum + row.height, 0) + LAYOUT_GAP * Math.max(rows.length - 1, 0);
  let top = existing
    ? existing.y + existing.height + 2 * LAYOUT_GAP
    : Math.max(LAYOUT_MARGIN, page.height / 2 - blockHeight / 2);

  let current = document;
  const placed: PlacedStructure[] = [];
  const failed: OfficeStructureInsertion["failed"] = [];
  for (const row of rows) {
    let left = existing ? row.left : Math.max(LAYOUT_MARGIN, page.width / 2 - row.width / 2);
    for (const { location, payload } of row.items) {
      const { width } = payload.bounds;
      const point = { x: left + width / 2, y: top + row.height / 2 };
      left += width + LAYOUT_GAP;
      const before = new Set(current.pages[0]!.objects.map((object) => object.id));
      const warnings: string[] = [];
      let next: ChemDraftDocument;
      try {
        next = pasteSelectionClipboardPayload(current, payload, point, warnings);
      } catch (error) {
        failed.push({ location, reason: `it could not be placed (${error instanceof Error ? error.message : String(error)})` });
        continue;
      }
      const added = next.pages[0]!.objects.filter((object) => !before.has(object.id));
      const changed = identityDifference(moleculesOf(payload.objects), moleculesOf(added));
      if (changed) {
        failed.push({ location, reason: `its chemistry changed when placed (${changed})` });
        continue;
      }
      placed.push({ location, objectIds: [...next.selection.objectIds], warnings: [...new Set(warnings)] });
      current = next;
    }
    top += row.height + LAYOUT_GAP;
  }
  if (placed.length) current = selectDocumentObjects(current, page.id, placed.flatMap((item) => item.objectIds));
  return { document: current, placed, failed };
}

/**
 * The placement warnings: every one for the log, the first (and how many more) for the status
 * line. `subject` names a drawing by its location, e.g. "the structure on slide 2".
 */
export function placementWarnings(
  placed: readonly PlacedStructure[], subject: (location: string) => string,
): { message: string; details: string[] } {
  const details = placed.flatMap(({ location, warnings }) =>
    warnings.map((warning) => `Warning for ${subject(location)}: ${warning.trim().replace(/\.?$/, ".")}`));
  const more = details.length - 1;
  if (more < 0) return { message: "", details };
  return { message: ` ${details[0]}${more ? ` ${more} more ${more === 1 ? "warning is" : "warnings are"} in the log.` : ""}`, details };
}

const WARNING_WORDS: Record<OfficeCarrierWarningReason, [one: string, many: string]> = {
  "malformed": ["has damaged ChemDraft data", "have damaged ChemDraft data"],
  "unknown-version": ["was made by a newer or unknown version of ChemDraft", "were made by a newer or unknown version of ChemDraft"],
  "too-large": ["is over the size limit", "are over the size limit"],
  "unsupported": ["could not be read on this system", "could not be read on this system"],
};
const CHECK_WORDS: [string, string] = ["failed the chemistry check", "failed the chemistry check"];
const PLACE_WORDS: [string, string] = ["could not be placed without changing its chemistry", "could not be placed without changing their chemistry"];

export interface OfficeImportOutcome {
  /** One plain sentence or two for the status line. */
  message: string;
  /** Per-structure reasons, for the log. */
  details: string[];
  /** The document to commit as one undo step, or undefined when nothing was inserted. */
  document?: ChemDraftDocument;
  inserted: number;
  skipped: number;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Turn a package result into the inserted document and the words to report. Pure. */
export function planOfficeStructureImport(
  document: ChemDraftDocument, fileName: string, result: OfficeImportResult,
): OfficeImportOutcome {
  const details: string[] = [];
  const skipCounts = new Map<[string, string], number>();
  const skip = (words: [string, string], detail: string) => {
    skipCounts.set(words, (skipCounts.get(words) ?? 0) + 1);
    details.push(detail);
  };
  for (const warning of result.warnings) skip(WARNING_WORDS[warning.reason], warning.message);

  const checked: { location: string; payload: ChemDraftSelectionClipboardPayload }[] = [];
  for (const structure of result.structures) {
    const check = checkOfficeStructure(structure);
    if (check.ok) checked.push({ location: structure.location, payload: check.payload });
    else skip(CHECK_WORDS, `The structure on ${structure.location} was not imported: ${check.reason}.`);
  }
  const insertion = checked.length ? insertOfficeStructures(document, checked) : undefined;
  for (const { location, reason } of insertion?.failed ?? []) {
    skip(PLACE_WORDS, `The structure on ${location} was not imported: ${reason}.`);
  }

  const inserted = insertion?.placed.length ?? 0;
  const skipped = [...skipCounts.values()].reduce((sum, n) => sum + n, 0);
  const why = [...skipCounts].map(([[one, many], n]) => `${n} ${n === 1 ? one : many}`).join(", ");
  let message: string;
  if (inserted) {
    message = `Imported ${count(inserted, "structure")} from ${fileName}.`;
    if (skipped) message += ` Skipped ${skipped}: ${why}.`;
  } else if (skipped) {
    message = `No structures were imported from ${fileName}. Skipped ${skipped}: ${why}.`;
  } else {
    message = `No ChemDraft structures were found in ${fileName}. Only pictures placed from ChemDraft can be imported.`;
  }
  const lost = placementWarnings(insertion?.placed ?? [], (location) => `the structure on ${location}`);
  message += lost.message;
  if (result.notes.length) message += ` ${result.notes.join(" ")}`;
  return { message, details: [...details, ...lost.details, ...result.notes], document: inserted ? insertion!.document : undefined, inserted, skipped };
}

export interface OfficeImportFile {
  name: string;
  read(): Promise<Uint8Array>;
}

export interface OfficeImportDeps {
  pickFile(): Promise<OfficeImportFile | undefined>;
  getDocumentKey(): string;
  getDocument(key: string): ChemDraftDocument | undefined;
  /**
   * Commit one undo entry with this label. Returns false when the commit was refused (for example by
   * the chemistry guard); the committer has already shown why, so the import reports no success.
   */
  commit(key: string, document: ChemDraftDocument, undoLabel: string): boolean | void;
  report(message: string, details: readonly string[]): void;
  importStructures?: typeof importOfficeStructures;
}

/** The command handler: pick, read, find, check, insert as one undo entry, report. */
export async function runOfficeStructureImport(deps: OfficeImportDeps): Promise<OfficeImportOutcome | undefined> {
  const documentKey = deps.getDocumentKey();
  const file = await deps.pickFile();
  if (!file) {
    deps.report("Import canceled", []);
    return undefined;
  }
  let outcome: OfficeImportOutcome;
  try {
    const bytes = await file.read();
    const result = await (deps.importStructures ?? importOfficeStructures)(bytes);
    const document = deps.getDocument(documentKey);
    if (!document) {
      deps.report("Import canceled because the originating drawing was closed or replaced.", []);
      return undefined;
    }
    outcome = planOfficeStructureImport(document, file.name, result);
    // A refused commit is an import failure: keep the committer's refusal on the status line.
    if (outcome.document && deps.commit(documentKey, outcome.document, IMPORT_OFFICE_STRUCTURES_UNDO_LABEL) === false) {
      return undefined;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const detail = error instanceof OfficeImportError && error.detail ? [error.detail] : [];
    deps.report(`Could not import structures from ${file.name}: ${reason}`, detail);
    return undefined;
  }
  deps.report(outcome.message, outcome.details);
  return outcome;
}

/** Native file dialog on desktop (macOS and Windows alike), a file input in the browser build. */
export async function pickOfficeImportFile(basename: (path: string) => string): Promise<OfficeImportFile | undefined> {
  if (isDesktopRuntime()) {
    const { open } = await import("./nativeFileDialog");
    const selected = await open({
      title: "Import Structures from Word or PowerPoint",
      multiple: false,
      directory: false,
      fileAccessMode: "scoped",
      filters: OFFICE_IMPORT_FILE_FILTERS,
    });
    const path = typeof selected === "string" ? selected : undefined;
    return path ? { name: basename(path), read: () => readNativeFileBytes(path) } : undefined;
  }
  return new Promise((resolve) => {
    const input = globalThis.document.createElement("input");
    input.type = "file";
    input.accept = ".docx,.pptx";
    input.addEventListener("cancel", () => resolve(undefined), { once: true });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      resolve(file ? {
        name: file.name,
        read: async () => {
          assertDocumentSize(file.size);
          return new Uint8Array(await file.arrayBuffer());
        },
      } : undefined);
    }, { once: true });
    input.click();
  });
}
