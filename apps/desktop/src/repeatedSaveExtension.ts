/**
 * The macOS save panel hides the file extension by default. A user who types the extension anyway
 * (`x.chemdraft`) gets the filter's extension appended again, and the panel returns
 * `x.chemdraft.chemdraft`. These helpers undo exactly that repeat, for a panel path only on macOS:
 * the Windows and Linux pickers return exactly what the user typed, so a typed `x.svg.svg` stays.
 */

import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";

/** Extensions a document Save panel offers. */
export const DOCUMENT_SAVE_EXTENSIONS: readonly string[] = ["chemdraft", "cdxml", "cdx"];

/**
 * Collapse one repeated trailing extension (`x.chemdraft.chemdraft` -> `x.chemdraft`) when that
 * extension is one of `extensions`. Case-insensitive; keeps the user's spelling of the first copy.
 * Accepts `/` and `\` separators. Every other name, including `a.b.chemdraft` and
 * `x.cdxml.chemdraft`, comes back unchanged.
 */
export function collapseRepeatedFileExtension(path: string, extensions: readonly string[]): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(separator + 1).toLowerCase();
  for (const extension of extensions) {
    const suffix = `.${extension.toLowerCase()}`;
    if (suffix === "." || suffix === ".*") continue;
    // A non-empty stem must remain before the first copy.
    if (name.length > 2 * suffix.length && name.endsWith(suffix + suffix)) {
      return path.slice(0, path.length - suffix.length);
    }
  }
  return path;
}

export interface RepeatedExtensionSaveContext {
  /**
   * The document's own current file. Saving onto it needs no Replace question, but only when the
   * collapsed path is exactly this string: identity is never guessed from spelling, so any other
   * spelling of an existing file is asked about.
   */
  ownPath?: string;
  /** Rejects when the path cannot be checked (for example, outside the file access scope). */
  exists: (path: string) => Promise<boolean>;
  /** Ask the user to replace an existing file. Resolves true to replace. */
  confirmReplace: (path: string) => Promise<boolean>;
  /** Only the macOS panel repeats an extension; elsewhere the panel's path is used as typed. */
  platform?: ShortcutPlatform;
}

export interface RepeatedExtensionSaveTarget {
  path: string;
  /**
   * True when `path` is a collapsed path that was free when checked and the user was never asked
   * about it. The panel's Replace question covered only the doubled name, so such a path is
   * written with exclusive creation (`writeRepeatedExtensionSaveTarget`), and a file that appeared
   * there since the check is confirmed first.
   */
  recheck: boolean;
}

/**
 * Like `resolveRepeatedExtensionSavePath`, but also reports whether the write must re-check the
 * collapsed path. Never rejects because the collapsed path cannot be checked: outside the file
 * access scope (an external volume, for example) the panel's own path is kept unchanged on purpose,
 * because only that exact path was granted.
 */
export async function resolveRepeatedExtensionSaveTarget(
  selected: string,
  extensions: readonly string[],
  context: RepeatedExtensionSaveContext
): Promise<RepeatedExtensionSaveTarget | undefined> {
  if ((context.platform ?? detectDesktopShortcutPlatform()) !== "macos") return { path: selected, recheck: false };
  const collapsed = collapseRepeatedFileExtension(selected, extensions);
  if (collapsed === selected) return { path: selected, recheck: false };
  if (context.ownPath !== undefined && collapsed === context.ownPath) return { path: collapsed, recheck: false };
  let exists: boolean;
  try {
    exists = await context.exists(collapsed);
  } catch {
    return { path: selected, recheck: false };
  }
  if (!exists) return { path: collapsed, recheck: true };
  return await context.confirmReplace(collapsed) ? { path: collapsed, recheck: false } : undefined;
}

/**
 * The path to write for a path the save panel returned, or undefined when the user declined to
 * replace a file. The panel's own Replace question was about the doubled name, so replacing a
 * different existing file at the collapsed path is confirmed here. If the collapsed path cannot be
 * checked, the panel's path is kept unchanged, as before this fix.
 */
export async function resolveRepeatedExtensionSavePath(
  selected: string,
  extensions: readonly string[],
  context: RepeatedExtensionSaveContext
): Promise<string | undefined> {
  return (await resolveRepeatedExtensionSaveTarget(selected, extensions, context))?.path;
}

