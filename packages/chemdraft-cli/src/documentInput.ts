import { open } from "node:fs/promises";
import { win32 } from "node:path";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { validateBatchName, CliUsageError } from "./output";

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** Absolute destinations are allowed; filenames follow the existing portable batch-name policy. */
export function validateDocumentOutputPath(file: string): void {
  if (!file || file.includes("\0") || file.split(/[\\/]/).includes("..")) {
    throw new CliUsageError("Unsafe output path: parent traversal and empty paths are refused.");
  }
  const name = win32.basename(file);
  const extension = win32.extname(name);
  validateBatchName(extension ? name.slice(0, -extension.length) : name);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
      /[<>:"|?*]/.test(name) || /[. ]$/.test(name)) {
    throw new CliUsageError(`Unsafe output filename ${JSON.stringify(name)}.`);
  }
}

/** Bound the read itself, including when the file changes after it is opened. */
export async function loadAgentDocument(file: string) {
  let contents: string;
  try {
    const handle = await open(file, "r");
    try {
      const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds the 5 MB input limit.");
      contents = bytes.subarray(0, length).toString("utf8");
    } finally {
      await handle.close();
    }
    const opened = openChemDraftPayload(contents);
    if (!opened.document || opened.source === "external-cdxml") {
      throw new Error(opened.warnings.map((warning) => warning.message).join("; ") ||
        "Expected native document JSON or a ChemDraft envelope.");
    }
    validateAgentDocument(opened.document);
    return opened;
  } catch (error) {
    throw new CliUsageError(`Could not load document "${file}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateAgentDocument(document: ChemDraftDocument): void {
  if (document.pages.length > 100) throw new Error("Document exceeds the 100 page limit.");
  for (const page of document.pages) {
    if (page.objects.length > 2000) throw new Error(`Page ${page.id} exceeds the 2000 object limit.`);
    for (const object of page.objects) {
      if (object.type !== "molecule") continue;
      const heavyAtoms = object.atoms.filter((atom) => !["H", "D", "T"].includes(atom.element)).length;
      if (heavyAtoms > 500) throw new Error(`Molecule ${object.id} exceeds the 500 heavy atom limit.`);
      if (object.atoms.length > 2000 || object.bonds.length > 4000) {
        throw new Error(`Molecule ${object.id} exceeds the 2000 atom / 4000 bond limit.`);
      }
    }
  }
}
