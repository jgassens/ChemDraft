import { constants, type BigIntStats } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";

import {
  nativeDrawingStyleFromCdxmlStyle,
  readCdxmlDocumentStyle,
  type CdxmlDocumentStyle
} from "@chemdraft/cdx-compat";
import type { NativeDrawingStyle } from "@chemdraft/chem-core";

import { MAX_DOCUMENT_BYTES } from "./documentInput";
import { CliUsageError, isWindowsDeviceName } from "./output";
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
export function resolveStyleReference(
  request: StyleReferenceRequest,
  platform: NodeJS.Platform = process.platform
): ResolvedStyleReference | undefined {
  for (const lookup of styleReferenceSources) {
    const resolved = lookup(request);
    if (resolved === undefined) continue;
    // The environment lookup has already resolved its path against the host, which can hide a
    // network path's shape, so that source is checked from the text the user wrote.
    if (resolved.source === "environment") {
      const written = request.env?.[CDXML_STYLE_REFERENCE_ENV]?.trim() ?? "";
      refuseNonLocalWindowsPath({ ...resolved, path: written }, platform);
    }
    return resolved;
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

const leadingTwoSeparators = /^[\\/]{2}/;

/**
 * Refuses, by the shape of the text alone, a path Windows would send to the network or to the
 * device namespace: UNC (`\\host\share\x`, `//host/share/x`), `\\.\pipe\x`, `\\?\C:\x` and
 * `\\?\UNC\host\share\x`. Opening one can make Windows contact another machine and offer the
 * user's credentials, and a device-namespace name can be a pipe that a stat or open would connect
 * to, so this runs before any filesystem call, for every source of a reference. It applies on
 * Windows only; on POSIX a leading `//` is an ordinary path. The path's win32 resolved form is
 * checked too, in case a relative path resolves onto a share.
 */
export function refuseNonLocalWindowsPath(reference: ResolvedStyleReference, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") return;
  const path = reference.path;
  const resolved = leadingTwoSeparators.test(path) ? path : path.includes("\0") ? "" : win32.resolve(path);
  if (!leadingTwoSeparators.test(resolved)) return;
  // `\\.\` and `\\?\` (either slash) are the device namespace; anything else is a UNC host.
  if (/^[\\/]{2}[.?][\\/]/.test(resolved)) {
    throw unusable(reference, "it is a Windows device-namespace path (\\\\.\\ or \\\\?\\), which is refused before it is opened.");
  }
  throw unusable(reference, "it is a network (UNC) path, which is refused so that Windows never contacts another host.");
}

/** What the path checks found out about an argument's name before anything is read. */
interface ArgumentPathCheck {
  /** The name ends in `.cdx`, which is accepted only as an 8.3 short name whose content is CDXML. */
  shortCdx: boolean;
}

// A Windows 8.3 short name: up to eight characters, a dot, up to three. A long name such as
// "style.cdxml" can be reached as "STYLE~1.CDX", its extension truncated to three characters.
const shortNameCdx = /^[^.\\/]{1,8}\.cdx$/i;

/**
 * Checks for a path an agent supplied (the MCP argument), before anything is read. It names an
 * existing input file, so the portable rules for output names do not apply: an existing file may
 * have any name its filesystem allows, spaces and commas included, and a Windows 8.3 short name
 * (C:\TEMP\STYLE~1.CDXML) is a valid way to reach it. What is refused: an empty path or one with a
 * NUL character, a `..` segment, a Windows device name (reading CON or NUL is not reading a file),
 * and an extension other than `.cdxml` (any case). A `.cdx` extension is accepted only on an 8.3
 * name, since Windows truncates the short name of "style.cdxml" to "STYLE~1.CDX"; the file must then
 * still parse as CDXML, which loadStyleReference checks, so a binary CDX file is never taken for one.
 * `platform` chooses the path rules (Windows or POSIX); it defaults to the host's.
 */
export function validateStyleReferenceArgumentPath(
  reference: ResolvedStyleReference,
  platform: NodeJS.Platform = process.platform
): ArgumentPathCheck {
  const path = reference.path;
  refuseNonLocalWindowsPath(reference, platform);
  if (!path) throw unusable(reference, "the path is empty.");
  if (path.includes("\0")) throw unusable(reference, "the path contains a NUL character.");
  const separators = platform === "win32" ? /[\\/]/ : /\//;
  if (path.split(separators).includes("..")) {
    throw unusable(reference, "the path has a .. segment; parent traversal is refused.");
  }
  const paths = platform === "win32" ? win32 : posix;
  const name = paths.basename(path);
  if (platform === "win32" && isWindowsDeviceName(name)) {
    throw unusable(reference, `${JSON.stringify(name)} is a Windows device name, not a file.`);
  }
  const extension = paths.extname(name).toLowerCase();
  if (extension === ".cdxml") return { shortCdx: false };
  if (extension === ".cdx" && shortNameCdx.test(name)) return { shortCdx: true };
  throw unusable(reference, "it does not have a .cdxml extension.");
}

/** Test seams: `afterCheck` runs between the path check and the open, where a swap would happen. */
export interface LoadStyleReferenceHooks {
  afterCheck?: () => Promise<void> | void;
  /** The path rules to apply; the host's by default. Tests pass `win32` from a POSIX host. */
  platform?: NodeJS.Platform;
}

function sameFile(checked: BigIntStats, opened: BigIntStats): boolean {
  return checked.dev === opened.dev && checked.ino === opened.ino;
}

/**
 * Read and parse a style reference, failing with the reason when it cannot be used: not an existing
 * regular file, larger than the CLI's 5 MB input cap, not CDXML, or holding an unusable value. The
 * file is parsed with CDXML import's XML rules and limits. A reference from the MCP argument is
 * untrusted agent input: it must also pass the path and extension checks first, and its final path
 * component must not be a symbolic link (a link would let an agent read a file it did not name, and
 * the report would show only the link). For every source, a network (UNC) or Windows
 * device-namespace path is refused by shape before any filesystem call, and the file opened must
 * be the file checked: the device and inode of the opened handle are compared with the earlier check.
 */
export async function loadStyleReference(
  reference: ResolvedStyleReference,
  hooks: LoadStyleReferenceHooks = {}
): Promise<LoadedStyleReference> {
  const untrusted = reference.source === "argument";
  const platform = hooks.platform ?? process.platform;
  // Every source passes through here, so this is the one place that refuses a network or
  // device-namespace path before the first filesystem call.
  refuseNonLocalWindowsPath(reference, platform);
  const { shortCdx } = untrusted ? validateStyleReferenceArgumentPath(reference, platform) : { shortCdx: false };
  let bytes: Buffer;
  try {
    // Check before opening and on the handle. Nonblocking open covers a FIFO swapped in between
    // the two checks on POSIX. Windows has no O_NONBLOCK flag or filesystem FIFOs. For the MCP
    // argument the check is lstat, so a symbolic link is refused rather than followed, and O_NOFOLLOW
    // (POSIX) makes the open itself refuse one swapped in after the check.
    const checked = untrusted ? await lstat(reference.path, { bigint: true }) : await stat(reference.path, { bigint: true });
    if (checked.isSymbolicLink()) {
      throw unusable(reference, "it is a symbolic link; an agent-supplied style reference must name the file itself.");
    }
    if (!checked.isFile()) throw unusable(reference, "it is not a regular file.");
    await hooks.afterCheck?.();
    const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (untrusted ? constants.O_NOFOLLOW ?? 0 : 0);
    const handle = await open(reference.path, flags);
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile()) throw unusable(reference, "it is not a regular file.");
      if (!sameFile(checked, info)) {
        throw unusable(reference, "it changed between the check and the read (the file opened is not the file checked).");
      }
      if (info.size > BigInt(MAX_STYLE_REFERENCE_BYTES)) throw unusable(reference, `it is larger than the ${MAX_STYLE_REFERENCE_BYTES} byte input limit.`);
      // Bound the read itself too, in case the file grows after the size check.
      const buffer = Buffer.alloc(MAX_STYLE_REFERENCE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > MAX_STYLE_REFERENCE_BYTES) throw unusable(reference, `it is larger than the ${MAX_STYLE_REFERENCE_BYTES} byte input limit.`);
      bytes = buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (untrusted && code === "ELOOP") {
      throw unusable(reference, "it is a symbolic link; an agent-supplied style reference must name the file itself.");
    }
    throw unusable(reference, code === "ENOENT" ? "no such file (ENOENT)." : error instanceof Error ? error.message : String(error));
  }
  try {
    const { style, missing } = readCdxmlDocumentStyle(decodeUserText(bytes));
    return { ...reference, style, drawingStyle: nativeDrawingStyleFromCdxmlStyle(style), missing };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (shortCdx) {
      throw unusable(reference, `a .cdx extension is accepted only as the 8.3 short name of a CDXML file, and this file is not CDXML: ${reason}`);
    }
    throw unusable(reference, reason);
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