/**
 * The path to write when `appended` is the panel's `selected` path with an extension added after
 * the panel returned (the Linux and Windows pickers return the name as typed). The panel asked only
 * about `selected`, so an existing file at a different `appended` path is confirmed here; undefined
 * means the user declined. An unchanged path or the document's own file is never asked about, and
 * a path that cannot be checked is written as before.
 */
export async function resolveAppendedExtensionSavePath(
  selected: string,
  appended: string,
  context: Pick<RepeatedExtensionSaveContext, "ownPath" | "exists" | "confirmReplace">
): Promise<string | undefined> {
  if (appended === selected || appended === context.ownPath) return appended;
  let exists: boolean;
  try {
    exists = await context.exists(appended);
  } catch {
    return appended;
  }
  return !exists || await context.confirmReplace(appended) ? appended : undefined;
}

/**
 * True when `error` is the fs plugin's report that an exclusive (`createNew`) write found a file
 * already there: Rust's `io::ErrorKind::AlreadyExists`. tauri-plugin-fs 2.5.1 rejects with a plain
 * string, `failed to open file at path: <path> with error: <io::Error>`, and an OS io::Error
 * displays as `<description> (os error <code>)`: `File exists (os error 17)` (EEXIST, macOS and
 * Linux), `The file exists. (os error 80)` (ERROR_FILE_EXISTS, Windows) or `Cannot create a file
 * when that file already exists. (os error 183)` (ERROR_ALREADY_EXISTS, Windows). The code decides,
 * since the description can be localized; a kind-only error displays `entity already exists`.
 * Only the text after the last `with error:` is read, so a path that merely contains such words
 * does not count. Every other failure, including disk full after the file was created, is not one.
 */
export function isFileAlreadyExistsError(error: unknown): boolean {
  const text = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown } | null)?.message === "string"
        ? (error as { message: string }).message
        : String(error);
  const marker = text.toLowerCase().lastIndexOf("with error:");
  const detail = (marker < 0 ? text : text.slice(marker + "with error:".length)).toLowerCase();
  return /\(os error (?:17|80|183)\)/.test(detail) || /\bentity already exists\b/.test(detail);
}

/** Writes `path`; with `createNew`, fails instead of replacing a file that already exists. */
export type RepeatedExtensionSaveWrite = (path: string, options: { createNew: boolean }) => Promise<void>;

/**
 * Write a resolved target. Resolves true once written and false when the user declined to replace
 * a file; rejects when the write fails. A target that needs a re-check is written with exclusive
 * creation, so a file that appeared since the check is never overwritten silently: when that write
 * fails because a file is already there (`isFileAlreadyExistsError`), the user is asked, and only a
 * confirmed replacement is written normally. Any other failure rejects with its own error, even if
 * it left a file behind (the plugin creates the file before writing, so a full disk can leave an
 * empty one), and is never reported as a declined replacement. A target the user already confirmed
 * (or that needs no re-check) is written normally.
 */
export async function writeRepeatedExtensionSaveTarget(
  target: RepeatedExtensionSaveTarget,
  context: Pick<RepeatedExtensionSaveContext, "exists" | "confirmReplace">,
  write: RepeatedExtensionSaveWrite
): Promise<boolean> {
  if (!target.recheck) {
    await write(target.path, { createNew: false });
    return true;
  }
  try {
    await write(target.path, { createNew: true });
    return true;
  } catch (error) {
    if (!isFileAlreadyExistsError(error)) throw error;
  }
  if (!await context.confirmReplace(target.path)) return false;
  await write(target.path, { createNew: false });
  return true;
}

/**
 * Write `path` for a deferred save (Export picks, then writes on a later click). When the cached
 * grant for `key` names this path, its re-check applies, and it is cleared only after the write
 * succeeds: a retry after a failed or declined write still re-checks and asks again. A grant
 * replaced while the user was being asked is left alone.
 */
export async function writeGrantedRepeatedExtensionTarget<K, G extends RepeatedExtensionSaveTarget>(
  grants: Map<K, G>,
  key: K,
  path: string,
  context: Pick<RepeatedExtensionSaveContext, "exists" | "confirmReplace">,
  write: RepeatedExtensionSaveWrite
): Promise<boolean> {
  const grant = grants.get(key);
  const target: RepeatedExtensionSaveTarget = grant?.path === path ? grant : { path, recheck: false };
  if (!await writeRepeatedExtensionSaveTarget(target, context, write)) return false;
  // The user's own export (or a confirmed file) is there now; do not ask again.
  if (grant && target === grant && grant.recheck && grants.get(key) === grant) grants.set(key, { ...grant, recheck: false });
  return true;
}
