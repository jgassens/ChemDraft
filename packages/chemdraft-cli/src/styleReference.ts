import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";

import {
  nativeDrawingStyleFromCdxmlStyle,
  readCdxmlDocumentStyle,
  type CdxmlDocumentStyle
} from "@chemdraft/cdx-compat";
import type { NativeDrawingStyle } from "@chemdraft/chem-core";

import { MAX_DOCUMENT_BYTES, validateDocumentOutputPath } from "./documentInput";
import { CliUsageError } from "./output";
import { decodeUserText } from "./textInput";

/** Names a CDXML file whose drawing settings CDXML exports use when neither --style-reference nor
 *  the MCP argument names one. It is a source only because setting it is an explicit choice. */
export const CDXML_STYLE_REFERENCE_ENV = "CHEMDRAFT_CDXML_STYLE_REFERENCE";

/** The same cap as every other CDXML or document the CLI reads. */
export const MAX_STYLE_REFERENCE_BYTES = MAX_DOCUMENT_BYTES;

/** Where the reference in use was named: the CLI's --style-reference, the MCP `styleReference`
 *  argument, or the CHEMDRAFT_CDXML_STYLE_REFERENCE environment variable. */
export type StyleReferenceSource = "flag" | "argument" | "environment";

export interface ResolvedStyleReference {
  path: string;
  source: StyleReferenceSource;
}

/** What a caller was given that could name a reference. */
export interface StyleReferenceRequest {
  flag?: string;
  argument?: string;
  env?: NodeJS.ProcessEnv;
}

/** A style reference that loaded: CDXML settings for the file header, the matching native
 *  drawing style for the molecule, and the CDXML attributes the reference left unset. */
export interface LoadedStyleReference extends ResolvedStyleReference {
  style: CdxmlDocumentStyle;
  drawingStyle: Partial<NativeDrawingStyle>;
  missing: string[];
}

type StyleReferenceSourceLookup = (request: StyleReferenceRequest) => ResolvedStyleReference | undefined;

/**
 * Every place a reference may be named, highest precedence first. A style file is used only when
 * the user names it: there is deliberately no default file and no lookup in the home directory or
 * any configuration directory. A later source (a default file, say) is one more entry appended
 * here; resolveStyleReference's callers would not change.
 */
const styleReferenceSources: readonly StyleReferenceSourceLookup[] = [
  ({ flag }) => (flag === undefined ? undefined : { path: flag, source: "flag" }),
  ({ argument }) => (argument === undefined ? undefined : { path: argument, source: "argument" }),
  ({ env }) => {
    const configured = env?.[CDXML_STYLE_REFERENCE_ENV]?.trim();
    if (!configured) return undefined;
    // `~` here is the user's own spelling of a path they named, not a default location.
    const expanded = configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured;
    return { path: resolve(expanded), source: "environment" };
  }
];

/** The reference a CDXML export should use and where it was named, or undefined when none was. */
export function resolveStyleReference(request: StyleReferenceRequest): ResolvedStyleReference | undefined {
  for (const lookup of styleReferenceSources) {
    const resolved = lookup(request);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

const sourceLabels: Record<StyleReferenceSource, string> = {
  flag: "--style-reference",
  argument: "styleReference argument",
  environment: CDXML_STYLE_REFERENCE_ENV
};

function unusable(reference: ResolvedStyleReference, reason: string): CliUsageError {
  return new CliUsageError(`CDXML style reference "${reference.path}" (${sourceLabels[reference.source]}) cannot be used: ${reason}`);
}

/**
 * Checks for a path an agent supplied (the MCP argument), before anything is read: the CLI's
 * unsafe-path and unsafe-filename rules for outputs, and a `.cdxml` extension.
 */
function validateUntrustedPath(reference: ResolvedStyleReference): void {
  try {
    validateDocumentOutputPath(reference.path);
  } catch (error) {
    throw unusable(reference, error instanceof Error ? error.message : String(error));
  }
  if (extname(reference.path).toLowerCase() !== ".cdxml") {
    throw unusable(reference, "it does not have a .cdxml extension.");
  }
}

/**
 * Read and parse a style reference, failing with the reason when it cannot be used: not an existing
 * regular file, larger than the CLI's 5 MB input cap, not CDXML, or holding an unusable value. The
 * file is parsed with CDXML import's XML rules. A reference from the MCP argument is untrusted agent
 * input and must also pass the path and extension checks first.
 */
export async function loadStyleReference(reference: ResolvedStyleReference): Promise<LoadedStyleReference> {
  if (reference.source === "argument") validateUntrustedPath(reference);
  let contents: string;
  try {
    // Check before opening and on the handle. Nonblocking open covers a FIFO swapped in between
    // the two checks on POSIX. Windows has no O_NONBLOCK flag or filesystem FIFOs.
    if (!(await stat(reference.path)).isFile()) throw unusable(reference, "it is not a regular file.");
    const handle = await open(reference.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw unusable(reference, "it is not a regular file.");
      if (info.size > MAX_STYLE_REFERENCE_BYTES) throw unusable(reference, `it is larger than the ${MAX_STYLE_REFERENCE_BYTES} byte input limit.`);
      // Bound the read itself too, in case the file grows after the size check.
      const bytes = Buffer.alloc(MAX_STYLE_REFERENCE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > MAX_STYLE_REFERENCE_BYTES) throw unusable(reference, `it is larger than the ${MAX_STYLE_REFERENCE_BYTES} byte input limit.`);
      contents = decodeUserText(bytes.subarray(0, length));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw unusable(reference, code === "ENOENT" ? "no such file (ENOENT)." : error instanceof Error ? error.message : String(error));
  }
  try {
    const { style, missing } = readCdxmlDocumentStyle(contents);
    return { ...reference, style, drawingStyle: nativeDrawingStyleFromCdxmlStyle(style), missing };
  } catch (error) {
    throw unusable(reference, error instanceof Error ? error.message : String(error));
  }
}

/** The report every CDXML export result carries when a reference was used. */
export function styleReferenceReport(reference: ResolvedStyleReference | undefined): { styleReference?: ResolvedStyleReference } {
  return reference === undefined ? {} : { styleReference: { path: reference.path, source: reference.source } };
}

/** A warning naming the structure settings the reference left unset. */
export function styleReferenceWarnings(reference: LoadedStyleReference | undefined): string[] {
  if (reference === undefined || reference.missing.length === 0) return [];
  return [`CDXML style reference "${reference.path}" sets no ${reference.missing.join(", ")}; ChemDraft's own values were kept for those.`];
}
