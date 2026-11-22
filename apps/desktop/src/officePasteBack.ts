import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { recoverPasteBackFromClipboard, type ClipboardReadPayload } from "@chemdraft/clipboard-adapter";
import type { ChemDraftSelectionClipboardPayload } from "./documentWorkflow";
import { checkOfficeStructure, insertOfficeStructures, placementWarnings } from "./officeStructureImport";

/**
 * Paste-back (docs/architecture/office-editing.md, slice 3): paste a ChemDraft structure picture
 * copied in Word or PowerPoint as the editable structure its carrier holds. The package layer
 * (`recoverPasteBackFromClipboard`) finds the carriers; this layer runs the importer's own
 * chemistry check (`checkOfficeStructure`, then a trial placement with `insertOfficeStructures`),
 * so a drawing is pasted only if its chemistry survives (AGENTS.md §7).
 */

export const OFFICE_PASTE_BACK_UNDO_LABEL = "Paste Structures";

export type OfficePasteBackDecision =
  /** No ChemDraft data in the copied pictures: the ordinary paste goes ahead. */
  | { kind: "none"; details: string[] }
  /** One structure: paste it like a ChemDraft selection, at the paste position. */
  | { kind: "selection"; payload: ChemDraftSelectionClipboardPayload; message: string; details: string[] }
  /** Several structures, laid out like File ▸ Import Structures; commit as one undo step. */
  | { kind: "document"; document: ChemDraftDocument; message: string; details: string[] }
  /** ChemDraft data is present but unusable: paste nothing, say why. */
  | { kind: "refused"; message: string; details: string[] };

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Decide the paste-back for one clipboard read. Call it only after ChemDraft's own selection
 * flavor has declined; the package layer also refuses to act when that flavor is present.
 */
export async function officePasteBackDecision(
  read: ClipboardReadPayload,
  getDocument: () => ChemDraftDocument,
  recover: typeof recoverPasteBackFromClipboard = recoverPasteBackFromClipboard,
): Promise<OfficePasteBackDecision> {
  let result: Awaited<ReturnType<typeof recover>>;
  try {
    result = await recover(read);
  } catch (error) {
    // An unexpected failure must not block the ordinary paste of the same clipboard.
    return { kind: "none", details: [`Paste-back could not read the clipboard: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (result.kind === "none") return { kind: "none", details: result.notes };
  const carrierDetails = [...result.refusals.map((refusal) => refusal.message), ...result.notes];
  if (result.kind === "refused") {
    return { kind: "refused", message: `${result.message.replace(/\.?$/, ".")} Nothing was pasted.`, details: carrierDetails };
  }

  const details = [...carrierDetails];
  const checked: { location: string; payload: ChemDraftSelectionClipboardPayload }[] = [];
  const failures: string[] = [];
  for (const [index, structure] of result.structures.entries()) {
    const location = result.structures.length === 1 ? "the copied picture" : `copied picture ${index + 1}`;
    const check = checkOfficeStructure(structure);
    if (check.ok) checked.push({ location, payload: check.payload });
    else failures.push(`The structure in ${location} failed the chemistry check: ${check.reason}.`);
  }
  // The importer's placement check: each drawing must keep its chemistry once placed.
  const insertion = checked.length ? insertOfficeStructures(getDocument(), checked) : undefined;
  for (const { location, reason } of insertion?.failed ?? []) failures.push(`The structure in ${location} was not pasted: ${reason}.`);
  details.push(...failures);

  const placed = insertion?.placed ?? [];
  // What placing a drawing could not keep (AGENTS.md §7). One structure is pasted again by the
  // window's selection paste, which shows the same warnings in its status, so only the log gets
  // them here; several structures are committed as laid out, so the message carries them.
  const lost = placementWarnings(placed, (location) => `the structure in ${location}`);
  details.push(...lost.details);
  const skipped = failures.length + result.refusals.length;
  if (!placed.length) {
    return { kind: "refused", message: `${(failures[0] ?? result.refusals[0]?.message ?? "The copied structure could not be read.").replace(
      /^The structure in the copied picture/, "The copied structure")} Nothing was pasted.`, details };
  }
  const skippedNote = skipped
    ? ` Skipped ${plural(skipped, "other structure")} with damaged data or a failed chemistry check.` : "";
  if (placed.length === 1) {
    const { payload } = checked.find((drawing) => drawing.location === placed[0]!.location)!;
    return { kind: "selection", payload, message: `Pasted the ChemDraft structure from the copied picture.${skippedNote}`, details };
  }
  return { kind: "document", document: insertion!.document,
    message: `Pasted ${plural(placed.length, "ChemDraft structure")} from the copied pictures.${skippedNote}${lost.message}`, details };
}
