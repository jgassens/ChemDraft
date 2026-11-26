import type { OpenDialogOptions, OpenDialogReturn, SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { detectShortcutPlatform, type ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { FILE_DIALOG_ALREADY_OPEN_STATUS, withOneFileDialog } from "./fileDialogGuard";
import { withNativeUtilitySuspension } from "./nativeUtilitySuspension";

type SaveDialogFilter = NonNullable<SaveDialogOptions["filters"]>[number];

/**
 * Move the first filter that matches `defaultPath`'s file name to the front; otherwise return
 * `filters` itself. A filter matches when one of its extensions ends the name (case-insensitive),
 * or it lists "*".
 */
export function filtersMatchingDefaultPathFirst(filters: SaveDialogFilter[], defaultPath: string): SaveDialogFilter[] {
  const name = (defaultPath.split(/[\\/]/).pop() ?? "").toLowerCase();
  const index = filters.findIndex(filter => filter.extensions.some(extension =>
    extension === "*" || (extension !== "" && name.endsWith(`.${extension.toLowerCase()}`))));
  if (index <= 0) return filters;
  return [filters[index]!, ...filters.slice(0, index), ...filters.slice(index + 1)];
}

/**
 * Linux only. The GTK Save dialog showed a blank file-type list when the suggested file already
 * existed with an extension the first filter does not list (Save As of drawing.cdxml offers
 * ChemDraft first): GTK preselects the existing file, finds it hidden by the active filter, and
 * drops the filter, which leaves the list with no active entry. Offering the filter that matches
 * the suggested name first keeps that file visible, so the list shows its name. The filters, their
 * names and the chosen path are unchanged; only their order is. macOS and Windows get `options`
 * back as given.
 */
export function saveDialogOptionsForPlatform(
  options: SaveDialogOptions | undefined,
  platform: ShortcutPlatform
): SaveDialogOptions | undefined {
  if (platform !== "linux" || !options?.filters?.length || !options.defaultPath) return options;
  const filters = filtersMatchingDefaultPathFirst(options.filters, options.defaultPath);
  return filters === options.filters ? options : { ...options, filters };
}

let dialogModule: Promise<typeof import("@tauri-apps/plugin-dialog")> | undefined;

export function prewarmNativeFileDialogs(): Promise<typeof import("@tauri-apps/plugin-dialog")> {
  dialogModule ??= import("@tauri-apps/plugin-dialog").catch((error) => {
    dialogModule = undefined;
    throw error;
  });
  return dialogModule;
}

/**
 * Linux: Rust lets one file chooser be in flight app-wide, so that it can parent it to the window
 * that asked, and refuses a request from any other window meanwhile with
 * FILE_DIALOG_ALREADY_OPEN_STATUS. Report that exactly as this window reports its own second
 * request, and resolve `cancelled`. Any other failure is passed on.
 */
async function refusedAsCancel<T>(panel: () => Promise<T>, cancelled: T): Promise<T> {
  try {
    return await panel();
  } catch (error) {
    if (error !== FILE_DIALOG_ALREADY_OPEN_STATUS) throw error;
    // Called while this request still holds the window's guard, which therefore refuses it: it
    // reports the status and resolves `cancelled`, opening nothing.
    return withOneFileDialog(async () => cancelled, cancelled);
  }
}

/** All document-window file panels use these wrappers, including plugin pickers and exports.
 * At most one is pending at a time; a refused request resolves null, as a cancel. */
export function open<T extends OpenDialogOptions>(options?: T): Promise<OpenDialogReturn<T>> {
  const cancelled = null as unknown as OpenDialogReturn<T>;
  return withOneFileDialog(async () => {
    const dialogs = await prewarmNativeFileDialogs();
    return withNativeUtilitySuspension(() => refusedAsCancel(() => dialogs.open(options), cancelled));
  }, cancelled);
}

export function save(
  options?: SaveDialogOptions,
  focusExportSessionId?: string,
  platform: ShortcutPlatform = detectShortcutPlatform()
): Promise<string | null> {
  return withOneFileDialog(async () => {
    const dialogs = await prewarmNativeFileDialogs();
    const panelOptions = saveDialogOptionsForPlatform(options, platform);
    return withNativeUtilitySuspension(() => refusedAsCancel(() => dialogs.save(panelOptions), null), focusExportSessionId);
  }, null);
}
